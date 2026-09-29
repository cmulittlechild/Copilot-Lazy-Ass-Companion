"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const bridge_1 = require("./bridge");
const sessionWatcher_1 = require("./sessionWatcher");
const sessionIndex_1 = require("./sessionIndex");
const transcriptWatcher_1 = require("./transcriptWatcher");
const inject_1 = require("./inject");
const pathutil_1 = require("./pathutil");
const tunnel_1 = require("./tunnel");
const qrPanel_1 = require("./qrPanel");
const push_1 = require("./push");
const terminal_1 = require("./terminal");
const instances_1 = require("./instances");
const chatControl_1 = require("./chatControl");
const workspaceIndex_1 = require("./workspaceIndex");
let bridge;
let watcher;
let transcriptWatcher;
// 手机显式点选的会话 + 优先窗截止时间：窗内压制指向别会话的自动跟随，
// 防止在途会话写盘 newest 把绑定/页面拽回活动会话。被压制时顺延窗口。
const EXPLICIT_SELECT_GUARD_MS = 20000;
let lastExplicitSelect;
/** 被显式点选窗吞掉的最后一次 SESSION_FOLLOW：watcher 侧的 newest 转移检测
 *  只发一次，吞掉即永久丢失（PWA 滞留旧会话）。暂存后于窗口结束补发。 */
let pendingSuppressedFollow;
let suppressedFollowTimer;
/** 绑定（点选）会话最近一条可见事件的时间戳——sessionWatcher 只 tail 绑定文件 */
let boundSessionActivityAt = 0;
/** 当前绑定是否来自手机显式点选——只有点选来的绑定才有「活跃即续压」资格；
 *  桌面跟随绑定的会话若也享有活跃压制权，桌面端主动切会话会被延迟 ~90s */
let boundViaExplicitSelect = false;
/** 最近一次显式点选的时刻：跨向跟随须校验目标会话在此之后有真实用户
 *  活动（R22：被弃会话的在途轮持续写盘一直占 newest，「文件最新」是
 *  turn 写入假象而非用户回访）。 */
let lastExplicitSelectAt = 0;
/** 各会话最近一条 USER_MESSAGE 的时间戳（含别会话——sessiondb 全局轮询
 *  会投来所有会话的用户文，按 _sess 分记）。 */
const userActivityBySess = new Map();
/** 因零内容被跳过的跟随目标：该会话出现首个用户轮次时补发跟随 */
let pendingFollowFile;
// 挂空操作占位；tdir 存在时赋真实现（sessionWatcher 通道先建，引用需提前可解析）
let reevaluatePendingFollow = () => { };
let performSessionFollow = () => { };
/** PHONE_STOP 可能比注入请求的 USER 落盘还早（取消打在未开启的轮上=空操作，
 * 该轮照样跑完——实测 stop 比 USER 早 0.8s，答案仍全文到达）。
 * 若停止时最近注入文本的 USER 尚未注册上游，挂起停止；其 USER_MESSAGE 在
 * transcript 出现时（轮真正开启）补发一次取消。45s TTL。 */
let lastInjectedPhoneText = "";
let lastInjectedUserSeen = true;
let deferredPhoneStop;
/** 落盘核验的「活着」旁证：带 _ut 的事件按用户文本记时；任意 AGENT/TOOL/
 *  THINKING 事件记全局时刻——请求行要轮次完成才写盘（长作文轮全程缺席），
 *  纯查文件会把在途轮误报成未落盘（s1 实测 +45s 误火）。 */
const lastAgentUtAt = new Map();
let lastAnyAgentEventAt = 0;
/**
 * 目标 transcript 尾部是否存在「message.text === sentText 且 request.timestamp >= sinceTs」
 * 的请求条目（注入落盘核验：inject 宣称送达后定时复查——宣称路径已让手机端
 * 以为成功，真没落盘时必须事后补一句真话）。读不到文件/结构对不上时返回
 * true（保守不报警），同文历史请求靠 timestamp 下界区分不误判。
 */
function transcriptHasRequestSince(file, sentText, sinceTs) {
    try {
        const want = sentText.trim();
        const needle = JSON.stringify(want).slice(1, -1);
        if (!needle)
            return true;
        const st = fs.statSync(file);
        const size = Math.min(st.size, 768 * 1024);
        const fd = fs.openSync(file, "r");
        let hay;
        try {
            const buf = Buffer.alloc(size);
            fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
            hay = buf.toString("utf8");
        }
        finally {
            fs.closeSync(fd);
        }
        for (const line of hay.split("\n")) {
            if (!line.includes(needle))
                continue;
            try {
                const obj = JSON.parse(line);
                const reqs = Array.isArray(obj?.v)
                    ? obj.v
                    : Array.isArray(obj?.requests)
                        ? obj.requests
                        : [];
                for (const r of reqs) {
                    const t = r?.message;
                    const mt = typeof t?.text === "string" ? t.text : typeof t?.content?.[0]?.text === "string" ? t.content[0].text : "";
                    if (mt.trim() !== want)
                        continue;
                    const ts = Number(r?.timestamp || 0);
                    if (!ts || ts >= sinceTs)
                        return true;
                }
            }
            catch {
                // tail 截断的残行 parse 失败——needle 命中即视为已落盘（不报警）
                return true;
            }
        }
        return false;
    }
    catch {
        return true;
    }
}
/** 正文规范化（dedupe 用）：剥 markdown 强调+压空白+截断，与 transcriptWatcher.agentTextKey 同形 */
function replayTextKey(text) {
    return String(text || "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
}
/**
 * 把 sessiondb turns 里 chatSessions 尚未写盘的回答合回回放：
 * - 已在 hist 里的回答（按规范化文本键）跳过
 * - 缺失的回答插到其 user_message 对应的 USER_MESSAGE 之后；
 *   找不到对应用户文（sessiondb-only）则 USER+AGENT 一对追加到尾部
 */
function buildReplayWithDbBackfill(hist, dbTurns, sid) {
    const out = hist.filter(Boolean); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!dbTurns || !dbTurns.length || !sid)
        return out;
    const seen = new Set(out
        .filter((e) => e?.type === "AGENT_MESSAGE")
        .map((e) => replayTextKey(String(e.text || ""))));
    const tail = [];
    for (const r of dbTurns) {
        const ans = String(r.assistant_response || "").trim();
        if (!ans)
            continue;
        if (seen.has(replayTextKey(ans)))
            continue;
        const ev = {
            type: "AGENT_MESSAGE",
            text: ans,
            streamId: `sessiondb/${sid}/${r.id}`,
            requestIndex: -1,
            timestamp: Date.now(),
            _ut: r.user_message || undefined,
        };
        // 找该回答所属的用户消息位置：最后一个与该 user_message 同文的 USER_MESSAGE
        const uKey = replayTextKey(String(r.user_message || ""));
        let inserted = false;
        if (uKey) {
            for (let i = out.length - 1; i >= 0; i--) {
                const e = out[i];
                if (e?.type === "USER_MESSAGE" &&
                    replayTextKey(String(e.text || "")) === uKey) {
                    // 该轮到下一条 USER 之间已有助手回复（文件投影或先补全）→ 跳过。
                    // sessiondb 与文件投影的文本形态常异构（含/不含文件名引用等），
                    // 纯文本 key 去重会漏 → 同一条答案双投成相邻两块。
                    // 只认有正文的答：失败轮只剩 START+END 空流壳，生命周期标记不算已答。
                    let answered = false;
                    for (let j = i + 1; j < out.length; j++) {
                        const t = out[j]?.type;
                        if (t === "USER_MESSAGE")
                            break;
                        if (t === "AGENT_MESSAGE") {
                            answered = true;
                            break;
                        }
                        if ((t === "AGENT_STREAM_SET" || t === "AGENT_STREAM_CHUNK") &&
                            typeof out[j]?.text === "string" &&
                            String(out[j].text).trim().length > 0) {
                            answered = true;
                            break;
                        }
                    }
                    if (!answered)
                        out.splice(i + 1, 0, ev);
                    inserted = true;
                    break;
                }
            }
        }
        if (!inserted) {
            if (uKey) {
                tail.push({
                    type: "USER_MESSAGE",
                    text: String(r.user_message || ""),
                    timestamp: Date.now(),
                });
            }
            tail.push(ev);
        }
        seen.add(replayTextKey(ans));
    }
    return out.concat(tail);
}
function rebindTranscriptForSession(file) {
    if (!transcriptWatcher || !file)
        return;
    try {
        const base = path.basename(file);
        const rec = workspaceIndex?.resolveBySessionFile(file);
        const tdirForSession = rec?.transcriptsDir ?? transcriptDir();
        if (tdirForSession) {
            const tfile = path.join(tdirForSession, base);
            if (fs.existsSync(tfile)) {
                if (transcriptWatcher.currentFile === tfile) {
                    transcriptWatcher.pinFile(tfile);
                    transcriptActive = true;
                    return;
                }
                transcriptWatcher.bindFile(tfile, { replay: false });
                transcriptWatcher.pinFile(tfile);
                transcriptActive = true;
                return;
            }
        }
        transcriptActive = false;
        qrPanel.addLog(`会话 ${base} 无 transcripts（${rec?.qualifiedName ?? "未知工作区"}）→ 降级 chatSessions 源`);
        // 无 transcript 也要让 sessiondb 快通道跟上所选会话：轮询本身是全局的，
        // 但归属 sid/悬挂行补种需要同步，否则该会话的在途轮直播整段静默。
        transcriptWatcher?.noteSession(base);
    }
    catch {
        /* transcript rebind best-effort */
    }
}
let tunnel;
let terminalMgr;
let discovery;
/** 模型 / 审批级别控制（手机端选择器） */
let chatControl;
/** 工作区索引：让会话列表能显示「主机:文件夹」两级归属 */
let workspaceIndex;
/**
 * 当前选中会话是否由 transcripts 实时源供稿。
 * 为 false 时（如切到无 transcripts 的远程工作区）必须放行 chatSessions 投影，
 * 否则两个源都不出内容，手机端会一片空白。
 */
