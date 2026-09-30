"use strict";
/**
 * 统一事件裁决器：三个数据源（chatSessions / transcripts / session-store.db）
 * 写盘时机各不相同，同一轮次的内容会经多通道重复、乱序到达。此前客户端
 * （PWA）要各自猜测归属/去重/定序，竞态层出不穷。
 *
 * 这里在广播出口做单一裁决点：
 *  - 每条内容事件打规范归属：_sess（会话 basename）、_ut（所属用户文本）、
 *    _seq（单调序）、reqIdx（可推导时）；
 *  - 跨通道去重：同会话+同轮次+同内容前缀的事件在窗口内只放行第一条；
 *  - DONE 仲裁：过期 DONE（早于最近 live USER）打 stale 标记；
 *    注入回执 DONE（发送后 ~2s、无归属）打 ack 标记；停止类 DONE 打
 *    closedUt 让客户端精确清待答条目。
 * 客户端仍保留原有防线作兜底，但权威判断从此在服务端。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TurnArbiter = void 0;
const CONTENT_DEDUPE_MS = 120_000;
const TOOL_DEDUPE_MS = 3_000;
/** toolId 级长记忆：parked/重投的工具帧 5min 内只许向终态推进。 */
const TOOL_REPROJ_MS = 300_000;
const STALE_DONE_SKEW_MS = 2_000;
const INJECT_ACK_WINDOW_MS = 8_000;
/** AGENT_MESSAGE 先行判答后，本轮自己的收尾 DONE 仍须放行（客户端拿它
    释放 requestRunning/出队排队消息）——只杀「轮已答很久/从未注册」的死件。 */
