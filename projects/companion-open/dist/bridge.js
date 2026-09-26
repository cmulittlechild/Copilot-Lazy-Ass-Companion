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
exports.BridgeServer = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const http = __importStar(require("http"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const ws_1 = require("ws");
/** 需要走 onRequest 分发（而不是普通 onPhoneMessage 广播）的消息类型 */
const REQUEST_TYPES = new Set([
    'PHONE_SESSION_LIST',
    'PHONE_SESSION_SELECT',
    'PHONE_TERMINAL_LIST',
    'PHONE_TERMINAL_EXEC',
    'PHONE_INSTANCE_STATUS',
    'PHONE_INSTANCE_LIST',
    'PHONE_MODEL_LIST',
    'PHONE_MODEL_SELECT',
    'PHONE_PERMISSION_LIST',
    'PHONE_PERMISSION_SET',
]);
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
};
/** Events that must not bloat reconnect HISTORY_REPLAY. */
const HISTORY_SKIP = new Set([
    'AGENT_STREAM_CHUNK',
    'AGENT_STREAM_START',
    'AGENT_STREAM_END',
    'AGENT_STREAM_SET',
    'AGENT_LIST',
    'AGENT_CONFIRM_RESOLVED',
    'AGENT_CONFIRM', // transient interaction — pendingConfirm re-sent on connect only
    'COPILOT_TYPING',
    'COPILOT_DONE',
    'TUNNEL_URL',
    'CONNECTED_ACK',
    'HISTORY_REPLAY',
    'PHONE_CONNECT',
    'SYSTEM_MESSAGE', // ephemeral status; never replay as chat spam
    // step chrome — live only; final AGENT_MESSAGE/TOOL snapshot is enough on replay
    'PROGRESS_STEP',
    'THINKING_STEP',
]);
const HISTORY_MAX = 200;
const HISTORY_TEXT_MAX = 8000;
const OFFLINE_QUEUE_MAX = 80;
const HEARTBEAT_MS = 8000;
// 落盘回声可能很慢（chatSessions 最长 ~60s+ 才写），30s 窗口漏掉迟到回声 → 手机端重复气泡。
const PHONE_ECHO_WINDOW_MS = 120_000;
const USER_EMIT_DEDUPE_MS = 60_000;
const PHONE_ECHO_MAX = 20;
/** 同一条手机文本最多吞掉的镜像条数（transcript 源 + chatSessions 源各可能来一条） */
const PHONE_ECHO_SUPPRESS_PER_TEXT = 4;
const WS_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PHONE_TEXT_LENGTH = 256 * 1024;
const MAX_REQUEST_TYPE_LENGTH = 64;
const MAX_HTTP_REQUEST_URL_LENGTH = 8192;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const AUTH_HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_QUEUED_MESSAGES_PER_SOCKET = 100;
/** Internal chrome that should not spam the phone feed. */
function isInternalSystemMessage(ev) {
    if (!ev || ev.type !== 'SYSTEM_MESSAGE')
        return false;
    if (ev.visibility === 'internal' || ev.internal === true)
        return true;
    const t = String(ev.text || '');
    return (t.startsWith('Watching session:') ||
        t === 'lazy ass companion connected' ||
        t.startsWith('lazy ass companion connected'));
}
/** Stable key for history / offline dedupe. */
function eventDedupeKey(ev) {
    if (!ev || typeof ev !== 'object')
        return String(ev);
    const t = String(ev.type || '');
    switch (t) {
        case 'USER_MESSAGE':
            return `U|${ev.requestId || ''}|${ev.text || ''}`;
        case 'AGENT_MESSAGE':
            return `A|${ev.streamId || ''}|${ev.text || ''}`;
        case 'TOOL_CALL':
            return `T|${ev.toolId || ''}|${ev.text || ''}|${ev.isComplete === false ? 0 : 1}`;
        case 'PROGRESS_STEP':
            return `P|${ev.stepId || ''}|${ev.title || ''}|${String(ev.detail || '').slice(0, 80)}`;
        case 'THINKING_STEP':
            return `H|${ev.stepId || ''}|${String(ev.text || '').slice(0, 100)}`;
        case 'AGENT_CONFIRM':
            return `C|${ev.title || ''}|${ev.message || ''}`;
        case 'TUNNEL_URL':
            return `TUN|${ev.url || ''}`;
        case 'SYSTEM_MESSAGE':
            return `S|${ev.text || ''}`;
        default:
            return `${t}|${ev.streamId || ''}|${ev.requestId || ''}|${String(ev.text || '').slice(0, 120)}`;
    }
}
class BridgeServer {
    server;
    wss;
    clients = new Set();
    clientAuth = new Map();
    startPromise;
    phoneHandlerTail = Promise.resolve();
    requestHandlerTail = Promise.resolve();
    handlers = [];
    requestHandlers = [];
    history = [];
    offlineQueue = [];
    pendingConfirm = null;
    push = null;
    heartbeatTimer = null;
    pendingChunk = null;
    currentStreamId = null;
    chunkTimer = null;
    static CHUNK_THROTTLE_MS = 35;
    activeStreamId = null;
    activeStreamAccum = '';
    /** Recent PHONE_MESSAGE texts — suppress JSONL USER_MESSAGE echo back to phone. */
    recentPhoneTexts = [];
    /** 非手机来源 USER_MESSAGE 的最近广播（双源去重）：text → 上次广播时刻 */
    recentUserEmits = new Map();
    host;
    preferredPort;
    portRange;
    _port;
    authToken;
    pwaDir;
    onClientCount;
    publicUrl = null;
    constructor(opts) {
        this.host = opts.host;
        const configuredPort = Number(opts.port);
        const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535
            ? configuredPort
            : 3010;
        this.preferredPort = port;
        this._port = port;
        this.portRange = Math.min(100, Math.max(0, Math.floor(Number(opts.portRange ?? 20) || 0)));
        this.authToken = typeof opts.authToken === 'string' && opts.authToken.trim()
            ? opts.authToken.trim()
            : undefined;
        if (!this.authToken && !isLoopbackHost(this.host)) {
            this.authToken = crypto.randomBytes(16).toString('hex');
        }
        this.pwaDir = opts.pwaDir;
        this.onClientCount = opts.onClientCount;
    }
    get port() {
        return this._port;
    }
    get preferredListenPort() {
        return this.preferredPort;
    }
    get clientCount() {
        return this.authorizedClientCount();
    }
    /** Original WsServer alias. */
    get connectedCount() {
        return this.authorizedClientCount();
    }
    get authTokenPresent() {
        return !!this.authToken;
    }
    getAuthToken() {
        return this.authToken;
    }
    setAuthToken(token) {
        const next = token?.trim() || undefined;
        this.authToken = next || (!isLoopbackHost(this.host) ? crypto.randomBytes(16).toString('hex') : undefined);
        for (const ws of this.clients) {
            // A token change invalidates previous socket authentication. Clients must
            // perform PHONE_CONNECT again with the current token.
            this.clientAuth.set(ws, !this.authToken);
        }
        this.emitClientCount();
    }
    setPushManager(pm) {
        this.push = pm ?? null;
    }
    get vapidPublicKey() {
        return this.push?.vapidPublicKey ?? null;
    }
    get localHttpUrl() {
        const host = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
        return `http://${host}:${this._port}/`;
    }
    get localWsUrl() {
        const host = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
        return `ws://${host}:${this._port}`;
    }
    onPhoneMessage(h) {
        this.handlers.push(h);
    }
    /** 注册请求-响应处理器（会话列表 / 终端执行 / 实例状态等）。 */
    onRequest(h) {
        this.requestHandlers.push(h);
    }
    async start() {
        if (this.server)
            return;
        if (this.startPromise)
            return this.startPromise;
        const pending = this.startOnAvailablePort();
        this.startPromise = pending;
        try {
            await pending;
        }
        finally {
            if (this.startPromise === pending)
                this.startPromise = undefined;
        }
    }
    async startOnAvailablePort() {
        const last = this.preferredPort + this.portRange;
        let lastErr;
        for (let p = this.preferredPort; p <= last; p++) {
            try {
                await this.listenOn(p);
                this._port = p;
                this.startHeartbeat();
                return;
            }
            catch (e) {
                lastErr = e;
                if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES'))
                    continue;
                throw e;
            }
        }
        const why = lastErr instanceof Error ? lastErr.message : String(lastErr || 'busy');
        throw new Error(`No free port in ${this.preferredPort}..${last} (like Remote 3000-3020). Last error: ${why}`);
    }
    listenOn(port) {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handleHttp(req, res));
            const wss = new ws_1.WebSocketServer({
                server,
                perMessageDeflate: false,
                maxPayload: WS_MAX_PAYLOAD_BYTES,
            });
            wss.on('connection', (ws, req) => this.onConnection(ws, req));
            // 关键：ws 会把底层 http server 的 'error' 事件**转发**到 WebSocketServer 实例。
            // 若不在 wss 上挂 error 监听，端口被占用（EADDRINUSE）时 wss 的 error 无人处理，
            // Node 会抛 unhandled 'error' 直接崩掉扩展宿主 —— start() 里的端口扫描
            // （EADDRINUSE → 试下一个端口）就永远走不到，多开窗口时只有第一个能起 bridge。
            // 这里静默吞掉：真正的错误由下面 server 的 onErr / 运行期 handler 统一处理。
            wss.on('error', () => {
                /* 由 server 的 error 处理路径统一负责 */
            });
            const onErr = (err) => {
                cleanupPartial();
                reject(err);
            };
            const cleanupPartial = () => {
                server.off('error', onErr);
                try {
                    wss.close();
                }
                catch { /* ignore */ }
                try {
                    server.close();
                }
                catch { /* ignore */ }
            };
            server.once('error', onErr);
            server.listen(port, this.host, () => {
                server.off('error', onErr);
                this.server = server;
                this.wss = wss;
                server.on('error', (err) => console.error('[sidecar bridge]', err));
                resolve();
            });
        });
    }
    onConnection(ws, req) {
        try {
            ws._socket?.setNoDelay?.(true);
        }
        catch { /* ignore */ }
        ws._alive = true;
        this.clients.add(ws);
        this.emitClientCount();
        const urlTok = tokenFromReqUrl(req.url) || cookieValue(req.headers.cookie, 'sidecar_auth');
        let authed = !this.authToken;
        if (this.authToken && urlTok && safeCompareTokens(urlTok, this.authToken))
            authed = true;
        this.clientAuth.set(ws, authed);
        let authTimer;
        let helloSent = false;
        // Do not disclose bridge state to an unauthenticated socket. In no-auth mode
        // this is the normal initial hello; in auth mode it is sent after PHONE_CONNECT.
        const sendHello = () => {
            if (helloSent)
                return;
            helloSent = true;
            this.send(ws, { type: 'AGENT_LIST', agents: ['GitHub Copilot'], active: 'GitHub Copilot' });
            if (this.publicUrl)
                this.send(ws, { type: 'TUNNEL_URL', url: this.publicUrl });
        };
        if (authed)
            sendHello();
        if (authed)
            this.emitClientCount();
        else {
            authTimer = setTimeout(() => {
                if (this.clientAuth.get(ws) === true)
                    return;
                try {
                    ws.close(1008, 'authentication timeout');
                }
                catch { /* ignore */ }
                try {
                    ws.terminate();
                }
                catch { /* ignore */ }
            }, AUTH_HANDSHAKE_TIMEOUT_MS);
        }
        /** Per-socket: HISTORY_REPLAY only once (reconnect = new socket → once again). */
        let historyReplayed = false;
        let messageTail = Promise.resolve();
        let queuedMessages = 0;
        ws.on('message', (data) => {
            if (queuedMessages >= MAX_QUEUED_MESSAGES_PER_SOCKET) {
                try {
                    ws.close(1008, 'too many queued messages');
                }
                catch { /* ignore */ }
                try {
                    ws.terminate();
                }
                catch { /* ignore */ }
                return;
            }
            queuedMessages += 1;
            messageTail = messageTail.then(async () => {
                try {
                    if (!this.clients.has(ws))
                        return;
                    if (Buffer.isBuffer(data) && data.length > WS_MAX_PAYLOAD_BYTES)
                        return;
                    let msg;
                    try {
                        msg = JSON.parse(String(data));
                    }
                    catch {
                        return;
                    }
                    if (!msg || typeof msg !== 'object' || Array.isArray(msg))
                        return;
                    if (typeof msg.type !== 'string' || msg.type.length === 0 || msg.type.length > MAX_REQUEST_TYPE_LENGTH)
                        return;
                    // Authentication must gate every mutating/request message. In particular,
                    // PHONE_MESSAGE and PHONE_PUSH_SUBSCRIBE must not run before PHONE_CONNECT.
                    if (this.authToken && this.clientAuth.get(ws) !== true && msg?.type !== 'PHONE_CONNECT') {
                        this.send(ws, { type: 'SYSTEM_MESSAGE', text: 'auth required — send PHONE_CONNECT' });
                        return;
                    }
                    if (msg.type === 'PHONE_PUSH_SUBSCRIBE') {
                        this.push?.addSubscription(msg.subscription);
                        return;
                    }
                    if (msg.type === 'PHONE_MESSAGE' && typeof msg.text === 'string') {
                        if (Buffer.byteLength(msg.text, 'utf8') > MAX_PHONE_TEXT_LENGTH) {
                            this.send(ws, {
                                type: 'SYSTEM_MESSAGE',
                                text: `message too large (max ${MAX_PHONE_TEXT_LENGTH} bytes)`,
                            });
                            return;
                        }
                        // 先入 history + 广播 USER_MESSAGE，再记 echo。
                        // 否则 isPhoneEcho 会把「手机自己的问题」从 live/history 里抹掉，
                        // 只剩助手回复（切会话 / 重连 HISTORY_REPLAY 后尤其明显）。
                        // JSONL 回读仍靠 rememberPhoneText 在 30s 内抑制重复气泡。
                        this.acceptPhoneUserMessage(msg.text);
                    }
                    if (msg.type === 'PHONE_CONNECT') {
                        if (this.authToken) {
                            const tok = msg.token ?? urlTok;
                            if (!safeCompareTokens(tok, this.authToken)) {
                                // 0.5.20：结构化 AUTH_FAILED，PWA 停止无限重连；并带短提示
                                this.send(ws, {
                                    type: 'AUTH_FAILED',
                                    reason: 'missing_or_bad_token',
                                    text: 'auth failed',
                                    hint: 'Open the QR/link from the extension (URL must include ?token=)',
                                });
                                this.send(ws, { type: 'SYSTEM_MESSAGE', text: 'auth failed' });
                                try {
                                    ws.close();
                                }
                                catch { /* ignore */ }
                                return;
                            }
                            authed = true;
                            this.clientAuth.set(ws, true);
                            this.emitClientCount();
                            if (authTimer) {
                                clearTimeout(authTimer);
                                authTimer = undefined;
                            }
                            sendHello();
                        }
                        await this.dispatchPhoneHandlers(msg);
                        this.send(ws, {
                            type: 'CONNECTED_ACK',
                            timestamp: Date.now(),
                            vapidPublicKey: this.vapidPublicKey,
                        });
                        // Single HISTORY_REPLAY per socket — PWA replaces feed, does not append.
                        if (!historyReplayed) {
                            historyReplayed = true;
                            this.send(ws, { type: 'HISTORY_REPLAY', messages: this.history.slice(-HISTORY_MAX) });
                        }
                        if (this.activeStreamId && this.activeStreamAccum) {
                            this.send(ws, {
                                type: 'AGENT_STREAM_SET',
                                text: this.activeStreamAccum,
                                streamId: this.activeStreamId,
                                timestamp: Date.now(),
                            });
                        }
                        // Flush offline queue as top-level events (e2e / raw clients).
                        // PWA already replaced feed via HISTORY_REPLAY and dedupes by requestId/streamId.
                        // Offline queue can be huge after long phone-offline runs; history already
                        // covers durable chat. Only flush a short tail for raw clients / e2e.
                        const offlineTail = this.offlineQueue.slice(-20);
                        this.offlineQueue = [];
                        for (const ev of offlineTail)
                            this.send(ws, ev);
                        if (this.pendingConfirm)
                            this.send(ws, this.pendingConfirm);
                        // Do NOT re-send TUNNEL_URL here — already sent on socket open if set.
                        return;
                    }
                    // 请求-响应消息：回发到当前 socket，不进入普通广播 handler
                    if (REQUEST_TYPES.has(msg.type)) {
                        const reply = (ev) => this.send(ws, ev);
                        await this.dispatchRequestHandlers(msg, reply);
                        return;
                    }
                    if (msg.type === 'PHONE_CONFIRM') {
                        this.pendingConfirm = null;
                        this.broadcast({ type: 'AGENT_CONFIRM_RESOLVED', button: msg.button });
                    }
                    await this.dispatchPhoneHandlers(msg);
                }
                catch (err) {
                    console.error('[sidecar bridge] error processing message:', err?.message || err);
                }
                finally {
                    queuedMessages -= 1;
                }
            }).catch((err) => {
                console.error('[sidecar bridge] queued message error:', err);
            });
        });
        ws.on('pong', () => { ws._alive = true; });
        ws.on('close', () => {
            if (authTimer)
                clearTimeout(authTimer);
            this.clients.delete(ws);
            this.clientAuth.delete(ws);
            this.emitClientCount();
        });
        ws.on('error', () => {
            if (authTimer)
                clearTimeout(authTimer);
            this.clients.delete(ws);
            this.clientAuth.delete(ws);
            this.emitClientCount();
        });
    }
    setPublicUrl(url) {
        const next = url || null;
        // Dedup: tunnel logs / applyPublicUrl may fire repeatedly with same URL.
        if (this.publicUrl === next)
            return;
        this.publicUrl = next;
        if (next) {
            // Live notify only — never pushHistory (would spam every reconnect replay
            this.broadcastRaw({ type: "TUNNEL_URL", url: next, timestamp: Date.now() });
        }
        else {
            // 0.5.30: 显式广播隧道失效，让 PWA 停止对旧 URL 重连并提示刷新
            this.broadcastRaw({ type: "TUNNEL_URL", url: null, down: true, text: "tunnel down: open the QR panel and scan the new URL", timestamp: Date.now() });
        }
    }
    /**
     * 会话切换后广播完整回放：清空本地 history（旧会话内容不残留），
     * 推 HISTORY_REPLAY（PWA 端清空 feed 并重放）；后续新事件继续累积。
     * 也重置 activeStream/offlineQueue，避免跨会话串流。
     */
    replaySession(messages, file) {
        this.history = [];
        this.offlineQueue = [];
        this.activeStreamId = null;
        this.activeStreamAccum = '';
        this.pendingConfirm = null;
        // 0.5.9：按「对话轮次」裁剪，而不是盲目 slice(-N)。
        // projectHistory 已按 request 交错输出；若再按事件数截断，TOOL 洪水会
        // 挤掉尾部 USER/AGENT（手机只剩中间某次 0.5.4 验证表）。
        const raw = Array.isArray(messages) ? messages : [];
        const filtered = [];
        for (const ev of raw) {
            if (!ev)
                continue;
            if (ev.type !== 'SYSTEM_MESSAGE') {
                if (HISTORY_SKIP.has(ev.type))
                    continue;
                if (isInternalSystemMessage(ev))
                    continue;
            }
            let stored = ev;
            if (typeof ev.text === 'string' && ev.text.length > HISTORY_TEXT_MAX) {
                stored = { ...ev, text: ev.text.slice(0, HISTORY_TEXT_MAX) + '\n…(truncated)' };
            }
            filtered.push(stored);
        }
        // 以 USER_MESSAGE 为轮次边界，只保留最近 ~40 轮（或 HISTORY_MAX 事件上限）
        const turnStarts = [];
        for (let i = 0; i < filtered.length; i++) {
            if (filtered[i].type === 'USER_MESSAGE')
                turnStarts.push(i);
        }
        const MAX_TURNS = 40;
        let start = 0;
        if (turnStarts.length > MAX_TURNS) {
            start = turnStarts[turnStarts.length - MAX_TURNS];
        }
        // 同时守住事件上限，从 start 起向后取，宁可少轮次也要完整轮次
        let slice = filtered.slice(start);
        if (slice.length > HISTORY_MAX) {
            // 从尾部找一个 USER_MESSAGE 作为新起点，避免半截轮次
            const tail = slice.slice(-HISTORY_MAX);
            const firstUser = tail.findIndex((e) => e.type === 'USER_MESSAGE');
            slice = firstUser > 0 ? tail.slice(firstUser) : tail;
        }
        this.history = slice;
        // file 透传：PWA 回放后据此恢复该会话的滚动位置（切回不从头拉到底）
        this.broadcastRaw({
            type: 'HISTORY_REPLAY',
            messages: this.history,
            file: file || undefined,
            timestamp: Date.now(),
        });
    }
    /**
     * Preferred path for session/projector events (RE sendToPhone).
     * Durable chat events go to history (reconnect via HISTORY_REPLAY).
     * Live stream state tracked for mid-stream resume.
     * Offline queue only keeps non-history edge events; no double-flush with history.
     * Triggers web-push on AGENT_CONFIRM.
     */
    sendToPhone(ev) {
        if (!ev || isInternalSystemMessage(ev))
            return;
        // 0.5.19：仅抑制「手机刚发出」的 JSONL 回声。
        // 注意：短文案（「1」/「2」）会话历史里可能多次出现；若无条件吞掉，
        // 切会话 HISTORY / 桌面侧同文新消息都会在远端消失。
        // fromPhone 已由 acceptPhoneUserMessage 广播过，这里不该再来一条。
        if (ev.type === 'USER_MESSAGE' &&
            typeof ev.text === 'string' &&
            this.isPhoneEcho(ev)) {
            return;
        }
        // 双源去重：同一桌面发出的 USER_MESSAGE 会经 transcripts + chatSessions
        // 两个通道各投一次（间隔数秒到 ~45s 落盘延迟）。按文本在窗口内去重，
        // 保证单气泡；超时同文（真的重发同问题）照常放行。
        if (ev.type === 'USER_MESSAGE' && typeof ev.text === 'string' && !ev.fromPhone) {
            const t = ev.text.trim();
            const now = Date.now();
            for (const [k, ts] of this.recentUserEmits) {
                if (now - ts > USER_EMIT_DEDUPE_MS)
                    this.recentUserEmits.delete(k);
            }
            if (t) {
                const last = this.recentUserEmits.get(t);
                if (last != null && now - last <= USER_EMIT_DEDUPE_MS)
                    return;
                this.recentUserEmits.set(t, now);
            }
        }
        const stamped = {
            ...ev,
            timestamp: ev?.timestamp ?? Date.now(),
        };
        this.trackStreamState(stamped);
        this.pushHistory(stamped);
        if (stamped.type === 'AGENT_CONFIRM')
            this.pendingConfirm = stamped;
        const skipOffline = stamped.type === 'COPILOT_TYPING' ||
            stamped.type === 'COPILOT_DONE' ||
            stamped.type === 'TUNNEL_URL' ||
            stamped.type === 'SYSTEM_MESSAGE';
        if (this.authorizedClientCount() === 0) {
            // Queue durable + non-stream events for flush on next PHONE_CONNECT.
            // HISTORY_REPLAY also has durable items; PWA dedupes by requestId/streamId,
            // and connect path skips offline items already present in history keys.
            // Still queue durable so raw WS clients / e2e see top-level events after reconnect.
            if (!skipOffline &&
                stamped.type !== 'AGENT_STREAM_CHUNK' &&
                stamped.type !== 'AGENT_STREAM_START' &&
                stamped.type !== 'AGENT_STREAM_SET' &&
                stamped.type !== 'AGENT_STREAM_END') {
                if (this.offlineQueue.length >= OFFLINE_QUEUE_MAX)
                    this.offlineQueue.shift();
                this.offlineQueue.push(stamped);
            }
        }
        else {
            this.broadcastRaw(stamped);
        }
        if (stamped.type === 'AGENT_CONFIRM') {
            const title = String(stamped.title ?? 'Approval needed');
            const message = String(stamped.message ?? '');
            void this.push?.notify(title, message).catch(() => { });
        }
    }
    /** Keep active stream snapshot in sync for projector path (not only sendStream*). */
    trackStreamState(ev) {
        if (!ev || !ev.type)
            return;
        switch (ev.type) {
            case 'AGENT_STREAM_START':
                this.activeStreamId = ev.streamId || this.activeStreamId;
                this.activeStreamAccum = '';
                break;
            case 'AGENT_STREAM_SET':
                this.activeStreamId = ev.streamId || this.activeStreamId;
                this.activeStreamAccum = String(ev.text ?? '');
                break;
            case 'AGENT_STREAM_CHUNK':
                this.activeStreamId = ev.streamId || this.activeStreamId;
                this.activeStreamAccum += String(ev.text ?? '');
                break;
            case 'AGENT_MESSAGE':
                if (ev.streamId) {
                    this.activeStreamId = ev.streamId;
                    if (typeof ev.text === 'string')
                        this.activeStreamAccum = ev.text;
                }
                break;
            case 'AGENT_STREAM_END':
                if (!ev.streamId || ev.streamId === this.activeStreamId) {
                    this.activeStreamId = null;
                    this.activeStreamAccum = '';
                }
                break;
            case 'COPILOT_DONE':
                this.activeStreamId = null;
                this.activeStreamAccum = '';
                break;
            default:
                break;
        }
    }
    sendStreamStart(streamId) {
        this.flushPendingChunk();
        this.activeStreamId = streamId;
        this.activeStreamAccum = '';
        this.broadcast({ type: 'AGENT_STREAM_START', streamId, timestamp: Date.now() });
    }
    sendStreamSet(streamId, text) {
        this.flushPendingChunk();
        this.activeStreamId = streamId;
        this.activeStreamAccum = text;
        this.broadcast({ type: 'AGENT_STREAM_SET', streamId, text, timestamp: Date.now() });
    }
    /** Append delta; coalesce via pendingChunk + throttle timer (~35ms) → AGENT_STREAM_CHUNK. */
    sendStreamChunk(delta, streamId) {
        if (this.currentStreamId !== streamId) {
            this.flushPendingChunk();
            this.currentStreamId = streamId;
        }
        this.pendingChunk = (this.pendingChunk ?? '') + delta;
        if (!this.chunkTimer) {
            this.chunkTimer = setTimeout(() => this.flushPendingChunk(), BridgeServer.CHUNK_THROTTLE_MS);
        }
    }
    flushPendingChunk() {
        if (this.chunkTimer) {
            clearTimeout(this.chunkTimer);
            this.chunkTimer = null;
        }
        if (this.pendingChunk === null)
            return;
        const ev = {
            type: 'AGENT_STREAM_CHUNK',
            text: this.pendingChunk,
            streamId: this.currentStreamId,
            timestamp: Date.now(),
        };
        this.sendToPhone(ev);
        this.pendingChunk = null;
        this.currentStreamId = null;
    }
    sendStreamEnd(streamId) {
        this.flushPendingChunk();
        const msg = {
            type: 'AGENT_MESSAGE',
            text: this.activeStreamAccum,
            streamId,
            timestamp: Date.now(),
        };
        this.pushHistory(msg);
        this.broadcastRaw({ type: 'AGENT_STREAM_END', streamId, timestamp: Date.now() });
        // Final snapshot for clients that only listen for AGENT_MESSAGE.
        this.broadcastRaw(msg);
        if (this.authorizedClientCount() === 0 && this.activeStreamAccum) {
            void this.push
                ?.notify('Copilot finished', this.activeStreamAccum.slice(0, 160))
                .catch(() => { });
        }
        this.activeStreamId = null;
        this.activeStreamAccum = '';
    }
    /**
     * Direct fan-out. Prefer sendToPhone for session events (offline queue + push).
     * Still used by extension/e2e; applies history filters for reconnect.
     */
    broadcast(ev) {
        if (!ev || isInternalSystemMessage(ev))
            return;
        if (ev.type === 'TUNNEL_URL') {
            const url = typeof ev.url === 'string' ? ev.url : null;
            if (url)
                this.setPublicUrl(url);
            return;
        }
        if (ev?.type === 'AGENT_CONFIRM')
            this.pendingConfirm = ev;
        this.trackStreamState(ev);
        this.pushHistory(ev);
        this.broadcastRaw(ev);
    }
    broadcastRaw(ev) {
        let s;
        try {
            s = JSON.stringify(ev);
        }
        catch (e) {
            console.warn('[sidecar bridge] unable to serialize event:', e?.message || e);
            return;
        }
        for (const c of this.clients) {
            if (this.authToken && this.clientAuth.get(c) !== true)
                continue;
            if (c.readyState !== ws_1.WebSocket.OPEN) {
                this.clients.delete(c);
                this.clientAuth.delete(c);
                this.emitClientCount();
                continue;
            }
            try {
                if (c.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
                    console.warn('[sidecar bridge] slow client exceeded WebSocket buffer limit');
                    this.clients.delete(c);
                    this.clientAuth.delete(c);
                    try {
                        c.terminate();
                    }
                    catch { /* ignore */ }
                    this.emitClientCount();
                    continue;
                }
                c.send(s, (err) => {
                    if (err) {
                        this.clients.delete(c);
                        this.clientAuth.delete(c);
                        try {
                            c.terminate();
                        }
                        catch { /* ignore */ }
                        this.emitClientCount();
                    }
                });
            }
            catch (e) {
                console.warn('[sidecar bridge] send failed, removing client:', e?.message || e);
                this.clients.delete(c);
                this.clientAuth.delete(c);
                try {
                    c.terminate();
                }
                catch { /* ignore */ }
                this.emitClientCount();
            }
        }
    }
    send(ws, ev) {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            try {
                if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
                    this.clients.delete(ws);
                    this.clientAuth.delete(ws);
                    try {
                        ws.terminate();
                    }
                    catch { /* ignore */ }
                    this.emitClientCount();
                    return;
                }
                ws.send(JSON.stringify(ev), (err) => {
                    if (err) {
                        this.clients.delete(ws);
                        this.clientAuth.delete(ws);
                        try {
                            ws.terminate();
                        }
                        catch { /* ignore */ }
                        this.emitClientCount();
                    }
                });
            }
            catch (e) {
                this.clients.delete(ws);
                this.clientAuth.delete(ws);
                try {
                    ws.terminate();
                }
                catch { /* ignore */ }
                this.emitClientCount();
            }
        }
    }
    pushHistory(ev) {
        if (!ev || HISTORY_SKIP.has(ev.type))
            return;
        if (isInternalSystemMessage(ev))
            return;
        // Cap large text fields so HISTORY_REPLAY stays phone-friendly over tunnels.
        let stored = ev;
        if (typeof ev.text === 'string' && ev.text.length > HISTORY_TEXT_MAX) {
            stored = { ...ev, text: ev.text.slice(0, HISTORY_TEXT_MAX) + '\n…(truncated)' };
        }
        const key = eventDedupeKey(stored);
        // Replace last identical key instead of appending duplicates (reconnect / re-emit).
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (eventDedupeKey(this.history[i]) === key) {
                this.history[i] = stored;
                return;
            }
        }
        this.history.push(stored);
        while (this.history.length > HISTORY_MAX)
            this.history.shift();
    }
    rememberPhoneText(text) {
        const t = (text || '').trim();
        if (!t)
            return;
        this.recentPhoneTexts.push({ text: t, at: Date.now(), used: 0 });
        while (this.recentPhoneTexts.length > PHONE_ECHO_MAX)
            this.recentPhoneTexts.shift();
    }
    /**
     * 手机发出的用户消息：写入 history、广播给所有客户端，并登记 echo 抑制。
     * 必须在 rememberPhoneText 之前 push/broadcast，避免被 isPhoneEcho 误杀。
     * requestId 省略 → PWA 用 `user:${text.slice(0,160)}` 与乐观渲染去重。
     */
    acceptPhoneUserMessage(text) {
        const t = (text || '').trim();
        if (!t)
            return;
        const ev = {
            type: 'USER_MESSAGE',
            text: t,
            timestamp: Date.now(),
            fromPhone: true,
        };
        this.pushHistory(ev);
        this.broadcastRaw(ev);
        this.rememberPhoneText(t);
    }
    isPhoneEcho(ev) {
        if (ev?.fromPhone)
            return false;
        if (ev?.foreign)
            return false;
        const t = String(ev?.text || '').trim();
        if (!t)
            return false;
        const now = Date.now();
        while (this.recentPhoneTexts.length && now - this.recentPhoneTexts[0].at > PHONE_ECHO_WINDOW_MS) {
            this.recentPhoneTexts.shift();
        }
        // 同一条手机文本可能产生多个镜像源（transcript + chatSessions + 兜底），
        // 每条最多吞 PHONE_ECHO_SUPPRESS_PER_TEXT 次，之后视为真实新消息放行。
        const hit = this.recentPhoneTexts.find((x) => x.text === t && x.used < PHONE_ECHO_SUPPRESS_PER_TEXT);
        if (!hit)
            return false;
        hit.used += 1;
        return true;
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            for (const ws of [...this.clients]) {
                if (ws._alive === false) {
                    try {
                        ws.terminate();
                    }
                    catch { /* ignore */ }
                    this.clients.delete(ws);
                    continue;
                }
                ws._alive = false;
                try {
                    ws.ping();
                    // 应用层心跳：浏览器拿不到协议层 ping/pong 帧，客户端只能靠 inbound
                    // JSON 消息感知链路活性。前台空闲时半死 socket readyState 仍 OPEN
                    // → ws.send 静默吞消息；一条周期 PING 让客户端能在 ~30s 内识别断链。
                    if (ws.readyState === ws_1.WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
                    }
                }
                catch {
                    try {
                        ws.terminate();
                    }
                    catch { /* ignore */ }
                    this.clients.delete(ws);
                }
            }
            this.emitClientCount();
        }, HEARTBEAT_MS);
    }
    /** Original dispose: clear heartbeat/chunk and close sockets. */
    dispose() {
        this.clearTimers();
        for (const c of this.clients) {
            try {
                c.terminate();
            }
            catch { /* ignore */ }
        }
        try {
            this.wss?.close();
        }
        catch { /* ignore */ }
        try {
            this.server?.close();
        }
        catch { /* ignore */ }
        this.clients.clear();
        this.clientAuth.clear();
        this.wss = undefined;
        this.server = undefined;
    }
    async stop() {
        this.clearTimers();
        for (const c of this.clients) {
            try {
                c.terminate();
            }
            catch { /* ignore */ }
        }
        this.clients.clear();
        this.clientAuth.clear();
        this.emitClientCount();
        await new Promise((resolve) => {
            if (!this.wss)
                return resolve();
            this.wss.close(() => resolve());
        });
        await new Promise((resolve) => {
            if (!this.server)
                return resolve();
            this.server.close(() => resolve());
        });
        this.wss = undefined;
        this.server = undefined;
    }
    clearTimers() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.chunkTimer) {
            clearTimeout(this.chunkTimer);
            this.chunkTimer = null;
        }
        this.pendingChunk = null;
        this.currentStreamId = null;
        this.activeStreamId = null;
        this.activeStreamAccum = '';
    }
    emitClientCount() {
        try {
            this.onClientCount?.(this.authorizedClientCount());
        }
        catch (e) {
            console.warn('[sidecar bridge] client-count callback failed:', e?.message || e);
        }
    }
    authorizedClientCount() {
        if (!this.authToken)
            return this.clients.size;
        let count = 0;
        for (const ws of this.clients) {
            if (this.clientAuth.get(ws) === true)
                count += 1;
        }
        return count;
    }
    async dispatchPhoneHandlers(msg) {
        const run = this.phoneHandlerTail.then(async () => {
            for (const h of this.handlers) {
                try {
                    await h(msg);
                }
                catch (e) {
                    console.error('[sidecar bridge] handler error:', e?.message || e);
                }
            }
        });
        this.phoneHandlerTail = run.catch(() => { });
        await run;
    }
    async dispatchRequestHandlers(msg, reply) {
        const run = this.requestHandlerTail.then(async () => {
            for (const h of this.requestHandlers) {
                try {
                    await h(msg, reply);
                }
                catch (e) {
                    reply({
                        type: 'SYSTEM_MESSAGE',
                        text: `${msg.type} failed: ${e?.message || e}`,
                    });
                }
            }
        });
        this.requestHandlerTail = run.catch(() => { });
        await run;
    }
    handleHttp(req, res) {
        const fullUrl = req.url || '/';
        if (fullUrl.length > MAX_HTTP_REQUEST_URL_LENGTH) {
            res.writeHead(414, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('request URI too long');
            return;
        }
        const qIdx = fullUrl.indexOf('?');
        const raw = (qIdx >= 0 ? fullUrl.slice(0, qIdx) : fullUrl) || '/';
        const query = qIdx >= 0 ? fullUrl.slice(qIdx + 1) : '';
        const params = new URLSearchParams(query);
        const urlTok = params.get('token') || undefined;
        const cookieTok = cookieValue(req.headers.cookie, 'sidecar_auth');
        const httpTok = urlTok || cookieTok;
        if (raw === '/health' || raw === '/api/health') {
            if (this.authToken && !safeCompareTokens(httpTok, this.authToken)) {
                res.writeHead(401, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                });
                res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
                return;
            }
            const pwaIndex = this.resolvePwaIndex();
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
            });
            res.end(JSON.stringify({
                ok: true,
                name: 'copilot-sidecar-companion',
                clients: this.authorizedClientCount(),
                port: this._port,
                publicUrl: this.publicUrl,
                tokenPresent: !!this.authToken,
                vapidPublicKey: this.vapidPublicKey,
                offlineQueued: this.offlineQueue.length,
                pwaOk: !!pwaIndex,
            }));
            return;
        }
        // 0.5.21：开了 auth 时访问 / 却不带 token → 引导页（避免 PWA 一直 connecting）
        // 0.5.39：完整 token 链接仅对本机请求展示；LAN/隧道来源只给脱敏 token + 扫码引导，
        // 防止未鉴权页面把 authToken 泄露给同网段/公网任意访问者。
        if (this.authToken &&
            (raw === '/' || raw === '/index.html') &&
            !safeCompareTokens(httpTok, this.authToken)) {
            const ra = String(req.socket.remoteAddress || '');
            const masked = this.authToken.length > 8
                ? `${this.authToken.slice(0, 4)}…${this.authToken.slice(-2)}`
                : '****';
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            });
            res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>需要 Token</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#1e1e1e;color:#ddd;padding:24px;line-height:1.5}