let transcriptActive = false;
let status;
let qrPanel;
let push;
/** In-memory session token when settings authToken empty but public tunnel needs auth. */
let sessionToken;
/** package.json version of this extension instance (not getExtension — avoids stale multi-version) */
let extensionVersion;
async function activate(context) {
    extensionVersion =
        context.extension.packageJSON?.version ||
            context.extension.packageJSON?.version ||
            undefined;
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.text = "$(phone) Lazy Ass: off";
    status.command = "copilotSidecar.showStatus";
    status.show();
    context.subscriptions.push(status);
    qrPanel = new qrPanel_1.QrPanelProvider();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(qrPanel_1.QrPanelProvider.viewType, qrPanel));
    const pwaDir = path.join(context.extensionPath, "media", "pwa");
    if (!fs.existsSync(path.join(pwaDir, "index.html"))) {
        vscode.window.showErrorMessage(`Lazy Ass PWA assets missing at ${pwaDir}. Reinstall the VSIX and Reload Window.`);
    }
    const start = async () => {
        if (bridge)
            return;
        const cfg = vscode.workspace.getConfiguration("copilotSidecar");
        const preferredPort = cfg.get("port", 3010);
        const host = cfg.get("host", "127.0.0.1");
        const settingsToken = (cfg.get("authToken", "") || "").trim();
        const enableTunnel = cfg.get("enableTunnel", false);
        const allowDownload = cfg.get("downloadCloudflared", true);
        const token = settingsToken || sessionToken || undefined;
        if (settingsToken)
            sessionToken = undefined;
        bridge = new bridge_1.BridgeServer({
            host,
            port: preferredPort,
            portRange: 20,
            authToken: token,
            pwaDir,
            onClientCount: (n) => {
                qrPanel.setPhoneConnected(n > 0);
                if (bridge) {
                    refreshStatus(bridge, !!(enableTunnel || tunnel?.running || tunnel));
                    writeChannelArtifact();
                }
            },
        });
        // 连接回放缺 USER 行时的完整回放源：回读当前会话 chatSessions + sessiondb 补全。
        // 会话文件源优先级：显式点选/跟随（activeSessionFile）→ chatSessions 当前绑定
        // → transcript 当前绑定同名映射（重启后 activeSessionFile 为空，必须落到后两者）。
        bridge.historyProvider = () => {
            let file = (0, inject_1.getActiveSessionFile)();
            if (!file || !fs.existsSync(file))
                file = watcher?.currentFile;
            const tFile = transcriptWatcher?.currentFile;
            if ((!file || !fs.existsSync(file)) && tFile) {
                const csdirP = (0, transcriptWatcher_1.findChatSessionsDir)(context.storageUri);
                if (csdirP) {
                    const cand = path.join(csdirP, path.basename(tFile));
                    if (fs.existsSync(cand))
                        file = cand;
                }
            }
            if (!file || !fs.existsSync(file))
                return undefined;
            let hist = watcher?.projectHistory(file, 40) ?? [];
            if (!hist.some((e) => e?.type === "USER_MESSAGE")) {
                // 冷启动/新建空会话：VS Code 会自动创建一个只有头部的空 chatSessions
                // 文件并成为全局 newest → watcher.currentFile 绑定到它 → 回放得到
                // 空历史，feed 只剩激活期/live 缓冲里杂讯（用户泡全丢）。
                // 回退到最近一条真正有用户轮次的会话。
                for (const s of watcher?.listSessions(20) ?? []) {
                    if (!s.file || (0, pathutil_1.samePath)(s.file, file))
                        continue;
                    if (s.requestCount === 0)
                        continue;
                    const alt = watcher?.projectHistory(s.file, 40) ?? [];
                    if (alt.some((e) => e?.type === "USER_MESSAGE")) {
                        file = s.file;
                        hist = alt;
                        break;
                    }
                }
            }
            if (!hist.length)
                return undefined;
            const sid = path.basename(file).replace(/\.jsonl$/i, "");
            const merged = buildReplayWithDbBackfill(hist, transcriptWatcher?.sessionDbRecentTurns(20, sid), sid);
            // 连接回放后播种 watcher 去重集合：激活/catch-up 迟到的整段重投影
            // （transcript tail、sessiondb 轮询、chatSessions rewrite）会在回放之后
            // 作为 live 事件再投一遍 → feed 尾部出现用户泡/答案堆叠副本。
            transcriptWatcher?.seedFromHistory(merged);
            // 把 file/title 一起回传：重连回放若不带 file，客户端
            // currentSessionMeta.file 一直为空——_sess 过滤、待发补画、
            // 未送达校验全部失效（实测杀进程重连后发送记录 sess=''，
            // 泡既不补画也不报未送达，静默消失）。
            const rTitle = watcher
                ?.listSessions(40)
                .find((s) => s.file === file || (s.file && (0, pathutil_1.samePath)(s.file, file)))?.title;
            return { events: merged, file, title: rTitle };
        };
        push = new push_1.PushManager(context.globalState);
        bridge.setPushManager?.(push);
        bridge.onPhoneMessage(async (msg) => {
            try {
                if (msg.type === "PHONE_MESSAGE" && typeof msg.text === "string") {
                    const cfg = vscode.workspace.getConfiguration("companion");
                    const mode = msg.mode || cfg.get("defaultMode", "agent");
                    // 手机可附带 file：防止 activeSessionFile 丢失/多窗口错乱时打到错误会话
                    if (typeof msg.file === "string" && msg.file.trim()) {
                        const file = msg.file.trim();
                        (0, inject_1.setActiveSessionFile)(file);
                        try {
                            watcher?.selectSession(file);
                        }
                        catch {
                            /* select best-effort */
                        }
                        // 0.5.27：发送前强制 rebind/pin 目标会话 transcript
                        rebindTranscriptForSession(file);
                    }
                    // 0.5.28：transcript 文件可能 stale，先登记 pending，等 chatSessions gap-fill
                    if (transcriptWatcher && typeof msg.text === "string") {
                        transcriptWatcher.addPendingPhoneUserText(msg.text);
                    }
                    // 新发即解除挂起停止：用户重新提问表示想要这个轮（同文重问亦然）
                    lastInjectedPhoneText = String(msg.text).trim();
                    lastInjectedUserSeen = false;
                    deferredPhoneStop = undefined;
                    // noteInjectedText is called inside injectMessage; bridge also remembers
                    // PHONE_MESSAGE text so sendToPhone can drop JSONL USER_MESSAGE echo.
                    // USER_MESSAGE 已由 bridge.acceptPhoneUserMessage 广播；这里只推 typing 态。
                    bridge?.broadcast({ type: "COPILOT_TYPING" });
                    const result = await (0, inject_1.injectMessage)(msg.text, mode);
                    try {
                        const leak = result.leakFile
                            ? path.basename(String(result.leakFile))
                            : "-";
                        qrPanel.addLog(`inject via=${result.injectPath || result.via} sid=${result.sessionId || "-"} activated=${!!result.sessionActivated} openVia=${result.openVia || "-"} verified=${result.verified === undefined ? "-" : result.verified} leak=${leak}`);
                    }
                    catch {
                        /* ignore */
                    }
                    // soft-unverified：已 submit 且无串台证据，落盘可能延迟 — 不吓用户去粘贴双发
                    if (String(result.injectPath || "").includes("soft-unverified")) {
                        bridge?.broadcast({
                            type: "SYSTEM_MESSAGE",
                            text: "已提交到目标会话（落盘确认稍慢，若桌面未出现再重试）",
                        });
                        bridge?.broadcast({ type: "COPILOT_DONE", reason: "inject_soft_unverified" });
                    }
                    else if (result.injectPath === "bind+chat.open+leak-warning") {
                        bridge?.broadcast({
                            type: "SYSTEM_MESSAGE",
                            text: "警告：目标会话已写入，但其它会话也检测到相同文本，请核对桌面 Chat",
                        });
                    }
                    // 商业化：clipboard → 明确告诉手机；verified 成功保持安静
                    if (result.via === "clipboard") {
                        const reason = String(result.injectPath || "clipboard");
                        bridge?.broadcast({
                            type: "SYSTEM_MESSAGE",
                            // injectFailed：终态注入失败（该会话绝不会再产出本轮内容）——
                            // 客户端据此销掉待答条目并回填原文。DONE 走裁决器会被判
                            // inject-ack 丢弃，终态信号只能搭 SYSTEM_MESSAGE。
                            injectFailed: String(msg.text || ""),
                            text: reason.includes("cross-session-leak")
                                ? "注入未确认目标会话（检测到可能串台），消息已复制到剪贴板，请在正确 Chat 粘贴"
                                : reason.includes("unverified")
                                    ? "注入未能确认目标会话，消息已复制到剪贴板（请打开手机选中的会话后粘贴）"
                                    : reason.includes("bind-failed")
                                        ? "无法打开目标会话，消息已复制到剪贴板"
                                        : "已复制到剪贴板（未能安全注入目标会话，请在 Chat 粘贴发送）",
                        });
                        // 结束手机端 typing，避免一直转圈
                        bridge?.broadcast({ type: "COPILOT_DONE", reason: "inject_clipboard" });
                    }
                    else if (result.verified === false &&
                        !/soft-unverified|leak-warning/.test(String(result.injectPath || ""))) {
                        // soft-unverified/leak-warning 已在上方链给过提示；避免同一次注入既「已提交」又「警告」。
                        bridge?.broadcast({
                            type: "SYSTEM_MESSAGE",
                            // 与 clipboard 同：verified=false = 未确认写入目标会话，本会话
                            // 绝不会再产出本轮——客户端销待答条目并回填。
                            injectFailed: String(msg.text || ""),
                            text: "警告：注入未通过目标会话校验，请核对桌面 Chat 是否为手机所选会话",
                        });
                        // 0.5.27：结束手机 typing，避免发送失败后一直显示“正在输入”
                        bridge?.broadcast({ type: "COPILOT_DONE", reason: "inject_verified_false" });
                    }
                    else if (result.leakFile) {
                        bridge?.broadcast({
                            type: "SYSTEM_MESSAGE",
                            text: `警告：目标会话已写入，但另一会话也出现相同文本（${path.basename(String(result.leakFile))}）`,
                        });
                    }
                    // 落盘核验：宣称送达后 45s 内目标 transcript 仍未多出该请求 → 注入
                    // 实际未落盘（window reload 期 chat 管道打空——桥回声已让手机端以为
                    // 成功，实测消息静默蒸发且无提示）。补一句真话并让手机回填原文。
                    // 45s 留足重载后的懒写盘余量（实测请求行 +20s 才进文件）。
                    // clipboard / verified_false 路径已当场告警，不再重复查。
                    {
                        const sentTextNow = String(msg.text || "").trim();
                        const targetFile = typeof msg.file === "string" ? msg.file.trim() : "";
                        const claimedDelivery = result.via !== "clipboard" && result.verified !== false;
                        if (sentTextNow && targetFile && claimedDelivery) {
                            const sendAt = Date.now() - 15000; // 慢注入窗内的请求 ts 早于此刻一定算旧轮
                            setTimeout(() => {
                                try {
                                    // 三重门：请求行缺席 AND 该文本无任何 _ut 活动 AND 全局无 agent
                                    // 活动——后两者覆盖「行只在轮末写盘」的在途轮（长答全程行缺席）。
                                    const utSeen = (lastAgentUtAt.get(sentTextNow) || 0) >= sendAt;
                                    const anyAgent = lastAnyAgentEventAt >= sendAt;
                                    if (!utSeen &&
                                        !anyAgent &&
                                        !transcriptHasRequestSince(targetFile, sentTextNow, sendAt)) {
                                        qrPanel?.addLog(`inject not persisted: ${sentTextNow.slice(0, 60)}`);
                                        bridge?.broadcast({
                                            type: "SYSTEM_MESSAGE",
                                            text: "发送未落盘到目标会话（可能赶上 VS Code 重载），原文已回填，请重新发送",
                                            notPersisted: sentTextNow,
                                        });
                                        bridge?.broadcast({
                                            type: "COPILOT_DONE",
                                            reason: "inject_not_persisted",
                                        });
                                    }
                                }
                                catch {
                                    /* best-effort */
                                }
                            }, 45000);
                        }
                    }
                }
                else if (msg.type === "PHONE_STOP") {
                    const result = await (0, inject_1.cancelChatRequest)();
                    if (!result.ok) {
                        bridge?.broadcast({
                            type: "SYSTEM_MESSAGE",
                            text: `停止失败: ${result.error || "no cancel command"}`,
                        });
                    }
                    else {
                        // 本地立即收尾 typing；transcript 随后的 turn_end 还会再发 COPILOT_DONE
                        bridge?.broadcast({ type: "COPILOT_DONE", reason: "phone_stop" });
                        // 停止早于注入 USER 落盘：请求还在注入管道里、取消打空——挂起，
                        // 该文本的 USER_MESSAGE 出现时补发取消（见 handleTranscriptWatcherEvent）。
                        if (!lastInjectedUserSeen && lastInjectedPhoneText) {
                            deferredPhoneStop = { text: lastInjectedPhoneText, at: Date.now() };
                            qrPanel.addLog(`deferred stop armed: ${lastInjectedPhoneText.slice(0, 50)}`);
                        }
                    }
                }
                else if (msg.type === "PHONE_CONFIRM") {
                    await (0, inject_1.handleConfirmation)(String(msg.button || ""));
                    bridge?.broadcast({
                        type: "SYSTEM_MESSAGE",
                        text: `确认已处理: ${msg.button || ""}`,
                    });
                }
            }
            catch (e) {
                vscode.window.showErrorMessage(`Lazy Ass inject failed: ${e?.message || e}`);
                bridge?.broadcast({ type: "SYSTEM_MESSAGE", text: `inject failed: ${e?.message || e}` });
            }
        });
        await bridge.start();
        qrPanel.addLog(`Lazy Ass version ${extensionVersion || "?"} port ${bridge.port}`);
        if (bridge.port !== preferredPort) {
            qrPanel.addLog(`port ${preferredPort} busy → using ${bridge.port}`);
            vscode.window.showInformationMessage(`Lazy Ass port ${preferredPort} busy, using ${bridge.port}`);
        }
        // 终端管理 + 多实例发现（参考 copilot-remote 的 TerminalManager / InstanceDiscovery）
        terminalMgr = new terminal_1.TerminalManager((line) => qrPanel.addLog(line));
        discovery = new instances_1.InstanceDiscovery({
            // 扫描必须锚规范基端口而非本实例实绑端口：端口被占时桥会自增
            // 绑定（3010 忙→3011→3012…），若从实绑端口起扫，后起的实例永远
            // 看不到排在自己前面的实例（3012 扫 3012..3032 → 列表恒空）。
            basePort: bridge.preferredListenPort,
            authToken: bridge.getAuthToken() || undefined,
            log: (line) => qrPanel.addLog(line),
        });
        // 工作区索引（借鉴 paseo 的 Project→Workspace→Session 分层）：
        // 扫 workspaceStorage/*/workspace.json 建立「hash → 主机:文件夹」反向映射，
        // 让手机端会话列表能按工作区分组，解决「不知道哪个会话属于哪个文件夹」。
        workspaceIndex = new workspaceIndex_1.WorkspaceIndex({ log: (line) => qrPanel.addLog(line) });
        try {
            const wsAll = workspaceIndex.scan();
            const withSessions = wsAll.filter((w) => w.sessionCount > 0).length;
            qrPanel.addLog(`工作区索引: ${wsAll.length} 个（含会话 ${withSessions} 个，远程 ${wsAll.filter((w) => w.isRemote).length} 个）`);
        }
        catch (e) {
            qrPanel.addLog(`工作区索引扫描失败: ${e?.message || e}`);
        }
        // 模型 / 审批级别控制：手机端可选模型与「默认审批 / 绕过审批 / autopilot」
        chatControl = new chatControl_1.ChatControl({ log: (line) => qrPanel.addLog(line) });
        // 模型列表变化时推给手机端刷新
        try {
            context.subscriptions.push(chatControl.onModelsChanged(() => {
                void chatControl?.listModels().then((models) => {
                    bridge?.broadcast({ type: "MODEL_LIST", models, timestamp: Date.now() });
                });
            }));
        }
        catch {
            /* onDidChangeChatModels 不可用时忽略 */
        }
        // 桌面端切模型 → 手机同步：onDidChangeChatModels 只管模型集变更，不管选中项。
        // 轮询面板实际选中（chat.currentLanguageModel.panel，sqlite 读开销小），
        // 变化时推 MODEL_LIST（isCurrent 已按面板真实选中标记）。
        let lastPanelModelId = chatControl.peekPanelModelId();
        const panelModelPoll = setInterval(() => {
            const cur = chatControl?.peekPanelModelId();
            if (cur && cur !== lastPanelModelId) {
                lastPanelModelId = cur;
                void chatControl?.listModels().then((models) => {
                    bridge?.broadcast({ type: "MODEL_LIST", models, timestamp: Date.now() });
                });
            }
        }, 2000);
        context.subscriptions.push(new vscode.Disposable(() => clearInterval(panelModelPoll)));
        bridge.onRequest(async (msg, reply) => {
            switch (msg?.type) {
                case "PHONE_SESSION_LIST": {
                    const sessions = watcher?.listSessions(40) ?? [];
                    reply({ type: "SESSION_LIST", sessions, timestamp: Date.now() });
                    break;
                }
                case "PHONE_SESSION_SELECT": {
                    const file = typeof msg.file === "string" ? msg.file : "";
                    const ok = watcher?.selectSession(file) ?? false;
                    // 显式点选开窗：窗口内压制指向别会话的自动跟随（见 SESSION_FOLLOW 处）。
                    if (ok && file) {
                        lastExplicitSelect = { file, until: Date.now() + EXPLICIT_SELECT_GUARD_MS };
                        pendingFollowFile = undefined;
                        lastExplicitSelectAt = Date.now();
                        // 点选本身即算绑定会话活跃：inject 驱动桌面切换要 ~20-24s，期间
                        // 目标会话还无写盘事件，boundSessionActivityAt=0 会让 boundHot 恒假
                        // → 守卫窗外一条迟到的旧会话跟随就把手机拽回（R18 拉锯×3 根因）。
                        boundSessionActivityAt = Date.now();
                        boundViaExplicitSelect = true;
                    }
                    // 记录选中会话：后续 PHONE_MESSAGE 注入必须先切到该会话，
                    // 否则 workbench.action.chat.open 只会打到 VS Code 当前活跃会话。
                    if (ok && file)
                        (0, inject_1.setActiveSessionFile)(file);
                    // 联动实时数据源：切到对应 transcript 文件。
                    // 关键：目标会话可能属于**其他工作区**（含 SSH 远程），因此用工作区索引
                    // 反查该会话所属工作区的 transcripts 目录，而不是固定用当前窗口的目录。
                    //
                    // 历史回放只走 projectHistory → replaySession（单通道）。
                    // 这里 bindFile **禁止 replay**——否则 transcripts 再投一轮最近 user turns，
                    // 与 HISTORY_REPLAY 叠加，手机端会从头滑到尾（双重洪水）。
                    if (ok && file) {
                        // 先播种再 rebind：seedFromHistory 会把种子记入 pendingSeed，
                        // bindFile 内部 resetState/bindFallback 清空去重集合后在收尾处重放，
                        // 否则清集合发生在播种之后、种子被冲掉，旧轮次会被当实时消息洪水重放。
                        const hist = watcher?.projectHistory(file, 20) ?? [];
                        transcriptWatcher?.seedFromHistory(hist);
                        rebindTranscriptForSession(file);
                    }
                    // 附带真实标题：客户端 SESSION_SELECTED 若拿不到 title 会回退到
                    // currentSessionMeta.title（旧会话名）造成标题滞留。
                    const selTitle = ok
                        ? watcher
                            ?.listSessions(40)
                            .find((s) => s.file === file || path.basename(String(s.file || "")) === path.basename(file))
                            ?.title
                        : undefined;
                    reply({ type: "SESSION_SELECTED", file, ok, title: selTitle, timestamp: Date.now() });
                    if (ok) {
                        // 完整同步：回放该会话历史 + sessiondb 补全 chatSessions 尚未写盘的回答
                        // （HISTORY_REPLAY 瞬时渲染，不走打字机，不会有滑到尾的动画洪水）。
                        const sidSel = path.basename(file).replace(/\.jsonl$/i, "");
                        const merged = buildReplayWithDbBackfill(ok && file ? (watcher?.projectHistory(file, 20) ?? []) : [], transcriptWatcher?.sessionDbRecentTurns(20, sidSel), sidSel);
                        transcriptWatcher?.seedFromHistory(merged.filter((e) => e.streamId?.startsWith("sessiondb/")));
                        bridge?.replaySession([
                            ...merged,
                            {
                                type: "SYSTEM_MESSAGE",
                                text: `已切换到会话: ${path.basename(file)}`,
                            },
                        ], file, selTitle, 
                        // 用户显式点选：客户端已清空 feed，回放必须送达——跳过
                        // replaySession 的 5s 同文件节流（连点切回同会话不得吞掉回放）。
                        true);
                    }
                    break;
                }
                case "PHONE_TERMINAL_LIST": {
                    reply({ type: "TERMINAL_LIST", terminals: terminalMgr?.listTerminals() ?? [], timestamp: Date.now() });
                    break;
                }
                case "PHONE_TERMINAL_EXEC": {
                    const command = typeof msg.command === "string" ? msg.command : "";
                    const terminalId = typeof msg.terminalId === "string" ? msg.terminalId : undefined;
                    const result = await terminalMgr?.execute(command, terminalId);
                    const termName = (terminalId && terminalMgr?.listTerminals().find((t) => t.id === terminalId)?.name) ||
                        (terminalId ? terminalId : undefined);
                    reply({
                        type: "TERMINAL_OUTPUT",
                        terminalId: terminalId ?? null,
                        name: termName,
                        content: result?.content ?? "",
                        exitCode: result?.exitCode,
                        ok: result?.ok ?? false,
                        error: result?.error,
                        timestamp: Date.now(),
                    });
                    break;
                }
                case "PHONE_INSTANCE_STATUS": {
                    reply({
                        type: "INSTANCE_STATUS",
                        instanceId: (0, instances_1.makeInstanceId)(),
                        workspaceName: vscode.workspace.name || "untitled",
                        host: bridge?.host === "0.0.0.0" ? "127.0.0.1" : bridge?.host,
                        port: bridge?.port,
                        isPrimary: bridge?.port === preferredPort,
                        pid: process.pid,
                        timestamp: Date.now(),
                    });
                    break;
                }
                case "PHONE_INSTANCE_LIST": {
                    // 扫描端口范围发现其他窗口的 companion bridge 实例
                    const list = discovery ? await discovery.scan() : [];
                    reply({ type: "INSTANCE_LIST", instances: list, timestamp: Date.now() });
                    break;
                }
                case "PHONE_MODEL_LIST": {
                    const models = (await chatControl?.listModels()) ?? [];
                    reply({ type: "MODEL_LIST", models, timestamp: Date.now() });
                    break;
                }
                case "PHONE_MODEL_SELECT": {
                    const id = typeof msg.id === "string" ? msg.id : "";
                    const r = await chatControl?.selectModel({
                        id,
                        vendor: typeof msg.vendor === "string" ? msg.vendor : undefined,
                        family: typeof msg.family === "string" ? msg.family : undefined,
                    });
                    reply({
                        type: "MODEL_SELECTED",
                        ok: r?.ok ?? false,
                        id,
                        error: r?.error ?? (chatControl ? undefined : "模型控制未就绪"),
                        timestamp: Date.now(),
                    });
                    break;
                }
                case "PHONE_PERMISSION_LIST": {
                    const levels = chatControl?.listPermissionLevels() ?? [];
                    const current = chatControl?.currentPermissionLevel() ?? "default";
                    reply({ type: "PERMISSION_LIST", levels, current, timestamp: Date.now() });
                    break;
                }
                case "PHONE_PERMISSION_SET": {
                    const level = String(msg.level || "default");
                    const r = await chatControl?.setPermissionLevel(level, {
                        persist: msg.persist === true,
                    });
                    reply({
                        type: "PERMISSION_SET",
                        ok: r?.ok ?? false,
                        level,
                        error: r?.error ?? (chatControl ? undefined : "审批控制未就绪"),
                        notice: r?.notice,
                        timestamp: Date.now(),
                    });
                    break;
                }
                default:
                    break;
            }
        });
        const sessDiscovery = (0, sessionWatcher_1.sessionDiscoveryFromExtension)(context.storageUri, context.globalStorageUri);
        const useTranscript = cfg.get("preferTranscript", true);
        const tdir = useTranscript ? (0, transcriptWatcher_1.findTranscriptsDir)(context.storageUri) : undefined;
        _transcriptDir = tdir;
        if (useTranscript && !tdir) {
            qrPanel.addLog("transcripts 目录未找到，回退 chatSessions 数据源");
        }
        // 会话标题权威源：state.vscdb ChatSessionStore.index（与官方侧栏同源）
        // storageUri 形如 workspaceStorage/<hash>/<extensionId>，
        // 因此 workspace 根 = dirname(storageUri)（一次即可；两次会跑到 workspaceStorage 根，读错库）。
        let sessionIndex;
        let currentWorkspaceHash;
        try {
            if (context.storageUri?.fsPath) {
                const wsRoot = path.dirname(context.storageUri.fsPath);
                currentWorkspaceHash = path.basename(wsRoot);
                const vscdb = (0, sessionIndex_1.deriveVscdbPath)(wsRoot);
                if (fs.existsSync(vscdb)) {
                    sessionIndex = new sessionIndex_1.SessionIndexReader({ vscdbPath: vscdb, log: (l) => qrPanel.addLog(l) });
                    const n = sessionIndex.readAll().length;
                    qrPanel.addLog(`会话索引: ${vscdb}（${n} 条）`);
                }
                else {
                    qrPanel.addLog(`会话索引未找到: ${vscdb}`);
                }
            }
        }
        catch (e) {
            sessionIndex = undefined;
            qrPanel.addLog(`会话索引加载失败: ${e?.message || e}`);
        }
        watcher = new sessionWatcher_1.SessionWatcher({
            pollMs: cfg.get("pollMs", 50),
            rescanMs: cfg.get("sessionRescanMs", 2000),
            liveOnly: cfg.get("liveOnly", true),
            preferChatSessionDirs: sessDiscovery.preferChatSessionDirs,
            roots: sessDiscovery.roots,
            sessionIndex,
            workspaceIndex,
            currentWorkspaceHash,
            onEvent: (ev) => {
                // 各会话用户活动打点：事件 _sess 优先，无戳用绑定文件（本 watcher
                // 只 tail 绑定文件，事件必然属于该会话）。
                if (ev.type === "USER_MESSAGE") {
                    const us = (String(ev._sess || "") ||
                        (watcher?.currentFile ? path.basename(watcher.currentFile) : "")).replace(/\.jsonl$/i, "");
                    if (us)
                        userActivityBySess.set(us, Date.now());
                }
                if (ev.type === "USER_MESSAGE" &&
                    typeof ev.text === "string" &&
                    (0, inject_1.isInjectedEcho)(ev.text)) {
                    return;
                }
                // 绑定会话活动打点：sessionWatcher 只 tail 绑定文件，其可见事件即
                // 「所选会话仍在被使用」的信号（跟随拉锯评估用）。
                if (ev.type === "USER_MESSAGE" ||
                    ev.type === "AGENT_MESSAGE" ||
                    ev.type === "AGENT_STREAM_SET" ||
                    ev.type === "AGENT_STREAM_CHUNK" ||
                    ev.type === "COPILOT_DONE") {
                    boundSessionActivityAt = Date.now();
                }
                // chatSessions 通道的 USER 事件同样是 pending-follow 的内容信号——
                // 空会话首次写盘常只走此通道，不挂这里补发永远不触发。
                if (pendingFollowFile && ev.type === "USER_MESSAGE") {
                    reevaluatePendingFollow();
                }
                // Watching session is internal chrome — update artifact only, never phone feed.
                if (ev.type === "SYSTEM_MESSAGE" &&
                    (String(ev.text || "").startsWith("Watching session:") ||
                        ev.visibility === "internal" ||
                        ev.internal === true)) {
                    writeChannelArtifact();
                    return;
                }
                // 实时源优先：仅当当前会话确实由 transcripts 供稿时才抑制 chatSessions，
                // 避免切到无 transcripts 的（远程）工作区后两边都不出内容。
                //
                // 关键例外：USER_MESSAGE 必须放行 —— 用户可能在「别的」会话/文件里
                // 直接从 Copilot 插件发消息，而 transcripts 源只 tail 当前选中的单个文件，
                // 若 gate 住 chatSessions 的 USER_MESSAGE，桌面→手机的消息就全丢了。
                // （assistant 侧仍被 gate 拦，避免双渲染；手机注入回声由 isInjectedEcho 拦。）
                // USER_MESSAGE 双源重复由 bridge.sendToPhone 的时间窗去重处理
                // （gate 会矫枉过正：transcripts 静默时唯一来源被吞 → 零气泡）。
                if (transcriptActive && ev.type !== "USER_MESSAGE")
                    return;
                if (bridge?.sendToPhone)
                    bridge.sendToPhone(ev);
                else
                    bridge?.broadcast(ev);
            },
        });
        watcher.start();
        // 毫秒级实时事件流（transcripts）：主内容源，替代 chatSessions 60s 落盘投影
        if (tdir) {
            // chatSessions 兜底源：transcripts 偶尔漏写 assistant 回复（如简短问候），从 chatSessions 补全
            const csdir = (0, transcriptWatcher_1.findChatSessionsDir)(context.storageUri);
            // session-store.db 快速兜底：Copilot 新版 turns 行响应完成即落库，远快于 chatSessions 落盘
            const sessionStoreDb = path.join(path.dirname(context.globalStorageUri.fsPath), "github.copilot-chat", "session-store.db");
            // 执行一次会话跟随：SESSION_SELECTED（PWA 清 feed+标题）+ db 回填回放。
            // 供 SESSION_FOLLOW 事件与 pendingFollowFile 补发共用。
            performSessionFollow = (csFile, base) => {
                // 跨向跟随的用户活动门（R22 残余拉锯）：点选之后目标会话没有新
                // USER_MESSAGE = 用户在桌面并未回访它——其 newest 地位只是被弃会话
                // 在途轮的写盘假象，丢弃而非拽回。同一方向/无点选绑定不设此门。
                const boundF = lastExplicitSelect?.file || (0, inject_1.getActiveSessionFile)();
                const boundB = boundF ? path.basename(boundF).replace(/\.jsonl$/i, "") : "";
                const targetB = base.replace(/\.jsonl$/i, "");
                if (boundViaExplicitSelect &&
                    boundB &&
                    targetB &&
                    boundB !== targetB &&
                    (userActivityBySess.get(targetB) ?? 0) <= lastExplicitSelectAt) {
                    qrPanel.addLog(`SESSION_FOLLOW 丢弃: 点选后目标无用户活动 ${targetB}`);
                    return;
                }
                const hist = watcher?.projectHistory(csFile, 20) ?? [];
                const sidForDb = base ? base.replace(/\.jsonl$/, "") : "";
                const dbTurns = transcriptWatcher?.sessionDbRecentTurns(20, sidForDb) ?? [];
                const histUsers = hist.filter((e) => e?.type === "USER_MESSAGE").length;
                const dbUsers = dbTurns.filter((t) => t.user_message).length;
                // 空闲期漂移防护：新建的零内容会话文件曾触发跟随把 PWA 绑走、feed 清空——
                // 目标会话还没有任何用户轮次时不跟随，记下 pending 待有内容后补发。
                if (!histUsers && !dbUsers) {
                    qrPanel.addLog(`SESSION_FOLLOW 跳过: 目标会话无用户消息 ${base}`);
                    pendingFollowFile = csFile;
                    return;
                }
                pendingFollowFile = undefined;
                // 同一方向的跟随（所选会话本身）不得清点选绑定标记——否则 +3s 的
                // 补发跟随会提前解除 90s boundHot 保护，被弃会话的在途轮随后把
                // 手机拽走（R22 拉锯根因一）。真换向的跟随照常解除。
                const boundF2 = lastExplicitSelect?.file || (0, inject_1.getActiveSessionFile)();
                if (!boundF2 || !(0, pathutil_1.samePath)(csFile, boundF2))
                    boundViaExplicitSelect = false;
                (0, inject_1.setActiveSessionFile)(csFile);
                watcher?.selectSession(csFile);
                transcriptWatcher?.seedFromHistory(hist);
                const title = watcher
                    ?.listSessions(40)
                    .find((s) => s.file === csFile || (base && path.basename(String(s.file || "")) === base))
                    ?.title || undefined;
                bridge?.broadcast({
                    type: "SESSION_SELECTED",
                    file: csFile,
                    ok: true,
                    title,
                    timestamp: Date.now(),
                });
                // 合并 db 补全：chatSessions 尚未写盘的回答（含中间轮次）按用户文位置插回回放
                const mergedHist = buildReplayWithDbBackfill(hist, dbTurns, sidForDb);
                transcriptWatcher?.seedFromHistory(mergedHist.filter((e) => e.streamId?.startsWith("sessiondb/")));
                bridge?.replaySession([
                    ...mergedHist,
                    {
                        type: "SYSTEM_MESSAGE",
                        text: `已切换到会话: ${base}`,
                    },
                ], csFile, title);
            };
            // 被跳过的空会话出现首个用户轮次后补跟随：两条事件通道任一到达内容事件即重评估。
            reevaluatePendingFollow = () => {
                const pf = pendingFollowFile;
                if (!pf)
                    return;
                const pfBase = path.basename(pf).replace(/\.jsonl$/i, "");
                const pfHist = watcher?.projectHistory(pf, 5) ?? [];
                const pfDb = transcriptWatcher?.sessionDbRecentTurns(5, pfBase) ?? [];
                if (!pfHist.some((e) => e?.type === "USER_MESSAGE") &&
                    !pfDb.some((t) => t.user_message)) {
                    return;
                }
                qrPanel.addLog(`SESSION_FOLLOW 补发: ${pfBase} 已有内容`);
                performSessionFollow(pf, pfBase);
            };
            // 兜底轮询：pending 会话的文件若未被任一 watcher tail（如新文件未成为
            // newest），其写入不产生事件，靠 3s 轮询补发跟随；只在有 pending 时做事。
            const pendingPoll = setInterval(() => {
                if (pendingFollowFile)
                    reevaluatePendingFollow();
            }, 3000);
            context.subscriptions.push({ dispose: () => clearInterval(pendingPoll) });
            transcriptWatcher = new transcriptWatcher_1.TranscriptWatcher({
                dir: tdir,
                chatSessionsDir: csdir,
                // 路径恒传入、不做激活期 existsSync 门槛：Copilot 常在扩展激活之后才
                // 创建 session-store.db（登录/首个会话触发），一次性判定会让 turns
                // 快速通道永久失效。文件不存在时由 openSessionDb 惰性探测返回 null。
                sessionStoreDb,
                pollMs: Math.max(10, cfg.get("pollMs", 50)),
                onLog: (line) => qrPanel.addLog(line),
                // 具名函数表达式：压制窗口补发路径需要重入本 handler（见 SESSION_FOLLOW 压制分支）
                // 返回 sendToPhone 的投递结果：false = 事件在桥端被丢（回声/去重/仲裁），
                // watcher 据此不记「已投」——否则后续通道的同答案会被误判重投影而净丢。
                onEvent: function handleTranscriptWatcherEvent(ev) {
                    // 落盘核验旁证打点（见 lastAgentUtAt 注释）
                    if (/^(AGENT|TOOL|THINKING)/.test(String(ev.type || ""))) {
                        lastAnyAgentEventAt = Date.now();
                    }
                    {
                        const evUt = typeof ev._ut === "string" ? String(ev._ut).trim() : "";
                        if (evUt)
                            lastAgentUtAt.set(evUt, Date.now());
                    }
                    if (ev.type === "USER_MESSAGE" && typeof ev.text === "string") {
                        // 各会话用户活动打点（sessiondb 全局轮询的别会话 USER 也带 _sess）：
                        // 跨向跟随裁决「用户在桌面是否真去了那会话」的依据。
                        const usBase = String(ev._sess || "").replace(/\.jsonl$/i, "");
                        if (usBase)
                            userActivityBySess.set(usBase, Date.now());
                        const utNow = String(ev.text).trim();
                        if (utNow && utNow === lastInjectedPhoneText)
                            lastInjectedUserSeen = true;
                        // 挂起停止兑现：停止先于本 USER 落盘 → 此刻轮才真正开启，补发取消。
                        // 只匹配「停止时还没见到 USER」的那次注入文本；晚到的同文事件不误杀
                        // （45s TTL + 一次性消费）。
                        if (deferredPhoneStop && deferredPhoneStop.text === utNow) {
                            const armed = deferredPhoneStop;
                            deferredPhoneStop = undefined;
                            if (Date.now() - armed.at < 45000) {
                                qrPanel.addLog(`deferred stop fired on turn start: ${utNow.slice(0, 50)}`);
                                setTimeout(() => {
                                    (0, inject_1.cancelChatRequest)().catch(() => undefined);
                                }, 800);
                            }
                        }
                    }
                    if (ev.type === "USER_MESSAGE" &&
                        typeof ev.text === "string" &&
                        (0, inject_1.isInjectedEcho)(ev.text)) {
                        return false;
                    }
                    // 被跳过的空会话出现真实内容后补跟随：内容事件到达时重评估
                    // （本通道 + sessionWatcher 通道都挂；跳过的写盘不会再发 FOLLOW）。
                    if (pendingFollowFile &&
                        (ev.type === "USER_MESSAGE" ||
                            ev.type === "AGENT_MESSAGE" ||
                            ev.type === "AGENT_STREAM_SET" ||
                            ev.type === "AGENT_STREAM_CHUNK")) {
                        reevaluatePendingFollow();
                    }
                    // 桌面切会话跟随：页面完整同步——feed 换目标会话历史 + 标题切换。
                    // 先 SESSION_SELECTED（PWA 清 feed + 标题 + 切换态），再 HISTORY_REPLAY。
                    if (ev.type === "SESSION_FOLLOW") {
                        const tfile = String(ev.file || ev.csFile || "");
                        const base = path.basename(tfile);
                        qrPanel.addLog(`SESSION_FOLLOW: ${base}`);
                        // csFile 优先（transcripts 无同名文件时唯一可用源），否则按基名解析
                        let csFile = typeof ev.csFile === "string" && fs.existsSync(ev.csFile)
                            ? ev.csFile
                            : undefined;
                        if (!csFile && csdir && base) {
                            const cand = path.join(csdir, base);
                            if (fs.existsSync(cand))
                                csFile = cand;
                        }
                        // 显式点选优先窗：手机刚选了别的会话时，在途会话的写盘 newest 会
                        // 立刻触发跟随把绑定/页面拽回活动会话（实测 +0.7-0.8s 抢回 2 次）。
                        // 压制窗口内的异向跟随并顺延窗口（活动会话持续写盘不反复抢）；
                        // 指向所选会话本身的跟随放行并解除窗口。
                        const sel = lastExplicitSelect;
                        // 窗外也压制：绑定会话 90s 内有可见活动 = 用户正在用它——异向跟随
                        // 一律延后重评；否则窗外新 follow 绕过压制门把页面拽走（拉锯残余）。
                        const boundFile = sel?.file || (0, inject_1.getActiveSessionFile)();
                        const boundHot = boundViaExplicitSelect && Date.now() - boundSessionActivityAt < 90000;
                        const selBase = boundFile ? path.basename(boundFile).replace(/\.jsonl$/i, "") : "";
                        const followBase = base.replace(/\.jsonl$/i, "");
                        const inWindow = !!(sel && Date.now() < sel.until);
                        if (selBase && followBase && selBase !== followBase && (inWindow || boundHot)) {
                            lastExplicitSelect = { file: boundFile, until: Date.now() + EXPLICIT_SELECT_GUARD_MS };
                            qrPanel.addLog(`SESSION_FOLLOW 压制: ${inWindow ? "显式选择窗口内" : "绑定会话活跃"} ${followBase}`);
                            // watcher 的 newest 转移检测只发一次——吞掉就永久丢失，
                            // PWA 会永久滞留旧会话（实测：点选期间桌面开新轮，跟随从此不再来）。
                            // 暂存事件，窗口结束（含顺延）后重入本 handler 补发。
                            pendingSuppressedFollow = ev;
                            if (!suppressedFollowTimer) {
                                const wait = Math.max(50, lastExplicitSelect.until - Date.now() + 50);
                                suppressedFollowTimer = setTimeout(function retrySuppressedFollow() {
                                    suppressedFollowTimer = undefined;
                                    const p = pendingSuppressedFollow;
                                    pendingSuppressedFollow = undefined;
                                    if (!p)
                                        return;
                                    if (lastExplicitSelect && Date.now() < lastExplicitSelect.until) {
                                        // 窗口仍被顺延（写盘未停/又有点选）→ 继续排队到下一窗口
                                        pendingSuppressedFollow = p;
                                        suppressedFollowTimer = setTimeout(retrySuppressedFollow, Math.max(50, lastExplicitSelect.until - Date.now() + 50));
                                        return;
                                    }
                                    // 重评估而非无脑补发：所选会话在压制期间有新活动且未静默
                                    // 90s = 用户正在用它 → 续压顺延，避免「拽走又拽回」的拉锯。
                                    if (lastExplicitSelect &&
                                        boundViaExplicitSelect &&
                                        Date.now() - boundSessionActivityAt < 90000) {
                                        lastExplicitSelect = {
                                            file: lastExplicitSelect.file,
                                            until: Date.now() + EXPLICIT_SELECT_GUARD_MS,
                                        };
                                        pendingSuppressedFollow = p;
                                        suppressedFollowTimer = setTimeout(retrySuppressedFollow, EXPLICIT_SELECT_GUARD_MS + 50);
                                        qrPanel.addLog(`SESSION_FOLLOW 续压: 所选会话近期有活动`);
                                        return;
                                    }
                                    // 重放前校验目标仍是双源最新：被压制的跟随描述的是发出时刻的
                                    // 「桌面活跃会话」，窗口结束时桌面可能已搬到别处（含 inject 完成
                                    // 切到所选会话）——过时跟随直接丢，否则手机会被拽去死会话（R18）。
                                    const pTarget = String(p.csFile || p.file || "");
                                    const stillNewest = transcriptWatcher?.newestSessionFile?.();
                                    if (pTarget &&
                                        stillNewest &&
                                        !(0, pathutil_1.samePath)(pTarget, stillNewest)) {
                                        qrPanel.addLog(`SESSION_FOLLOW 丢弃: 目标已非最新 ${path.basename(pTarget)}`);
                                    }
                                    else {
                                        qrPanel.addLog(`SESSION_FOLLOW 补发: 窗口结束重放被压制的跟随`);
                                        handleTranscriptWatcherEvent(p);
                                    }
                                }, wait);
                            }
                            return;
                        }
                        // 跨向跟随的用户活动门（直发路径）：被弃会话的在途轮持续写盘
                        // 会一直占 newest——若点选后目标会话无任何用户活动，这次跟随是
                        // turn 写入的假象，丢掉不拽回（压制重放走同一门：performSessionFollow）。
                        if (boundViaExplicitSelect &&
                            selBase &&
                            followBase &&
                            selBase !== followBase &&
                            (userActivityBySess.get(followBase) ?? 0) <= lastExplicitSelectAt) {
                            qrPanel.addLog(`SESSION_FOLLOW 丢弃: 点选后目标无用户活动 ${followBase}`);
                            return;
                        }
                        // 指向绑定会话本身的跟随：放行并解除显式选择窗口——但不再回放。
                        // 同一会话的重放是纯消耗：feed 被清空重渲（实测空窗 ~75s），还会
                        // 清掉输入框里的草稿。live 事件流已经在补增量，无需重放。
                        if (inWindow)
                            lastExplicitSelect = undefined;
                        if (selBase && followBase && selBase === followBase) {
                            qrPanel.addLog(`SESSION_FOLLOW 跳过: 跟随目标即绑定会话 ${followBase}`);
                            return;
                        }
                        if (csFile && fs.existsSync(csFile)) {
                            performSessionFollow(csFile, base);
                        }
                        else if (bridge?.sendToPhone) {
                            // 找不到 chatSessions 对应文件：退化为提示（不替换 feed）。
                            // Windows 实测 transcripts 可比 chatSessions 早 ~30s 落盘——此刻 cs
                            // 文件尚未出生。跟随意图记为 pending：文件出现且拿到首个用户轮后
                            // 由 pendingPoll/内容事件补发跟随，不再永久丢失。
                            bridge.sendToPhone({ type: "SYSTEM_MESSAGE", text: String(ev.text || "") });
                            const cand = csdir && base ? path.join(csdir, base) : undefined;
                            if (cand)
                                pendingFollowFile = cand;
                        }
                        return;
                    }
                    // 桌面在其他会话直接发消息时，transcripts 单文件 tail 可能没跟过去；
                    // 用 chatSessions 的 USER_MESSAGE 兜底（bridge sendToPhone 的 isPhoneEcho
                    // 会拦手机回声，不会双出现）。
                    if (ev.type === "USER_MESSAGE") {
                        if (bridge?.sendToPhone)
                            return bridge.sendToPhone(ev);
                        bridge?.broadcast(ev);
                        return true;
                    }
                    if (ev.type === "SYSTEM_MESSAGE" &&
                        (ev.visibility === "internal" || ev.internal === true)) {
                        writeChannelArtifact();
                        return;
                    }
                    if (bridge?.sendToPhone)
                        return bridge.sendToPhone(ev);
                    bridge?.broadcast(ev);
                    return true;
                },
            });
            transcriptWatcher.start();
            // 启动时监控当前窗口最新的 transcript，此时由实时源供稿
            transcriptActive = true;
            qrPanel.addLog(`transcript 实时源: ${tdir}`);
            if (csdir)
                qrPanel.addLog(`chatSessions 兜底源: ${csdir}`);
        }
        const activeToken = bridge.getAuthToken();
        const localUrl = withToken(bridge.localHttpUrl, activeToken);
        qrPanel.setBridgeUrl(localUrl);
        qrPanel.setPort(bridge.port);
        qrPanel.setTokenHint(activeToken ? maskToken(activeToken) : null);
        qrPanel.setTunnelEnabled(enableTunnel);
        qrPanel.addLog(`bridge ${bridge.localWsUrl}`);
        refreshStatus(bridge, enableTunnel);
        writeChannelArtifact();
        vscode.window.setStatusBarMessage(`Copilot Lazy Ass PWA ${localUrl}`, 5000);
        if (enableTunnel) {
            await startTunnel(bridge.port, allowDownload);
        }
    };
    const stop = async () => {
        await tunnel?.stop();
        tunnel = undefined;
        watcher?.dispose();
        watcher = undefined;
        transcriptWatcher?.dispose();
        transcriptWatcher = undefined;
        _transcriptDir = undefined;
        chatControl?.dispose();
        chatControl = undefined;
        workspaceIndex = undefined;
        transcriptActive = false;
        terminalMgr = undefined;
        discovery = undefined;
        if (suppressedFollowTimer) {
            clearTimeout(suppressedFollowTimer);
            suppressedFollowTimer = undefined;
        }
        pendingSuppressedFollow = undefined;
        await bridge?.stop();
        bridge = undefined;
        push = undefined;
        sessionToken = undefined;
        qrPanel.setBridgeUrl(null);
        qrPanel.setPublicUrl(null);
        qrPanel.setPort(null);
        qrPanel.setTokenHint(null);
        qrPanel.setPhoneConnected(false);
        qrPanel.setTunnelEnabled(false);
        status.text = "$(phone) Lazy Ass: off";
        writeChannelArtifact();
    };
    context.subscriptions.push(vscode.commands.registerCommand("copilotSidecar.start", start), vscode.commands.registerCommand("copilotSidecar.stop", stop), vscode.commands.registerCommand("copilotSidecar.showStatus", async () => {
        if (!bridge) {
            vscode.window.showInformationMessage("Lazy Ass bridge is stopped");
            return;
        }
        const tok = bridge.getAuthToken();
        const local = withToken(bridge.localHttpUrl, tok);
        const pub = bridge.publicUrl ? withToken(ensureSlash(bridge.publicUrl), tok) : null;
        const tunState = tunnel?.running ? "running" : tunnel ? "starting/stopped" : "off";
        vscode.window.showInformationMessage(`Lazy Ass ${local}` +
            (pub ? ` | tunnel ${pub}` : "") +
            ` | tun=${tunState}` +
            ` | clients=${bridge.clientCount}` +
            ` | session=${watcher?.currentFile ? path.basename(watcher.currentFile) : "none"}` +
            (tok ? ` | token=${maskToken(tok)}` : ""));
    }), vscode.commands.registerCommand("copilotSidecar.copyWsUrl", async () => {
        if (!bridge) {
            vscode.window.showWarningMessage("Bridge not running");
            return;
        }
        const tok = bridge.getAuthToken();
        const url = withToken(bridge.publicUrl ? ensureSlash(bridge.publicUrl) : bridge.localHttpUrl, tok);
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage(`Copied ${url}`);
    }), vscode.commands.registerCommand("copilotSidecar.showQr", async () => {
        await vscode.commands.executeCommand("copilotSidecar.qrPanel.focus");
    }), vscode.commands.registerCommand("copilotSidecar.copyToken", async () => {
        const tok = bridge?.getAuthToken() || sessionToken;
        if (!tok) {
            vscode.window.showWarningMessage("当前没有 token。本地模式默认无 token；开启隧道后会自动生成，或在设置里填 copilotSidecar.authToken。");
            return;
        }
        await vscode.env.clipboard.writeText(tok);
        vscode.window.showInformationMessage(`已复制 token: ${maskToken(tok)}`);
    }), vscode.commands.registerCommand("copilotSidecar.startTunnel", async () => {
        clearTunnelRestart();
        if (!bridge)
            await start();
        if (!bridge)
            return;
        await startTunnel(bridge.port, vscode.workspace.getConfiguration("copilotSidecar").get("downloadCloudflared", true));
    }), vscode.commands.registerCommand("copilotSidecar.stopTunnel", async () => {
        clearTunnelRestart();
        await tunnel?.stop();
        tunnel = undefined;
        bridge?.setPublicUrl(null);
        qrPanel.setPublicUrl(null);
        qrPanel.setTunnelEnabled(false);
        if (bridge)
            refreshStatus(bridge, false);
        qrPanel.addLog("tunnel stopped");
        writeChannelArtifact();
    }), vscode.commands.registerCommand("copilotSidecar.restartTunnel", async () => {
        clearTunnelRestart();
        await tunnel?.stop();
        tunnel = undefined;
        if (!bridge)
            await start();
        if (!bridge)
            return;
        await startTunnel(bridge.port, vscode.workspace.getConfiguration("copilotSidecar").get("downloadCloudflared", true));
    }));
    if (vscode.workspace.getConfiguration("copilotSidecar").get("autoStart", true)) {
        start().catch((e) => {
            console.error(e);
            vscode.window.showErrorMessage(`Lazy Ass start failed: ${e?.message || e}`);
        });
    }
}
async function deactivate() {
    clearTunnelRestart();
    await tunnel?.stop();
    watcher?.dispose();
    await bridge?.stop();
    writeChannelArtifact();
}
let tunnelRestartAttempts = 0;
let tunnelRestartTimer;
let tunnelStarting = false;
const MAX_TUNNEL_RESTART_ATTEMPTS = 10;
function clearTunnelRestart() {
    if (tunnelRestartTimer) {
        clearTimeout(tunnelRestartTimer);
        tunnelRestartTimer = undefined;
    }
    tunnelRestartAttempts = 0;
}
function scheduleTunnelRestart(port) {
    if (tunnelRestartTimer) {
        clearTimeout(tunnelRestartTimer);
        tunnelRestartTimer = undefined;
    }
    if (!qrPanel.state.tunnelEnabled && !tunnel) {
        return;
    }
    if (tunnel?.running || tunnelStarting) {
        return;
    }
    if (tunnelRestartAttempts >= MAX_TUNNEL_RESTART_ATTEMPTS) {
        qrPanel.addLog('tunnel restart max attempts reached; open QR panel and click "开启隧道".');
        qrPanel.setTunnelEnabled(false);
        return;
    }
    const delay = Math.min(5000 + tunnelRestartAttempts * 3000, 30000);
    tunnelRestartAttempts += 1;
    qrPanel.addLog(`tunnel reconnecting in ${delay}ms (attempt ${tunnelRestartAttempts}/${MAX_TUNNEL_RESTART_ATTEMPTS})`);
    tunnelRestartTimer = setTimeout(() => {
        tunnelRestartTimer = undefined;
        if (!bridge)
            return;
        if (tunnel?.running || tunnelStarting)
            return;
        const cfg = vscode.workspace.getConfiguration("copilotSidecar");
        const allowDownload = cfg.get("downloadCloudflared", true);
        void startTunnel(port || bridge.port, allowDownload);
    }, delay);
}
async function startTunnel(port, allowDownload) {
    if (tunnelStarting || tunnel?.running) {
        return;
    }
    tunnelStarting = true;
    clearTunnelRestart();
    qrPanel.setTunnelEnabled(true);
    if (!bridge) {
        tunnelStarting = false;
        return;
    }
    ensurePublicAuthToken();
    if (tunnel) {
        await tunnel.stop();
        tunnel = undefined;
    }
    const cfg = vscode.workspace.getConfiguration("copilotSidecar");
    const timeoutMs = cfg.get("tunnelTimeoutMs", 35000);
    tunnel = new tunnel_1.TunnelManager({
        allowDownload,
        timeoutMs,
        log: (line) => qrPanel.addLog(line),
        onUrl: (url) => {
            if (!url) {
                bridge?.setPublicUrl(null);
                qrPanel.setPublicUrl(null);
                if (bridge)
                    refreshStatus(bridge, true);
                return;
            }
            applyPublicUrl(url);
        },
        onExit: (code, signal) => {
            qrPanel.addLog(`tunnel exited code=${code} signal=${signal}`);
            bridge?.setPublicUrl(null);
            qrPanel.setPublicUrl(null);
            if (bridge)
                refreshStatus(bridge, false);
            writeChannelArtifact();
            // 0.5.30：免费 trycloudflare 隧道会在网络抖动/长时间 idle 时被 edge 断开，
            // 自动重开以恢复服务；URL 会变，PWA 需刷新。
            scheduleTunnelRestart(bridge?.port || 0);
        },
    });
    try {
        refreshStatus(bridge, true);
        const url = await tunnel.start(port);
        applyPublicUrl(url);
        tunnelRestartAttempts = 0;
        const tok = bridge.getAuthToken();
        const full = withToken(ensureSlash(url), tok);
        vscode.window
            .showInformationMessage(`Sidecar tunnel ready: ${full}`, "Copy URL")
            .then((pick) => {
            if (pick === "Copy URL")
                void vscode.env.clipboard.writeText(full);
        });
        qrPanel.addLog(`tunnel ready ${url}`);
        writeChannelArtifact();
    }
    catch (e) {
        const reason = e?.message || String(e);
        qrPanel.addLog(`tunnel failed: ${reason}`);
        vscode.window.showErrorMessage(`Sidecar tunnel failed: ${reason}`);
        tunnel = undefined;
        bridge.setPublicUrl(null);
        qrPanel.setPublicUrl(null);
        qrPanel.setTunnelEnabled(false);
        refreshStatus(bridge, false);
        writeChannelArtifact();
    }
    finally {
        tunnelStarting = false;
    }
}
function applyPublicUrl(url) {
    if (!bridge)
        return;
    const tok = bridge.getAuthToken();
    const full = withToken(ensureSlash(url), tok);
    bridge.setPublicUrl(url);
    qrPanel.setPublicUrl(full);
    qrPanel.setPort(bridge.port);
    qrPanel.setTokenHint(tok ? maskToken(tok) : null);
    refreshStatus(bridge, true);
}
/**
 * If tunnel is used and no authToken in settings, mint an in-memory session token
 * so the public trycloudflare URL is not open.
 */