const DONE_LATE_CLOSE_MS = 45_000;
const MAX_TRACKED_TURNS = 64;
function normText(t) {
    return String(t ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}
function sessBaseOf(ev) {
    const f = String(ev?._sess || ev?.file || ev?.sessionFile || "");
    if (!f)
        return "";
    const base = f.split(/[\\/]/).pop() || "";
    return base.replace(/\.jsonl$/i, "");
}
class TurnArbiter {
    seq = 0;
    latestUserLiveTs = 0;
    latestReqIdx = -1;
    openTurns = [];
    emitted = new Map();
    /** 同文不同轮重投影识别：a3 指纹（sess|前缀80）→ 已投递的 _ut。*/
    emittedUt = new Map();
    /** toolId → {t, done}：跨轮工具重投影压制（session 域内）。 */
    emittedTools = new Map();
    /** sess|toolId → 归属轮 ut：START 时钉死，进度/完成帧钉回原轮（R66 B3）。 */
    toolOwnerUt = new Map();
    /** sess|streamId → 归属轮 ut：首帧钉死，之后的 _ut-less 帧一律钉回原轮——
        回声开新轮后旧轮的在途流/思考帧不会再被盖成新轮的 ut（R48：A1 作文流
        在 A2/A3 echo 开新轮后被盖成 M48A3，渲染到 A3 泡下）。 */
    streamOwnerUt = new Map();
    /** a2 指纹（sess|前缀80）→ {t, 归属轮, ut}：轮次实例级同文去重。 */
    emittedA2 = new Map();
    /** 已 END 的 streamId → 终结时刻。END 后迟到的 START/CHUNK 服务端丢弃——
        否则客户端流卡已收尾又追加一遍（R64 双渲）且迟到帧会重新置 rr、
        把队列挂到看门狗（~135s 悬挂）。位置型 sid（requests/N/…）每轮唯一，
        60s 窗不会误伤下一轮。 */
    endedStreams = new Map();
    /** 最近 SESSION_SELECTED 的会话 basename：sess 缺失的轮次（只有手机发出的
        USER 不带 _sess/file 戳）归到这个会话——否则 pendingUserEvents 会把
        别会话的 pending 泡补投进任意会话的回放尾部（R96 跨会话泄漏）。 */
    boundSess = "";
    /** 合成待投事件（superseded DONE 等）：accept 只能回一件，附属终态件由
        桥端在广播主事件后 drain 补投。 */
    syntheticOut = [];
    /** 会话切换/绑定变更时调用：清本轮状态，避免跨会话误杀。 */
    /** 当前 sess 的未答开启轮 USER 事件（全文）：供回放尾部补投未落盘的
        pending 轮 USER（桌面发出的轮 PWA 端无 sentAwaitingReply 备份）。 */
    pendingUserEvents(sessBase) {
        const out = [];
        for (const t of this.openTurns) {
            if (t.answered || !t.text)
                continue;
            // 严格会话匹配：sess 缺失的轮（手机发出）视同属于绑定会话，
            // 只在回放目标恰是绑定会话时才补投——不再漏进别会话 feed。
            if (sessBase) {
                const ts = String(t.sess || this.boundSess);
                if (ts !== sessBase)
                    continue;
            }
            out.push({
                type: "USER_MESSAGE",
                text: t.text,
                timestamp: t.ts,
                _ut: t.utKey,
                _sess: t.sess || sessBase,
                _seq: ++this.seq,
                pendingTurn: true,
            });
        }
        return out;
    }
    /** 取出并清空合成待投事件队列。 */
    drainSynthetic() {
        const out = this.syntheticOut;
        this.syntheticOut = [];
        return out;
    }
    resetForSession(sessBase) {
        // openTurns 跨切保留（轮次都带 sess 戳，查找点按 sessBase 过滤）：
        // 否则「在途轮切走→切回」后 pendingUserEvents 拿不到该轮记录，
        // 回放无法补投未落盘的 pending USER（R66 B1）。只修剪过老/已答轮。
        const now0 = Date.now();
        this.openTurns = this.openTurns.filter((t) => !t.answered && now0 - t.ts < 30 * 60_000);
        this.latestUserLiveTs = 0;
        this.latestReqIdx = -1;
        // 位置型 streamId（requests/N/…）每个会话文件从 0 重新计数——换会话必须清
        this.endedStreams.clear();
        this.emittedUt.clear();
        this.emittedTools.clear();
        this.toolOwnerUt.clear();
        this.streamOwnerUt.clear();
        this.emittedA2.clear();
        if (sessBase)
            this.pruneEmitted(0);
    }
    pruneEmitted(now) {
        for (const [k, ts] of this.emitted) {
            if (now - ts > CONTENT_DEDUPE_MS)
                this.emitted.delete(k);
        }
    }
    /** 内容指纹：类型族 + 会话 + 轮次 + 内容前缀。窗口内重复 → 跨通道重投，丢弃。 */
    contentKey(ev, sessBase, utKey) {
        switch (ev.type) {
            case "USER_MESSAGE": {
                const t = normText(ev.text);
                if (!t)
                    return null;
                return `u|${sessBase}|${t}`;
            }
            case "AGENT_MESSAGE": {
                const t = normText(ev.text);
                if (!t)
                    return null;
                const sid = String(ev.streamId || "");
                const req = typeof ev.requestIndex === "number" ? `r${ev.requestIndex}` : "";
                // streamId 相同 = 同一条流终帧在多个通道各发一遍；但 requests/N/...
                // 这类位置型 sid 跨轮复用，必须再按文本前缀区分才不会误杀新答案。
                return sid
                    ? `a|${sessBase}|${sid}|${t.slice(0, 40)}`
                    : `a|${sessBase}|${req}|${utKey}|${t.slice(0, 80)}`;
            }
            case "AGENT_CONFIRM": {
                // 同一待批准确认卡在各通道各投一遍（transcript + sessiondb 重投影）——
                // 客户端每张建一块卡 → feed 双卡。指纹：confirmId/toolCallId 优先，
                // 否则标题+正文前缀（不同确认文案不同，不会误杀新卡）。
                const cid = String(ev.confirmId || ev.requestId || ev.toolCallId || ev.id || "");
                if (cid)
                    return `c|${sessBase}|${cid}`;
                const body = normText(`${ev.title || ""} ${ev.message || ""}`);
                if (!body)
                    return null;
                return `c|${sessBase}|${utKey}|${body.slice(0, 80)}`;
            }
            case "TOOL_CALL":
            case "AGENT_TOOL_CALL":
            case "AGENT_TOOL_RESULT":
            case "TOOL_RESULT": {
                // 同一工具调用在各通道各投一遍。指纹【不含】状态：两通道副本恰好
                // running/done 双态不同，含状态会被当不同事件放行（R58 实测）。
                // 真实 running→done 更新间隔常 >3s，配合 TOOL 短窗去重不伤进度更新。
                const cid = String(ev.toolId || ev.callId || ev.toolCallId || ev.id || "");
                if (cid)
                    return `t|${sessBase}|${cid}`;
                const name = normText(ev.text || ev.name || ev.tool);
                if (!name)
                    return null;
                const args = normText(ev.args ?? ev.arguments ?? ev.input).slice(0, 60);
                return `t|${sessBase}|n:${name}|${args}`;
            }
            default:
                return null;
        }
    }
    newestOpenTurn(sessBase) {
        for (let i = this.openTurns.length - 1; i >= 0; i--) {
            const t = this.openTurns[i];
            if (t.answered)
                continue;
            if (sessBase && t.sess && t.sess !== sessBase)
                continue;
            return t;
        }
        return undefined;
    }
    /** 按 _ut 反查轮次（含已答轮）：取最近一个该用户文的轮实例。
        同题重问的迟到重投影会归到最新同 ut 轮——与 a2 记录的归属轮一致即可判重。 */
    lastTurnWithUt(sessBase, utKey) {
        if (!utKey)
            return undefined;
        for (let i = this.openTurns.length - 1; i >= 0; i--) {
            const t = this.openTurns[i];
            if (sessBase && t.sess && t.sess !== sessBase)
                continue;
            if (t.utKey === utKey)
                return t;
        }
        return undefined;
    }
    /** 归属判定用：事件自带源时间戳且早于最新未答轮的开启时刻 >2s → 上一轮
        经慢通道迟到的重投影，不归本轮（否则盖错 _ut，客户端把旧答案当本轮
        答案渲染出串位泡）。无 ts 的事件照常归属（只能靠到达序）。 */
    openTurnForEvent(sessBase, evTs) {
        const t = this.newestOpenTurn(sessBase);
        if (!t)
            return undefined;
        if (evTs != null && evTs < t.ts - 2_000)
            return undefined;
        return t;
    }
    /**
     * sid 归属钉住：首帧把 streamId 钉到当时归属轮；之后同 sid 的帧（即使
     * 到达时更新轮已开启）一律钉回原轮。返回 {t, ownerUt}——ownerUt 是
     * 钉住的 ut（归属轮可能已被修剪只剩 ut 戳），用它盖戳优先于 t.utKey。
     */
    turnForStreamEvent(sessBase, evTs, sid) {
        const pinKey = sid && sessBase ? `${sessBase}|${sid}` : "";
        const owner = pinKey ? this.streamOwnerUt.get(pinKey) || "" : "";
        const owned = owner ? this.lastTurnWithUt(sessBase, owner) : undefined;
        const t = owned ?? this.openTurnForEvent(sessBase, evTs);
        if (t && pinKey && !owner)
            this.streamOwnerUt.set(pinKey, t.utKey);
        if (this.streamOwnerUt.size > 512) {
            let n = 0;
            for (const k of this.streamOwnerUt.keys()) {
                this.streamOwnerUt.delete(k);
                if (++n >= 64)
                    break;
            }
        }
        return { t, ownerUt: owner };
    }
    static tsOf(ev) {
        const v = typeof ev?.timestamp === "number" ? ev.timestamp : typeof ev?.ts === "number" ? ev.ts : null;
        return v;
    }
    markAnswered(sessBase, utKey) {
        for (const t of this.openTurns) {
            if (t.answered)
                continue;
            if (sessBase && t.sess && t.sess !== sessBase)
                continue;
            if (utKey && t.utKey !== utKey)
                continue;
            t.answered = true;
            t.answeredAt = Date.now();
            if (!utKey)
                break;
        }
        while (this.openTurns.length > MAX_TRACKED_TURNS)
            this.openTurns.shift();
    }
    /**
     * 裁决一条待广播事件。返回打戳后的事件；返回 null = 丢弃（跨通道重复）。
     * 非内容类事件（MODEL_LIST/SYSTEM_MESSAGE 等）原样放行，仅打 _seq。
     * markEmitted=false 表示这条不会立刻上公网（如离线排队）：去重判定照常，
     * 但不消耗首发名额——首个真正广播出去的副本才有资格记名。
     */
    accept(ev, opts) {
        const markEmitted = opts?.markEmitted !== false;
        if (!ev || typeof ev !== "object")
            return ev;
        const now = Date.now();
        this.pruneEmitted(now);
        const sessBase = sessBaseOf(ev);
        const type = String(ev.type || "");
        if (type === "SESSION_SELECTED" && sessBase)
            this.boundSess = sessBase;
        // 轮次归属键：服务端下发的 _ut 优先；否则归到最新未答轮
        let utKey = typeof ev._ut === "string" ? normText(ev._ut) : "";
        let ownerTurn;
        switch (type) {
            case "USER_MESSAGE": {
                const t = normText(ev.text);
                // 迟到重投影去重：sessiondb 行 / kind:2 记录编辑重写会把「同一轮」的
                // USER 再投一遍（实测 run_in_terminal 待批准轮在其 tool 重试时于
                // +430s 重投 → 客户端同文用户泡二次渲染）。判定：live 事件与同会话
                // 「未答开启轮」同文 = 该轮本身，不是新轮——整件丢弃（用户泡早已渲）。
                // 真同文重问发生在前轮 answered 之后，不受影响；回放/历史事件放行。
                if (t && !ev.replayed && !ev.history) {
                    for (const ot of this.openTurns) {
                        if (ot.answered)
                            continue;
                        if (sessBase && ot.sess && ot.sess !== sessBase)
                            continue;
                        if (ot.utKey === t)
                            return null;
                    }
                }
                const reqIdx = typeof ev.requestIndex === "number" ? ev.requestIndex : null;
                if (reqIdx != null && reqIdx > this.latestReqIdx)
                    this.latestReqIdx = reqIdx;
                if (!ev.replayed && !ev.history)
                    this.latestUserLiveTs = Math.max(this.latestUserLiveTs, now);
                const turn = {
                    utKey: t,
                    ts: now,
                    reqIdx,
                    answered: false,
                    text: typeof ev.text === "string" ? ev.text : undefined,
                };
                // sess 缺失 = 手机发出的轮（watcher 事件恒带文件戳）——归到绑定会话，
                // 否则 openTurns 里 sess='' 的轮跨会话泄漏（pendingUserEvents/R96）。
                turn.sess = sessBase || this.boundSess;
                if (!sessBase && this.boundSess && !ev._sess) {
                    ev._sess = this.boundSess;
                }
                const turnSess = String(turn.sess || "");
                this.openTurns.push(turn);
                if (this.openTurns.length > MAX_TRACKED_TURNS)
                    this.openTurns.shift();
                // parked 待批准轮被取代：同会话新 live USER 到达时，挂确认卡的旧轮
                // 上游永不发 DONE（工具调用被弃）——合成 superseded DONE 让客户端
                // 释放该轮的待答条目+清审批卡（ack:true 不碰新轮的在途态）。
                // steering 合轮不受影响：那类轮没挂确认卡。
                if (!ev.replayed && !ev.history) {
                    for (const ot of this.openTurns) {
                        if (ot === turn || ot.answered || !ot.hasConfirm)
                            continue;
                        if (String(ot.sess || "") !== turnSess)
                            continue;
                        ot.answered = true;
                        ot.answeredAt = now;
                        this.syntheticOut.push({
                            type: "COPILOT_DONE",
                            reason: "superseded",
                            ack: true,
                            _ut: ot.utKey,
                            _sess: turnSess,
                            timestamp: now,
                        });
                    }
                }
                utKey = t;
                break;
            }
            case "AGENT_STREAM_START":
            case "AGENT_STREAM_SET":
            case "AGENT_STREAM_CHUNK": {
                const sid = String(ev.streamId || "");
                const endedAt = sid ? this.endedStreams.get(sid) : undefined;
                if (endedAt != null && now - endedAt < 60_000)
                    return null;
                // 整帧迟到的流事件（源 ts 老于 30s）：已结束轮次的慢通道重投影，
                // 广播出去会重新武装 rr 并渲第二份答文——直接丢（R64/R33 同族）。
                const evTs = TurnArbiter.tsOf(ev);
                if (evTs != null && now - evTs > 30_000)
                    return null;
                const { t, ownerUt } = this.turnForStreamEvent(sessBase, evTs, sid);
                if (!t && !ownerUt) {
                    // 孤儿流帧：归属不到任何开启轮。CHUNK 在「全轮已答」后到达 =
                    // 已收尾轮的迟到重投影——客户端会为它新建永不收尾的 ghost 卡
                    // （requests/N 投影在答案落线 ~55s 后补帧实测）。ts 早于开启轮
                    // 的 START/SET 同理是旧轮迟到件。openTurns 全空不可判——放行，
                    // 以免吞掉 USER 尚未登记的桌面新轮。
                    const staleVsOpen = evTs != null && this.newestOpenTurn(sessBase) != null;
                    // noOpenButKnown 需按会话数轮（openTurns 现跨切保留——别会话的轮
                    // 不该把本会话的孤儿 CHUNK 判成迟到重投影）。
                    const anyTurnHere = this.openTurns.some((ot) => !sessBase || !ot.sess || ot.sess === sessBase);
                    const noOpenButKnown = this.newestOpenTurn(sessBase) == null && anyTurnHere;
                    if (type === "AGENT_STREAM_CHUNK" ? staleVsOpen || noOpenButKnown : staleVsOpen)
                        return null;
                }
                if (t && (!ownerUt || t.utKey === ownerUt))
                    t.sawStream = true;
                if (!utKey)
                    utKey = ownerUt || (t ? t.utKey : "");
                break;
            }
            case "AGENT_STREAM_END": {
                const sid = String(ev.streamId || "");
                if (sid) {
                    this.endedStreams.set(sid, now);
                    if (this.endedStreams.size > 128) {
                        for (const [k, ts] of this.endedStreams) {
                            if (now - ts > 60_000)
                                this.endedStreams.delete(k);
                        }
                    }
                }
                {
                    const { t, ownerUt } = this.turnForStreamEvent(sessBase, TurnArbiter.tsOf(ev), sid);
                    if (t && (!ownerUt || t.utKey === ownerUt))
                        t.sawStream = true;
                    if (!utKey)
                        utKey = ownerUt || (t ? t.utKey : "");
                }
                break;
            }
            case "TOOL_CALL":
            case "AGENT_TOOL_CALL":
            case "AGENT_TOOL_RESULT":
            case "TOOL_RESULT": {
                // 上一轮的迟滞重投：ts 早于最新 live USER 10s+ → 该事件属于旧轮，
                // 丢弃（R90：上轮工具调 ~37s 后漏进下一轮窗口渲成杂散工具卡）。
                const evTs = TurnArbiter.tsOf(ev);
                if (evTs != null &&
                    this.latestUserLiveTs > 0 &&
                    evTs < this.latestUserLiveTs - 10_000) {
                    return null;
                }
                // 工具归属钉死：START 帧记录 toolId→归属轮 ut；随后的进度/完成帧（即使
                // 该轮已被新 USER 取代、或 ts 缺失的慢通道重投）一律钉回原轮——否则
                // isComplete 会盖上新轮 _ut，渲成串位的孤儿工具卡（R66 B3）。
                const tidPin = String(ev.toolId || ev.callId || ev.toolCallId || ev.id || "");
                const evComplete = ev.isComplete === true;
                if (tidPin && sessBase) {
                    const k = `${sessBase}|${tidPin}`;
                    const owner = this.toolOwnerUt.get(k);
                    if (owner && !utKey)
                        utKey = owner;
                    if (!evComplete && utKey)
                        this.toolOwnerUt.set(k, utKey);
                    if (evComplete)
                        this.toolOwnerUt.delete(k);
                    if (this.toolOwnerUt.size > 256) {
                        const cut = this.toolOwnerUt.keys();
                        for (const key of cut)
                            this.toolOwnerUt.delete(key);
                        // Map 键序即插入序——全清过度但不误伤（极少到 256）。
                        break;
                    }
                }
                const t = this.openTurnForEvent(sessBase, evTs);
                if (t) {
                    t.sawStream = true;
                    if (!utKey)
                        utKey = t.utKey;
                    if (tidPin && sessBase && !evComplete) {
                        this.toolOwnerUt.set(`${sessBase}|${tidPin}`, t.utKey);
                    }
                }
                break;
            }
            case "AGENT_THINKING":
            case "THINKING_START":
            case "THINKING_END":
            case "COPILOT_TYPING": {
                const { t, ownerUt } = this.turnForStreamEvent(sessBase, TurnArbiter.tsOf(ev), String(ev.streamId || ""));
                if (t && (!ownerUt || t.utKey === ownerUt))
                    t.sawStream = true;
                if (!utKey)
                    utKey = ownerUt || (t ? t.utKey : "");
                break;
            }
            case "THINKING_STEP":
            case "PROGRESS_STEP": {
                const evTs = TurnArbiter.tsOf(ev);
                const { t, ownerUt } = this.turnForStreamEvent(sessBase, evTs, String(ev.streamId || ""));
                const hadStream = t?.sawStream === true;
                if (t && (!ownerUt || t.utKey === ownerUt))
                    t.sawStream = true;
                if (!utKey)
                    utKey = ownerUt || (t ? t.utKey : "");
                if (!t && !ownerUt && evTs != null && this.newestOpenTurn(sessBase)) {
                    // 存在开启轮但事件 ts 早于其开启 >2s：上一轮经慢通道迟到的
                    // 思考/进度帧——归属轮已收尾，放出去客户端只会为它新建流卡并
                    // 贴到 feed 底部（实测两枚旧轮 thinking 泡串进新轮下）。
                    return null;
                }
                // 迟到帧的第二种形态：上游把旧轮 thinking 以「新鲜 ts」在归属轮判答
                // 后 1-2s 重投（实测 R96A 答 DONE 后 +1s 到达，>2s stale-ts 门兜不住）。
                // 到达序把它归到刚开启、尚无流的新轮 → 错锚渲染在新用户泡下。
                // 无 _ut/rid 自证且新轮未见流时，同会话另一轮 3s 内刚判答 → 判旧轮残骸丢。
                // 新轮自身首帧思考通常在其 DONE 数秒后才可能产出，窗口内不误伤。
                if (t &&
                    !ownerUt &&
                    !hadStream &&
                    !ev.replayed &&
                    !ev.history) {
                    for (const ot of this.openTurns) {
                        if (ot === t || !ot.answeredAt)
                            continue;
                        if (sessBase && ot.sess && ot.sess !== sessBase)
                            continue;
                        if (now - ot.answeredAt < 3000)
                            return null;
                    }
                }
                break;
            }
            case "AGENT_CONFIRM": {
                // 待批准卡归属到当前开启轮：其 DONE 携带的 _ut 才能与 pendingConfirms
                // 的卡片 ut 对齐（bridge 按 ut 配对清理）；确认卡不视为「回答」。
                // hasConfirm 标记 parked 轮：被新 USER 取代时合成收尾 DONE 的依据。
                const t = this.openTurnForEvent(sessBase, TurnArbiter.tsOf(ev));
                if (t) {
                    t.hasConfirm = true;
                    if (!utKey)
                        utKey = t.utKey;
                }
                break;
            }
            case "AGENT_MESSAGE": {
                const { t, ownerUt } = this.turnForStreamEvent(sessBase, TurnArbiter.tsOf(ev), String(ev.streamId || ""));
                if (t && (!ownerUt || t.utKey === ownerUt))
                    t.sawStream = true;
                if (!utKey)
                    utKey = ownerUt || (t ? t.utKey : "");
                // 去重归属：_ut 自证优先（已答轮也能反查回自己的实例）；
                // 无 _ut 的才落到到达序最新未答轮。
                ownerTurn = utKey ? this.lastTurnWithUt(sessBase, utKey) ?? t : t;
                break;
            }
            case "COPILOT_DONE": {
                // 扩展自产的注入终态信号（inject_* reason）不是上游轮次事件——死注入
                // 路径上目标轮从未注册，过裁决会被 !doneTurn/!recentClose 判死整条丢，
                // 客户端永远收不到终态（实测空窗口死桥上 inject_soft_unverified 即被丢，
                // 其送达核验解除逻辑从未触发）。
                if (typeof ev.reason === "string" && ev.reason.startsWith("inject_"))
                    return ev;
                // requestIndex 负数是 Copilot 的「无归属」哨兵（裸答案 DONE 实测带 -1）——
                // 按无索引处理：否则 -1 < latestReqIdx 被误判陈旧 DONE，该轮释放信号整条丢。
                const reqIdx = typeof ev.requestIndex === "number" && ev.requestIndex >= 0
                    ? ev.requestIndex
                    : null;
                const doneTs = typeof ev.ts === "number" ? ev.ts : typeof ev.timestamp === "number" ? ev.timestamp : now;
                const immediate = ev.reason === "phone_stop" || ev.reason === "isCanceled";
                // 过期 DONE：归属旧轮次，不得释放当前在途状态。
                // staleByTs 与 reqIdx 解耦——各通道 requestIndex 编号域不同
                // （sessiondb 行号 / transcript turnSeq / chatSessions 请求序），
                // 跨通道的「同号」其实属于旧轮：ts 早于最近 live USER 即 stale，
                // 不论它带不带 requestIndex。
                const staleByIdx = reqIdx != null && this.latestReqIdx > reqIdx;
                const staleByTs = !immediate &&
                    Number.isFinite(doneTs) &&
                    doneTs + STALE_DONE_SKEW_MS < this.latestUserLiveTs;
                if (staleByIdx || staleByTs)
                    ev.stale = true;
                // 注入回执 DONE：发送后 ~2s 必到——特征不是「无 _ut」（回显带上戳后
                // 它也会带归属），而是「目标轮此刻还没见过任何流事件」。
                // 携 _ut 的对应到自己那轮；无 _ut 的对应最新未答轮。
                const doneTurn = utKey
                    ? this.openTurns.find((t) => !t.answered && t.utKey === utKey)
                    : this.newestOpenTurn(sessBase);
                if (!immediate &&
                    doneTurn &&
                    !doneTurn.sawStream &&
                    now - doneTurn.ts < INJECT_ACK_WINDOW_MS) {
                    ev.ack = true;
                }
                // 中间 DONE：归属轮仍在流式产出（见过流、未判答）时到达的 DONE 是
                // 工具步/子轮边界件而非本请求收尾——放行会让客户端拿它提前释放
                // 发送队列（R26：queued 消息在答案落线前 ~18s 逃逸上链），同时
                // markAnswered 会把轮错关、放走后续同类 DONE。直接丢。
                // reason==='result' 是请求级权威收尾，豁免；从未见过流的轮
                // （无流模型）其 turnSeq DONE 是唯一收尾件，也豁免。
                if (!immediate &&
                    ev.reason !== "result" &&
                    doneTurn &&
                    doneTurn.sawStream === true) {
                    ev.interim = true;
                    return null;
                }
                // 停止类 DONE：终止最新未答轮，记 closedUt 让客户端精确清条目
                const newest = this.newestOpenTurn(sessBase);
                if (immediate && !utKey && newest) {
                    ev.closedUt = newest.utKey;
                    this.markAnswered(sessBase, newest.utKey);
                }
                else if (utKey) {
                    this.markAnswered(sessBase, utKey);
                }
                // 无归属的普通 DONE 不妄关轮次——它可能属于更早的轮（迟到件），
                // 错关最新轮会让后续 ack 判定失去 openTurns 依据。
                // 判死 DONE：doneTurn 落空有两种——死件（轮早答/从未注册，
                // elapsedMs/迟到通道重投）与合法件（AGENT_MESSAGE 先行判答，
                // 本 DONE 就是它自己的收尾）。后者必须放行：客户端靠它释放
                // requestRunning、出队 pendingSendQueue；杀掉会把连发第二条
                // 卡死在队列里。只对「判答 ≤45s 内的同轮 DONE」放行。
                if (!immediate && !doneTurn) {
                    let recentClose = false;
                    for (let i = this.openTurns.length - 1; i >= 0; i--) {
                        const t = this.openTurns[i];
                        if (!t.answeredAt)
                            continue;
                        if (sessBase && t.sess && t.sess !== sessBase)
                            continue;
                        if (utKey && t.utKey !== utKey)
                            continue;
                        recentClose = now - t.answeredAt <= DONE_LATE_CLOSE_MS;
                        break;
                    }
                    if (!recentClose)
                        return null;
                }
                // 服务端判死的 DONE（stale/ack）不带任何可拼接信息（无 _ut/closedUt）
                // 时，根本没有投递价值——客户端只会拿它做释放判断且一律压制，
                // 广播出去反而多一条可被竞态利用的释放触发。直接丢。
                if (!immediate && (ev.stale === true || ev.ack === true))
                    return null;
                break;
            }
            default:
                break;
        }
        // 跨通道去重：AGENT_MESSAGE 与 TOOL_* 事件按指纹在窗口内只放行首发。
        // （USER 另有 recentUserEmits 文本窗去重——同题重问是合法行为，这里不拦。）
        const isTool = type.endsWith("TOOL_CALL") || type.endsWith("TOOL_RESULT");
        if (isTool) {
            // parked 轮（桌面确认挂起的工具）会被慢通道以 fresh ts 重投——
            // stale-ts 门拦不住 → 工具卡串进新轮 feed。toolId 级 5min 记忆：
            // 同 id 再投仅放行「向终态推进」的更新（isComplete/done），
            // 重复 running 帧直接丢。
            const tid = String(ev.toolId || ev.callId || ev.toolCallId || ev.id || "");
            if (tid) {
                const prev = this.emittedTools.get(`${sessBase}|${tid}`);
                if (prev) {
                    const advancing = (ev.isComplete === true || ev.status === "done" || ev.status === "completed") &&
                        !prev.done;
                    if (!advancing && now - prev.t < TOOL_REPROJ_MS)
                        return null;
                    if (advancing) {
                        prev.done = true;
                        prev.t = now;
                    }
                }
                if (!prev && markEmitted) {
                    this.emittedTools.set(`${sessBase}|${tid}`, {
                        t: now,
                        done: ev.isComplete === true || ev.status === "done" || ev.status === "completed",
                    });
                    if (this.emittedTools.size > 256) {
                        const cutoff = now - TOOL_REPROJ_MS;
                        for (const [k, v] of this.emittedTools)
                            if (v.t < cutoff)
                                this.emittedTools.delete(k);
                    }
                }
            }
        }
        if (type === "AGENT_MESSAGE" ||
            type === "AGENT_CONFIRM" ||
            type.endsWith("TOOL_CALL") ||
            type.endsWith("TOOL_RESULT")) {
            const key = this.contentKey(ev, sessBase, utKey);
            // AGENT_MESSAGE 再配一条「轮次+前缀」副指纹：sessiondb 位置型 streamId
            // （requests/N/）与实时流 id 不同，同一答文经异构 sid 双通道到会各渲一
            // 张卡片（R58 长答双渲）。同轮同前缀即重复，无论 sid 形态。
            // 副指纹按「轮次实例」判重而非 ut 文本：同一条答案经双通道重投，
            // 两副本都归同一个 TrackedTurn → 压；同题重问产生新轮，同文新答的
            // ownerTurn 不同 → 放行（R92：ut 键会把第二答当重投影吞掉）。
            const altKey = type === "AGENT_MESSAGE"
                ? `a2|${sessBase}|${normText(ev.text).slice(0, 80)}`
                : null;
            // AGENT_CONFIRM 用 30s 窗：吃双通道同刻重投，但不误杀数分钟后同文案的
            // 真实新一轮待批准（同窗口只在「真·同一张卡」上才误伤）。
            const window = type === "AGENT_MESSAGE"
                ? CONTENT_DEDUPE_MS
                : type === "AGENT_CONFIRM"
                    ? 30_000
                    : TOOL_DEDUPE_MS;
            const altPrev = altKey ? this.emittedA2.get(altKey) : undefined;
            // 幻影重投影纠偏（R20 BUG-4）：上轮答案经变体重投到达时被盖到新开启轮
            // 的 _ut 下——事件自证不了归属（无 requestIndex 或下标落后于已见最新），
            // 而同一文本在窗口内已投给别的轮实例。此时 _ut 拨回其真实归属轮：
            // a2 按轮次实例判重会把迟到的幻影自然吃掉。
            // 前提：事件自己没有权威 _ut（sessiondb 行带 r.user_message 是自证归属——
            // 同题重问的第二答_ut 相同但轮实例不同，拨回旧轮会把它误杀）。
            const evReqIdx = typeof ev.requestIndex === "number" ? ev.requestIndex : null;
            const unproven = evReqIdx == null || evReqIdx < this.latestReqIdx;
            const hadOwnUt = typeof ev._ut === "string" && normText(ev._ut) !== "";
            if (type === "AGENT_MESSAGE" &&
                unproven &&
                !hadOwnUt &&
                altPrev &&
                altPrev.turn != null &&
                ownerTurn !== altPrev.turn &&
                now - altPrev.t <= window) {
                utKey = altPrev.ut;
                ownerTurn = altPrev.turn;
            }
            const altDup = !!altPrev &&
                now - altPrev.t <= window &&
                (altPrev.turn === ownerTurn || (altPrev.turn == null && ownerTurn == null && altPrev.ut === utKey));
            // 再配一条「同文不同轮」指纹：旧轮答案经慢通道重投影时被盖上当轮的
            // _ut（openTurnForEvent 的 ts 门挡不住无 ts 的件），ut 不同但文本同。
            // 只在事件无法自证属于当前轮时启用（无 requestIndex 或下标落后）——
            // 否则同题重问拿到的同文新答会被误杀。
            // sessiondb 行不查 a3：行即轮次记录、user_message 即本题——同文答案
            // 落到不同行 = 不同轮的真实新答（R17：M17B 撞 M17A 文本指纹被杀，
            // 且 requestIndex 恒 -1 使 unproven 恒真 → 该通道永远无法自证）。
            // sessionDbEmittedIds + a|sid 键已挡同行重投，a3 对它只有误伤。
            const isSessionDb = String(ev.streamId || "").startsWith("sessiondb/");
            const reprojKey = type === "AGENT_MESSAGE" && utKey && unproven && !isSessionDb
                ? `a3|${sessBase}|${normText(ev.text).slice(0, 80)}`
                : null;
            const reprojUt = reprojKey ? this.emittedUt.get(reprojKey) : undefined;
            const reprojDup = reprojUt != null && reprojUt !== utKey;
            const isDup = (key && (this.emitted.get(key) ?? 0) && now - this.emitted.get(key) <= window) ||
                altDup ||
                reprojDup;
            if (isDup) {
                return null;
            }
            // 只在「真的会广播」时记名：离线排队/被后续闸丢弃的首发不算已投递，
            // 否则首份被吞、重发又被当重复——净丢一条消息。
            if (markEmitted) {
                if (key)
                    this.emitted.set(key, now);
                if (altKey)
                    this.emittedA2.set(altKey, { t: now, turn: ownerTurn, ut: utKey });
                if (reprojKey && utKey)
                    this.emittedUt.set(reprojKey, utKey);
            }
            if (type === "AGENT_MESSAGE")
                this.markAnswered(sessBase, utKey);
        }
        const out = { ...ev, _seq: ++this.seq };
        if (sessBase && !out._sess)
            out._sess = sessBase;
        else if (type === "USER_MESSAGE" && !out._sess && this.boundSess) {
            out._sess = this.boundSess;
        }
        if (utKey && !out._ut)
            out._ut = utKey;
        return out;
    }
}
exports.TurnArbiter = TurnArbiter;
//# sourceMappingURL=turnArbiter.js.map