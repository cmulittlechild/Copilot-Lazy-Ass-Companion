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
const RESCAN_MS = 800;
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
/** pinned 文件超过该时间无新写入视为「沉默」，允许自动切换到更新的会话 */
const PIN_STALE_MS = 60_000;
/** 手机侧会话绑定后的窗口期：期内自动跟随一律 live-only@EOF，防旧轮次洪水 */
const PHONE_SELECT_WINDOW_MS = 60_000;
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
 * 检查 buffer 尾部是否是截断的 UTF-8 多字节序列，返回需要裁剪的字节数。
 * 从末尾向前查找 lead byte，判断后续 continuation byte 是否足够。
 */
function trimTrailingUtf8(buf) {
    if (buf.length === 0)
        return 0;
    let continuation = 0;
    for (let i = buf.length - 1; i >= 0 && (buf[i] & 0xc0) === 0x80; i--) {
        continuation += 1;
    }
    if (continuation === 0)
        return 0;
    const leadIndex = buf.length - continuation - 1;
    if (leadIndex < 0)
        return 0;
    const lead = buf[leadIndex];
    let expected = 0;
    if (lead >= 0xc2 && lead <= 0xdf)
        expected = 2;
    else if (lead >= 0xe0 && lead <= 0xef)
        expected = 3;
    else if (lead >= 0xf0 && lead <= 0xf4)
        expected = 4;
    if (!expected)
        return 0;
    const actual = continuation + 1;
    return actual < expected ? actual : 0;
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
    /** 上次读取尾部被截断的 UTF-8 字节，下次读取时拼接（B6） */
    pendingBytes = Buffer.alloc(0);
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
    /**
     * 手机切会话 live-only：transcript 已是权威实时源，HISTORY_REPLAY 负责历史。
     * chatSessions fallback **不得整轮重放**（会重复 1/2 回复），但必须允许
     * **gap-fill**：transcript 常出现空 assistant.message，真实正文只在 chatSessions
     * 稍后落盘（用户截图：桌面有「周六」远程没有）。
     */
    suppressFallbackAgent = false;
    /** 已从 transcript/gap 发出的助手正文指纹（前 160 字），防 chatSessions 重复补全 */
    emittedAgentTextKeys = new Set(); // 0.5.31 键改为 text|rid|requestIndex|streamId，避免同一回复文字误吞
    /** text::ut= 键 → 记录时的提问序号：迟到重投影（chatSessions 滞后可达数分钟，
     *  固定时间窗不可靠）只有同题在记录之后真的重问才放行；不同问题同文回复不拦。 */
    emittedAgentUtKeys = new Map();
    /** 已答轮次的迟到 requests/N 流：START 判定后被整流丢弃的 streamId 集合 */
    suppressedFallbackStreams = new Set();
    /** ut → 已投答案正文键：迟到重投影的文本形态与已投版本不同时，按「同问题已投答案」模糊压制 */
    emittedTextByUt = new Map();
    /** 规范化用户文 → 最近一次该问题发出的用户消息序号 */
    userSeqByUt = new Map();
    /** 已发出 USER_MESSAGE / 注入提问的单调序号（判断「记录之后是否有新提问」） */
    userEmitSeq = 0;
    /** 已成功 gap-fill（发出助手正文）的 chatSessions requestId */
    gapFilledRequestIds = new Set();
    /** 已经从 transcript 得到完整助手回复的用户文，避免 chatSessions 再 gap */
    completedGapUserTexts = new Set();
    /**
     * 0.5.26：待补全的用户请求有序队列（FIFO）。
     * 确保多个 in-flight 请求按时间序确定性匹配，取代无序集合迭代。
     */
    pendingGapQueue = [];
    pendingGapSeq = 0;
    /** 活跃 fs.watch 时的备份轮询间隔 (ms) */
    static BACKUP_POLL_MS = 1200;
    /** 当前 turn 对应的用户原文（规范化前/后各一份便于匹配） */
    activeUserText = '';
    /**
     * 0.5.23：当前 turn 是否已发出用户可见助手正文。
     * 工具切断流会清空 streamAccum，不能再用 streamAccum 空判断 gap。
     */
    turnEmittedVisibleAgent = false;
    /**
     * 0.5.24/0.5.26：turn_start 超时定时器。
     * 超时后只把 activeUserText 记入 pendingGapUserTexts，并关闭 activeTurn，
     * 避免数小时后 orphan assistant.message（parentId=null）挂到旧用户气泡。
     */
    turnGapTimer;
    turnHardTimer;
    static TURN_GAP_TIMEOUT_MS = 3000;
    static TURN_HARD_TIMEOUT_MS = 120_000;
    /** chatSessions requestId → timestamp（用于 gap-fill 事件排序） */
    fallbackRequestTs = new Map();
    /** chatSessions requestId → 用户原文（规范化），供按轮匹配 */
    fallbackRequestUserText = new Map();
    /** chatSessions request 下标 → requestId（对齐 k=['requests', N, 'response']） */
    fallbackRequestIndex = new Map();
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
    /** 每道用户题的最近一次提问时刻（transcript timestamp）：迟到 assistant.message
     *  的记录时间早于新提问，用它归属到正确的问题键 */
    userTsByUt = new Map();
    constructor(opts) {
        this.opts = opts;
        this.pollMs = Math.max(10, opts.pollMs ?? 100);
        // 0.5.24：默认从 2000ms 降到 1000ms，让 chatSessions gap-fill 更快补全
        this.fallbackPollMs = Math.max(100, opts.fallbackPollMs ?? 600);
    }
    /**
     * 0.5.22b：从 projectHistory 输出预填 emittedAgentTextKeys，
     * 防止 chatSessions gap-fill 把 HISTORY_REPLAY 已显示的旧回复再发一遍。
     * 也预填 fallbackSeenRequestIds，避免第一轮全量 rewrite 重新处理所有旧 request。
     * 0.5.23：已完整投影过的 requestId 一并记入 gapFilledRequestIds，
     * 避免 chatSessions 全量 rewrite 时把旧轮次再 gap 一遍。
     */
    seedFromHistory(events) {
        if (!events || !Array.isArray(events))
            return;
        // 记下本次种子：随后 bindFile/resetState/bindFallback 会清空这些去重集合，
        // bindFile 收尾时重新应用，避免种子被重置冲掉（切会话旧轮次洪水）。
        this.pendingSeed = events.slice();
        this.applySeedEvents(events);
    }
    /** 待应用的种子：seedFromHistory 记录，bindFile 清空集合后重放 */
    pendingSeed = null;
    /** 已通过回放/backfill 投过的 sessiondb turns 行 id：迟到的轮询重投影跳过 */
    sessionDbEmittedIds = new Set();
    /** 最近一次手机侧会话绑定时间：窗口期内自动跟随不得 replay/catch-up 洪水 */
    lastPhoneSelectMs = 0;
    /** 最近一次已发射 SESSION_FOLLOW 的目标路径：防止 csdir-only 会话占 newest 时每 tick 重发 */
    lastFollowedPath;
    applySeedEvents(events) {
        if (!events || !Array.isArray(events))
            return;
        // requestIndex → requestId（USER_MESSAGE 带 rid；AGENT 通常只有 requestIndex）
        const ridByIndex = new Map();
        let lastUt = '';
        for (const ev of events) {
            if (!ev)
                continue;
            const rid = ev.requestId;
            const ri = ev.requestIndex;
            if (ev.type === 'USER_MESSAGE' && typeof ev.text === 'string') {
                const ut = this.normUserText(String(ev.text || ''));
                if (ut) {
                    lastUt = ut;
                    // 回放轮次同步记提问序号：回放态答案算「该题已答」，后续迟到重投影
                    // isUtAnswered/前缀40 才能拦住（只记 sessiondb 通道会漏整段回放史）。
                    this.userEmitSeq += 1;
                    this.userSeqByUt.set(ut, this.userEmitSeq);
                    const ts = ev.timestamp;
                    if (typeof ts === 'number' && ts)
                        this.userTsByUt.set(ut, ts);
                }
                if (ut && typeof rid === 'string' && rid) {
                    this.fallbackRequestUserText.set(rid, ut);
                    if (typeof ri === 'number')
                        this.fallbackRequestIndex.set(ri, rid);
                }
            }
            if (typeof rid === 'string' && rid) {
                this.fallbackSeenRequestIds.add(rid);
                if (typeof ri === 'number')
                    ridByIndex.set(ri, rid);
            }
            if ((ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET') &&
                typeof ev.text === 'string') {
                // sessiondb 行回放事件带 sessiondb/<sid>/<rowId> streamId：记行 id 防轮询重投
                const sidStr = String(ev.streamId || '');
                const sm = sidStr.match(/^sessiondb\/[^/]+\/(\d+)$/);
                if (sm)
                    this.sessionDbEmittedIds.add(parseInt(sm[1], 10));
                const text = String(ev.text || '').trim();
                // monologue 不进正文指纹（否则会挡住真实最终回复的前缀匹配）
                if (text && !(0, jsonl_1.isInternalMonologue)(text))
                    this.noteEmittedAgentText(text, { requestIndex: ev.requestIndex, streamId: ev.streamId, rid: rid || undefined, userText: ev._ut ?? lastUt });
                // 仅当历史已有助手正文时标记 gapFilled，避免「只有 USER、最终回复未落盘」被挡住补全
                if (typeof rid === 'string' && rid)
                    this.gapFilledRequestIds.add(rid);
                else if (typeof ri === 'number' && ridByIndex.has(ri)) {
                    this.gapFilledRequestIds.add(ridByIndex.get(ri));
                }
            }
        }
        this.capCollections();
    }
    updatePollInterval() {
        if (this.disposed)
            return;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        const isWatchHealthy = !!this.fileWatcher;
        const interval = isWatchHealthy ? TranscriptWatcher.BACKUP_POLL_MS : this.pollMs;
        this.pollTimer = setInterval(() => this.tail(), interval);
    }
    /**
     * 启动：扫描目录选最新 .jsonl → 绑定 → tail + fs.watch + poll 兜底 + rescan 定时器。
     */
    start() {
        if (this.disposed)
            return;
        this.scanNewestBoth();
        // poll 兜底：fs.watch 活跃时退至 BACKUP_POLL_MS，故障/不可用时用 pollMs
        this.updatePollInterval();
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
        this.clearTurnGapTimer();
        this.clearTurnHardTimer();
        this.pollTimer = undefined;
        this.rescanTimer = undefined;
        this.watchDebounce = undefined;
        // 兜底源清理：解绑 + 清投影器内部 debounce 定时器
        this.unbindFallback();
        this.fallbackProjector.dispose();
        this.closeWatchers();
        this.closeSessionDbWatcher();
    }
    /**
     * 绑定文件：
     * - 默认 live-only：偏移 = EOF（纯实时，不重放历史）
     * - 文件 >5MB：从尾部 1MB 开始（防历史洪水，能立即看到进行中轮次）
     * - replay=true（切会话回放）：从文件尾部第 N 个 user.message 行开始全量解析，
     *   让手机端切到旧会话时能看到最近几轮历史
     * 切换文件时发 internal SYSTEM_MESSAGE 通知。
     */
    /**
     * @param opts.replay true = 回放最近用户轮次（历史）
     * @param opts.replay false = **手机切会话**：纯 EOF live，禁止 tail 1MB / fallback 全量 catch-up
     *   （0.5.16：否则与 HISTORY_REPLAY 双通道 → 错序、TOOL 洪水、状态乱跳）
     * @param opts.liveOnly 同 replay:false（显式）
     */
    /** 主动登记手机发送的用户文（transcript 可能 stale） */
    addPendingPhoneUserText(text) {
        const ut = this.normUserText(text);
        if (!ut)
            return;
        this.activeUserText = ut;
        this.pushPendingGap(ut, true);
        this.capCollections();
        this.startTurnGapTimer();
    }
    pushPendingGap(userText, fresh = false) {
        const ut = this.normUserText(userText);
        if (!ut)
            return;
        // fresh（手机注入的新问题）才算一次「提问」推进序号；
        // markCurrentTurnGap 在轮末登记 pending 是同问的事后簿记，不推进——
        // 否则同一问题答案发出后再登记 pending 会被误判成「重问」放行幻影。
        if (fresh) {
            this.userEmitSeq += 1;
            this.userSeqByUt.set(ut, this.userEmitSeq);
            this.userTsByUt.set(ut, Date.now());
        }
        this.pendingGapQueue.push({
            userText: ut,
            timestamp: Date.now(),
            seq: ++this.pendingGapSeq,
        });
        if (this.pendingGapQueue.length > 2000) {
            this.pendingGapQueue = this.pendingGapQueue.slice(-1000);
        }
    }
    hasPendingGap(userText) {
        if (!this.pendingGapQueue.length)
            return false;
        if (!userText)
            return this.pendingGapQueue.length > 0;
        const ut = this.normUserText(userText);
        return this.pendingGapQueue.some((q) => q.userText === ut);
    }
    removePendingGap(userText) {
        const ut = this.normUserText(userText);
        const idx = this.pendingGapQueue.findIndex((q) => q.userText === ut);
        if (idx >= 0) {
            this.pendingGapQueue.splice(idx, 1);
            return true;
        }
        return false;
    }
    popFirstPendingGap() {
        return this.pendingGapQueue.shift();
    }
    bindFile(file, opts) {
        this.current = file;
        // 再次 bindFile（如用户重新选择）即解除 pin，允许后续自动跟随
        this.pinnedFile = null;
        // 同会话重绑（auto-follow / catchUp 重投影）保留去重指纹，避免刚发出的正文被重投
        const sameSessionBind = path.basename(file) === this.boundSessionBase;
        this.pending = '';
        this.resetState(sameSessionBind);
        this.lastLineFp = '';
        this.skipFirstLine = false;
        const phoneSelectLive = opts?.liveOnly === true || opts?.replay === false; /* 显式 false，不是 undefined */
        // 0.5.18：phone live 时 mute chatSessions 助手投影，避免与 transcript 双通道重复
        this.suppressFallbackAgent = phoneSelectLive;
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
        if (phoneSelectLive)
            this.lastPhoneSelectMs = Date.now();
        if (opts?.replay === true) {
            startOffset = this.findReplayOffset(file, size);
            // findReplayOffset 返回精确行首偏移，无需 skip；只有非 0 且非行首才 skip
            this.skipFirstLine = false;
            mode = 'replay (last user turns)';
            this.suppressFallbackAgent = false;
        }
        else if (phoneSelectLive) {
            // 手机 PHONE_SESSION_SELECT：历史只走 projectHistory→HISTORY_REPLAY
            startOffset = size;
            this.skipFirstLine = false;
            mode = 'live-only@EOF (phone select)';
        }
        else if (size > BIG_FILE_BYTES) {
            // 自动跟随最新会话：允许 tail 1MB 接住进行中的 turn
            startOffset = Math.max(0, size - TAIL_BYTES);
            this.skipFirstLine = true;
            mode = `live, tail ${Math.round(TAIL_BYTES / 1024)}KB`;
        }
        this.offset = startOffset;
        this.lastSize = size;
        this.lastMtimeMs = st?.mtimeMs ?? 0;
        // 会话基名 + chatSessions 兜底源联动
        this.boundSessionBase = path.basename(file);
        // session-store.db：换会话时重置 turns 游标到当前末尾（只跟新增）
        const sid = this.boundSessionBase.replace(/\.jsonl$/, '');
        if (this.sessionDbSessionId !== sid) {
            this.sessionDbSessionId = sid;
            this.sessionDbLastRow = this.querySessionDbMaxId();
        }
        if (this.opts.chatSessionsDir) {
            const csFile = path.join(this.opts.chatSessionsDir, this.boundSessionBase);
            if (fs.existsSync(csFile)) {
                // 手机切会话：fallback 也从 EOF 增量，禁止全文件 catch-up 洪水
                // 且 suppressFallbackAgent 时即使有增量也不再投助手侧（见 emitAgentSide）
                this.bindFallback(csFile, { catchUp: !phoneSelectLive });
            }
            else {
                this.unbindFallback();
            }
        }
        else {
            this.unbindFallback();
        }
        this.emit({
            type: 'SYSTEM_MESSAGE',
            text: `Watching transcript: ${path.basename(file)} (${mode})`,
            visibility: 'internal',
            internal: true,
        });
        // 手机切会话场景：seedFromHistory 记下的种子在 resetState/bindFallback 清空后重放，
        // 保证旧 requestId/回复文本指纹继续生效，阻断全量 rewrite / catch-up 的旧轮次洪水。
        const seed = this.pendingSeed;
        this.pendingSeed = null;
        if (seed)
            this.applySeedEvents(seed);
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
                    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
                    if (!line.trim()) {
                        running += lineBytes;
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
                    running += lineBytes;
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
        // 手动 pin 的会话优先：但如果 pinned 文件已沉默（长时间无新写入），
        // 且有另一个会话文件在活跃写入，自动解除 pin 并切换到新文件。
        // 这解决了：用户从手机发消息 → pinFile → 之后在桌面切换到新会话 →
        // watcher 仍被 pin 在旧会话 → 新会话的回复无法实时推送到远端。
        if (this.pinnedFile) {
            if (this.current !== this.pinnedFile && fs.existsSync(this.pinnedFile)) {
                this.bindFile(this.pinnedFile, { liveOnly: true });
            }
            // 检查 pinned 文件是否已沉默
            let pinnedMtime = 0;
            try {
                pinnedMtime = fs.statSync(this.pinnedFile).mtimeMs;
            }
            catch {
                // pinned 文件不存在了 → 解除 pin，走正常逻辑
                this.pinnedFile = null;
                // 继续往下走，不 return
            }
            if (this.pinnedFile) {
                const now = Date.now();
                const pinnedAge = now - pinnedMtime;
                if (pinnedAge > PIN_STALE_MS) {
                    // pinned 文件已沉默，检查是否有更新的会话文件
                    const t = this.newestInDir(this.opts.dir);
                    const cs = this.opts.chatSessionsDir ? this.newestInDir(this.opts.chatSessionsDir) : undefined;
                    let newestMtime = -1;
                    let newestName;
                    if (t && t.mtimeMs > newestMtime) {
                        newestMtime = t.mtimeMs;
                        newestName = t.name;
                    }
                    if (cs && cs.mtimeMs > newestMtime) {
                        newestMtime = cs.mtimeMs;
                        newestName = cs.name;
                    }
                    // 新文件的 mtime 比 pinned 文件新且在最近 PIN_STALE_MS 内有写入 → 切换
                    if (newestName && newestMtime > pinnedMtime && (now - newestMtime) < PIN_STALE_MS) {
                        const tfile = path.join(this.opts.dir, newestName);
                        const csPath = this.opts.chatSessionsDir
                            ? path.join(this.opts.chatSessionsDir, newestName)
                            : undefined;
                        const tExists = fs.existsSync(tfile);
                        const csExists = !!(csPath && fs.existsSync(csPath));
                        if ((tExists || csExists) && (tExists ? tfile : csPath) !== this.current) {
                            this.pinnedFile = null; // 解除 pin
                            if (tExists) {
                                // 无论谁触发的跟随都 live-only@EOF：重绑定 ≠ 加载历史，
                                // replay:true 会把外会话整段历史灌进当前 feed（录屏实证洪水）。
                                this.bindFile(tfile, { liveOnly: true });
                            }
                            // 桌面发起跟随：通知扩展做完整同步（feed 换目标会话历史+标题）
                            this.emit({
                                type: 'SESSION_FOLLOW',
                                file: tExists ? tfile : undefined,
                                csFile: csExists ? csPath : undefined,
                                text: `已切换到会话: ${newestName}`,
                            });
                        }
                    }
                }
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
        const csPath = this.opts.chatSessionsDir ? path.join(this.opts.chatSessionsDir, base) : undefined;
        if (!fs.existsSync(tfile)) {
            // transcripts 无同名文件但 chatSessions 有新会话 → 仍发跟随（扩展用 csFile 回放）。
            // lastFollowedPath 去重：否则该会话持续占 newest，每个 tick 都重发（跟随风暴）。
            if (this.current !== undefined &&
                csPath &&
                fs.existsSync(csPath) &&
                csPath !== this.lastFollowedPath) {
                this.lastFollowedPath = csPath;
                this.emit({
                    type: 'SESSION_FOLLOW',
                    csFile: csPath,
                    text: `已切换到会话: ${base}`,
                });
            }
            return;
        }
        // 手机刚发起过切会话 → live-only@EOF，防止 pin 丢失后的全量 catch-up 洪水；
        // 桌面侧切换的重绑定同样 live-only（否则外会话历史整段灌进 feed）。
        // 仅首次绑定（current 为空）走默认 tail/catchUp，让首载有上下文。
        const isRebind = this.current !== undefined;
        this.bindFile(tfile, isRebind ? { liveOnly: true } : undefined);
        if (isRebind) {
            this.lastFollowedPath = tfile;
            this.emit({
                type: 'SESSION_FOLLOW',
                file: tfile,
                csFile: csPath && fs.existsSync(csPath) ? csPath : undefined,
                text: `已切换到会话: ${base}`,
            });
        }
    }
    // ---------------------------------------------------------------- chatSessions 兜底源
    /**
     * 绑定 chatSessions 兜底文件：从字节 0 投影全部历史（catch-up，补 transcripts 缺失回复），
     * 再启动周期轮询读增量。doneSink 让 JsonlProjector 的 COPILOT_DONE（debounce）走同一出口。
     */
    bindFallback(file, opts) {
        this.fallbackFile = file;
        this.fallbackOffset = 0;
        this.fallbackPending = '';
        this.fallbackSeenRequestIds.clear();
        this.fallbackProjector.reset();
        this.fallbackProjector.setDoneSink((ev) => this.emit(ev));
        const doCatchUp = opts?.catchUp !== false;
        if (doCatchUp) {
            // 立即 catch-up：把该文件全部投影，transcripts 缺失的历史回复在这里补上
            this.catchUpFallback();
        }
        else {
            // 手机切会话：只跟增量，避免与 HISTORY_REPLAY 双通道（TOOL/STREAM 洪水）
            try {
                this.fallbackOffset = fs.statSync(file).size;
            }
            catch {
                this.fallbackOffset = 0;
            }
        }
        // 周期轮询：chatSessions 无 fs.watch，按最短间隔读增量字节；
        // 顺带轮询 session-store.db turns（响应完成即落库，先于 chatSessions 写盘）
        if (this.fallbackTimer)
            clearInterval(this.fallbackTimer);
        this.fallbackTimer = setInterval(() => {
            this.pollFallback();
            this.pollSessionStoreDb();
        }, this.fallbackPollMs);
        this.bindSessionDbWatcher();
    }
    /** session-store.db 目录级 fs.watch：SQLite 落库（-wal/-shm/主文件任一变化）立即 poll，不等周期轮询 */
    sessionDbWatcher;
    sessionDbWatchDir;
    bindSessionDbWatcher() {
        const dbPath = this.opts.sessionStoreDb;
        const dir = dbPath ? path.dirname(dbPath) : undefined;
        if (!dbPath || !dir || !fs.existsSync(dir))
            return;
        if (this.sessionDbWatcher && this.sessionDbWatchDir === dir)
            return;
        this.closeSessionDbWatcher();
        this.sessionDbWatchDir = dir;
        try {
            this.sessionDbWatcher = fs.watch(dir, { persistent: false }, (_t, filename) => {
                if (!filename)
                    return;
                const name = String(filename);
                // WAL 模式下写入落在 session-store.db-wal/-shm，journal_mode=delete 则落主文件
                if (name === 'session-store.db' || name.startsWith('session-store.db-')) {
                    this.pollSessionStoreDb();
                }
            });
            this.sessionDbWatcher.on('error', () => this.closeSessionDbWatcher());
        }
        catch {
            this.sessionDbWatcher = undefined;
        }
    }
    closeSessionDbWatcher() {
        try {
            this.sessionDbWatcher?.close();
        }
        catch {
            /* ignore */
        }
        this.sessionDbWatcher = undefined;
        this.sessionDbWatchDir = undefined;
    }
    /** 最近 n 条 turns 行（按 id 升序）：跟随回放时补 chatSessions 尚未落盘的最后一轮答案 */
    sessionDbRecentTurns(n, sid) {
        const sessId = sid ?? this.sessionDbSessionId;
        if (!this.opts.sessionStoreDb || !sessId)
            return [];
        const db = this.openSessionDb();
        if (!db)
            return [];
        try {
            return db
                .prepare('SELECT id, user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?')
                .all(sessId, n)
                .reverse();
        }
        catch {
            return [];
        }
        finally {
            db.close();
        }
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
    // ---- session-store.db 快速兜底（Copilot 新版：turns 行响应完成即落库）----
    sessionDbSessionId;
    sessionDbLastRow = 0;
    /** 打开 session-store.db（优先只读，不支持则退回普通模式）；失败返回 null */
    openSessionDb() {
        const dbPath = this.opts.sessionStoreDb;
        if (!dbPath)
            return null;
        try {
            const { DatabaseSync } = require('node:sqlite');
            try {
                return new DatabaseSync(dbPath, { readOnly: true });
            }
            catch {
                return new DatabaseSync(dbPath);
            }
        }
        catch {
            return null;
        }
    }
    /** 当前绑定会话在 turns 表里的最大行号（换会话时调用；失败视为 0 从头跟） */
    querySessionDbMaxId() {
        const sid = this.sessionDbSessionId;
        if (!sid)
            return 0;
        const db = this.openSessionDb();
        if (!db)
            return 0;
        try {
            const row = db
                .prepare('SELECT MAX(id) AS m FROM turns WHERE session_id = ?')
                .get(sid);
            return row?.m ?? 0;
        }
        catch {
            return 0;
        }
        finally {
            db.close();
        }
    }
    /** 轮询 turns 新行：响应完成即落库 → 立即 emit AGENT_MESSAGE（ut 键去重 chatSessions 迟到的重复投影） */
    pollSessionStoreDb() {
        const sid = this.sessionDbSessionId;
        if (!this.opts.sessionStoreDb || !sid || this.disposed)
            return;
        let rows;
        const db = this.openSessionDb();
        if (!db)
            return;
        try {
            rows = db
                .prepare('SELECT id, user_message, assistant_response FROM turns WHERE session_id = ? AND id > ? ORDER BY id')
                .all(sid, this.sessionDbLastRow);
        }
        catch {
            return; // 库被锁/结构变化：下轮再试
        }
        finally {
            db.close();
        }
        if (!Array.isArray(rows) || !rows.length)
            return;
        for (const r of rows) {
            if (typeof r.id === 'number' && r.id > this.sessionDbLastRow) {
                this.sessionDbLastRow = r.id;
            }
            if (typeof r.id === 'number' && this.sessionDbEmittedIds.has(r.id))
                continue;
            // turns 行含 user_message：提前发 USER_MESSAGE（比 chatSessions 落盘快数十秒），
            // 稍后 chatSessions 通道的同一 USER 由 bridge 60s 文本去重压住。
            const uText = String(r.user_message || '').trim();
            if (uText && !isInternalUserMessage(uText)) {
                const utT = this.normUserText(uText);
                if (utT) {
                    this.userTsByUt.set(utT, Date.now());
                    this.activeUserText = utT;
                }
                this.emit({ type: 'USER_MESSAGE', text: uText, timestamp: Date.now() });
            }
            const text = String(r.assistant_response || '').trim();
            if (!text)
                continue;
            if (typeof r.id === 'number')
                this.sessionDbEmittedIds.add(r.id);
            // 用户文挂上供 ut 键/轮次匹配；streamId 用 sessiondb 前缀区别于其他通道
            this.emitAgentSide([
                {
                    type: 'AGENT_MESSAGE',
                    text,
                    streamId: `sessiondb/${sid}/${r.id}`,
                    requestIndex: -1,
                    timestamp: Date.now(),
                    _ut: r.user_message || undefined,
                },
            ]);
            // turns 行落库=该轮已完成：补一个 DONE 收尾，否则 typing/••• 占位要等到
            // chatSessions 迟到的收尾事件（可达分钟级）才消，表现为答案后的「…」波动。
            // _ut 标归属轮次：客户端按 ut 释放「已发未答」条目，不误清别轮在途条目。
            this.emit({
                type: 'COPILOT_DONE',
                requestIndex: -1,
                timestamp: Date.now(),
                _ut: r.user_message || undefined,
            });
        }
    }
    /** catch-up：读取 chatSessions 文件逐行投影（补历史缺失回复）；大文件只读尾部 8MB */
    catchUpFallback() {
        const file = this.fallbackFile;
        if (!file)
            return;
        let stat;
        try {
            stat = fs.statSync(file);
        }
        catch {
            return;
        }
        const MAX_BYTES = 8 * 1024 * 1024;
        let text;
        if (stat.size <= MAX_BYTES) {
            try {
                text = fs.readFileSync(file, 'utf8');
            }
            catch {
                return;
            }
            this.fallbackOffset = stat.size;
        }
        else {
            console.warn(`[TranscriptWatcher] catchUpFallback: ${path.basename(file)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB, reading last 8MB only`);
            const fd = fs.openSync(file, 'r');
            try {
                const readLen = MAX_BYTES;
                const buf = Buffer.alloc(readLen);
                fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
                this.fallbackOffset = stat.size;
                const raw = buf.toString('utf8');
                const firstNl = raw.indexOf('\n');
                text = firstNl >= 0 ? raw.slice(firstNl + 1) : raw;
            }
            finally {
                fs.closeSync(fd);
            }
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
            // base index：与 JsonlProjector 一致（有 i 用 i，否则按已见 request 数）
            let base = typeof rec.i === 'number' && rec.i >= 0
                ? rec.i
                : this.fallbackRequestIndex.size;
            for (let n = 0; n < rec.v.length; n++) {
                const req = rec.v[n];
                const r = asRecord(req);
                const rid = r ? asString(r.requestId) : null;
                const userText = r ? this.normUserText((0, jsonl_1.textOfUserReq)(r)) : '';
                const gi = base + n;
                if (rid && userText)
                    this.fallbackRequestUserText.set(rid, userText);
                if (rid) {
                    const ts = r ? (typeof r.timestamp === 'number' ? r.timestamp : undefined) : undefined;
                    if (ts != null)
                        this.fallbackRequestTs.set(rid, ts);
                    this.fallbackRequestIndex.set(gi, rid);
                }
                // 0.5.26 phone gap-fill：只投影「有待补用户文」且带完整 response 的 request
                if (this.suppressFallbackAgent) {
                    if (rid)
                        this.fallbackSeenRequestIds.add(rid);
                    if (!r || !Array.isArray(r.response) || !r.response.length)
                        continue;
                    if (rid && this.gapFilledRequestIds.has(rid))
                        continue;
                    if (!userText || !this.hasPendingGap(userText))
                        continue;
                    fresh.push(req);
                    continue;
                }
                if (rid && this.fallbackSeenRequestIds.has(rid)) {
                    if (r && Array.isArray(r.response) && r.response.length) {
                        if (!this.gapFilledRequestIds.has(rid))
                            fresh.push(req);
                    }
                    continue;
                }
                if (rid)
                    this.fallbackSeenRequestIds.add(rid);
                fresh.push(req);
            }
            if (!fresh.length) {
                this.capCollections();
                return;
            }
            // phone gap：单条完整 request 投影；streamId 索引可能不准，emitAgentSide 用 pending 匹配
            this.emitAgentSide(this.fallbackProjector.projectLine({ kind: 2, k: ['requests'], v: fresh }));
            return;
        }
        // kind=2 k=["requests", N, "response"] 增量
        if (this.suppressFallbackAgent &&
            rec.kind === 2 &&
            Array.isArray(rec.k) &&
            rec.k.length === 3 &&
            typeof rec.k[1] === 'number' &&
            rec.k[2] === 'response') {
            const idx = rec.k[1];
            const rid = this.fallbackRequestIndex.get(idx) ||
                [...this.fallbackSeenRequestIds][idx];
            const userText = rid ? this.fallbackRequestUserText.get(rid) : undefined;
            if (!userText || !this.hasPendingGap(userText))
                return;
            if (rid && this.gapFilledRequestIds.has(rid))
                return;
        }
        this.emitAgentSide(this.fallbackProjector.projectLine(rec));
        this.capCollections();
    }
    /** 解析投影事件真正所属的用户问题：_ut 已有直接用；否则按 requestId /
     *  streamId 的 requests/N 索引 / requestIndex 反查 fallbackRequestUserText。
     *  全查不到时返回 undefined——调用方宁缺毋滥，禁止拿 activeUserText 兜底归错。 */
    resolveUtForFallbackEv(ev) {
        const own = ev._ut;
        if (typeof own === 'string' && own.trim())
            return own;
        let rid = typeof ev.requestId === 'string' ? ev.requestId : undefined;
        const streamId = String(ev.streamId || '');
        const m = streamId.match(/^requests\/(\d+)\//);
        let idx;
        if (m)
            idx = parseInt(m[1], 10);
        else if (typeof ev.requestIndex === 'number' && ev.requestIndex >= 0)
            idx = ev.requestIndex;
        if (!rid && typeof idx === 'number') {
            rid = this.fallbackRequestIndex.get(idx) || [...this.fallbackSeenRequestIds][idx];
        }
        if (rid) {
            const ut = this.fallbackRequestUserText.get(rid);
            if (ut)
                return ut;
        }
        return undefined;
    }
    /**
     * 兜底源只补助手侧内容：跳过 USER_MESSAGE / COPILOT_TYPING
     * （transcripts 已实时覆盖用户消息，避免手机端重复）。
     *
     * 0.5.26：phone live 仅 gap-fill **pending 用户轮**的最终助手正文；
     * 不再因全局 transcriptHadGap 重扫整文件把旧回复贴到新气泡。
     */
    emitAgentSide(evs) {
        // sessiondb 行是「完成才入库」的新轮次，不是 catch-up 洪水，不走 suppress/pending 门槛
        const forceLive = evs.some((e) => typeof e?.streamId === 'string' && e.streamId.startsWith('sessiondb/'));
        if (!this.suppressFallbackAgent || forceLive) {
            for (const ev of evs) {
                // 已答轮次的迟到 requests/N 死流：该问题答案已发过（sessiondb 快通道等），
                // START 则整流丢弃（含后续 CHUNK/SET/END），否则留「…」占位+停止态误吞发送。
                const evSid = ev.streamId;
                if (evSid && this.suppressedFallbackStreams.has(evSid)) {
                    if (ev.type === 'AGENT_STREAM_END')
                        this.suppressedFallbackStreams.delete(evSid);
                    continue;
                }
                if (ev.type === 'AGENT_STREAM_START' && evSid) {
                    // 归属解析走全通道（_ut/streamId/requestIndex/rid）——requests/N 在 rid
                    // 索引查不到时不再漏网开空流（实测死流挂「•••」占位 ~2min）。
                    const ut = this.resolveUtForFallbackEv(ev);
                    if (ut && this.isUtAnswered(ut)) {
                        this.suppressedFallbackStreams.add(evSid);
                        continue;
                    }
                }
                if (ev.type === 'USER_MESSAGE' || ev.type === 'COPILOT_TYPING') {
                    // 用户消息本身不投，但记 rid→问题文本：后续该请求的助手投影拿得到
                    // ut 键，迟到重投影才能被 ut 去重命中
                    if (ev.type === 'USER_MESSAGE') {
                        const rid = ev.requestId;
                        const ut = this.normUserText(String(ev.text || ''));
                        if (rid && ut) {
                            this.fallbackRequestUserText.set(rid, ut);
                            const ri = ev.requestIndex;
                            if (typeof ri === 'number')
                                this.fallbackRequestIndex.set(ri, rid);
                        }
                    }
                    continue;
                }
                // 归属先行：投影事件本就缺 _ut 时 emit() 会拿 activeUserText 兜底——
                // 迟到事件会被错误归到当前新问题（幻影/双发根因）。先按 rid/streamId/
                // requestIndex 解析它真正的问题写进 _ut；解析不到宁可不带，也别归错。
                const evUt = this.resolveUtForFallbackEv(ev);
                if (evUt && !ev._ut)
                    ev._ut = evUt;
                // chatSessions 写盘滞后数十秒：正文已在 transcript 通道发出时，迟到的
                // 同用户轮次重复投影（含 markdown 变体）按用户文键去重，避免双气泡。
                if (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET') {
                    const text = String(ev.text || '').trim();
                    if (text) {
                        const streamId = ev.streamId || '';
                        const m = streamId.match(/^requests\/(\d+)\//);
                        let rid;
                        let reqIdx = ev.requestIndex;
                        if (m) {
                            const idx = parseInt(m[1], 10);
                            if (reqIdx == null)
                                reqIdx = idx;
                            rid = this.fallbackRequestIndex.get(idx) || [...this.fallbackSeenRequestIds][idx];
                        }
                        const ut = ev._ut ?? (rid ? this.fallbackRequestUserText.get(rid) : undefined);
                        // 内容被压的流若已开过 START：补 END 收尸——否则手机端「•••」占位
                        // 挂到下一条 DONE 才清（实测 ~2min）。同时标 suppressed 吞掉后续帧。
                        const suppressLiveStream = () => {
                            if (streamId && !this.suppressedFallbackStreams.has(streamId)) {
                                this.suppressedFallbackStreams.add(streamId);
                                this.emit({
                                    type: 'AGENT_STREAM_END',
                                    streamId,
                                    requestIndex: reqIdx,
                                    _ut: ut || undefined,
                                });
                            }
                        };
                        if (this.hasEmittedAgentText(text, { requestIndex: reqIdx, streamId, rid, userText: ut })) {
                            suppressLiveStream();
                            continue;
                        }
                        // 自轮重投影：同一答案文本经另一流形态再投（requests/N 重放）→ 双气泡
                        if (this.isReplayedFor(text, ut)) {
                            suppressLiveStream();
                            continue;
                        }
                        // 文本变体压制：sessiondb/fallback 通道投影与已投版本形态不同时，
                        // 按该问题已投答案的前/后 40 字比对（前缀因工具引用缺失异、尾部常一致——
                        // 残缺重投影 +37s 变体实测即尾部同文）。同题重问由 seq 放行。
                        const utN = ut ? this.normUserText(ut) : '';
                        if (utN && this.isUtAnswered(utN)) {
                            const prev = this.emittedTextByUt.get(utN) || '';
                            const cur = this.agentTextKey(text);
                            if ((cur.slice(0, 40).length >= 12 && cur.slice(0, 40) === prev.slice(0, 40)) ||
                                (cur.slice(-40).length >= 12 && cur.slice(-40) === prev.slice(-40))) {
                                suppressLiveStream();
                                continue;
                            }
                        }
                    }
                }
                this.emit(ev);
            }
            return;
        }
        // 无待补用户轮 → 不发任何 fallback 助手；
        // 但流收尾事件仍放行——否则已开流的「…」占位泡/停止按钮会卡死
        if (!this.hasPendingGap()) {
            for (const ev of evs) {
                if (ev.type === 'AGENT_STREAM_END' || ev.type === 'COPILOT_DONE') {
                    const doneUt = this.resolveUtForFallbackEv(ev);
                    if (doneUt && !ev._ut)
                        ev._ut = doneUt;
                    this.emit(ev);
                }
            }
            return;
        }
        for (const ev of evs) {
            if (!ev || typeof ev !== 'object')
                continue;
            if (ev.type === 'USER_MESSAGE' || ev.type === 'COPILOT_TYPING') {
                if (ev.type === 'USER_MESSAGE') {
                    const rid = ev.requestId;
                    const ut = this.normUserText(String(ev.text || ''));
                    if (rid && ut) {
                        this.fallbackRequestUserText.set(rid, ut);
                        const ri = ev.requestIndex;
                        if (typeof ri === 'number')
                            this.fallbackRequestIndex.set(ri, rid);
                    }
                }
                continue;
            }
            if (ev.type === 'AGENT_STREAM_START' || ev.type === 'AGENT_STREAM_CHUNK')
                continue;
            if (ev.type === 'COPILOT_DONE') {
                const doneUt = this.resolveUtForFallbackEv(ev);
                if (doneUt && !ev._ut)
                    ev._ut = doneUt;
                this.emit(ev);
                continue;
            }
            // 0.5.26：不 gap-fill TOOL——避免旧工具卡洪水；只补最终正文
            if (ev.type === 'TOOL_CALL')
                continue;
            if (ev.type === 'AGENT_STREAM_END') {
                this.emit(ev);
                continue;
            }
            if (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET') {
                const text = String(ev.text || '').trim();
                if (!text)
                    continue;
                if ((0, jsonl_1.isInternalMonologue)(text))
                    continue;
                const streamId = ev.streamId || '';
                const m = streamId.match(/^requests\/(\d+)\//);
                let ts;
                let matchedUser;
                let matchedRid;
                let reqIdx = ev.requestIndex;
                if (m) {
                    const idx = parseInt(m[1], 10);
                    if (reqIdx == null)
                        reqIdx = idx;
                    const rid = this.fallbackRequestIndex.get(idx) ||
                        [...this.fallbackSeenRequestIds][idx];
                    if (rid) {
                        matchedRid = rid;
                        ts = this.fallbackRequestTs.get(rid);
                        matchedUser = this.fallbackRequestUserText.get(rid);
                    }
                }
                // sessiondb 通道行自带用户文，直接用
                if (!matchedUser)
                    matchedUser = ev._ut;
                // 单 pending 或顺序 FIFO 匹配：无 streamId 索引匹配时取队列首个匹配项
                if (!matchedUser) {
                    if (this.pendingGapQueue.length === 1) {
                        matchedUser = this.pendingGapQueue[0].userText;
                    }
                    else if (matchedRid && this.fallbackRequestUserText.has(matchedRid)) {
                        matchedUser = this.fallbackRequestUserText.get(matchedRid);
                    }
                    else {
                        // 多个 in-flight 时按 FIFO 取第一个在 fallbackRequestUserText 中匹配或队列头
                        matchedUser = this.pendingGapQueue[0]?.userText;
                    }
                    if (matchedUser && !matchedRid) {
                        for (const [rid, ut] of this.fallbackRequestUserText) {
                            if (ut === matchedUser) {
                                matchedRid = rid;
                                ts = this.fallbackRequestTs.get(rid);
                                break;
                            }
                        }
                    }
                }
                // 必须能对应到某个 pending 用户文；否则丢弃（防止旧 turn 正文）
                if (!matchedUser || !this.hasPendingGap(matchedUser))
                    continue;
                if (this.hasEmittedAgentText(text, { requestIndex: reqIdx, streamId, rid: matchedRid, userText: matchedUser }))
                    continue;
                this.noteEmittedAgentText(text, { requestIndex: reqIdx, streamId, rid: matchedRid || undefined, userText: matchedUser });
                if (matchedRid)
                    this.gapFilledRequestIds.add(matchedRid);
                this.removePendingGap(matchedUser);
                this.completedGapUserTexts.add(matchedUser);
                this.emit({
                    ...ev,
                    type: 'AGENT_MESSAGE',
                    text,
                    streamId: streamId || `gap-${Date.now().toString(36)}`,
                    gapFill: true,
                    timestamp: ts,
                    _ut: matchedUser,
                });
                continue;
            }
        }
        this.capCollections();
    }
    normUserText(text) {
        return String(text || '')
            .trim()
            .replace(/\s+/g, ' ');
    }
    /** 当前 turn 缺可见正文 → 登记待补用户文（不重扫全文） */
    markCurrentTurnGap() {
        const ut = this.normUserText(this.activeUserText);
        if (ut && !this.completedGapUserTexts.has(ut)) {
            this.pushPendingGap(ut);
        }
        this.capCollections();
    }
    agentTextKey(text) {
        // markdown 强调差异视为同文（"Fe" == "**Fe**"），用于跨通道重复判定
        return text.trim().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').slice(0, 160);
    }
    /** 会话域前缀：dedupe 键按会话隔离，重绑回来仍能命中本会话指纹 */
    sessPrefix() {
        return this.boundSessionBase ? this.boundSessionBase.replace(/\.jsonl$/, '') + '::' : '';
    }
    dedupeKeys(text, ctx) {
        const sess = this.sessPrefix();
        const base = this.agentTextKey(text);
        if (!base)
            return [];
        const b = sess + base;
        const keys = [];
        if (ctx?.rid)
            keys.push(`${b}::rid=${ctx.rid}`);
        if (ctx?.requestIndex != null)
            keys.push(`${b}::idx=${ctx.requestIndex}`);
        if (ctx?.streamId)
            keys.push(`${b}::sid=${ctx.streamId}`);
        // 用户文键：同一用户轮次的回复在 transcript 与 chatSessions 双通道下发时互斥，
        // 不同轮次得到同文字回复仍可各显一次（test_gapfill_pending F 段语义）。
        const ut = ctx?.userText ? this.normUserText(ctx.userText) : '';
        if (ut)
            keys.push(`${b}::ut=${ut}`);
        if (!keys.length)
            keys.push(b);
        return keys;
    }
    hasEmittedAgentText(text, ctx) {
        if (this.isStalePendingReplay(text))
            return true;
        for (const k of this.dedupeKeys(text, ctx)) {
            if (k.includes('::ut=')) {
                // 永久 ut 键：该问题已发过同文回复且此后没重问同题 → 迟到重复，压制
                const s = this.emittedAgentUtKeys.get(k);
                if (s != null && (this.userSeqByUt.get(ctx?.userText ? this.normUserText(ctx.userText) : '') ?? 0) <= s)
                    return true;
                continue;
            }
            if (this.emittedAgentTextKeys.has(k))
                return true;
        }
        return false;
    }
    noteEmittedAgentText(text, ctx) {
        const keys = this.dedupeKeys(text, ctx);
        if (!keys.length)
            return;
        for (const k of keys) {
            if (k.includes('::ut=')) {
                this.emittedAgentUtKeys.set(k, this.userEmitSeq);
                const ut = k.slice(k.indexOf('::ut=') + 5);
                if (ut)
                    this.emittedTextByUt.set(ut, this.agentTextKey(text));
            }
            else
                this.emittedAgentTextKeys.add(k);
        }
        if (this.emittedAgentUtKeys.size > 400) {
            const arr = [...this.emittedAgentUtKeys];
            this.emittedAgentUtKeys = new Map(arr.slice(-200));
        }
        if (this.emittedAgentTextKeys.size > 800) {
            const arr = [...this.emittedAgentTextKeys];
            this.emittedAgentTextKeys = new Set(arr.slice(-400));
        }
    }
    capSet(set, limit) {
        if (set.size > limit) {
            const arr = [...set];
            set.clear();
            for (let i = arr.length >> 1; i < arr.length; i++)
                set.add(arr[i]);
        }
    }
    capMap(map, limit) {
        if (map.size > limit) {
            const arr = [...map];
            map.clear();
            for (let i = arr.length >> 1; i < arr.length; i++)
                map.set(arr[i][0], arr[i][1]);
        }
    }
    capCollections() {
        this.capSet(this.seenMessageIds, 2000);
        this.capMap(this.lastContentByMessageId, 500);
        this.capMap(this.lastEmittedTextByStream, 500);
        this.capSet(this.fallbackSeenRequestIds, 2000);
        this.capMap(this.fallbackRequestTs, 2000);
        this.capMap(this.fallbackRequestUserText, 500);
        this.capMap(this.fallbackRequestIndex, 2000);
        this.capSet(this.gapFilledRequestIds, 2000);
        this.capSet(this.completedGapUserTexts, 2000);
        if (this.pendingGapQueue.length > 2000) {
            this.pendingGapQueue = this.pendingGapQueue.slice(-1000);
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
                this.updatePollInterval();
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
        this.updatePollInterval();
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
        this.updatePollInterval();
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
            this.pendingBytes = Buffer.alloc(0);
            this.lastLineFp = '';
        }
        // 同 size 但 mtime 前进：可能原地重写了最后一行 → 回退读取最后一行对比指纹
        if (st.size === this.offset && st.size > 0 && st.mtimeMs > this.lastMtimeMs + 5) {
            this.lastMtimeMs = st.mtimeMs;
            this.pendingBytes = Buffer.alloc(0);
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
            const combined = this.pendingBytes.length > 0
                ? Buffer.concat([this.pendingBytes, buf])
                : buf;
            const trim = trimTrailingUtf8(combined);
            if (trim > 0) {
                this.pendingBytes = Buffer.from(combined.subarray(combined.length - trim));
                this.processChunk(combined.toString('utf8', 0, combined.length - trim));
            }
            else {
                this.pendingBytes = Buffer.alloc(0);
                this.processChunk(combined.toString('utf8'));
            }
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
        let fd;
        let line;
        try {
            fd = fs.openSync(cur, 'r');
            const st = fs.fstatSync(fd);
            const actualSize = st.size;
            if (actualSize <= 0)
                return;
            const readLen = Math.min(actualSize, REREAD_LAST_LINE_BYTES);
            const startOffset = Math.max(0, actualSize - readLen);
            const buf = Buffer.alloc(readLen);
            const bytesRead = fs.readSync(fd, buf, 0, readLen, startOffset);
            const s = buf.subarray(0, bytesRead).toString('utf8');
            const nl = s.lastIndexOf('\n');
            if (nl < 0)
                return; // 块内无换行：正在写入的半行，跳过
            line = s.slice(nl + 1).trim();
        }
        catch {
            return;
        }
        finally {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                }
                catch {
                    /* ignore */
                }
            }
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
                // 新 turn 前先收尾上一流，避免跨 turn 正文/streamId 粘连（发 2 又回放 1）
                if (this.activeTurnId || this.activeStreamId || this.streamAccum) {
                    this.endActiveStream();
                }
                this.turnSeq += 1;
                this.activeTurnId = turnId;
                this.streamAccum = '';
                this.pendingReasoning = [];
                this.turnEmittedVisibleAgent = false;
                // 0.5.24：turn_start 超时兜底——如果 transcript 在 3 秒内没写出任何
                // assistant.message 内容（断流），自动开 gap-fill，让 chatSessions 补上
                this.startTurnGapTimer();
                // 不预发 STREAM_START：等真正有 content 时由 emitAssistantContent 开流（避免空 ••• 壳）
                return;
            }
            case 'assistant.message': {
                if (!data)
                    return;
                this.handleAssistantMessage(data, tsMs);
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
        if (!Number.isNaN(tsMs)) {
            this.lastUserTsMs = tsMs;
            const utT = this.normUserText(content);
            if (utT)
                this.userTsByUt.set(utT, tsMs);
        }
        this.endActiveStream(); // 新用户输入：结束上一轮未结束的流
        this.clearTurnGapTimer();
        this.clearTurnHardTimer();
        this.activeUserText = this.normUserText(content);
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
    /** 按记录时间戳归属正文到正确的问题：迟到写入的上一轮 assistant.message
     *  的记录 ts 早于当前新问题 → 映射回它所属的问题键，命中幻影压制。 */
    resolveUtForTs(tsMs) {
        if (Number.isNaN(tsMs))
            return this.activeUserText;
        let best;
        let bestTs = -1;
        for (const [ut, ts] of this.userTsByUt) {
            if (ts <= tsMs + 2000 && ts > bestTs) {
                best = ut;
                bestTs = ts;
            }
        }
        return best ?? this.activeUserText;
    }
    handleAssistantMessage(data, tsMs = NaN) {
        const messageId = asString(data.messageId);
        const reasoning = asString(data.reasoningText);
        const content = asString(data.content);
        const toolReqs = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        // 该 messageId 首次出现才处理 reasoning / toolRequests（重放/重读防重复）；
        // content 每次都走增量投影（同一 messageId 重写变长 → CHUNK）
        const firstSeen = !messageId || !this.seenMessageIds.has(messageId);
        if (messageId)
            this.seenMessageIds.add(messageId);
        // 0.5.26：无 activeTurn 时，**禁止**仅因 content 自动开 turn。
        // 旧逻辑 `if (!activeTurnId && content) activeTurnId='auto'` 会把超时关闭后的
        // orphan assistant.message（如迟到的 "789"）重新挂到新用户气泡。
        // 仅 reasoning / toolRequests 在 mid-file replay 时允许 auto-open。
        if (!this.activeTurnId && (reasoning || toolReqs.length)) {
            this.turnSeq += 1;
            this.activeTurnId = 'auto';
            this.streamAccum = '';
            this.turnEmittedVisibleAgent = false;
            this.pendingReasoning = [];
            this.startTurnHardTimer();
        }
        // 0.5.26：空 content 不再开「全局 gap」。
        // 仅当本 turn 结束仍无可见正文时，才把 activeUserText 记入 pending。
        if (reasoning && firstSeen) {
            this.pendingReasoning.push(reasoning);
            this.emit({
                type: 'THINKING_STEP',
                text: reasoning,
                requestIndex: this.turnSeq,
                stepId: messageId ? 'think-' + messageId : undefined,
            });
        }
        // 0.5.24：收到任何 assistant.message 内容 → 取消 turn_start 超时（transcript 没断流）
        // 0.5.26：仅当本 turn 仍 active 时取消；orphan 迟到消息不复活已关闭 turn
        if (this.activeTurnId)
            this.clearTurnGapTimer();
        if (content) {
            // 0.5.26：orphan assistant（无 activeTurn）不当正文投影——避免挂到旧用户气泡
            if (!this.activeTurnId) {
                if ((0, jsonl_1.isInternalMonologue)(content) && firstSeen) {
                    this.emit({
                        type: 'THINKING_STEP',
                        text: content,
                        requestIndex: this.turnSeq,
                        stepId: messageId ? 'orphan-mono-' + messageId : undefined,
                    });
                }
                else if (this.hasPendingGap() && !this.turnEmittedVisibleAgent) {
                    this.turnSeq += 1;
                    this.activeTurnId = 'late';
                    this.streamAccum = '';
                    this.turnEmittedVisibleAgent = false;
                    this.startTurnHardTimer();
                    this.emitAssistantContent(content, messageId, tsMs);
                }
            }
            else if ((0, jsonl_1.isInternalMonologue)(content)) {
                this.markCurrentTurnGap();
                if (firstSeen) {
                    this.pendingReasoning.push(content);
                    this.emit({
                        type: 'THINKING_STEP',
                        text: content,
                        requestIndex: this.turnSeq,
                        stepId: messageId ? 'mono-' + messageId : undefined,
                    });
                }
            }
            else {
                this.emitAssistantContent(content, messageId, tsMs);
            }
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
                // 工具卡单独占位；正文用独立 stream，避免与 tool 交错时同一 bubble 被整段 SET 覆盖错序
                this.toolStates.set(toolCallId, { text: name, requestIndex: this.turnSeq, complete: false });
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
        this.capCollections();
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
    emitAssistantContent(content, messageId, tsMs = NaN) {
        // 迟到重投影：上一轮 assistant.message 延迟落盘到达时，内容已是发过的答案 → 不开流。
        // ut 归属：按记录时间戳找回它所属的问题（activeUserText 可能已被新问覆盖）；
        // 同时查 stale pending 兜底。
        const resolvedUt = this.resolveUtForTs(tsMs);
        if (this.isReplayedFor(content, resolvedUt) || this.isStalePendingReplay(content))
            return;
        // 同问题答案文本变体压制：迟到记录的正文与已投版本形态不同（markdown/db 差异）
        // 键未命中时按「该问题已投答案」的前/后 40 字比对——前缀因工具引用缺失异、
        // 尾部常一致（残缺重投影 +37s 变体实测即尾部同文）。同题重问由 seq 放行。
        if (resolvedUt && this.isUtAnswered(resolvedUt)) {
            const prev = this.emittedTextByUt.get(resolvedUt) || '';
            const cur = this.agentTextKey(content);
            const a = cur.slice(0, 40);
            const b = prev.slice(0, 40);
            const at = cur.slice(-40);
            const bt = prev.slice(-40);
            if ((a.length >= 12 && a === b) || (at.length >= 12 && at === bt))
                return;
        }
        // 用户可见正文（非 monologue 路径才会进这里）
        this.turnEmittedVisibleAgent = true;
        // 0.5.18：工具后的新正文用独立 streamId，避免与上一截正文/tool 合并成「堆积」
        // 同一 messageId 的流式增长仍复用 activeStreamId。
        let streamId = this.activeStreamId;
        if (!streamId) {
            if (messageId)
                streamId = 't' + this.turnSeq + 'm' + messageId.slice(0, 12);
            else
                streamId = 't' + this.turnSeq + 's' + Date.now().toString(36).slice(-4);
            this.activeStreamId = streamId;
            this.emit({
                type: 'AGENT_STREAM_START',
                streamId,
                requestIndex: this.turnSeq,
                _ut: resolvedUt || undefined,
            });
        }
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
                            _ut: resolvedUt || undefined,
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
                    _ut: resolvedUt || undefined,
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
                    _ut: resolvedUt || undefined,
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
                        _ut: resolvedUt || undefined,
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
            _ut: resolvedUt || undefined,
        });
    }
    /**
     * tool.execution_start：发/更新 TOOL_CALL（arguments 已是对象，直接透传），
     * 记录 toolStates 供 execution_complete 回填。
     * 0.5.18：工具开始时结束当前正文流，使后续正文成为 tool 之后的新 bubble（对齐桌面穿插）。
     */
    handleToolExecutionStart(data) {
        const toolCallId = asString(data.toolCallId);
        if (!toolCallId)
            return;
        const toolName = asString(data.toolName) || 'tool';
        // 只切断 stream，保留 turnSeq / activeTurnId（否则 requestIndex 错乱）
        if (this.streamAccum || this.activeStreamId) {
            const keepTurn = this.activeTurnId || 'tool-split';
            const keepSeq = this.turnSeq;
            this.endActiveStream();
            this.activeTurnId = keepTurn;
            this.turnSeq = keepSeq;
        }
        this.toolStates.set(toolCallId, { text: toolName, requestIndex: this.turnSeq, complete: false });
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
        if (!st) {
            // 绑定前未见到 start：仍发 complete，避免 PWA 永远 running（用 toolCallId 短名）
            this.toolStates.set(toolCallId, {
                text: asString(data.toolName) || 'tool',
                requestIndex: this.turnSeq,
                complete: true,
            });
            this.emit({
                type: 'TOOL_CALL',
                text: asString(data.toolName) || 'tool',
                toolId: toolCallId,
                isComplete: true,
                requestIndex: this.turnSeq,
            });
            return;
        }
        st.complete = true;
        this.emit({
            type: 'TOOL_CALL',
            text: st.text,
            toolId: toolCallId,
            isComplete: true,
            requestIndex: st.requestIndex,
        });
    }
    /** 把尚未 complete 的工具全部标 done（turn 结束 / 用户新消息时） */
    completeOpenTools() {
        for (const [toolCallId, st] of this.toolStates) {
            if (st.complete)
                continue;
            st.complete = true;
            this.emit({
                type: 'TOOL_CALL',
                text: st.text,
                toolId: toolCallId,
                isComplete: true,
                requestIndex: st.requestIndex ?? this.turnSeq,
            });
        }
    }
    /**
     * assistant.turn_end：
     * - 未完成工具 → 强制 isComplete（桌面已结束步骤时远程不得残留 running）
     * - 有正文 → AGENT_MESSAGE（最终完整文本）
     * - 只要本 turn 开过正文流 → AGENT_STREAM_END
     * - 再发 COPILOT_DONE
     */
    handleTurnEnd() {
        const streamId = this.activeStreamId || 't' + this.turnSeq;
        this.completeOpenTools();
        // 0.5.24：turn_end 到了，取消超时定时器
        this.clearTurnGapTimer();
        this.clearTurnHardTimer();
        // 0.5.28：如果已发出过可见正文，把用户文记入 completed，并从 pending 中移除，避免 chatSessions 兜底再 gap 出重复回复
        if (this.turnEmittedVisibleAgent && this.activeUserText) {
            const ut = this.normUserText(this.activeUserText);
            this.completedGapUserTexts.add(ut);
            this.removePendingGap(ut);
        }
        // 0.5.23：本 turn 从未发出用户可见正文（空 content / 仅 monologue / 仅 tool）→ gap
        // 注意：工具切断会清 streamAccum，不能用 streamAccum 空判断
        if (!this.turnEmittedVisibleAgent) {
            this.markCurrentTurnGap();
        }
        // 收尾事件必须先取本轮 ut 再清：AGENT_MESSAGE/DONE 按 _ut 归属到本题，
        // 客户端按 ut 释放「已发未答」条目与去重键（兜底 activeUserText 已清会归空键）。
        const doneUt = this.activeUserText || undefined;
        this.activeUserText = '';
        if (this.streamAccum && !(0, jsonl_1.isInternalMonologue)(this.streamAccum)) {
            this.emit({
                type: 'AGENT_MESSAGE',
                streamId,
                text: this.streamAccum,
                requestIndex: this.turnSeq,
                _ut: doneUt,
            });
        }
        if (this.activeStreamId || this.streamAccum || this.lastEmittedTextByStream.has(streamId)) {
            this.emit({ type: 'AGENT_STREAM_END', streamId, requestIndex: this.turnSeq, _ut: doneUt });
        }
        this.emit({ type: 'COPILOT_DONE', requestIndex: this.turnSeq, _ut: doneUt });
        this.activeStreamId = null;
        this.activeTurnId = null;
        this.streamAccum = '';
        this.pendingReasoning = [];
        this.turnEmittedVisibleAgent = false;
        this.lastEmittedTextByStream.delete(streamId);
        this.capCollections();
    }
    /** 结束当前未结束的流：发 AGENT_MESSAGE（如有正文）+ AGENT_STREAM_END，重置缓冲 */
    endActiveStream() {
        const streamId = this.activeStreamId || (this.activeTurnId ? 't' + this.turnSeq : null);
        if (streamId) {
            if (this.streamAccum && !(0, jsonl_1.isInternalMonologue)(this.streamAccum)) {
                this.emit({
                    type: 'AGENT_MESSAGE',
                    streamId,
                    text: this.streamAccum,
                    requestIndex: this.turnSeq,
                });
            }
            if (this.activeStreamId || this.streamAccum || this.lastEmittedTextByStream.has(streamId)) {
                this.emit({
                    type: 'AGENT_STREAM_END',
                    streamId,
                    requestIndex: this.turnSeq,
                });
            }
            this.lastEmittedTextByStream.delete(streamId);
            // 0.5.26：结束当前正文流后必须清空 activeStreamId / streamAccum，
            // 否则 tool 切流后的新正文会复用旧 streamId，导致两段正文被 SET 覆盖到同一气泡。
            this.activeStreamId = null;
            this.streamAccum = '';
        }
        // 注意：不重置 turnEmittedVisibleAgent——工具切流后仍属同一 turn
    }
    /**
     * 0.5.24：启动 turn_start 超时定时器。
     * 如果 transcript 在 TURN_GAP_TIMEOUT_MS 内没有写出任何 assistant.message
     * 内容（断流场景），把 activeUserText 记入 pendingGapUserTexts，让 chatSessions 按轮 gap-fill
     * 能补上最终回复。收到任何 assistant.message 或 turn_end 时取消。
     */
    startTurnGapTimer() {
        this.clearTurnGapTimer();
        this.turnGapTimer = setTimeout(() => {
            this.turnGapTimer = undefined;
            // turn_start 后 3 秒内无用户可见正文 → 只登记 pending gap，不关 turn
            // 真实 Copilot 首段正文常 >3s 且 parentId 为空；关 turn 会丢掉桌面回复
            if (!this.turnEmittedVisibleAgent && this.activeTurnId) {
                this.markCurrentTurnGap();
            }
        }, TranscriptWatcher.TURN_GAP_TIMEOUT_MS);
        this.startTurnHardTimer();
    }
    /** 0.5.24：取消 turn_start 超时定时器 */
    clearTurnGapTimer() {
        if (this.turnGapTimer) {
            clearTimeout(this.turnGapTimer);
            this.turnGapTimer = undefined;
        }
    }
    startTurnHardTimer() {
        this.clearTurnHardTimer();
        this.turnHardTimer = setTimeout(() => {
            this.turnHardTimer = undefined;
            this.closeCurrentTurn();
        }, TranscriptWatcher.TURN_HARD_TIMEOUT_MS);
    }
    clearTurnHardTimer() {
        if (this.turnHardTimer) {
            clearTimeout(this.turnHardTimer);
            this.turnHardTimer = undefined;
        }
    }
    closeCurrentTurn() {
        const streamId = this.activeStreamId || (this.activeTurnId ? 't' + this.turnSeq : null);
        this.completeOpenTools();
        if (!this.turnEmittedVisibleAgent) {
            this.markCurrentTurnGap();
        }
        if (streamId) {
            if (this.streamAccum && !(0, jsonl_1.isInternalMonologue)(this.streamAccum)) {
                this.emit({
                    type: 'AGENT_MESSAGE',
                    streamId,
                    text: this.streamAccum,
                    requestIndex: this.turnSeq,
                    _ut: this.activeUserText || undefined,
                });
            }
            if (this.activeStreamId || this.streamAccum || this.lastEmittedTextByStream.has(streamId)) {
                this.emit({
                    type: 'AGENT_STREAM_END',
                    streamId,
                    requestIndex: this.turnSeq,
                    _ut: this.activeUserText || undefined,
                });
            }
            this.lastEmittedTextByStream.delete(streamId);
        }
        // DONE 带本轮 _ut：客户端按 ut 释放「已发未答」条目（任意 DONE 整表清
        // 会把别轮在途条目误杀 → 用户泡丢、答案裸奔）。
        this.emit({
            type: 'COPILOT_DONE',
            requestIndex: this.turnSeq,
            _ut: this.activeUserText || undefined,
        });
        this.activeTurnId = null;
        this.activeStreamId = null;
        this.streamAccum = '';
        this.pendingReasoning = [];
        this.turnEmittedVisibleAgent = false;
        this.activeUserText = '';
        this.clearTurnGapTimer();
        this.clearTurnHardTimer();
    }
    /** 重置全部投影状态（session.start / bindFile 时调用）。preserveDedupe=true（同会话重绑）保留去重指纹 */
    resetState(preserveDedupe = false) {
        this.activeTurnId = null;
        this.turnSeq = 0;
        this.activeStreamId = null;
        this.streamAccum = '';
        this.pendingReasoning = [];
        this.pendingBytes = Buffer.alloc(0);
        this.fallbackRequestIndex.clear();
        this.turnEmittedVisibleAgent = false;
        this.clearTurnGapTimer();
        this.clearTurnHardTimer();
        this.toolStates.clear();
        this.seenMessageIds.clear();
        this.lastContentByMessageId.clear();
        this.lastEmittedTextByStream.clear();
        this.lastUserTsMs = null;
        // bindFile 会 reset：ut/正文去重键已按会话基名域化（见 dedupeKeys 的 sess 前缀），
        // 跨会话重绑保留指纹也无串扰——保留它们可以在「重绑回来」后仍压制迟到重投影。
        // 其余 live 状态（pending/gap/active 轮次）仍清空。
        if (!preserveDedupe) {
            this.fallbackSeenRequestIds.clear();
            this.gapFilledRequestIds.clear();
            this.pendingGapQueue = [];
            this.completedGapUserTexts.clear();
            this.activeUserText = '';
            this.fallbackRequestUserText.clear();
            this.fallbackRequestTs.clear();
        }
        // suppressFallbackAgent 由 bindFile 设置，不在此清
    }
    /** 归一化用户文+回复文 → 最近发出时间：阻断同轮次响应经不同 streamId/通道的重复投影 */
    recentAgentEmits = new Map();
    /** 事件出口：dispose 后不再发出；记录助手正文供 chatSessions gap-fill 去重 */
    emit(ev) {
        if (this.disposed)
            return;
        // 会话标签：客户端按绑定会话过滤，任何通道的跨会话事件不得投影到当前 feed
        if (ev && this.boundSessionBase) {
            ev._sess = this.boundSessionBase.replace(/\.jsonl$/, '');
        }
        if (ev && ev.type === 'USER_MESSAGE') {
            // 记录提问序号：迟到重复投影只有「之后真的重问了同题」才放行
            this.userEmitSeq += 1;
            const ut = this.normUserText(String(ev.text || ''));
            if (ut)
                this.userSeqByUt.set(ut, this.userEmitSeq);
        }
        if (ev && (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET')) {
            const text = String(ev.text || '');
            if (text.trim() && !(0, jsonl_1.isInternalMonologue)(text)) {
                // 同轮次去重：同一回答被 requests/N 重编号或双通道投影成不同 streamId 时
                // 只发一次。键含用户文——不同用户轮次得到同文字回复时各显一次（不误吞）。
                // ut 归属优先事件自带 _ut；否则按事件时间戳找回所属问题（activeUserText
                // 会把迟到投影归到新问题——幻影/双发根因）。都无 → 空键也绝不归错。
                const evTs = typeof ev.timestamp === 'number' ? ev.timestamp : NaN;
                const resolvedEvUt = ev._ut ??
                    (Number.isNaN(evTs) ? this.activeUserText : this.resolveUtForTs(evTs));
                const ut = this.normUserText(String(resolvedEvUt ?? ''));
                // 跨通道去重：t 流/sessiondb 同文同题答案间隔可达 ~6s 超过旧窗才双发；
                // 键不含 ev.type、窗 15s，同题重问的新答由 userSeq 语义在别的检查放行。
                const wkey = `${ut}|${this.agentTextKey(text)}`;
                const last = this.recentAgentEmits.get(wkey) ?? 0;
                if (Date.now() - last < 15000)
                    return;
                // 集中兜底：同 ut 已答且本条与已投版本前/后 40 字同形 → 跨通道迟到
                // 残缺重投影（前缀异/超时窗躲过上两层压制）。同轮 text→tool→text 的
                // 第二段正文内容不同、前后 40 字都不同 → 不误伤。
                if (ut && this.isUtAnswered(ut)) {
                    const prev = this.emittedTextByUt.get(ut) || '';
                    const cur = this.agentTextKey(text);
                    if ((cur.slice(0, 40).length >= 12 && cur.slice(0, 40) === prev.slice(0, 40)) ||
                        (cur.slice(-40).length >= 12 && cur.slice(-40) === prev.slice(-40)))
                        return;
                }
                this.recentAgentEmits.set(wkey, Date.now());
                if (this.recentAgentEmits.size > 300) {
                    const cutoff = Date.now() - 60_000;
                    for (const [k, ts] of this.recentAgentEmits)
                        if (ts < cutoff)
                            this.recentAgentEmits.delete(k);
                }
                this.noteEmittedAgentText(text, {
                    requestIndex: ev.requestIndex,
                    streamId: ev.streamId,
                    rid: ev.requestId,
                    userText: resolvedEvUt,
                });
            }
        }
        this.opts.onEvent(ev);
    }
    /** (用户文,正文) 键是否已发过且此后没同题重问（迟到重投影判定） */
    isReplayedFor(text, userText) {
        // 按「答案文本」查所有已投键：正文同一问题发出的答案只许出现一次。
        // 对每条匹配键用它自己的 ut 比较 seq——同题重问会抬 userSeqByUt[ut]，放行真重答；
        // 迟到重投影（无论归属到哪个 ut/哪个 sess）统一压制。
        const prefix = `${this.agentTextKey(text)}::ut=`;
        if (!prefix || prefix === '::ut=')
            return false;
        for (const [k, v] of this.emittedAgentUtKeys) {
            const i = k.indexOf(prefix);
            if (i < 0)
                continue;
            const keyUt = k.slice(i + prefix.length);
            if ((this.userSeqByUt.get(keyUt) ?? 0) <= v)
                return true;
        }
        return false;
    }
    /** 该问题的答案是否已发过（任一通道）：seq 语义同 isReplayedFor——
     *  答案记录在最新提问之后才算「已答」，同题重问会抬 seq 放行。 */
    isUtAnswered(userText) {
        const normUt = this.normUserText(userText);
        if (!normUt)
            return false;
        const suffix = `::ut=${normUt}`;
        for (const [k, v] of this.emittedAgentUtKeys) {
            if (k.endsWith(suffix) && (this.userSeqByUt.get(normUt) ?? 0) <= v)
                return true;
        }
        return false;
    }
    /** 该正文是否已是某个「仍挂起」问题的答案：上一轮答案发出后其 pending 未消耗（stale），
     *  迟到的 assistant.message/chatSessions 副本会在新轮次里把它整体重投 → 压制。 */
    isStalePendingReplay(text) {
        const k = this.agentTextKey(text);
        if (!k)
            return false;
        const sess = this.sessPrefix();
        for (const q of this.pendingGapQueue) {
            const s = this.emittedAgentUtKeys.get(`${sess}${k}::ut=${q.userText}`);
            if (s != null && (this.userSeqByUt.get(q.userText) ?? 0) <= s)
                return true;
        }
        return false;
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