function ensurePublicAuthToken() {
    if (!bridge)
        return;
    const settingsToken = (vscode.workspace.getConfiguration("copilotSidecar").get("authToken", "") || "").trim();
    if (settingsToken) {
        bridge.setAuthToken(settingsToken);
        sessionToken = undefined;
        qrPanel.setTokenHint(maskToken(settingsToken));
        qrPanel.setBridgeUrl(withToken(bridge.localHttpUrl, settingsToken));
        return;
    }
    if (bridge.getAuthToken()) {
        qrPanel.setTokenHint(maskToken(bridge.getAuthToken()));
        return;
    }
    sessionToken = crypto.randomBytes(16).toString("hex");
    bridge.setAuthToken(sessionToken);
    qrPanel.setTokenHint(maskToken(sessionToken));
    qrPanel.setBridgeUrl(withToken(bridge.localHttpUrl, sessionToken));
    qrPanel.addLog(`session auth token generated (in-memory): ${maskToken(sessionToken)}`);
    vscode.window
        .showInformationMessage(`Sidecar public tunnel token: ${sessionToken} (also in QR ?token=)`, "Copy token")
        .then((pick) => {
        if (pick === "Copy token" && sessionToken) {
            void vscode.env.clipboard.writeText(sessionToken);
        }
    });
}
function refreshStatus(b, tunnelOn) {
    const t = b.publicUrl ? " tun" : tunnelOn ? " tun…" : "";
    const c = b.clientCount > 0 ? ` ·${b.clientCount}` : "";
    status.text = `$(phone) Lazy Ass: :${b.port}${t}${c}`;
}
function ensureSlash(url) {
    return url.endsWith("/") ? url : url + "/";
}
/** 当前工作区的 transcripts 目录（若存在） */
let _transcriptDir;
function transcriptDir() {
    return _transcriptDir;
}
function withToken(url, token) {
    if (!token)
        return url;
    try {
        const u = new URL(url);
        u.searchParams.set("token", token);
        return u.toString();
    }
    catch {
        const sep = url.includes("?") ? "&" : "?";
        return `${url}${sep}token=${encodeURIComponent(token)}`;
    }
}
function maskToken(tok) {
    if (tok.length <= 8)
        return tok;
    return `${tok.slice(0, 4)}…${tok.slice(-4)}`;
}
/** Write ~/.copilot-sidecar-companion/channel.json for external tools / self-use.
 * 多窗口时每个 bridge 写 channel-<port>.json，并更新 channel.json 为「本窗口」快照。
 * 注意：多窗口会互相覆盖 channel.json；查实例请用 channel-*.json 或 PWA 实例列表。
 */
