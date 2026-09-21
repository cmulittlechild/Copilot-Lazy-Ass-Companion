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
 * 对应 workbench `LocalChatSessionUri.forSession`：
 *   scheme = vscode-chat-session, authority = local, path = / + base64url(sessionId)
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
/**
 * 0.5.12：把目标会话绑到「会被 chat.open 打到的」widget。
 *
 * VS Code 1.131 铁律（workbench WGt / Mqn）：
 *   1) workbench.action.chat.open({query}) **只**用 lastFocusedWidget（忽略 sessionResource）
 *   2) vscode.open(vscode-chat-session://...) 经 ChatEditorInput 加载指定会话到**编辑器**
 *   3) workbench.action.chat.openInSidebar (Mqn)：
 *        若 active editor 是 ChatEditor → close + ChatViewPane.loadSession(该 sessionResource)
 *        这是扩展侧唯一能把「指定 id」灌进侧边栏并 focus 的公开命令链
 *
 * 序列（正确会话优先；顺带消掉双面板）：
 *   vscode.open(uri) → delay → openInSidebar → delay → chat.open({query})
 *
 * 禁止：
 *   - 把 sessionResource 传给 chat.open（假成功）
 *   - 有 sid 时不绑会话就 focused-fallback（会串会话）
 */
async function activateSessionForInject(sessionId) {
    const uri = localChatSessionUri(sessionId);
    const steps = [];
    // Step 1: 打开目标会话为 active ChatEditor
    try {
        await vscode.commands.executeCommand("vscode.open", uri);
        steps.push("vscode.open");
    }
    catch (e) {
        // 备选：openSessionInEditorGroup（部分 build 要 session 对象，可能失败）
        try {
            await vscode.commands.executeCommand("workbench.action.chat.openSessionInEditorGroup", {
                resource: uri,
            });
            steps.push("openSessionInEditorGroup");
        }
        catch {
            return { ok: false, via: "open-failed", steps };
        }
    }
    // 等 ChatEditorInput.resolve / acquireOrLoadSession
    await delay(220);
    // Step 2: Move Chat into Side Bar —— 把刚打开的 editor 会话 loadSession 进侧边并 focus
    try {
        await vscode.commands.executeCommand("workbench.action.chat.openInSidebar");
        steps.push("openInSidebar");
        await delay(120);
    }
    catch {
        // 若命令不存在：编辑器 tab 仍可能成为 lastFocused；继续
        steps.push("openInSidebar-miss");
    }
    // Step 3: 再 focus 一次，减少 lastFocused 仍指向旧侧边 widget 的竞态
    try {
        await vscode.commands.executeCommand("workbench.action.chat.focusInput");
        steps.push("focusInput");
    }
    catch {
        /* optional */
    }
    return { ok: true, via: steps.join(">"), steps };
}
/**
 * 校验目标文件（优先 transcripts，其次 chatSessions）是否出现注入文本。
 * transcripts 近实时；chatSessions 可能 60s 才 flush，不能作为硬失败依据。
 */
async function waitForInjectInSessionFile(file, text, timeoutMs = 2500, pollMs = 120) {
    if (!file || !text)
        return false;
    const needle = text.trim();
    if (!needle)
        return false;
    const candidates = [file];
    // 同 id 的 transcript 路径（若 file 是 chatSessions）
    try {
        const base = path.basename(file);
        const dir = path.dirname(file);
        if (dir.endsWith("chatSessions")) {
            const wsRoot = path.dirname(dir);
            const t = path.join(wsRoot, "GitHub.copilot-chat", "transcripts", base);
            candidates.unshift(t);
        }
    }
    catch {
        /* ignore */
    }
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
    // 注意：chat.open({mode}) 在非空会话上可能 newChat 清历史；故只试独立 mode 命令
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
        /* 1.131 常无这些命令 */
    }
}
/**
 * 手机消息注入 —— 0.5.12 会话定向（根因修复落地版）
 *
 * 证据：
 *   - 用户手机选 DeepSeek (8304329e)，桌面焦点「项目学习」(42c7881d) → hi 进 42c7881d
 *   - 安装目录仍是 0.5.10（sessionResource 假成功路径）
 *   - DeepSeek jsonl 无 hi；42c7881d 有
 *
 * 有 sid 时：
 *   bind(open→sidebar) → submit query → soft verify（不因 verify 失败二次乱发）
 *   bind 失败 → **剪贴板**，绝不 silent focused-fallback
 * 无 sid：
 *   focused-only（与付费 Remote 一致）
 */