code{background:#333;padding:2px 6px;border-radius:4px}
.box{background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:16px;margin:12px 0}
.warn{color:#ffcc66}
</style></head><body>
<h1>无法连接：缺少 Token</h1>
<p class="warn">这个 bridge 开启了鉴权。打开页面时 URL 必须带 <code>?token=…</code>，否则 WebSocket 会鉴权失败并一直显示 connecting。</p>
<div class="box">
<p>当前 token 形如 <code>${escapeHtml(masked)}</code>（已脱敏，出于安全本页面不提供完整值）。</p>
<p><b>获取完整链接：</b>在 VS Code 侧栏 <b>Copilot Lazy Ass</b> 面板扫二维码，或运行命令 <code>Copilot Lazy Ass: Copy PWA URL</code>（含 <code>?token=…</code>）。</p>
</div>
<p style="opacity:.7;font-size:12px">port ${this._port} · auth required · ${escapeHtml(ra || 'unknown')}</p>
</body></html>`);
            return;
        }
        const pwaRoot = this.resolvePwaRoot();
        if (!pwaRoot) {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('copilot-sidecar-companion bridge\n' +
                'PWA assets missing. Reload VS Code window after installing/updating the extension.\n' +
                `configured pwaDir=${this.pwaDir || '(none)'}\n`);
            return;
        }
        let rel = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
        // strip accidental absolute-looking segments
        rel = path.normalize(rel).replace(/^(\.\.(?:[/\\]|$))+/, '').replace(/^[/\\]+/, '');
        if (!rel || rel === '.')
            rel = 'index.html';
        const root = path.resolve(pwaRoot);
        const file = path.resolve(root, rel);
        if (file !== root && !file.startsWith(root + path.sep)) {
            res.writeHead(403);
            res.end('forbidden');
            return;
        }
        const sendFile = (abs) => {
            const ext = path.extname(abs);
            const headers = {
                'content-type': MIME[ext] || 'application/octet-stream',
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
                'content-security-policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' https://cdnjs.cloudflare.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
                // app shell 不缓存，避免一直 connecting 时还在跑旧 app.js
                'cache-control': ext === '.js' || ext === '.css' || ext === '.html' ? 'no-cache' : 'public, max-age=60',
            };
            // A token-bearing navigation establishes a same-origin HttpOnly cookie so
            // an installed PWA can reopen at start_url "/" without putting the token
            // back in its address bar. The cookie is never returned in page content.
            if (this.authToken && safeCompareTokens(urlTok, this.authToken)) {
                headers['set-cookie'] = 'sidecar_auth=' + encodeURIComponent(this.authToken) + '; Path=/; SameSite=Strict; HttpOnly';
            }
            res.writeHead(200, headers);
            const stream = fs.createReadStream(abs);
            stream.on('error', () => {
                if (!res.headersSent)
                    res.writeHead(404);
                if (!res.writableEnded)
                    res.end('not found');
            });
            stream.pipe(res);
        };
        try {
            const realRoot = fs.realpathSync(root);
            const realFile = fs.realpathSync(file);
            if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
                res.writeHead(403);
                res.end('forbidden');
                return;
            }
            if (fs.statSync(realFile).isFile()) {
                sendFile(realFile);
                return;
            }
        }
        catch {
            // Missing/unreadable files fall through to the SPA fallback below.
        }
        // SPA fallback to index.html for unknown paths
        const index = path.join(root, 'index.html');
        try {
            const realRoot = fs.realpathSync(root);
            const realIndex = fs.realpathSync(index);
            if (realIndex !== realRoot && !realIndex.startsWith(realRoot + path.sep)) {
                res.writeHead(403);
                res.end('forbidden');
                return;
            }
            if (fs.statSync(realIndex).isFile()) {
                sendFile(realIndex);
                return;
            }
        }
        catch {
            // Fall through to 404.
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`not found\npwaRoot=${root}\nrequest=${raw}\n`);
    }
    /** Resolve usable PWA directory (must contain index.html). */
    resolvePwaRoot() {
        const candidates = [];
        if (this.pwaDir)
            candidates.push(this.pwaDir);
        // common layout fallovers if extension was updated and old folder deleted
        try {
            const home = os.homedir();
            const extRoot = path.join(home, '.vscode', 'extensions');
            if (fs.existsSync(extRoot)) {
                const dirs = fs
                    .readdirSync(extRoot)
                    .filter((d) => d.startsWith('local-dev.copilot-sidecar-companion-'))
                    .sort()
                    .reverse();
                for (const d of dirs) {
                    candidates.push(path.join(extRoot, d, 'media', 'pwa'));
                }
            }
        }
        catch {
            // ignore
        }
        for (const c of candidates) {
            try {
                const index = path.join(c, 'index.html');
                if (fs.existsSync(index) && fs.statSync(index).isFile()) {
                    if (c !== this.pwaDir) {
                        // self-heal for hot-updated installs without window reload
                        this.pwaDir = c;
                    }
                    return c;
                }
            }
            catch {
                // continue
            }
        }
        return undefined;
    }
    resolvePwaIndex() {
        const root = this.resolvePwaRoot();
        if (!root)
            return undefined;
        const index = path.join(root, 'index.html');
        return fs.existsSync(index) ? index : undefined;
    }
}
exports.BridgeServer = BridgeServer;
function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function safeCompareTokens(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}
function tokenFromReqUrl(url) {
    if (!url)
        return undefined;
    try {
        const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const params = new URLSearchParams(q);
        return params.get('token') || undefined;
    }
    catch {
        return undefined;
    }
}
function cookieValue(header, name) {
    if (!header)
        return undefined;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0 || part.slice(0, idx).trim() !== name)
            continue;
        try {
            return decodeURIComponent(part.slice(idx + 1).trim()) || undefined;
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}
//# sourceMappingURL=bridge.js.map