function writeChannelArtifact() {
    try {
        const dir = path.join(os.homedir(), ".copilot-sidecar-companion");
        fs.mkdirSync(dir, { recursive: true });
        const tok = bridge?.getAuthToken();
        const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
        const payload = {
            localUrl: bridge ? withToken(bridge.localHttpUrl, tok) : null,
            publicUrl: bridge?.publicUrl ? withToken(ensureSlash(bridge.publicUrl), tok) : null,
            port: bridge?.port ?? null,
            host: bridge?.host ?? null,
            token: tok || null,
            tokenPresent: !!tok,
            session: watcher?.currentFile ? path.basename(watcher.currentFile) : null,
            workspaceName: vscode.workspace.name || null,
            workspaceFolders: folders,
            pid: process.pid,
            extensionVersion: extensionVersion ?? null,
            clients: bridge?.clientCount ?? 0,
            running: !!bridge,
            tunnelRunning: !!tunnel?.running,
            updated: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(dir, "channel.json"), JSON.stringify(payload, null, 2), {
            encoding: "utf8",
            mode: 0o600,
        });
        if (bridge?.port) {
            fs.writeFileSync(path.join(dir, `channel-${bridge.port}.json`), JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
        }
    }
    catch {
        // ignore disk errors
    }
}
//# sourceMappingURL=extension.js.map