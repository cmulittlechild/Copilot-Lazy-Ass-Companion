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
const PHONE_ECHO_WINDOW_MS = 30_000;
const PHONE_ECHO_MAX = 20;
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
    activeStreamId = null;
    activeStreamAccum = '';
    /** Recent PHONE_MESSAGE texts — suppress JSONL USER_MESSAGE echo back to phone. */
    recentPhoneTexts = [];
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
        this.preferredPort = opts.port;
        this._port = opts.port;
        this.portRange = Math.max(0, opts.portRange ?? 20);
        this.authToken = opts.authToken;
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
        return this.clients.size;
    }
    /** Original WsServer alias. */
    get connectedCount() {
        return this.clients.size;
    }
    get authTokenPresent() {
        return !!this.authToken;
    }
    getAuthToken() {
        return this.authToken;
    }
    setAuthToken(token) {
        this.authToken = token || undefined;
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
            const wss = new ws_1.WebSocketServer({ server, perMessageDeflate: false });
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
        // Minimal hello — no "connected" SYSTEM_MESSAGE spam; no history until PHONE_CONNECT.
        this.send(ws, { type: 'AGENT_LIST', agents: ['GitHub Copilot'], active: 'GitHub Copilot' });
        // TUNNEL_URL once per socket open (not again on PHONE_CONNECT; not in history).
        if (this.publicUrl) {
            this.send(ws, { type: 'TUNNEL_URL', url: this.publicUrl });
        }
        const urlTok = tokenFromReqUrl(req.url);
        let authed = !this.authToken;
        if (this.authToken && urlTok && urlTok === this.authToken)
            authed = true;
        /** Per-socket: HISTORY_REPLAY only once (reconnect = new socket → once again). */
        let historyReplayed = false;
        ws.on('message', async (data) => {
            let msg;
            try {
                msg = JSON.parse(String(data));
            }
            catch {
                return;
            }
            if (msg.type === 'PHONE_PUSH_SUBSCRIBE') {
                this.push?.addSubscription(msg.subscription);
                return;
            }
            if (msg.type === 'PHONE_MESSAGE' && typeof msg.text === 'string') {
                // 先入 history + 广播 USER_MESSAGE，再记 echo。
                // 否则 isPhoneEcho 会把「手机自己的问题」从 live/history 里抹掉，
                // 只剩助手回复（切会话 / 重连 HISTORY_REPLAY 后尤其明显）。
                // JSONL 回读仍靠 rememberPhoneText 在 30s 内抑制重复气泡。
                this.acceptPhoneUserMessage(msg.text);
            }
            if (msg.type === 'PHONE_CONNECT') {
                if (this.authToken) {
                    const tok = msg.token ?? urlTok;
                    if (tok !== this.authToken) {
                        this.send(ws, { type: 'SYSTEM_MESSAGE', text: 'auth failed' });
                        try {
                            ws.close();
                        }
                        catch { /* ignore */ }
                        return;
                    }
                    authed = true;
                }
                for (const h of this.handlers)
                    await h(msg);
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
            if (this.authToken && !authed) {
                this.send(ws, { type: 'SYSTEM_MESSAGE', text: 'auth required — send PHONE_CONNECT' });
                return;
            }
            // 请求-响应消息：回发到当前 socket，不进入普通广播 handler
            if (REQUEST_TYPES.has(msg.type)) {
                const reply = (ev) => this.send(ws, ev);
                for (const h of this.requestHandlers) {
                    try {
                        await h(msg, reply);
                    }
                    catch (e) {
                        this.send(ws, {
                            type: 'SYSTEM_MESSAGE',
                            text: `${msg.type} failed: ${e?.message || e}`,
                        });
                    }
                }
                return;
            }
            if (msg.type === 'PHONE_CONFIRM') {
                this.pendingConfirm = null;
                this.broadcast({ type: 'AGENT_CONFIRM_RESOLVED', button: msg.button });
            }
            for (const h of this.handlers)
                await h(msg);
        });
        ws.on('pong', () => { ws._alive = true; });
        ws.on('close', () => { this.clients.delete(ws); this.emitClientCount(); });
        ws.on('error', () => { this.clients.delete(ws); this.emitClientCount(); });
    }
    setPublicUrl(url) {
        const next = url || null;
        // Dedup: tunnel logs / applyPublicUrl may fire repeatedly with same URL.
        if (this.publicUrl === next)
            return;
        this.publicUrl = next;
        if (next) {
            // Live notify only — never pushHistory (would spam every reconnect replay).
            this.broadcastRaw({ type: 'TUNNEL_URL', url: next, timestamp: Date.now() });
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
        if (ev.type === 'USER_MESSAGE' &&
            typeof ev.text === 'string' &&
            this.isPhoneEcho(ev.text)) {
            return;
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
        if (this.clients.size === 0) {
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
        this.activeStreamId = streamId;
        this.activeStreamAccum = '';
        this.broadcast({ type: 'AGENT_STREAM_START', streamId, timestamp: Date.now() });
    }
    sendStreamSet(streamId, text) {
        this.activeStreamId = streamId;
        this.activeStreamAccum = text;
        this.broadcast({ type: 'AGENT_STREAM_SET', streamId, text, timestamp: Date.now() });
    }
    /** Append delta; coalesce via pendingChunk + setImmediate → AGENT_STREAM_CHUNK. */
    sendStreamChunk(delta, streamId) {
        this.activeStreamAccum += delta;
        if (this.pendingChunk !== null && this.currentStreamId === streamId) {
            this.pendingChunk += delta;
        }
        else {
            this.flushPendingChunk();
            this.pendingChunk = delta;
            this.currentStreamId = streamId;
            this.chunkTimer = setImmediate(() => this.flushPendingChunk());
        }
    }
    flushPendingChunk() {
        if (this.pendingChunk === null)
            return;
        const ev = {
            type: 'AGENT_STREAM_CHUNK',
            text: this.pendingChunk,
            streamId: this.currentStreamId,
            timestamp: Date.now(),
        };
        this.broadcastRaw(ev);
        this.pendingChunk = null;
        this.currentStreamId = null;
        if (this.chunkTimer) {
            clearImmediate(this.chunkTimer);
            this.chunkTimer = null;
        }
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
        if (this.clients.size === 0 && this.activeStreamAccum) {
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
        const s = JSON.stringify(ev);
        for (const c of this.clients) {
            if (c.readyState === ws_1.WebSocket.OPEN)
                c.send(s);
        }
    }
    send(ws, ev) {
        if (ws.readyState === ws_1.WebSocket.OPEN)
            ws.send(JSON.stringify(ev));
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
        this.recentPhoneTexts.push({ text: t, at: Date.now() });
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
    isPhoneEcho(text) {
        const t = (text || '').trim();
        if (!t)
            return false;
        const now = Date.now();
        while (this.recentPhoneTexts.length && now - this.recentPhoneTexts[0].at > PHONE_ECHO_WINDOW_MS) {
            this.recentPhoneTexts.shift();
        }
        return this.recentPhoneTexts.some((x) => x.text === t);
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
        try {
            this.wss?.close();
        }
        catch { /* ignore */ }
        try {
            this.server?.close();
        }
        catch { /* ignore */ }
        this.clients.clear();
        this.wss = undefined;
        this.server = undefined;
    }
    async stop() {
        this.clearTimers();
        for (const c of this.clients) {
            try {
                c.close();
            }
            catch { /* ignore */ }
        }
        this.clients.clear();
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
            clearImmediate(this.chunkTimer);
            this.chunkTimer = null;
        }
        this.pendingChunk = null;
        this.currentStreamId = null;
    }
    emitClientCount() {
        this.onClientCount?.(this.clients.size);
    }
    handleHttp(req, res) {
        const raw = (req.url || '/').split('?')[0] || '/';
        if (raw === '/health' || raw === '/api/health') {
            const pwaIndex = this.resolvePwaIndex();
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                ok: true,
                name: 'copilot-sidecar-companion',
                clients: this.clients.size,
                port: this._port,
                publicUrl: this.publicUrl,
                tokenPresent: !!this.authToken,
                vapidPublicKey: this.vapidPublicKey,
                offlineQueued: this.offlineQueue.length,
                // 诊断字段：处理器注册数。
                // requestHandlers=0 说明扩展 start() 在 onRequest() 之前就中断了，
                // 此时 PHONE_SESSION_LIST 等请求会被 dispatch 吞掉且永不回包。
                messageHandlers: this.handlers.length,
                requestHandlers: this.requestHandlers.length,
                pwaDir: this.pwaDir || null,
                pwaOk: !!pwaIndex,
            }));
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
            res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
            fs.createReadStream(abs).pipe(res);
        };
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            sendFile(file);
            return;
        }
        // SPA fallback to index.html for unknown paths
        const index = path.join(root, 'index.html');
        if (fs.existsSync(index) && fs.statSync(index).isFile()) {
            sendFile(index);
            return;
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
//# sourceMappingURL=bridge.js.map