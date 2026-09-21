"use strict";
/**
 * TranscriptWatcher — 毫秒级实时会话事件流数据源。
 *
 * VS Code 新版 Copilot 把会话事件实时追加写入
 * `<workspaceStorage>/<wsHash>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl`，
 * 每行一个 JSON 事件（session.start / user.message / assistant.turn_start /
 * assistant.message / tool.execution_* / assistant.turn_end），timestamp 单调递增，
 * 行序 = 时间序 = 重放序。
 *
 * 本模块纯 node fs 逻辑（不依赖 vscode），做字节偏移 tail + fs.watch + poll 兜底，
 * 把事件流投影成手机 PWA 可消费的 PhoneEvent（与 chatSessions 60s 落盘旧源相比是
 * 毫秒级实时）。assistant.message 是完整快照（非增量）：同一 messageId 的 content
 * 会随流式输出被多次重写变长，因此对相邻快照做前缀 diff，输出 AGENT_STREAM_CHUNK
 * 增量实现打字机效果；无法判定增长时回退 AGENT_STREAM_SET 整段覆盖。
 * thinking 与正文是两条独立 message。
 */
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
exports.TranscriptWatcher = void 0;
exports.findTranscriptsDir = findTranscriptsDir;
exports.findChatSessionsDir = findChatSessionsDir;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const jsonl_1 = require("./jsonl");
/** 重新扫描目录找最新文件的周期 ms */
const RESCAN_MS = 2000;
/** fs.watch 触发 → tail 的防抖 ms（追加频率高时合并读取） */
const WATCH_DEBOUNCE_MS = 25;
/** 超过该大小视为历史大文件，只 tail 尾部 1MB */
const BIG_FILE_BYTES = 5 * 1024 * 1024;
/** 大文件回退读取的尾部字节数 */
const TAIL_BYTES = 1024 * 1024;
/** 同 size 但 mtime 前进时认为发生了原地重写，回退读取的最后一行上限 */
const REREAD_LAST_LINE_BYTES = 64 * 1024;
/** user.message ±3s 窗口：同一时刻批量派生的子代理消息只保留第一条 */
const DUP_USER_MS = 3000;
/** replay 模式：从尾部回放的最近用户消息轮次数 */
const REPLAY_USER_TURNS = 10;
/** unknown → Record 收窄 */
function asRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
        ? v
        : null;
}
/** unknown → string 收窄 */
function asString(v) {
    return typeof v === 'string' ? v : null;
}
/**
 * 内部子代理派生消息过滤：
 * - content 以 `[Terminal` / `[Session` / `[Task` / `[Notification` 开头
 * - 或 content 包含 "notification:"（真实样例: "[Terminal <uuid> notification: ..."）
 * 这类 user.message 是 agent 内部派生的（子代理任务/终端通知），不应显示为手机端用户输入。
 */
function isInternalUserMessage(content) {
    return (content.startsWith('[Terminal') ||
        content.startsWith('[Session') ||
        content.startsWith('[Task') ||
        content.startsWith('[Notification') ||
        content.includes('notification:'));
}
/**
 * 会话事件流 → PhoneEvent 投影器。
 *
 * 状态机：
 * - turnSeq：每轮 assistant.turn_start 递增，作为 requestIndex 与 streamId 编号（'t'+turnSeq）
 * - activeStreamId：当前流式消息（第一条有 content 的 assistant.message 时建立）
 * - streamAccum：最新一条正文完整快照（每条 assistant.message 都是完整 markdown）
 * - pendingReasoning：当前 turn 的 thinking 缓冲（thinking 与正文是分开的 message）
 * - toolStates：toolCallId → { text: 工具名, requestIndex }，供 execution_complete 回填
 * - seenMessageIds：assistant.message 辅助事件（reasoning/tools）去重（文件重读/重放安全）
 * - lastContentByMessageId：messageId → 已见到的最大 content 快照，前缀增长 → CHUNK 增量
 * - lastEmittedTextByStream：streamId → 已发出的累计文本，新消息增量对比基准
 */
