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
exports.noteInjectedText = noteInjectedText;
exports.isInjectedEcho = isInjectedEcho;
exports.setActiveSessionFile = setActiveSessionFile;
exports.getActiveSessionFile = getActiveSessionFile;
exports.sessionIdFromFile = sessionIdFromFile;
exports.localChatSessionUri = localChatSessionUri;
exports.activateSessionForInject = activateSessionForInject;
exports.waitForInjectInSessionFile = waitForInjectInSessionFile;
exports.detectCrossSessionLeak = detectCrossSessionLeak;
exports.injectMessage = injectMessage;
exports.handleConfirmation = handleConfirmation;
exports.cancelChatRequest = cancelChatRequest;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const recentInjects = [];
const ECHO_WINDOW_MS = 30_000;
const ECHO_MAX = 20;
/** 手机端当前选中的 chatSessions 文件；注入时必须先打开该会话再发消息 */
let activeSessionFile;
/** Remember injected text so JSONL mirror can suppress phone echo. */
function noteInjectedText(text) {
    const t = (text || "").trim();
    if (!t)
        return;
    recentInjects.push({ text: t, at: Date.now() });
    while (recentInjects.length > ECHO_MAX)
        recentInjects.shift();
}
function isInjectedEcho(text) {
    const t = (text || "").trim();
    if (!t)
        return false;
    const now = Date.now();
    while (recentInjects.length && now - recentInjects[0].at > ECHO_WINDOW_MS) {
        recentInjects.shift();
    }
    return recentInjects.some((x) => x.text === t);
}
/** 记录手机端选中的会话文件（chatSessions/*.jsonl 绝对路径） */
function setActiveSessionFile(file) {
    activeSessionFile = file && file.trim() ? file : undefined;
}
function getActiveSessionFile() {
    return activeSessionFile;
}
/** 从会话文件名提取 sessionId（去掉 .jsonl） */
function sessionIdFromFile(file) {
    const base = path.basename(file);
    if (!base)
        return undefined;
    return base.replace(/\.jsonl$/i, "") || undefined;
}
/**
 * 构造 VS Code 本地 chat 会话 URI。
 * workbench LocalChatSessionUri.forSession:
 *   encodeBase64(utf8(id), padded=false, urlSafe=true)
 *   → vscode-chat-session://local/<base64url>
 */
