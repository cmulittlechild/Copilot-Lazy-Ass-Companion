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
    /** a2 指纹（sess|前缀80）→ {t, 归属轮, ut}：轮次实例级同文去重。 */
    emittedA2 = new Map();
    /** 已 END 的 streamId → 终结时刻。END 后迟到的 START/CHUNK 服务端丢弃——
        否则客户端流卡已收尾又追加一遍（R64 双渲）且迟到帧会重新置 rr、
        把队列挂到看门狗（~135s 悬挂）。位置型 sid（requests/N/…）每轮唯一，
        60s 窗不会误伤下一轮。 */
    endedStreams = new Map();
    /** 会话切换/绑定变更时调用：清本轮状态，避免跨会话误杀。 */
    resetForSession(sessBase) {
        this.openTurns = [];
        this.latestUserLiveTs = 0;
        this.latestReqIdx = -1;
        // 位置型 streamId（requests/N/…）每个会话文件从 0 重新计数——换会话必须清
        this.endedStreams.clear();
        this.emittedUt.clear();
        this.emittedTools.clear();
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
        // 轮次归属键：服务端下发的 _ut 优先；否则归到最新未答轮
        let utKey = typeof ev._ut === "string" ? normText(ev._ut) : "";
        let ownerTurn;
        switch (type) {
            case "USER_MESSAGE": {
                const t = normText(ev.text);
                const reqIdx = typeof ev.requestIndex === "number" ? ev.requestIndex : null;
                if (reqIdx != null && reqIdx > this.latestReqIdx)
                    this.latestReqIdx = reqIdx;
                if (!ev.replayed && !ev.history)
                    this.latestUserLiveTs = Math.max(this.latestUserLiveTs, now);
                const turn = { utKey: t, ts: now, reqIdx, answered: false };
                turn.sess = sessBase;
                this.openTurns.push(turn);
                if (this.openTurns.length > MAX_TRACKED_TURNS)
                    this.openTurns.shift();
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
                const t = this.openTurnForEvent(sessBase, TurnArbiter.tsOf(ev));
                if (t) {
                    t.sawStream = true;
                    if (!utKey)
                        utKey = t.utKey;
                }
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
                const t = this.openTurnForEvent(sessBase, TurnArbiter.tsOf(ev));
                if (t) {
                    t.sawStream = true;
                    if (!utKey)
                        utKey = t.utKey;
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
                const t = this.openTurnForEvent(sessBase, evTs);
                if (t) {
                    t.sawStream = true;
                    if (!utKey)
                        utKey = t.utKey;
                }
                break;
            }
            case "AGENT_THINKING":
            case "THINKING_START":
            case "THINKING_END":
            case "COPILOT_TYPING": {
                const t = this.openTurnForEvent(sessBase, TurnArbiter.tsOf(ev));
                if (t) {
                    t.sawStream = true;
                    if (!utKey)
                        utKey = t.utKey;
                }
                break;
            }
            case "AGENT_MESSAGE": {
                const t = this.openTurnForEvent(sessBase, TurnArbiter.tsOf(ev));
                if (t) {
                    t.sawStream = true;
                    if (!utKey)
                        utKey = t.utKey;
                }
                // 去重归属：_ut 自证优先（已答轮也能反查回自己的实例）；
                // 无 _ut 的才落到到达序最新未答轮。
                ownerTurn = utKey ? this.lastTurnWithUt(sessBase, utKey) ?? t : t;
                break;
            }
            case "COPILOT_DONE": {
                const reqIdx = typeof ev.requestIndex === "number" ? ev.requestIndex : null;
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
        if (type === "AGENT_MESSAGE" || type.endsWith("TOOL_CALL") || type.endsWith("TOOL_RESULT")) {
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
            const window = type === "AGENT_MESSAGE" ? CONTENT_DEDUPE_MS : TOOL_DEDUPE_MS;
            const altPrev = altKey ? this.emittedA2.get(altKey) : undefined;
            const altDup = !!altPrev &&
                now - altPrev.t <= window &&
                (altPrev.turn === ownerTurn || (altPrev.turn == null && ownerTurn == null && altPrev.ut === utKey));
            // 再配一条「同文不同轮」指纹：旧轮答案经慢通道重投影时被盖上当轮的
            // _ut（openTurnForEvent 的 ts 门挡不住无 ts 的件），ut 不同但文本同。
            // 只在事件无法自证属于当前轮时启用（无 requestIndex 或下标落后）——
            // 否则同题重问拿到的同文新答会被误杀。
            const evReqIdx = typeof ev.requestIndex === "number" ? ev.requestIndex : null;
            const unproven = evReqIdx == null || evReqIdx < this.latestReqIdx;
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
            if (isDup)
                return null;
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
        if (utKey && !out._ut)
            out._ut = utKey;
        return out;
    }
}
exports.TurnArbiter = TurnArbiter;
//# sourceMappingURL=turnArbiter.js.map