async function injectMessage(text, mode = "agent") {
    noteInjectedText(text);
    const sid = activeSessionFile ? sessionIdFromFile(activeSessionFile) : undefined;
    const targetFile = activeSessionFile;
    const openPolicy = vscode.workspace.getConfiguration("copilotSidecar").get("injectSessionOpen", "editor") ||
        "editor";
    const preferBind = openPolicy !== "focused-only";
    // ---------- 有目标会话：必须绑定，禁止 silent 错会话 ----------
    if (sid && preferBind) {
        const opened = await activateSessionForInject(sid);
        if (!opened.ok) {
            await vscode.env.clipboard.writeText(text);
            try {
                await vscode.commands.executeCommand("workbench.action.chat.open");
            }
            catch {
                /* ignore */
            }
            vscode.window.showWarningMessage(`[Copilot Lazy Ass] 无法打开目标会话 ${sid.slice(0, 8)}…，消息已复制。请在桌面打开该会话后粘贴。`);
            return {
                ok: true,
                via: "clipboard",
                sessionActivated: false,
                injectPath: "clipboard-bind-failed",
                sessionId: sid,
                openVia: opened.via,
            };
        }
        // mode 在绑定之后（避免 mode 切走 widget）
        await tryModeCommands(mode);
        // 提交前再 focus，压竞态
        try {
            await vscode.commands.executeCommand("workbench.action.chat.focusInput");
        }
        catch {
            /* ignore */
        }
        await delay(40);
        const submitted = await submitFocusedQuery(text);
        if (!submitted) {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showWarningMessage(`[Copilot Lazy Ass] chat.open 提交失败，目标 ${sid.slice(0, 8)}… 消息已复制。`);
            return {
                ok: true,
                via: "clipboard",
                sessionActivated: true,
                injectPath: "clipboard-submit-failed",
                sessionId: sid,
                openVia: opened.via,
            };
        }
        // soft verify：只记日志，**不再自动二次 submit**（避免双发/继续串）
        let verified;
        if (targetFile) {
            verified = await waitForInjectInSessionFile(targetFile, text, 2000, 100);
        }
        return {
            ok: true,
            via: "chat.open",
            sessionActivated: true,
            injectPath: verified === false ? "bind+chat.open+unverified" : "bind+chat.open",
            sessionId: sid,
            verified,
            openVia: opened.via,
        };
    }
    // ---------- focused-only 策略或无 sid ----------
    if (sid && !preferBind) {
        await tryModeCommands(mode);
        if (await submitFocusedQuery(text)) {
            return {
                ok: true,
                via: "chat.open",
                sessionActivated: false,
                injectPath: "focused-only-policy",
                sessionId: sid,
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
    await vscode.env.clipboard.writeText(text);
    try {
        await vscode.commands.executeCommand("workbench.action.chat.open");
    }
    catch {
        // ignore
    }
    const hint = sid
        ? `（目标会话 ${sid.slice(0, 8)}… 未能自动提交，请确认 Chat 已打开该会话后粘贴）`
        : "（手机未选中会话，已复制到剪贴板）";
    vscode.window.showInformationMessage(`[Copilot Lazy Ass] Message copied — paste into Chat and press Enter. ${hint}`, { modal: false });
    return {
        ok: true,
        via: "clipboard",
        sessionActivated: false,
        injectPath: "clipboard",
        sessionId: sid,
    };
}
/**
 * Phone confirmation → VS Code tool confirmation commands.
 * Tries a few alternate command ids used across Copilot builds.
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
 * 停止当前 Copilot Chat 请求（对齐 VS Code 发送键在生成中变成 Stop 的行为）。
 * 命令 id 因版本略有差异，逐个尝试。
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