function localChatSessionUri(sessionId) {
    const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
    return vscode.Uri.from({
        scheme: "vscode-chat-session",
        authority: "local",
        path: "/" + encoded,
    });
}
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** 扩展可读的 active chat panel session（proposed API，可能不存在） */
function readActiveChatPanelSessionResource() {
    try {
        const w = vscode.window;
        return w.activeChatPanelSessionResource;
    }
    catch {
        return undefined;
    }
}
function uriEqualsChatSession(a, b) {
    if (!a)
        return false;
    try {
        if (a.toString() === b.toString())
            return true;
        // path 比较（忽略 query/fragment）
        if (a.scheme === b.scheme && a.authority === b.authority) {
            const ap = (a.path || "").replace(/\/+$/, "");
            const bp = (b.path || "").replace(/\/+$/, "");
            if (ap === bp)
                return true;
        }
    }
    catch {
        /* ignore */
    }
    return false;
}
/** 在 tabGroups 里找是否已打开目标 chat session（公开 API 尽力） */
function findOpenChatSessionTab(target) {
    const want = target.toString();
    const wantPath = target.path;
    for (const g of vscode.window.tabGroups.all) {
        for (const tab of g.tabs) {
            const input = tab.input;
            const u = input?.uri;
            if (!u)
                continue;
            if (u.toString() === want)
                return { group: g, tab };
            if (u.scheme === "vscode-chat-session" && u.path === wantPath)
                return { group: g, tab };
        }
    }
    return undefined;
}
async function openChatSessionEditor(uri, steps) {
    // 1) 标准 open
    try {
        await vscode.commands.executeCommand("vscode.open", uri);
        steps.push("vscode.open");
    }
    catch {
        steps.push("vscode.open-fail");
    }
    // 2) openWith 常见 ChatEditor id（不同 build 命名略异）
    const editorIds = [
        "workbench.editor.chatSession",
        "workbench.input.chatSession",
        "workbench.editor.chat",
    ];
    for (const id of editorIds) {
        try {
            await vscode.commands.executeCommand("vscode.openWith", uri, id);
            steps.push(`openWith:${id}`);
            break;
        }
        catch {
            /* next */
        }
    }
    // 3) agent session 命令（脆弱，但无害）
    try {
        await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", {
            resource: uri,
        });
        steps.push("openSessionInEditorGroup");
    }
    catch {
        /* optional */
    }
    // 轮询 tab：最多 ~1.5s，确认 editor 已挂上该 uri
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
        if (findOpenChatSessionTab(uri)) {
            steps.push("tab-visible");
            return true;
        }
        // 再敲一次 open 压竞态
        try {
            await vscode.commands.executeCommand("vscode.open", uri);
        }
        catch {
            /* ignore */
        }
        await delay(100);
    }
    // 即使 tab API 看不到（有的 build chat editor 不暴露 uri），open 未抛也算 best-effort
    const opened = steps.some((s) => s === "vscode.open" || s.startsWith("openWith:"));
    if (opened)
        steps.push("tab-unobserved");
    return opened;
}
/**
 * 0.5.15 商业化绑定：
 *   - **正确会话 > 无双面板**
 *   - 默认 **只开 ChatEditor**，**不**先 openInSidebar（1.131 Mqn 在 editor 未就绪时
 *     只会 openView，把 focus 留在旧侧边栏 → 实测串台根因）
 *   - 提交前再次 vscode.open 抢 lastFocused
 *   - 可选 sidebar 策略：仅配置 injectSessionOpen=sidebar 时在 open 后 Move
 */
async function activateSessionForInject(sessionId) {
    const uri = localChatSessionUri(sessionId);
    const steps = [];
    const policy = vscode.workspace.getConfiguration("copilotSidecar").get("injectSessionOpen", "editor") ||
        "editor";
    // 已是目标 panel session → 无需再开
    const active = readActiveChatPanelSessionResource();
    if (uriEqualsChatSession(active, uri)) {
        steps.push("already-active-panel");
        try {
            await vscode.commands.executeCommand("workbench.action.chat.focusInput");
            steps.push("focusInput");
        }
        catch {
            /* optional */
        }
        return { ok: true, via: steps.join(">"), steps };
    }
    const opened = await openChatSessionEditor(uri, steps);
    if (!opened) {
        return { ok: false, via: "open-failed", steps };
    }
    // 仅显式 sidebar 策略才 Move（默认 editor，避免 Mqn 焦点回旧侧边）
    if (policy === "sidebar") {
        try {
            await delay(200);
            await vscode.commands.executeCommand("workbench.action.chat.openInSidebar");
            steps.push("openInSidebar");
            await delay(150);
        }
        catch {
            steps.push("openInSidebar-miss");
        }
    }
    // 提交前焦点：再 open 一次（singlePerResource 复用 tab）+ focusInput
    try {
        await vscode.commands.executeCommand("vscode.open", uri);
        steps.push("reopen-focus");
    }
    catch {
        /* ignore */
    }
    try {
        await vscode.commands.executeCommand("workbench.action.chat.focusInput");
        steps.push("focusInput");
    }
    catch {
        /* optional */
    }
    await delay(80);
    return { ok: true, via: steps.join(">"), steps };
}
/**
 * 校验目标文件出现注入文本。
 * transcripts 优先（近实时）；chatSessions 可能延迟，故硬门闩应用更长 timeout。
 */