class TranscriptWatcher {
    opts;
    /** 当前监控的最新 transcript 文件（绝对路径） */
    get currentFile() {
        return this.current;
    }
    /**
     * 手动选择会话后 pin 住目标文件：
     * 周期 rescan（scanNewestBoth）在 pin 期间不再按 mtime 自动切换，
     * 否则手机端切到别的会话后会被「项目学习与理解」的最新 mtime 抢回来。
     * 切回按钮/重新选择目标会话即可解除（再次 bindFile 会覆盖 pin）。
     */
    pinFile(file) {
        this.pinnedFile = file ? path.normalize(file) : null;
    }
    /** 字节偏移 tail */
    current;
    /** 手动 pin 的会话文件（scanNewestBoth 期间不自动切换）；null = 未 pin */
    pinnedFile = null;
    offset = 0;
    /** 半行缓冲（文件尾的不完整 JSON 行等 \n 补齐） */
    pending = '';
    lastSize = 0;
    lastMtimeMs = 0;
    /** 已处理行指纹（长度+首64+尾32），防同 size 原地重写导致重复处理 */
    lastLineFp = '';
    /** 起始偏移落在行中间时，第一块的首行（半行）要丢弃 */
    skipFirstLine = false;
    fileWatcher;
    dirWatcher;
    watchDebounce;
    pollTimer;
    rescanTimer;
    disposed = false;
    pollMs;
    /** chatSessions 兜底轮询间隔 ms */
    fallbackPollMs;
    // ---- chatSessions 兜底源状态（双源融合：transcripts 实时为主，chatSessions 兜底补缺失回复）----
    /** chatSessions 投影器（复用 JsonlProjector：kind0/kind2 → PhoneEvent） */
    fallbackProjector = new jsonl_1.JsonlProjector();
    /** 当前兜底对应的 chatSessions 文件 */
    fallbackFile;
    /** chatSessions 文件字节偏移 */
    fallbackOffset = 0;
    /** chatSessions 半行缓冲（写入中的不完整 JSON 行） */
    fallbackPending = '';
    /** 兜底轮询定时器 */
    fallbackTimer;
    /** 当前绑定的 transcript 会话 id 基名（8304329e-xxx.jsonl → 8304329e-xxx.jsonl） */
    boundSessionBase;
    /** 已投影过的 chatSessions 请求 id（去重，防全量重写重复处理） */
    fallbackSeenRequestIds = new Set();
    // ---- 事件 → PhoneEvent 映射状态 ----
    activeTurnId = null;
    turnSeq = 0;
    activeStreamId = null;
    streamAccum = '';
    pendingReasoning = [];
    toolStates = new Map();
    seenMessageIds = new Set();
    /** messageId → 该消息已见到的最大 content 快照（同一 messageId 重写变长 → 前缀 diff 发增量） */
    lastContentByMessageId = new Map();
    /** streamId → 已发出的累计文本（新消息 content 是它的前缀增长 → CHUNK，否则 SET 兜底） */
    lastEmittedTextByStream = new Map();
    /** 最近一条保留的 user.message 时间戳（ms），用于 ±3s 派生消息去重 */
    lastUserTsMs = null;
    constructor(opts) {
        this.opts = opts;
        this.pollMs = Math.max(10, opts.pollMs ?? 100);
        this.fallbackPollMs = Math.max(100, opts.fallbackPollMs ?? 2000);
    }
    /**
     * 启动：扫描目录选最新 .jsonl → 绑定 → tail + fs.watch + poll 兜底 + rescan 定时器。
     */
    start() {
        if (this.disposed)
            return;
        this.scanNewestBoth();
        // poll 兜底：fs.watch 在某些平台/场景（网络盘、部分文件系统）不可靠
        this.pollTimer = setInterval(() => this.tail(), this.pollMs);
        // 周期 rescan：新会话文件出现时切换（双源：transcripts + chatSessions）
        this.rescanTimer = setInterval(() => this.scanNewestBoth(), RESCAN_MS);
    }
    dispose() {
        this.disposed = true;
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        if (this.rescanTimer)
            clearInterval(this.rescanTimer);
        if (this.watchDebounce)
            clearTimeout(this.watchDebounce);
        this.pollTimer = undefined;
        this.rescanTimer = undefined;
        this.watchDebounce = undefined;
        // 兜底源清理：解绑 + 清投影器内部 debounce 定时器
        this.unbindFallback();
        this.fallbackProjector.dispose();
        this.closeWatchers();
    }
    /**
     * 绑定文件：
     * - 默认 live-only：偏移 = EOF（纯实时，不重放历史）
     * - 文件 >5MB：从尾部 1MB 开始（防历史洪水，能立即看到进行中轮次）
     * - replay=true（切会话回放）：从文件尾部第 N 个 user.message 行开始全量解析，
     *   让手机端切到旧会话时能看到最近几轮历史
     * 切换文件时发 internal SYSTEM_MESSAGE 通知。
     */
    bindFile(file, opts) {
        this.current = file;
        // 再次 bindFile（如用户重新选择）即解除 pin，允许后续自动跟随
        this.pinnedFile = null;
        this.pending = '';
        this.resetState();
        this.lastLineFp = '';
        this.skipFirstLine = false;
        // 会话基名 + chatSessions 兜底源联动：同名文件存在则绑定（立即 catch-up 补历史缺失回复），否则解绑
        this.boundSessionBase = path.basename(file);
        if (this.opts.chatSessionsDir) {
            const csFile = path.join(this.opts.chatSessionsDir, this.boundSessionBase);
            if (fs.existsSync(csFile)) {
                this.bindFallback(csFile);
            }
            else {
                this.unbindFallback();
            }
        }
        else {
            this.unbindFallback();
        }
        let st;
        try {
            st = fs.statSync(file);
        }
        catch {
            st = undefined;
        }
        const size = st?.size ?? 0;
        let startOffset = size; // live-only：EOF
        let mode = 'live';
        if (opts?.replay) {
            startOffset = this.findReplayOffset(file, size);
            // findReplayOffset 返回精确行首偏移，无需 skip；只有非 0 且非行首才 skip
            this.skipFirstLine = false;
            mode = 'replay (last user turns)';
        }
        else if (size > BIG_FILE_BYTES) {
            startOffset = Math.max(0, size - TAIL_BYTES);
            this.skipFirstLine = true;
            mode = `live, tail ${Math.round(TAIL_BYTES / 1024)}KB`;
        }
        this.offset = startOffset;
        this.lastSize = size;
        this.lastMtimeMs = st?.mtimeMs ?? 0;
        this.emit({
            type: 'SYSTEM_MESSAGE',
            text: `Watching transcript: ${path.basename(file)} (${mode})`,
            visibility: 'internal',
            internal: true,
        });
        this.bindWatchers(file);
        this.tail(); // 立即读一次（replay / 尾部 1MB 场景立刻出内容；EOF 场景无增量）
    }
    /**
     * replay 模式起点：从文件尾部往前找最近 N 个 user.message 行的第一个的行首偏移。
     * 全文件扫描行号（只记录 user.message 行），取倒数第 N 个的字节偏移。
     */
    findReplayOffset(file, size) {
        const N = REPLAY_USER_TURNS;
        try {
            const fd = fs.openSync(file, 'r');
            try {
                // 大文件只扫尾部 4MB（最近的 user.message 一定在里面）
                const tailLen = Math.min(size, 4 * 1024 * 1024);
                const buf = Buffer.alloc(tailLen);
                fs.readSync(fd, buf, 0, tailLen, size - tailLen);
                const s = buf.toString('utf8');
                const lines = s.split('\n');
                const userOffsets = [];
                let running = size - tailLen;
                for (const line of lines) {
                    if (!line.trim()) {
                        running += line.length + 1;
                        continue;
                    }
                    try {
                        const obj = JSON.parse(line);
                        if (obj?.type === 'user.message' && obj?.data?.content) {
                            userOffsets.push(running);
                        }
                    }
                    catch {
                        // 半行忽略
                    }
                    running += line.length + 1;
                }
                if (!userOffsets.length)
                    return 0;
                // 取倒数第 N 个起点（向前多取一个用户消息，保证工具轮次完整）
                const idx = Math.max(0, userOffsets.length - N - 1);
                return userOffsets[idx];
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch {
            return 0;
        }
    }
    // ---------------------------------------------------------------- 目录扫描
    /** 在指定目录里选 mtime 最大的 .jsonl（= 最新会话文件） */
    newestInDir(dir) {
        let entries = [];
        try {
            entries = fs.readdirSync(dir);
        }
        catch {
            return undefined;
        }
        let newest;
        for (const name of entries) {
            if (!name.endsWith('.jsonl'))
                continue;
            const full = path.join(dir, name);
            try {
                const st = fs.statSync(full);
                if (!st.isFile())
                    continue;
                if (!newest || st.mtimeMs > newest.mtimeMs) {
                    newest = { name, mtimeMs: st.mtimeMs };
                }
            }
            catch {
                /* 不可读/已删除，忽略 */
            }
        }
        return newest;
    }
    /**
     * 双源会话跟随：同时看 transcripts 与 chatSessions 目录，比较两者各自最新文件的
     * mtime，选更大的作为活跃会话，绑定其 transcripts 文件（并联动 chatSessions 兜底）。
     * 多标签场景：即使 transcripts 目录里 A 最新，只要 chatSessions 目录里 B 更新（mtime
     * 更大），就切到 B 的 transcripts（同时 bindFallback B 的 chatSessions）。
     */
    scanNewestBoth() {
        if (this.disposed)
            return;
        // 手动 pin 的会话优先：期间绝不自动切换（否则手机端选中的会话会被最新 mtime 抢回）
        if (this.pinnedFile) {
            if (this.current !== this.pinnedFile && fs.existsSync(this.pinnedFile)) {
                this.bindFile(this.pinnedFile);
            }
            return;
        }
        const t = this.newestInDir(this.opts.dir);
        const cs = this.opts.chatSessionsDir ? this.newestInDir(this.opts.chatSessionsDir) : undefined;
        let base;
        let bestMtime = -1;
        if (t && t.mtimeMs > bestMtime) {
            base = t.name;
            bestMtime = t.mtimeMs;
        }
        if (cs && cs.mtimeMs > bestMtime) {
            base = cs.name;
            bestMtime = cs.mtimeMs;
        }
        if (!base)
            return;
        const tfile = path.join(this.opts.dir, base);
        if (tfile === this.current)
            return;
        if (!fs.existsSync(tfile))
            return; // chatSessions 最新但 transcripts 无同名文件：保持现状
        this.bindFile(tfile);
    }
    // ---------------------------------------------------------------- chatSessions 兜底源
    /**
     * 绑定 chatSessions 兜底文件：从字节 0 投影全部历史（catch-up，补 transcripts 缺失回复），
     * 再启动周期轮询读增量。doneSink 让 JsonlProjector 的 COPILOT_DONE（debounce）走同一出口。
     */
    bindFallback(file) {
        this.fallbackFile = file;
        this.fallbackOffset = 0;
        this.fallbackPending = '';
        this.fallbackSeenRequestIds.clear();
        this.fallbackProjector.reset();
        this.fallbackProjector.setDoneSink((ev) => this.emit(ev));
        // 立即 catch-up：把该文件全部投影，transcripts 缺失的历史回复在这里补上
        this.catchUpFallback();
        // 周期轮询：chatSessions 无 fs.watch，按最短间隔读增量字节
        if (this.fallbackTimer)
            clearInterval(this.fallbackTimer);
        this.fallbackTimer = setInterval(() => this.pollFallback(), this.fallbackPollMs);
    }
    /** 解绑兜底：清文件、清半行缓冲、清轮询定时器 */
    unbindFallback() {
        this.fallbackFile = undefined;
        this.fallbackOffset = 0;
        this.fallbackPending = '';
        if (this.fallbackTimer)
            clearInterval(this.fallbackTimer);
        this.fallbackTimer = undefined;
    }
    /** catch-up：从头读取整个 chatSessions 文件逐行投影（补历史缺失回复） */
    catchUpFallback() {
        const file = this.fallbackFile;
        if (!file)
            return;
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        }
        catch {
            return;
        }
        try {
            const st = fs.statSync(file);
            this.fallbackOffset = st.size;
        }
        catch {
            /* stat 失败则保持 0，下次轮询从头处理 */
        }
        for (const line of text.split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            let obj;
            try {
                obj = JSON.parse(s);
            }
            catch {
                continue; // 半行/损坏忽略（轮询增量会再次尝试）
            }
            this.projectFallbackLine(obj);
        }
    }
    /** 兜底轮询：读 fallbackFile 增量字节 → 逐行投影 */
    pollFallback() {
        const file = this.fallbackFile;
        if (!file || this.disposed)
            return;
        let st;
        try {
            st = fs.statSync(file);
        }
        catch {
            return; // 文件暂时不可读
        }
        // chatSessions 全量重写（truncate 重写）时 size 变小 → 从头重读；
        // 去重由 fallbackSeenRequestIds / JsonlProjector 内部幂等保证
        if (st.size < this.fallbackOffset) {
            this.fallbackOffset = 0;
        }
        if (st.size === this.fallbackOffset) {
            // 无增量但残留半行缓冲：文件可能写完且末行无 \n，尝试解析一次
            if (this.fallbackPending.trim()) {
                const s = this.fallbackPending.trim();
                let obj;
                try {
                    obj = JSON.parse(s);
                    this.fallbackPending = '';
                }
                catch {
                    return; // 真半行，继续等
                }
                this.projectFallbackLine(obj);
            }
            return;
        }
        const fd = fs.openSync(file, 'r');
        try {
            const len = st.size - this.fallbackOffset;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, this.fallbackOffset);
            this.fallbackOffset = st.size;
            this.processFallbackChunk(buf.toString('utf8'));
        }
        finally {
            fs.closeSync(fd);
        }
    }
    /** 处理一次兜底增量：拼半行缓冲 → 按 \n 切行 → 逐行投影 */
    processFallbackChunk(chunk) {
        let text = this.fallbackPending + chunk;
        this.fallbackPending = '';
        const parts = text.split('\n');
        this.fallbackPending = parts.pop() || ''; // 最后一段可能是写入中的半行
        for (const line of parts) {
            const s = line.trim();
            if (!s)
                continue;
            let obj;
            try {
                obj = JSON.parse(s);
            }
            catch {
                continue;
            }
            this.projectFallbackLine(obj);
        }
    }
    /**
     * 投影一行 chatSessions 数据（兜底路径）：
     * - kind=2 全量 requests mutation：按 requestId 去重——新请求整体投影；
     *   已见过的请求仅当其带完整 response 时重投影（可能有新完成的回复），避免重复处理
     * - 其余行（kind0 快照 / requests/N/response 增量）直接交给 JsonlProjector（内部幂等）
     * 输出统一走 emitAgentSide：只补助手侧内容
     */
    projectFallbackLine(obj) {
        const rec = asRecord(obj);
        if (!rec)
            return;
        if (rec.kind === 2 &&
            Array.isArray(rec.k) &&
            rec.k.length === 1 &&
            rec.k[0] === 'requests' &&
            Array.isArray(rec.v)) {
            const fresh = [];
            for (const req of rec.v) {
                const r = asRecord(req);
                const rid = r ? asString(r.requestId) : null;
                if (rid && this.fallbackSeenRequestIds.has(rid)) {
                    // 已投影过：仅当带完整 response 时才重投影（响应完成/更新），否则跳过
                    if (r && Array.isArray(r.response) && r.response.length)
                        fresh.push(req);
                    continue;
                }
                if (rid)
                    this.fallbackSeenRequestIds.add(rid);
                fresh.push(req);
            }
            if (!fresh.length)
                return;
            this.emitAgentSide(this.fallbackProjector.projectLine({ kind: 2, k: ['requests'], v: fresh }));
            return;
        }
        this.emitAgentSide(this.fallbackProjector.projectLine(rec));
    }
    /**
     * 兜底源只补助手侧内容：跳过 USER_MESSAGE / COPILOT_TYPING
     * （transcripts 已实时覆盖用户消息，避免手机端重复）。
     */
    emitAgentSide(evs) {
        for (const ev of evs) {
            if (ev.type === 'USER_MESSAGE' || ev.type === 'COPILOT_TYPING')
                continue;
            this.emit(ev);
        }
    }
    // ---------------------------------------------------------------- watchers
    bindWatchers(file) {
        this.closeWatchers();
        const onChange = () => this.scheduleTail();
        try {
            this.fileWatcher = fs.watch(file, { persistent: false }, onChange);
            this.fileWatcher.on('error', () => {
                try {
                    this.fileWatcher?.close();
                }
                catch {
                    /* ignore */
                }
                this.fileWatcher = undefined;
            });
        }
        catch {
            this.fileWatcher = undefined;
        }
        const parent = path.dirname(file);
        try {
            this.dirWatcher = fs.watch(parent, { persistent: false }, (_eventType, filename) => {
                if (filename && this.current && path.basename(this.current) === String(filename)) {
                    this.scheduleTail();
                }
                else {
                    // 新会话文件出现 / 当前文件被替换 → 双源重新扫描并读增量
                    this.scanNewestBoth();
                    this.scheduleTail();
                }
            });
            this.dirWatcher.on('error', () => {
                try {
                    this.dirWatcher?.close();
                }
                catch {
                    /* ignore */
                }
                this.dirWatcher = undefined;
            });
        }
        catch {
            this.dirWatcher = undefined;
        }
    }
    closeWatchers() {
        try {
            this.fileWatcher?.close();
        }
        catch {
            /* ignore */
        }
        try {
            this.dirWatcher?.close();
        }
        catch {
            /* ignore */
        }
        this.fileWatcher = undefined;
        this.dirWatcher = undefined;
    }
    /** fs.watch 触发后的防抖 tail（追加频率高时合并多次读） */
    scheduleTail() {
        if (this.disposed)
            return;
        if (this.watchDebounce)
            clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
            this.watchDebounce = undefined;
            this.tail();
        }, WATCH_DEBOUNCE_MS);
    }
    // ---------------------------------------------------------------- tail 读取
    /** 读取增量字节 → 按行解析 → handleEvent */
    tail() {
        if (!this.current || this.disposed)
            return;
        let st;
        try {
            st = fs.statSync(this.current);
        }
        catch {
            return; // 文件暂时不可读
        }
        // truncate / 文件重写变小：offset 归 0 重读（重复行由 seenMessageIds / 行指纹去重）
        if (st.size < this.offset) {
            this.offset = 0;
            this.pending = '';
            this.lastLineFp = '';
        }
        // 同 size 但 mtime 前进：可能原地重写了最后一行 → 回退读取最后一行对比指纹
        if (st.size === this.offset && st.size > 0 && st.mtimeMs > this.lastMtimeMs + 5) {
            this.lastMtimeMs = st.mtimeMs;
            this.rereadLastLine(st.size);
            return;
        }
        if (st.size === this.offset) {
            this.lastSize = st.size;
            this.lastMtimeMs = st.mtimeMs;
            return; // 无增量
        }
        const fd = fs.openSync(this.current, 'r');
        try {
            const len = st.size - this.offset;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, this.offset);
            this.offset = st.size;
            this.lastSize = st.size;
            this.lastMtimeMs = st.mtimeMs;
            this.processChunk(buf.toString('utf8'));
        }
        finally {
            fs.closeSync(fd);
        }
    }
    /** 处理一次增量读取的文本：拼 pending → 按 \n 切行 → 每行解析 */
    processChunk(chunk) {
        let text = this.pending + chunk;
        this.pending = '';
        if (this.skipFirstLine) {
            this.skipFirstLine = false;
            const nl = text.indexOf('\n');
            if (nl < 0) {
                // 第一块连换行都没有：全部是写入中的半行，继续等
                this.pending = text;
                return;
            }
            text = text.slice(nl + 1); // 丢弃起始偏移处的半行
        }
        const parts = text.split('\n');
        this.pending = parts.pop() || '';
        for (const line of parts) {
            const s = line.trim();
            if (!s)
                continue;
            // 同内容行指纹：防同 size 原地重写 / 极端重复追加
            const fp = s.length + ':' + s.slice(0, 64) + ':' + s.slice(-32);
            if (fp === this.lastLineFp)
                continue;
            this.lastLineFp = fp;
            this.handleLine(s);
        }
    }
    /** 同 size + mtime 前进：回退读取最后一行（上限 64KB 内找最后一个 \n） */
    rereadLastLine(size) {
        const cur = this.current;
        if (!cur)
            return;
        const readLen = Math.min(size, REREAD_LAST_LINE_BYTES);
        const fd = fs.openSync(cur, 'r');
        let line;
        try {
            const buf = Buffer.alloc(readLen);
            fs.readSync(fd, buf, 0, readLen, size - readLen);
            const s = buf.toString('utf8');
            const nl = s.lastIndexOf('\n');
            if (nl < 0)
                return; // 块内无换行：正在写入的半行，跳过
            line = s.slice(nl + 1).trim();
        }
        finally {
            fs.closeSync(fd);
        }
        if (!line)
            return;
        const fp = line.length + ':' + line.slice(0, 64) + ':' + line.slice(-32);
        if (fp === this.lastLineFp)
            return; // 内容未变
        this.lastLineFp = fp;
        this.handleLine(line);
    }
    // ---------------------------------------------------------------- 行解析
    handleLine(line) {
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            return; // 半行/损坏，忽略
        }
        this.handleEvent(obj);
    }
    /** 事件分发（未知类型忽略）。id/timestamp 均为可选顶层字段。 */
    handleEvent(obj) {
        const rec = asRecord(obj);
        if (!rec)
            return;
        const type = asString(rec.type);
        if (!type)
            return;
        const data = asRecord(rec.data);
        const id = asString(rec.id);
        const tsStr = asString(rec.timestamp);
        const tsMs = tsStr ? Date.parse(tsStr) : NaN;
        switch (type) {
            case 'session.start': {
                // 新会话：重置投影状态（不发事件）
                this.resetState();
                return;
            }
            case 'user.message': {
                if (!data)
                    return;
                this.handleUserMessage(data, id, tsMs);
                return;
            }
            case 'assistant.turn_start': {
                if (!data)
                    return;
                const turnId = asString(data.turnId);
                this.turnSeq += 1;
                this.activeTurnId = turnId;
                this.streamAccum = '';
                this.pendingReasoning = [];
                this.emit({
                    type: 'AGENT_STREAM_START',
                    streamId: 't' + this.turnSeq,
                    requestIndex: this.turnSeq,
                });
                return;
            }
            case 'assistant.message': {
                if (!data)
                    return;
                this.handleAssistantMessage(data);
                return;
            }
            case 'tool.execution_start': {
                if (!data)
                    return;
                this.handleToolExecutionStart(data);
                return;
            }
            case 'tool.execution_complete': {
                if (!data)
                    return;
                this.handleToolExecutionComplete(data);
                return;
            }
            case 'assistant.turn_end': {
                this.handleTurnEnd();
                return;
            }
            default:
                return; // 未知类型：忽略
        }
    }
    // ---------------------------------------------------------------- 映射规则
    /**
     * user.message：
     * - 过滤内部子代理派生消息（[Terminal/[Session/[Task/[Notification 前缀 或 含 notification:）
     * - ±3s 时间窗口内多条 user.message 只保留第一条（子代理批量派生）
     * - 发 USER_MESSAGE；随后结束上一轮未结束的流（新用户输入）
     */
    handleUserMessage(data, id, tsMs) {
        const content = asString(data.content);
        if (content === null)
            return;
        if (isInternalUserMessage(content))
            return;
        // ±3s 窗口去重：只保留第一条（保留后更新 lastUserTsMs 作为窗口基准）。
        // 严格小于：恰好 3s 间隔（如连续快速提问）不应被吞。
        if (!Number.isNaN(tsMs) && this.lastUserTsMs !== null && tsMs - this.lastUserTsMs < DUP_USER_MS) {
            return;
        }
        if (!Number.isNaN(tsMs))
            this.lastUserTsMs = tsMs;
        this.endActiveStream(); // 新用户输入：结束上一轮未结束的流
        const messageId = asString(data.messageId);
        this.emit({
            type: 'USER_MESSAGE',
            text: content,
            requestId: messageId || id || undefined,
        });
    }
    /**
     * assistant.message：
     * - reasoningText 非空 → THINKING_STEP（思考与正文是两条独立 message，本条可能无 content）
     * - content 非空 → 增量投影（emitAssistantContent）：同 messageId 前缀增长发
     *   AGENT_STREAM_CHUNK（打字机增量）；新消息与已发累计文本对比后 CHUNK / SET 兜底
     * - toolRequests 非空 → 每个 toolRequest 发 TOOL_CALL（arguments 是 JSON 字符串，尝试解析为对象）
     * - seenMessageIds 语义：标记"该 messageId 的辅助事件（reasoning/tools）已初始化"；
     *   content 增长不依赖它（靠 lastContentByMessageId 前缀比较），流式增量不会被去重吞掉
     */
    handleAssistantMessage(data) {
        const messageId = asString(data.messageId);
        const reasoning = asString(data.reasoningText);
        const content = asString(data.content);
        const toolReqs = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        // 容错：从文件中间开始解析（replay 模式）时可能没有 turn_start → 自动开新 turn
        if (!this.activeTurnId && (reasoning || content || toolReqs.length)) {
            this.turnSeq += 1;
            this.activeTurnId = 'auto';
            this.streamAccum = '';
            this.pendingReasoning = [];
            this.emit({
                type: 'AGENT_STREAM_START',
                streamId: 't' + this.turnSeq,
                requestIndex: this.turnSeq,
            });
        }
        // 该 messageId 首次出现才处理 reasoning / toolRequests（重放/重读防重复）；
        // content 每次都走增量投影（同一 messageId 重写变长 → CHUNK）
        const firstSeen = !messageId || !this.seenMessageIds.has(messageId);
        if (messageId)
            this.seenMessageIds.add(messageId);
        if (reasoning && firstSeen) {
            this.pendingReasoning.push(reasoning);
            this.emit({
                type: 'THINKING_STEP',
                text: reasoning,
                requestIndex: this.turnSeq,
                stepId: messageId ? 'think-' + messageId : undefined,
            });
        }
        if (content) {
            this.emitAssistantContent(content, messageId);
        }
        if (firstSeen) {
            for (const tr of toolReqs) {
                const rec = asRecord(tr);
                if (!rec)
                    continue;
                const name = asString(rec.name);
                const toolCallId = asString(rec.toolCallId);
                if (!name || !toolCallId)
                    continue;
                // toolRequests.arguments 是 JSON 字符串：解析成对象，失败则原样透传
                let input = rec.arguments;
                if (typeof rec.arguments === 'string') {
                    try {
                        input = JSON.parse(rec.arguments);
                    }
                    catch {
                        input = rec.arguments;
                    }
                }
                this.toolStates.set(toolCallId, { text: name, requestIndex: this.turnSeq });
                this.emit({
                    type: 'TOOL_CALL',
                    text: name,
                    toolId: toolCallId,
                    isComplete: false,
                    input,
                    requestIndex: this.turnSeq,
                });
            }
        }
    }
    /**
     * assistant.content 增量投影（打字机效果）：
     * - 情况 a：同一 messageId 且新 content 以旧快照为前缀（变长）→ AGENT_STREAM_CHUNK 只发增量；
     *   内容相同则静默（幂等，重读/重放安全）；非前缀重写 → 整段 SET 校正
     * - 情况 b：messageId 首次出现（新消息/新一轮正文）→ 与已发累计文本对比：
     *   新 content 以已发文本结尾（重复覆盖）→ SET 全量；已发文本是 content 前缀且更长 → CHUNK；
     *   否则 → SET 整段覆盖
     * - 情况 c：无 messageId（罕见）→ SET 整段覆盖（旧行为）
     */
    emitAssistantContent(content, messageId) {
        const streamId = 't' + this.turnSeq;
        if (!this.activeStreamId)
            this.activeStreamId = streamId;
        this.streamAccum = content; // 完整快照，始终保留最新（turn_end 发 AGENT_MESSAGE 用）
        // 情况 a：同一 messageId 的流式增长（content 前缀变长 → 发增量 CHUNK）
        if (messageId) {
            const prev = this.lastContentByMessageId.get(messageId);
            if (prev !== undefined) {
                if (content.startsWith(prev)) {
                    // 前缀关系（含完全相同）：只发增长部分；无增长则静默
                    const delta = content.slice(prev.length);
                    if (delta) {
                        this.lastContentByMessageId.set(messageId, content);
                        this.lastEmittedTextByStream.set(streamId, content);
                        this.emit({
                            type: 'AGENT_STREAM_CHUNK',
                            streamId,
                            text: delta,
                            requestIndex: this.turnSeq,
                        });
                    }
                    return;
                }
                // 非前缀增长（异常重写）：回退整段 SET 校正
                this.lastContentByMessageId.set(messageId, content);
                this.lastEmittedTextByStream.set(streamId, content);
                this.emit({
                    type: 'AGENT_STREAM_SET',
                    streamId,
                    text: content,
                    requestIndex: this.turnSeq,
                });
                return;
            }
            // messageId 首次出现：记录该消息当前 content 快照
            this.lastContentByMessageId.set(messageId, content);
        }
        // 情况 b：新消息（或新一轮正文）——与已发累计文本做增量对比
        const emitted = this.lastEmittedTextByStream.get(streamId);
        if (emitted !== undefined && emitted.length > 0) {
            // 新 content 以已发文本结尾（重复覆盖）→ SET 全量校正
            if (content.endsWith(emitted)) {
                this.lastEmittedTextByStream.set(streamId, content);
                this.emit({
                    type: 'AGENT_STREAM_SET',
                    streamId,
                    text: content,
                    requestIndex: this.turnSeq,
                });
                return;
            }
            // 已发文本是 content 的前缀且 content 更长 → 增量 CHUNK
            if (content.length > emitted.length && content.startsWith(emitted)) {
                const delta = content.slice(emitted.length);
                if (delta) {
                    this.lastEmittedTextByStream.set(streamId, content);
                    this.emit({
                        type: 'AGENT_STREAM_CHUNK',
                        streamId,
                        text: delta,
                        requestIndex: this.turnSeq,
                    });
                    return;
                }
            }
        }
        // 情况 c：该 stream 尚无已发文本 / 与已发文本无关 → 整段 SET 覆盖
        this.lastEmittedTextByStream.set(streamId, content);
        this.emit({
            type: 'AGENT_STREAM_SET',
            streamId,
            text: content,
            requestIndex: this.turnSeq,
        });
    }
    /**
     * tool.execution_start：发/更新 TOOL_CALL（arguments 已是对象，直接透传），
     * 记录 toolStates 供 execution_complete 回填。
     */
    handleToolExecutionStart(data) {
        const toolCallId = asString(data.toolCallId);
        if (!toolCallId)
            return;
        const toolName = asString(data.toolName) || 'tool';
        this.toolStates.set(toolCallId, { text: toolName, requestIndex: this.turnSeq });
        this.emit({
            type: 'TOOL_CALL',
            text: toolName,
            toolId: toolCallId,
            isComplete: false,
            input: data.arguments,
            requestIndex: this.turnSeq,
        });
    }
    /**
     * tool.execution_complete：toolStates 有记录 → 发 TOOL_CALL isComplete:true
     * （PWA 端按 toolId upsert 成 done 状态）。execution_complete 无结果内容，只有成功标志。
     */
    handleToolExecutionComplete(data) {
        const toolCallId = asString(data.toolCallId);
        if (!toolCallId)
            return;
        const st = this.toolStates.get(toolCallId);
        if (!st)
            return; // 未记录过（绑定前的历史工具），忽略
        this.emit({
            type: 'TOOL_CALL',
            text: st.text,
            toolId: toolCallId,
            isComplete: true,
            requestIndex: st.requestIndex,
        });
    }
    /**
     * assistant.turn_end：
     * - 有正文 → AGENT_MESSAGE（最终完整文本）
     * - 只要本 turn 开过流（turn_start / 自动开流）→ 必须 AGENT_STREAM_END
     *   （即使只有 tool、无 content，也要收尾，否则手机端 Copilot 头上的 ••• 常亮）
     * - 再发 COPILOT_DONE
     * - 重置活跃流
     */
    handleTurnEnd() {
        const streamId = 't' + this.turnSeq;
        const hadStream = !!this.activeStreamId ||
            !!this.activeTurnId ||
            this.lastEmittedTextByStream.has(streamId) ||
            !!this.streamAccum;
        if (this.streamAccum) {
            this.emit({
                type: 'AGENT_MESSAGE',
                streamId,
                text: this.streamAccum,
                requestIndex: this.turnSeq,
            });
        }
        if (hadStream) {
            this.emit({ type: 'AGENT_STREAM_END', streamId, requestIndex: this.turnSeq });
        }
        this.emit({ type: 'COPILOT_DONE', requestIndex: this.turnSeq });
        this.activeStreamId = null;
        this.activeTurnId = null;
        this.streamAccum = '';
        this.pendingReasoning = [];
        // 保险起见：turn 结束删除当前 stream 的已发文本记录
        // （turnSeq 递增，'t'+seq 不会复用，但清掉避免跨 turn 误判增量）
        this.lastEmittedTextByStream.delete(streamId);
    }
    /** 结束当前未结束的流：发 AGENT_MESSAGE（如有正文）+ AGENT_STREAM_END，重置缓冲 */
    endActiveStream() {
        const streamId = this.activeStreamId || (this.activeTurnId ? 't' + this.turnSeq : null);
        if (streamId) {
            if (this.streamAccum) {
                this.emit({
                    type: 'AGENT_MESSAGE',
                    streamId,
                    text: this.streamAccum,
                    requestIndex: this.turnSeq,
                });
            }
            this.emit({
                type: 'AGENT_STREAM_END',
                streamId,
                requestIndex: this.turnSeq,
            });
            // 流已结束：清掉该 stream 的已发文本记录，避免后续误判为增量
            this.lastEmittedTextByStream.delete(streamId);
        }
        this.activeStreamId = null;
        this.activeTurnId = null;
        this.streamAccum = '';
        this.pendingReasoning = [];
    }
    /** 重置全部投影状态（session.start / bindFile 时调用） */
    resetState() {
        this.activeTurnId = null;
        this.turnSeq = 0;
        this.activeStreamId = null;
        this.streamAccum = '';
        this.pendingReasoning = [];
        this.toolStates.clear();
        this.seenMessageIds.clear();
        this.lastContentByMessageId.clear();
        this.lastEmittedTextByStream.clear();
        this.lastUserTsMs = null;
    }
    /** 事件出口：dispose 后不再发出 */
    emit(ev) {
        if (!this.disposed)
            this.opts.onEvent(ev);
    }
}
exports.TranscriptWatcher = TranscriptWatcher;
/**
 * 从 storageUri 推导 transcripts 目录。
 *
 * storageUri 形如 `<workspaceStorage>/<wsHash>/local.<hash>`（扩展自身的存储位置），
 * transcripts 实际位于 `<workspaceStorage>/<wsHash>/GitHub.copilot-chat/transcripts`，
 * 因此取 dirname(storageUri.fsPath) 后拼 `GitHub.copilot-chat/transcripts`，
 * 存在且为目录则返回，否则 undefined。
 */
function findTranscriptsDir(storageUri) {
    if (!storageUri || typeof storageUri.fsPath !== 'string' || !storageUri.fsPath) {
        return undefined;
    }
    const dir = path.join(path.dirname(storageUri.fsPath), 'GitHub.copilot-chat', 'transcripts');
    try {
        const st = fs.statSync(dir);
        if (st.isDirectory())
            return dir;
    }
    catch {
        /* 目录不存在 */
    }
    return undefined;
}
/**
 * 从 storageUri 推导 chatSessions 目录（兜底源）。
 *
 * chatSessions 位于 `<workspaceStorage>/<wsHash>/chatSessions`，与 transcripts 同级父目录。
 * 用于 transcripts 漏写 assistant 回复时从 chatSessions 补全。
 */
function findChatSessionsDir(storageUri) {
    if (!storageUri || typeof storageUri.fsPath !== 'string' || !storageUri.fsPath) {
        return undefined;
    }
    const dir = path.join(path.dirname(storageUri.fsPath), 'chatSessions');
    try {
        const st = fs.statSync(dir);
        if (st.isDirectory())
            return dir;
    }
    catch {
        /* 目录不存在 */
    }
    return undefined;
}
//# sourceMappingURL=transcriptWatcher.js.map