async function waitForInjectInSessionFile(file, text, timeoutMs = 20000, pollMs = 200) {
    if (!file || !text)
        return false;
    const needle = text.trim();
    if (!needle)
        return false;
    const candidates = [];
    try {
        const base = path.basename(file);
        const dir = path.dirname(file);
        if (dir.endsWith("chatSessions")) {
            const wsRoot = path.dirname(dir);
            candidates.push(path.join(wsRoot, "GitHub.copilot-chat", "transcripts", base));
        }
    }
    catch {
        /* ignore */
    }
    candidates.push(file);
    const started = Date.now();
    const baseline = new Map();
    for (const f of candidates) {
        try {
            if (fs.existsSync(f))
                baseline.set(f, fs.readFileSync(f, "utf8"));
            else
                baseline.set(f, "");
        }
        catch {
            baseline.set(f, "");
        }
    }
    while (Date.now() - started < timeoutMs) {
        for (const f of candidates) {
            try {
                if (!fs.existsSync(f))
                    continue;
                const cur = fs.readFileSync(f, "utf8");
                const prev = baseline.get(f) ?? "";
                if (cur.length >= prev.length) {
                    const delta = cur.slice(prev.length);
                    if (delta.includes(needle))
                        return true;
                    if (cur.includes(needle) && cur !== prev)
                        return true;
                }
                else if (cur.includes(needle)) {
                    return true;
                }
            }
            catch {
                /* retry */
            }
        }
        await delay(pollMs);
    }
    return false;
}
/** 扫描「近期改动的其它 chatSessions」是否误收 token（串台检测） */
async function detectCrossSessionLeak(targetFile, text, lookbackMs = 20_000) {
    if (!targetFile || !text)
        return undefined;
    const needle = text.trim();
    if (!needle)
        return undefined;
    const targetBase = path.basename(targetFile);
    const roots = new Set();
    try {
        roots.add(path.dirname(targetFile));
    }
    catch {
        /* ignore */
    }
    // 同级 workspaceStorage 下其它 chatSessions（多窗口串台）
    try {
        const wsStorage = path.dirname(path.dirname(targetFile)); // .../workspaceStorage/<hash>
        const parent = path.dirname(wsStorage);
        if (path.basename(parent) === "workspaceStorage" || parent.includes("workspaceStorage")) {
            // targetFile = workspaceStorage/HASH/chatSessions/x.jsonl
            const storageRoot = path.dirname(path.dirname(targetFile)); // HASH
            const wsRoot = path.dirname(storageRoot); // workspaceStorage
            for (const hash of fs.readdirSync(wsRoot)) {
                const cs = path.join(wsRoot, hash, "chatSessions");
                if (fs.existsSync(cs))
                    roots.add(cs);
                const tr = path.join(wsRoot, hash, "GitHub.copilot-chat", "transcripts");
                if (fs.existsSync(tr))
                    roots.add(tr);
            }
        }
    }
    catch {
        /* ignore */
    }
    const now = Date.now();
    for (const root of roots) {
        let files = [];
        try {
            files = fs.readdirSync(root).filter((f) => f.endsWith(".jsonl"));
        }
        catch {
            continue;
        }
        for (const f of files) {
            if (f === targetBase)
                continue;
            const full = path.join(root, f);
            try {
                const st = fs.statSync(full);
                if (now - st.mtimeMs > lookbackMs)
                    continue;
                // 只读尾部，避免大文件
                const fd = fs.openSync(full, "r");
                try {
                    const size = st.size;
                    const readSize = Math.min(size, 512 * 1024);
                    const buf = Buffer.alloc(readSize);
                    fs.readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
                    if (buf.toString("utf8").includes(needle))
                        return full;
                }
                finally {
                    fs.closeSync(fd);
                }
            }
            catch {
                /* next */
            }
        }
    }
    return undefined;
}
async function submitFocusedQuery(text) {
    try {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: text,
            isPartialQuery: false,
        });
        return true;
    }
    catch {
        return false;
    }
}
async function tryModeCommands(mode) {
    // 不在非空会话上用 chat.open({mode})，可能 newChat 清历史
    try {
        if (mode === "agent") {
            await vscode.commands.executeCommand("workbench.action.chat.openAgentMode");
        }
        else if (mode === "edit") {
            await vscode.commands.executeCommand("workbench.action.chat.openEditSession");
        }
        else if (mode === "ask") {
            await vscode.commands.executeCommand("workbench.action.chat.openAskMode");
        }
    }
    catch {
        /* 1.131 常无 */
    }
}
async function clipboardFallback(text, sid, reason, extra) {
    try {
        await vscode.env.clipboard.writeText(text);
    }
    catch {
        /* ignore */
    }
    try {
        await vscode.commands.executeCommand("workbench.action.chat.open");
    }
    catch {
        /* ignore */
    }
    const short = sid ? sid.slice(0, 8) + "…" : "";
    vscode.window.showWarningMessage(`[Copilot Lazy Ass] 未确认写入目标会话${short ? " " + short : ""}（${reason}）。消息已复制，请在正确 Chat 粘贴发送。`);
    return {
        ok: true,
        via: "clipboard",
        sessionActivated: extra?.sessionActivated,
        injectPath: `clipboard:${reason}`,
        sessionId: sid,
        verified: extra?.verified === undefined ? false : extra.verified,
        openVia: extra?.openVia,
    };
}
/**
 * 手机消息注入 —— 0.5.15 商业化正确性门闩
 *
 * 规则：
 *   1) 有 sid：必须 bind 编辑器 → submit → **磁盘 verified** 才算 chat.open 成功
 *   2) verified 失败或检测到串台文件 → clipboard，**禁止**假成功
 *   3) 无 sid / focused-only 配置：跟焦点（与付费 Remote 同级，日志标明）
 *   4) 绝不把 sessionResource 传给 chat.open
 */
async function injectMessage(text, mode = "agent") {
    noteInjectedText(text);
    const sid = activeSessionFile ? sessionIdFromFile(activeSessionFile) : undefined;
    const targetFile = activeSessionFile;
    const openPolicy = vscode.workspace.getConfiguration("copilotSidecar").get("injectSessionOpen", "editor") ||
        "editor";
    const preferBind = openPolicy !== "focused-only";
    // ---------- 有目标 + 绑定策略 ----------
    if (sid && preferBind) {
        const uri = localChatSessionUri(sid);
        const opened = await activateSessionForInject(sid);
        if (!opened.ok) {
            return clipboardFallback(text, sid, "bind-failed", { openVia: opened.via, sessionActivated: false });
        }
        await tryModeCommands(mode);
        // 提交前最后一次抢焦点到目标 editor
        try {
            await vscode.commands.executeCommand("vscode.open", uri);
            await delay(60);
        }
        catch {
            /* ignore */
        }
        try {
            await vscode.commands.executeCommand("workbench.action.chat.focusInput");
        }
        catch {
            /* ignore */
        }
        const submitted = await submitFocusedQuery(text);
        if (!submitted) {
            return clipboardFallback(text, sid, "submit-failed", {
                openVia: opened.via,
                sessionActivated: true,
            });
        }
        // 硬门闩：目标 transcripts/chatSessions 出现文本才算 verified。
        // 实机：DeepSeek transcript 常 10–14s 才落盘；<16s 会误判。20s 硬等；无串台则 soft-unverified 不剪贴板。
        const verified = targetFile
            ? await waitForInjectInSessionFile(targetFile, text, 20000, 200)
            : false;
        // 无论 verified 与否都扫串台（提交已发生，剪贴板无法撤回错误会话里的消息）
        const leak = targetFile ? await detectCrossSessionLeak(targetFile, text, 30_000) : undefined;
        if (leak && !verified) {
            // 明确打到别的会话：告警 + 剪贴板（可能需用户在正确会话补发）
            return {
                ...(await clipboardFallback(text, sid, "cross-session-leak", {
                    openVia: opened.via,
                    verified: false,
                    sessionActivated: true,
                })),
                leakFile: leak,
            };
        }
        if (leak && verified) {
            // 目标有了但也写到别处（少见双写）
            return {
                ok: true,
                via: "chat.open",
                sessionActivated: true,
                injectPath: "bind+chat.open+leak-warning",
                sessionId: sid,
                verified: true,
                openVia: opened.via,
                leakFile: leak,
            };
        }
        if (!verified) {
            // 已 submit 且未检出串台：不要剪贴板（避免用户粘贴造成双发）。
            // 落盘可能仍在路上；日志标 soft-unverified，手机给轻提示而非「失败复制」。
            return {
                ok: true,
                via: "chat.open",
                sessionActivated: true,
                injectPath: "bind+chat.open+soft-unverified",
                sessionId: sid,
                verified: false,
                openVia: opened.via,
            };
        }
        return {
            ok: true,
            via: "chat.open",
            sessionActivated: true,
            injectPath: "bind+chat.open+verified",
            sessionId: sid,
            verified: true,
            openVia: opened.via,
        };
    }
    // ---------- focused-only 或无 sid ----------
    if (sid && !preferBind) {
        await tryModeCommands(mode);
        if (await submitFocusedQuery(text)) {
            // 仍尽量 verify；失败只警告不阻断（用户显式选了 focused-only）
            let verified;
            if (targetFile) {
                verified = await waitForInjectInSessionFile(targetFile, text, 5000, 150);
            }
            return {
                ok: true,
                via: "chat.open",
                sessionActivated: false,
                injectPath: verified ? "focused-only+verified" : "focused-only-policy",
                sessionId: sid,
                verified,
            };
        }
    }
    else if (!sid) {
        await tryModeCommands(mode);
        if (await submitFocusedQuery(text)) {
            return {
                ok: true,
                via: "chat.open",
                sessionActivated: false,
                injectPath: "focused-only",
            };
        }
    }
    return clipboardFallback(text, sid, "no-path");
}
/**
 * Phone confirmation → VS Code tool confirmation commands.
 */
async function handleConfirmation(button) {
    const lower = (button || "").toLowerCase();
    const reject = lower.includes("cancel") ||
        lower.includes("reject") ||
        lower.includes("deny") ||
        lower.includes("拒绝") ||
        lower.includes("取消");
    const candidates = reject
        ? [
            "chat.action.rejectToolConfirmation",
            "workbench.action.chat.rejectTool",
            "github.copilot.chat.rejectToolConfirmation",
        ]
        : [
            "chat.action.acceptToolConfirmation",
            "workbench.action.chat.acceptTool",
            "github.copilot.chat.acceptToolConfirmation",
        ];
    let lastErr;
    for (const cmd of candidates) {
        try {
            await vscode.commands.executeCommand(cmd);
            return;
        }
        catch (e) {
            lastErr = e;
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || "confirmation command failed"));
}
/**
 * 停止当前 Copilot Chat 请求。
 */
async function cancelChatRequest() {
    const candidates = [
        "workbench.action.chat.cancel",
        "workbench.action.chat.stop",
        "workbench.action.chat.abort",
        "workbench.action.chat.stopResponse",
        "workbench.action.chat.cancelRequest",
        "chat.action.stop",
        "chat.action.cancel",
    ];
    let lastErr;
    for (const cmd of candidates) {
        try {
            await vscode.commands.executeCommand(cmd);
            return { ok: true, via: cmd };
        }
        catch (e) {
            lastErr = e;
        }
    }
    return {
        ok: false,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr || "cancel command failed"),
    };
}
//# sourceMappingURL=inject.js.map