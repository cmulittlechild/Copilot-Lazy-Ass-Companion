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

import * as fs from 'fs';
import * as path from 'path';
import { JsonlProjector, PhoneEvent, isInternalMonologue, textOfUserReq } from './jsonl';
import { samePath } from './pathutil';

export interface PendingGapRequest {
  userText: string;
  timestamp: number;
  seq: number;
}

export interface TranscriptWatcherOptions {
  /** transcripts 目录（GitHub.copilot-chat/transcripts） */
  dir: string;
  /** chatSessions 目录（兜底源，可选）：transcripts 漏写回复时从 chatSessions 补全 */
  chatSessionsDir?: string;
  /** 轮询兜底间隔 ms，默认 100 */
  pollMs?: number;
  /** 投影出的 PhoneEvent 回调；返回 false 表示该事件最终未被投递
      （回声/去重/仲裁器丢弃）——emit() 据此不记「已投」指纹，避免
      首通道被丢后后续通道的同答案被误判重投影而净丢。 */
  onEvent: (ev: PhoneEvent) => boolean | void;
  /** 诊断日志（接到扩展 QR 面板）；压制类丢弃必须可观测 */
  onLog?: (line: string) => void;
  /** 兜底轮询 chatSessions 兜底源的最短间隔（ms），默认 2000 */
  fallbackPollMs?: number;
  /** Copilot 会话库（globalStorage/github.copilot-chat/session-store.db）：
   *  响应完成即落 turns 行，比 chatSessions 落盘快数十秒，用于快速补最终回复 */
  sessionStoreDb?: string;
}

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
/** 同题 USER_MESSAGE 多通道重影压制窗口：覆盖 chatSessions 批量落盘延迟（Windows ~75s+） */
const USER_COPY_WINDOW_MS = 120_000;
/** 手机侧会话绑定后的窗口期：期内自动跟随一律 live-only@EOF，防旧轮次洪水 */
const PHONE_SELECT_WINDOW_MS = 60_000;

/** unknown → Record 收窄 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** unknown → string 收窄 */
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * 检查 buffer 尾部是否是截断的 UTF-8 多字节序列，返回需要裁剪的字节数。
 * 从末尾向前查找 lead byte，判断后续 continuation byte 是否足够。
 */
function trimTrailingUtf8(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let continuation = 0;
  for (let i = buf.length - 1; i >= 0 && (buf[i] & 0xc0) === 0x80; i--) {
    continuation += 1;
  }
  if (continuation === 0) return 0;
  const leadIndex = buf.length - continuation - 1;
  if (leadIndex < 0) return 0;
  const lead = buf[leadIndex];
  let expected = 0;
  if (lead >= 0xc2 && lead <= 0xdf) expected = 2;
  else if (lead >= 0xe0 && lead <= 0xef) expected = 3;
  else if (lead >= 0xf0 && lead <= 0xf4) expected = 4;
  if (!expected) return 0;
  const actual = continuation + 1;
  return actual < expected ? actual : 0;
}

/**
 * 内部子代理派生消息过滤：
 * - content 以 `[Terminal` / `[Session` / `[Task` / `[Notification` 开头
 * - 或 content 包含 "notification:"（真实样例: "[Terminal <uuid> notification: ..."）
 * 这类 user.message 是 agent 内部派生的（子代理任务/终端通知），不应显示为手机端用户输入。
 */
function isInternalUserMessage(content: string): boolean {
  return (
    content.startsWith('[Terminal') ||
    content.startsWith('[Session') ||
    content.startsWith('[Task') ||
    content.startsWith('[Notification') ||
    content.includes('notification:')
  );
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
export class TranscriptWatcher {
  /** 当前监控的最新 transcript 文件（绝对路径） */
  get currentFile(): string | undefined {
    return this.current;
  }

  /**
   * 手动选择会话后 pin 住目标文件：
   * 周期 rescan（scanNewestBoth）在 pin 期间不再按 mtime 自动切换，
   * 否则手机端切到别的会话后会被「项目学习与理解」的最新 mtime 抢回来。
   * 切回按钮/重新选择目标会话即可解除（再次 bindFile 会覆盖 pin）。
   */
  pinFile(file: string | null): void {
    this.pinnedFile = file ? path.normalize(file) : null;
  }

  /** 字节偏移 tail */
  private current: string | undefined;
  /** 手动 pin 的会话文件（scanNewestBoth 期间不自动切换）；null = 未 pin */
  private pinnedFile: string | null = null;
  private offset = 0;
  /** 半行缓冲（文件尾的不完整 JSON 行等 \n 补齐） */
  private pending = '';
  /** 上次读取尾部被截断的 UTF-8 字节，下次读取时拼接（B6） */
  private pendingBytes = Buffer.alloc(0);
  private lastSize = 0;
  private lastMtimeMs = 0;
  /** 已处理行指纹（长度+首64+尾32），防同 size 原地重写导致重复处理 */
  private lastLineFp = '';
  /** 起始偏移落在行中间时，第一块的首行（半行）要丢弃 */
  private skipFirstLine = false;

  private fileWatcher: fs.FSWatcher | undefined;
  private dirWatcher: fs.FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly pollMs: number;
  /** chatSessions 兜底轮询间隔 ms */
  private readonly fallbackPollMs: number;

  // ---- chatSessions 兜底源状态（双源融合：transcripts 实时为主，chatSessions 兜底补缺失回复）----
  /** chatSessions 投影器（复用 JsonlProjector：kind0/kind2 → PhoneEvent） */
  private fallbackProjector = new JsonlProjector();
  /** 当前兜底对应的 chatSessions 文件 */
  private fallbackFile: string | undefined;
  /** chatSessions 文件字节偏移 */
  private fallbackOffset = 0;
  /** chatSessions 半行缓冲（写入中的不完整 JSON 行） */
  private fallbackPending = '';
  /** 兜底轮询定时器 */
  private fallbackTimer: NodeJS.Timeout | undefined;
  /** 当前绑定的 transcript 会话 id 基名（8304329e-xxx.jsonl → 8304329e-xxx.jsonl） */
  private boundSessionBase: string | undefined;
  /** 已投影过的 chatSessions 请求 id（去重，防全量重写重复处理） */
  private fallbackSeenRequestIds = new Set<string>();
  /**
   * 手机切会话 live-only：transcript 已是权威实时源，HISTORY_REPLAY 负责历史。
   * chatSessions fallback **不得整轮重放**（会重复 1/2 回复），但必须允许
   * **gap-fill**：transcript 常出现空 assistant.message，真实正文只在 chatSessions
   * 稍后落盘（用户截图：桌面有「周六」远程没有）。
   */
  private suppressFallbackAgent = false;
  /** 已从 transcript/gap 发出的助手正文指纹（前 160 字），防 chatSessions 重复补全 */
  private emittedAgentTextKeys = new Set<string>();  // 0.5.31 键改为 text|rid|requestIndex|streamId，避免同一回复文字误吞
  /** text::ut= 键 → 记录时的提问序号：迟到重投影（chatSessions 滞后可达数分钟，
   *  固定时间窗不可靠）只有同题在记录之后真的重问才放行；不同问题同文回复不拦。 */
  private emittedAgentUtKeys = new Map<string, number>();
  /** 已答轮次的迟到 requests/N 流：START 判定后被整流丢弃的 streamId 集合 */
  private suppressedFallbackStreams = new Set<string>();
  /** ut → 已投答案正文键：迟到重投影的文本形态与已投版本不同时，按「同问题已投答案」模糊压制 */
  private emittedTextByUt = new Map<string, string>();
  /** 规范化用户文 → 最近一次该问题发出的用户消息序号 */
  private userSeqByUt = new Map<string, number>();
  /** 已发出 USER_MESSAGE / 注入提问的单调序号（判断「记录之后是否有新提问」） */
  private userEmitSeq = 0;
  /** 已成功 gap-fill（发出助手正文）的 chatSessions requestId */
  private gapFilledRequestIds = new Set<string>();
  /** 已经从 transcript 得到完整助手回复的用户文，避免 chatSessions 再 gap */
  private completedGapUserTexts = new Set<string>();
  /** 本问题开问时 ut 是否已在 completedGapUserTexts（同题重问基线）。 */
  private utCompletedBeforeTurn = false;
  /**
   * 0.5.26：待补全的用户请求有序队列（FIFO）。
   * 确保多个 in-flight 请求按时间序确定性匹配，取代无序集合迭代。
   */
  private pendingGapQueue: PendingGapRequest[] = [];
  private pendingGapSeq = 0;
  /** 活跃 fs.watch 时的备份轮询间隔 (ms) */
  private static readonly BACKUP_POLL_MS = 1200;
  /** 当前 turn 对应的用户原文（规范化前/后各一份便于匹配） */
  private activeUserText = '';
  /**
   * 0.5.23：当前 turn 是否已发出用户可见助手正文。
   * 工具切断流会清空 streamAccum，不能再用 streamAccum 空判断 gap。
   */
  private turnEmittedVisibleAgent = false;
  /**
   * 0.5.24/0.5.26：turn_start 超时定时器。
   * 超时后只把 activeUserText 记入 pendingGapUserTexts，并关闭 activeTurn，
   * 避免数小时后 orphan assistant.message（parentId=null）挂到旧用户气泡。
   */
  private turnGapTimer: NodeJS.Timeout | undefined;
  private turnHardTimer: NodeJS.Timeout | undefined;
  private static readonly TURN_GAP_TIMEOUT_MS = 3000;
  private static readonly TURN_HARD_TIMEOUT_MS = 120_000;
  /** chatSessions requestId → timestamp（用于 gap-fill 事件排序） */
  private fallbackRequestTs = new Map<string, number>();
  /** chatSessions requestId → 用户原文（规范化），供按轮匹配 */
  private fallbackRequestUserText = new Map<string, string>();
  /** chatSessions request 下标 → requestId（对齐 k=['requests', N, 'response']） */
  private fallbackRequestIndex = new Map<number, string>();

  // ---- 事件 → PhoneEvent 映射状态 ----
  private activeTurnId: string | null = null;
  private turnSeq = 0;
  private activeStreamId: string | null = null;
  private streamAccum = '';
  private pendingReasoning: string[] = [];
  private toolStates = new Map<string, { text: string; requestIndex?: number; complete?: boolean }>();
  private seenMessageIds = new Set<string>();
  /** messageId → 该消息已见到的最大 content 快照（同一 messageId 重写变长 → 前缀 diff 发增量） */
  private lastContentByMessageId = new Map<string, string>();
  /** streamId → 已发出的累计文本（新消息 content 是它的前缀增长 → CHUNK，否则 SET 兜底） */
  private lastEmittedTextByStream = new Map<string, string>();
  /** 最近一条保留的 user.message 时间戳（ms），用于 ±3s 派生消息去重 */
  private lastUserTsMs: number | null = null;
  /** 每道用户题的最近一次提问时刻（transcript timestamp）：迟到 assistant.message
   *  的记录时间早于新提问，用它归属到正确的问题键 */
  private userTsByUt = new Map<string, number>();

  constructor(private opts: TranscriptWatcherOptions) {
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
  seedFromHistory(events: PhoneEvent[]) {
    if (!events || !Array.isArray(events)) return;
    // 记下本次种子：随后 bindFile/resetState/bindFallback 会清空这些去重集合，
    // bindFile 收尾时重新应用，避免种子被重置冲掉（切会话旧轮次洪水）。
    this.pendingSeed = events.slice();
    this.applySeedEvents(events);
  }

  /** 待应用的种子：seedFromHistory 记录，bindFile 清空集合后重放 */
  private pendingSeed: PhoneEvent[] | null = null;
  /** 已通过回放/backfill 投过的 sessiondb turns 行 id：迟到的轮询重投影跳过 */
  private sessionDbEmittedIds = new Set<number>();
  /** 最近一次手机侧会话绑定时间：窗口期内自动跟随不得 replay/catch-up 洪水 */
  private lastPhoneSelectMs = 0;
  /** 最近一次已发射 SESSION_FOLLOW 的目标路径：防止 csdir-only 会话占 newest 时每 tick 重发 */
  private lastFollowedPath: string | undefined;

  private applySeedEvents(events: PhoneEvent[]) {
    if (!events || !Array.isArray(events)) return;
    // requestIndex → requestId（USER_MESSAGE 带 rid；AGENT 通常只有 requestIndex）
    const ridByIndex = new Map<number, string>();
    let lastUt = '';
    for (const ev of events) {
      if (!ev) continue;
      const rid = (ev as any).requestId;
      const ri = (ev as any).requestIndex;
      if (ev.type === 'USER_MESSAGE' && typeof (ev as any).text === 'string') {
        const ut = this.normUserText(String((ev as any).text || ''));
        if (ut) {
          lastUt = ut;
          // 回放轮次同步记提问序号：回放态答案算「该题已答」，后续迟到重投影
          // isUtAnswered/前缀40 才能拦住（只记 sessiondb 通道会漏整段回放史）。
          this.userEmitSeq += 1;
          this.userSeqByUt.set(ut, this.userEmitSeq);
          const ts = (ev as any).timestamp;
          if (typeof ts === 'number' && ts) this.userTsByUt.set(ut, ts);
          // 已上屏的 USER 还要记进 live 重影窗：回放不走 emit()，否则回放后
          // sessiondb/transcript 迟到的同文副本会以 0 lastAt 穿透再投一个泡。
          this.recentUserEmitAt.set(ut, Date.now());
          if (typeof rid === 'string' && rid) this.recentUserEmitRid.set(ut, rid);
        }
        if (ut && typeof rid === 'string' && rid) {
          this.fallbackRequestUserText.set(rid, ut);
          if (typeof ri === 'number') this.fallbackRequestIndex.set(ri, rid);
        }
      }
      if (typeof rid === 'string' && rid) {
        this.fallbackSeenRequestIds.add(rid);
        if (typeof ri === 'number') ridByIndex.set(ri, rid);
      }
      if (
        (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET') &&
        typeof (ev as any).text === 'string'
      ) {
        // sessiondb 行回放事件带 sessiondb/<sid>/<rowId> streamId：记行 id 防轮询重投
        const sidStr = String((ev as any).streamId || '');
        const sm = sidStr.match(/^sessiondb\/[^/]+\/(\d+)$/);
        if (sm) this.sessionDbEmittedIds.add(parseInt(sm[1], 10));
        const text = String((ev as any).text || '').trim();
        // monologue 不进正文指纹（否则会挡住真实最终回复的前缀匹配）
        if (text && !isInternalMonologue(text)) this.noteEmittedAgentText(text, { requestIndex: (ev as any).requestIndex, streamId: (ev as any).streamId, rid: rid || undefined, userText: (ev as any)._ut ?? lastUt });
        // 仅当历史已有助手正文时标记 gapFilled，避免「只有 USER、最终回复未落盘」被挡住补全
        if (typeof rid === 'string' && rid) this.gapFilledRequestIds.add(rid);
        else if (typeof ri === 'number' && ridByIndex.has(ri)) {
          this.gapFilledRequestIds.add(ridByIndex.get(ri)!);
        }
      }
    }
    this.capCollections();
  }

  private updatePollInterval() {
    if (this.disposed) return;
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
    if (this.disposed) return;
    this.scanNewestBoth();
    // poll 兜底：fs.watch 活跃时退至 BACKUP_POLL_MS，故障/不可用时用 pollMs
    this.updatePollInterval();
    // 周期 rescan：新会话文件出现时切换（双源：transcripts + chatSessions）
    this.rescanTimer = setInterval(() => this.scanNewestBoth(), RESCAN_MS);
    // sessiondb 全局轮询独立启动：不依赖任何 transcript 绑定——切到无
    // transcript 的会话（或切换竞态中）快通道也必须在线，否则整轮静默丢答。
    this.ensureSessionDbPoll();
  }

  dispose() {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.clearTurnGapTimer();
    this.clearTurnHardTimer();
    this.pollTimer = undefined;
    this.rescanTimer = undefined;
    this.watchDebounce = undefined;
    // 兜底源清理：解绑 + 清投影器内部 debounce 定时器
    this.unbindFallback();
    this.fallbackProjector.dispose();
    if (this.sessionDbTimer) clearInterval(this.sessionDbTimer);
    this.sessionDbTimer = undefined;
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
  addPendingPhoneUserText(text: string) {
    const ut = this.normUserText(text);
    if (!ut) return;
    this.utCompletedBeforeTurn = this.completedGapUserTexts.has(ut);
    this.activeUserText = ut;
    this.pushPendingGap(ut, true);
    this.capCollections();
    this.startTurnGapTimer();
  }

  private pushPendingGap(userText: string, fresh = false) {
    const ut = this.normUserText(userText);
    if (!ut) return;
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

  private hasPendingGap(userText?: string): boolean {
    if (!this.pendingGapQueue.length) return false;
    if (!userText) return this.pendingGapQueue.length > 0;
    const ut = this.normUserText(userText);
    return this.pendingGapQueue.some((q) => q.userText === ut);
  }

  private removePendingGap(userText: string): boolean {
    const ut = this.normUserText(userText);
    const idx = this.pendingGapQueue.findIndex((q) => q.userText === ut);
    if (idx >= 0) {
      this.pendingGapQueue.splice(idx, 1);
      return true;
    }
    return false;
  }

  private popFirstPendingGap(): PendingGapRequest | undefined {
    return this.pendingGapQueue.shift();
  }

  bindFile(file: string, opts?: { replay?: boolean; liveOnly?: boolean }) {
    this.current = file;
    // 再次 bindFile（如用户重新选择）即解除 pin，允许后续自动跟随
    this.pinnedFile = null;
    // 同会话重绑（auto-follow / catchUp 重投影）保留去重指纹，避免刚发出的正文被重投
    const sameSessionBind = path.basename(file) === this.boundSessionBase;
    this.pending = '';
    this.resetState(sameSessionBind);
    this.lastLineFp = '';
    this.skipFirstLine = false;

    const phoneSelectLive =
      opts?.liveOnly === true || opts?.replay === false; /* 显式 false，不是 undefined */
    // 0.5.18：phone live 时 mute chatSessions 助手投影，避免与 transcript 双通道重复
    this.suppressFallbackAgent = phoneSelectLive;

    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(file);
    } catch {
      st = undefined;
    }
    const size = st?.size ?? 0;

    let startOffset = size; // live-only：EOF
    let mode = 'live';
    if (phoneSelectLive) this.lastPhoneSelectMs = Date.now();
    if (opts?.replay === true) {
      startOffset = this.findReplayOffset(file, size);
      // findReplayOffset 返回精确行首偏移，无需 skip；只有非 0 且非行首才 skip
      this.skipFirstLine = false;
      mode = 'replay (last user turns)';
      this.suppressFallbackAgent = false;
    } else if (phoneSelectLive) {
      // 手机 PHONE_SESSION_SELECT：历史只走 projectHistory→HISTORY_REPLAY
      startOffset = size;
      this.skipFirstLine = false;
      mode = 'live-only@EOF (phone select)';
    } else if (size > BIG_FILE_BYTES) {
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
    // session-store.db：turns 轮询是全局的（不按绑定 sid 过滤），这里只更新
    // 「当前会话」归属（回放兜底 sessionDbRecentTurns 的默认 sid）+ 补种在途
    // 悬挂行。行 id 是全局游标：换会话不再重置水位/已投集合——否则绑定瞬间
    // 已插入未完成的在途行被水位盖过，答案落库后永远不再投（切换竞态静默丢答）。
    const sid = this.boundSessionBase.replace(/\.jsonl$/, '');
    if (this.sessionDbSessionId !== sid) {
      this.sessionDbSessionId = sid;
      this.sessionDbPendingRows.clear();
      this.seedPendingSessionDbRows();
    }
    this.ensureSessionDbPoll();
    if (this.opts.chatSessionsDir) {
      const csFile = path.join(this.opts.chatSessionsDir, this.boundSessionBase);
      if (fs.existsSync(csFile)) {
        // 手机切会话：fallback 也从 EOF 增量，禁止全文件 catch-up 洪水
        // 且 suppressFallbackAgent 时即使有增量也不再投助手侧（见 emitAgentSide）
        this.bindFallback(csFile, { catchUp: !phoneSelectLive });
      } else {
        this.unbindFallback();
      }
    } else {
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
    if (seed) this.applySeedEvents(seed);

    this.bindWatchers(file);
    this.tail(); // 立即读一次（replay / 尾部 1MB 场景立刻出内容；EOF 场景无增量）
  }

  /**
   * replay 模式起点：从文件尾部往前找最近 N 个 user.message 行的第一个的行首偏移。
   * 全文件扫描行号（只记录 user.message 行），取倒数第 N 个的字节偏移。
   */
  private findReplayOffset(file: string, size: number): number {
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
        const userOffsets: number[] = [];
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
          } catch {
            // 半行忽略
          }
          running += lineBytes;
        }
        if (!userOffsets.length) return 0;
        // 取倒数第 N 个起点（向前多取一个用户消息，保证工具轮次完整）
        const idx = Math.max(0, userOffsets.length - N - 1);
        return userOffsets[idx];
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------- 目录扫描

  /** 在指定目录里选 mtime 最大的 .jsonl（= 最新会话文件） */
  private newestInDir(dir: string): { name: string; mtimeMs: number } | undefined {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return undefined;
    }
    let newest: { name: string; mtimeMs: number } | undefined;
    const tied: string[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { name, mtimeMs: st.mtimeMs };
          tied.length = 0;
          tied.push(name);
        } else if (st.mtimeMs === newest.mtimeMs) {
          tied.push(name);
        }
      } catch {
        /* 不可读/已删除，忽略 */
      }
    }
    if (!newest || tied.length <= 1) return newest;
    // Copilot 会把多个会话文件在同一个 tick 批量落盘（Windows 上实测到完全相同的
    // mtime），目录枚举序裁决会让「用户最后实际交互的会话」稳定输给某个文件 →
    // 桌面切会话后跟随永久失效。平手时读各文件尾部最后的时间戳，内容新者胜。
    let best = newest;
    let bestTs = this.tailTimestampMs(path.join(dir, best.name));
    for (const name of tied.slice(1)) {
      const ts = this.tailTimestampMs(path.join(dir, name));
      if (ts > bestTs) {
        bestTs = ts;
        best = { name, mtimeMs: newest.mtimeMs };
      }
    }
    return best;
  }

  /** 文件尾 64KB 内最后一个 "timestamp"/"ts" 数字字段：同 mtime 时裁决内容新旧 */
  private tailTimestampMs(file: string): number {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, Math.max(0, size - n));
      const s = buf.toString('utf8');
      let last = 0;
      const re = /"(?:timestamp|ts)"\s*:\s*(\d{10,13})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const v = Number(m[1]);
        if (v > last) last = v;
      }
      return last;
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * 双源会话跟随：同时看 transcripts 与 chatSessions 目录，比较两者各自最新文件的
   * mtime，选更大的作为活跃会话，绑定其 transcripts 文件（并联动 chatSessions 兜底）。
   * 多标签场景：即使 transcripts 目录里 A 最新，只要 chatSessions 目录里 B 更新（mtime
   * 更大），就切到 B 的 transcripts（同时 bindFallback B 的 chatSessions）。
   */
  private scanNewestBoth() {
    if (this.disposed) return;
    // 手动 pin 的会话优先：但如果 pinned 文件已沉默（长时间无新写入），
    // 且有另一个会话文件在活跃写入，自动解除 pin 并切换到新文件。
    // 这解决了：用户从手机发消息 → pinFile → 之后在桌面切换到新会话 →
    // watcher 仍被 pin 在旧会话 → 新会话的回复无法实时推送到远端。
    if (this.pinnedFile) {
      if (!samePath(this.current, this.pinnedFile) && fs.existsSync(this.pinnedFile)) {
        this.bindFile(this.pinnedFile, { liveOnly: true });
      }
      // 检查 pinned 文件是否已沉默
      let pinnedMtime = 0;
      try {
        pinnedMtime = fs.statSync(this.pinnedFile).mtimeMs;
      } catch {
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
          let newestName: string | undefined;
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
            if ((tExists || csExists) && !samePath(tExists ? tfile : csPath, this.current)) {
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
              } as PhoneEvent);
            }
          }
        }
      }
      return;
    }
    const t = this.newestInDir(this.opts.dir);
    const cs = this.opts.chatSessionsDir ? this.newestInDir(this.opts.chatSessionsDir) : undefined;
    let base: string | undefined;
    let bestMtime = -1;
    if (t && t.mtimeMs > bestMtime) {
      base = t.name;
      bestMtime = t.mtimeMs;
    }
    if (cs && cs.mtimeMs > bestMtime) {
      base = cs.name;
      bestMtime = cs.mtimeMs;
    }
    if (!base) return;
    const tfile = path.join(this.opts.dir, base);
    if (samePath(tfile, this.current)) return;
    const csPath = this.opts.chatSessionsDir ? path.join(this.opts.chatSessionsDir, base) : undefined;
    if (!fs.existsSync(tfile)) {
      // transcripts 无同名文件但 chatSessions 有新会话 → 仍发跟随（扩展用 csFile 回放）。
      // lastFollowedPath 去重：否则该会话持续占 newest，每个 tick 都重发（跟随风暴）。
      // current===undefined 豁免：若首个扫描周期全局 newest 就是 csOnly 文件（典型：
      // VS Code/Copilot 冷启动自动创建的空 New Chat），current 永远停在 undefined
      // → 之后所有 csOnly 跟随都被吞，连"空会话获得内容后补发"也失去挂载点。
      // 对仍在写入的新鲜文件放行；陈旧旧文件赢得首轮扫描仍不发（首载不跟随）。
      const freshWrite = bestMtime > 0 && Date.now() - bestMtime < PIN_STALE_MS;
      if (
        (this.current !== undefined || freshWrite) &&
        csPath &&
        fs.existsSync(csPath) &&
        !samePath(csPath, this.lastFollowedPath)
      ) {
        this.lastFollowedPath = csPath;
        this.emit({
          type: 'SESSION_FOLLOW',
          csFile: csPath,
          text: `已切换到会话: ${base}`,
        } as PhoneEvent);
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
      } as PhoneEvent);
    }
  }

  // ---------------------------------------------------------------- chatSessions 兜底源

  /**
   * 绑定 chatSessions 兜底文件：从字节 0 投影全部历史（catch-up，补 transcripts 缺失回复），
   * 再启动周期轮询读增量。doneSink 让 JsonlProjector 的 COPILOT_DONE（debounce）走同一出口。
   */
  private bindFallback(file: string, opts?: { catchUp?: boolean }) {
    this.fallbackFile = file;
    this.fallbackOffset = 0;
    this.fallbackPending = '';
    this.fallbackSeenRequestIds.clear();
    this.fallbackProjector.reset();
    this.fallbackProjector.setDoneSink((ev) => this.emit(ev));
    const doCatchUp = opts?.catchUp !== false;
    if (doCatchUp) {
      // 立即 catch-up：把该文件全部投影，transcripts 缺失的历史回复在这里补上。
      // 静默播种：只走去重指纹不落广播——重启/首次绑定时这些旧轮次已通过
      // connect/follow 回放到 PWA，再按 live 投一遍就是 feed 尾部的答案重复块
      // （Windows 实测：重启后 catch-up 把 5 条旧答案追加成孤儿泡）。
      this.catchUpQuiet = true;
      try {
        this.catchUpFallback();
      } finally {
        this.catchUpQuiet = false;
      }
    } else {
      // 手机切会话：只跟增量，避免与 HISTORY_REPLAY 双通道（TOOL/STREAM 洪水）
      try {
        this.fallbackOffset = fs.statSync(file).size;
      } catch {
        this.fallbackOffset = 0;
      }
    }
    // 周期轮询：chatSessions 无 fs.watch，按最短间隔读增量字节；
    // 顺带轮询 session-store.db turns（响应完成即落库，先于 chatSessions 写盘）
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = setInterval(() => {
      this.pollFallback();
      this.pollSessionStoreDb();
    }, this.fallbackPollMs);
    this.bindSessionDbWatcher();
  }

  /** session-store.db 目录级 fs.watch：SQLite 落库（-wal/-shm/主文件任一变化）立即 poll，不等周期轮询 */
  private sessionDbWatcher: fs.FSWatcher | undefined;
  private sessionDbWatchDir: string | undefined;
  private bindSessionDbWatcher() {
    const dbPath = this.opts.sessionStoreDb;
    const dir = dbPath ? path.dirname(dbPath) : undefined;
    if (!dbPath || !dir || !fs.existsSync(dir)) return;
    if (this.sessionDbWatcher && this.sessionDbWatchDir === dir) return;
    this.closeSessionDbWatcher();
    this.sessionDbWatchDir = dir;
    try {
      this.sessionDbWatcher = fs.watch(dir, { persistent: false }, (_t, filename) => {
        if (!filename) return;
        const name = String(filename);
        // WAL 模式下写入落在 session-store.db-wal/-shm，journal_mode=delete 则落主文件
        if (name === 'session-store.db' || name.startsWith('session-store.db-')) {
          this.pollSessionStoreDb();
        }
      });
      this.sessionDbWatcher.on('error', () => this.closeSessionDbWatcher());
    } catch {
      this.sessionDbWatcher = undefined;
    }
  }
  private closeSessionDbWatcher() {
    try {
      this.sessionDbWatcher?.close();
    } catch {
      /* ignore */
    }
    this.sessionDbWatcher = undefined;
    this.sessionDbWatchDir = undefined;
  }

  /** 最近 n 条 turns 行（按 id 升序）：跟随回放时补 chatSessions 尚未落盘的最后一轮答案 */
  sessionDbRecentTurns(
    n: number,
    sid?: string,
  ): Array<{ id: number; user_message: string | null; assistant_response: string | null }> {
    const sessId = sid ?? this.sessionDbSessionId;
    if (!this.opts.sessionStoreDb || !sessId) return [];
    const db = this.openSessionDb();
    if (!db) return [];
    try {
      return db
        .prepare(
          'SELECT id, user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(sessId, n)
        .reverse() as Array<{
        id: number;
        user_message: string | null;
        assistant_response: string | null;
      }>;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  /** 解绑兜底：清文件、清半行缓冲、清轮询定时器 */
  private unbindFallback() {
    this.fallbackFile = undefined;
    this.fallbackOffset = 0;
    this.fallbackPending = '';
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
  }

  // ---- session-store.db 快速兜底（Copilot 新版：turns 行响应完成即落库）----

  private sessionDbSessionId: string | undefined;
  private sessionDbLastRow = 0;
  private sessionDbWatermarked = false;
  /** 独立轮询表：不再寄生于 fallbackTimer（chatSessions 缺位会被解绑连带清掉） */
  private sessionDbTimer: ReturnType<typeof setInterval> | undefined;
  /** 当前正在分发的 transcript 行的事件 ts(ms)：emit() 给未带 timestamp 的事件
   *  盖上真实记录时刻，PWA 的按 ts 排序才有意义（否则全塌成到达序）。
   *  仅 handleEvent 内有效，分发结束即清——定时器/轮询通道的事件必须自带 ts。 */
  private evTsMs = NaN;
  /** sessiondb 悬挂行：首取时 assistant_response 为空（先插 user 行后 UPDATE），
   *  `id>` 游标已越过 → 每轮显式重查直到补全或超过 TTL。行 id → 首见时间。 */
  private sessionDbPendingRows = new Map<number, number>();
  /** sessiondb 已投过 USER 的行 id：悬挂行重查/窗口过期不得重投用户泡 */
  private sessionDbUserEmittedIds = new Set<number>();

  /** 打开 session-store.db（优先只读，不支持则退回普通模式）；失败返回 null */
  private openSessionDb(): {
    prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
    close(): void;
  } | null {
    const dbPath = this.opts.sessionStoreDb;
    // 文件不存在即返回：readOnly 失败后退回的普通打开会在缺失路径上**创建空库**，
    // 提前创建 session-store.db 会干扰 Copilot 首次初始化。
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    try {
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => {
          prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
          close(): void;
        };
      };
      try {
        return new DatabaseSync(dbPath, { readOnly: true });
      } catch {
        return new DatabaseSync(dbPath);
      }
    } catch {
      return null;
    }
  }

  /** turns 表全局最大行号（首启水位；失败视为 0 从头跟） */
  private querySessionDbGlobalMaxId(): number {
    const db = this.openSessionDb();
    if (!db) return 0;
    try {
      const row = db.prepare('SELECT MAX(id) AS m FROM turns').get() as
        | { m?: number }
        | undefined;
      return row?.m ?? 0;
    } catch {
      return 0;
    } finally {
      db.close();
    }
  }

  /** sessiondb 全局轮询启动 + 一次性水位播种（只跟新增行） */
  private ensureSessionDbPoll() {
    if (!this.opts.sessionStoreDb || this.disposed) return;
    if (!this.sessionDbWatermarked) {
      this.sessionDbLastRow = this.querySessionDbGlobalMaxId();
      this.sessionDbWatermarked = true;
      this.seedPendingSessionDbRows();
    }
    if (!this.sessionDbTimer) {
      this.sessionDbTimer = setInterval(() => this.pollSessionStoreDb(), this.fallbackPollMs);
    }
  }

  /**
   * 把「已插入但 assistant_response 仍为空」的近期 turns 行补进悬挂重查：
   * 轮询靠 `id > 水位` 抓新行，而在水位播种/换会话之前就已存在的在途行
   * 永远够不到水位 → 答案落库无人察觉 = 静默丢答（R18 BUG-1 根因之一）。
   */
  private seedPendingSessionDbRows() {
    if (!this.opts.sessionStoreDb || this.disposed) return;
    const db = this.openSessionDb();
    if (!db) return;
    try {
      const rows = db
        .prepare(
          "SELECT id, timestamp FROM turns WHERE assistant_response IS NULL OR TRIM(assistant_response) = '' ORDER BY id DESC LIMIT 64",
        )
        .all() as Array<{ id?: number; timestamp?: string }>;
      const now = Date.now();
      for (const r of rows) {
        if (typeof r.id !== 'number') continue;
        if (this.sessionDbEmittedIds.has(r.id)) continue;
        const ts = Date.parse(String(r.timestamp || '')) || 0;
        // 只跟近期在途行：陈旧的空答案行是停止/失败轮的死行，不补种
        if (!ts || now - ts > 10 * 60_000) continue;
        this.sessionDbPendingRows.set(r.id, now);
      }
    } catch {
      /* 库被锁/结构变化：下轮再试 */
    } finally {
      db.close();
    }
  }

  /** 无 transcript 可绑定时，让 sessiondb 归属/兜底仍跟随所选会话。 */
  noteSession(sessionBase: string) {
    const sid = String(sessionBase || '').replace(/\.jsonl$/i, '');
    if (!sid) return;
    if (this.sessionDbSessionId !== sid) {
      this.sessionDbSessionId = sid;
      this.sessionDbPendingRows.clear();
      this.seedPendingSessionDbRows();
    }
    this.ensureSessionDbPoll();
  }

  /** 当前双源目录里最新的会话文件路径（跟随压制重放前的有效性校验用）。 */
  newestSessionFile(): string | undefined {
    const t = this.newestInDir(this.opts.dir);
    const cs = this.opts.chatSessionsDir ? this.newestInDir(this.opts.chatSessionsDir) : undefined;
    let name: string | undefined;
    let m = -1;
    if (t && t.mtimeMs > m) {
      m = t.mtimeMs;
      name = t.name;
    }
    if (cs && cs.mtimeMs > m) {
      m = cs.mtimeMs;
      name = cs.name;
    }
    if (!name) return undefined;
    const tf = path.join(this.opts.dir, name);
    if (fs.existsSync(tf)) return tf;
    const cp = this.opts.chatSessionsDir ? path.join(this.opts.chatSessionsDir, name) : undefined;
    return cp && fs.existsSync(cp) ? cp : undefined;
  }

  /** 轮询 turns 新行：响应完成即落库 → 立即 emit AGENT_MESSAGE（ut 键去重 chatSessions 迟到的重复投影） */
  private pollSessionStoreDb() {
    if (!this.opts.sessionStoreDb || this.disposed) return;
    // 目录在激活时可能尚未创建（db 由 Copilot 登录/首会话后才出现）：
    // bindSessionDbWatcher 对缺目录早退且绑定期仅一次 → 这里每次轮询重试挂 watch。
    if (!this.sessionDbWatcher) this.bindSessionDbWatcher();
    let rows: Array<{
      id: number;
      session_id?: string;
      user_message: string | null;
      assistant_response: string | null;
      timestamp?: string;
    }>;
    const db = this.openSessionDb();
    if (!db) return;
    try {
      // 全局轮询（不按 session_id 过滤）：绑定/切换竞态中归属会话可能反复易主，
      // 按 sid 过滤会把真实会话的新行整段漏掉（R18 BUG-1：切会话后首发零直播帧）。
      // 事件打 _sess=行.session_id，客户端按展示会话过滤，别会话轮次不误显。
      rows = db
        .prepare(
          'SELECT id, session_id, user_message, assistant_response, timestamp FROM turns WHERE id > ? ORDER BY id',
        )
        .all(this.sessionDbLastRow) as typeof rows;
      // 悬挂行重查：turns 行可能先只写 user_message（插入）稍后 UPDATE 补
      // assistant_response —— `id >` 游标已越过它，不显示重查这行，
      // 在 transcript/chatSessions 两通道都滞后的场景（Windows 慢盘实测）
      // 就是「答案被吞」。悬挂行随每次轮询重取直到有正文或超过 TTL。
      if (this.sessionDbPendingRows.size) {
        const now = Date.now();
        const ids: number[] = [];
        for (const [id, t0] of this.sessionDbPendingRows) {
          if (now - t0 > 15 * 60_000) this.sessionDbPendingRows.delete(id);
          else ids.push(id);
        }
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          const again = db
            .prepare(
              `SELECT id, session_id, user_message, assistant_response, timestamp FROM turns WHERE id IN (${ph})`,
            )
            .all(...ids) as typeof rows;
          if (Array.isArray(again) && again.length) rows.push(...again);
        }
      }
    } catch {
      return; // 库被锁/结构变化：下轮再试
    } finally {
      db.close();
    }
    if (!Array.isArray(rows) || !rows.length) return;
    for (const r of rows) {
      if (typeof r.id === 'number' && r.id > this.sessionDbLastRow) {
        this.sessionDbLastRow = r.id;
      }
      if (typeof r.id === 'number' && this.sessionDbEmittedIds.has(r.id)) continue;
      // turns 行含 user_message：提前发 USER_MESSAGE（比 chatSessions 落盘快数十秒），
      // 稍后 chatSessions 通道的同一 USER 由 bridge 60s 文本去重压住。
      // 每行只投一次 USER：悬挂行重查或窗口过期不得再投第二个泡。
      // 行 timestamp（ISO）为真实轮次时刻：PWA 按 ts 插入排序，盖到达时
      // 会让迟到的 USER 泡贴到末尾/压到别轮答案之后（连发场景堆叠根因之一）。
      const rowTs = Date.parse(String((r as any).timestamp || '')) || Date.now();
      const uText = String(r.user_message || '').trim();
      if (uText && !isInternalUserMessage(uText) && !this.sessionDbUserEmittedIds.has(r.id)) {
        this.sessionDbUserEmittedIds.add(r.id);
        const utT = this.normUserText(uText);
        if (utT) {
          this.userTsByUt.set(utT, rowTs);
          this.activeUserText = utT;
        }
        this.emit({
          type: 'USER_MESSAGE',
          text: uText,
          timestamp: rowTs,
          _sess: String(r.session_id || ''),
        } as PhoneEvent);
      }
      const text = String(r.assistant_response || '').trim();
      if (!text) {
        if (typeof r.id === 'number' && !this.sessionDbPendingRows.has(r.id)) {
          this.sessionDbPendingRows.set(r.id, Date.now());
        }
        continue;
      }
      if (typeof r.id === 'number') {
        this.sessionDbPendingRows.delete(r.id);
        this.sessionDbEmittedIds.add(r.id);
      }
      // 用户文挂上供 ut 键/轮次匹配；streamId 用 sessiondb 前缀区别于其他通道
      this.emitAgentSide([
        {
          type: 'AGENT_MESSAGE',
          text,
          streamId: `sessiondb/${r.session_id}/${r.id}`,
          requestIndex: -1,
          timestamp: rowTs,
          _ut: r.user_message || undefined,
          _sess: String((r as any).session_id || ''),
        } as PhoneEvent,
      ]);
      // turns 行落库=该轮已完成：补一个 DONE 收尾，否则 typing/••• 占位要等到
      // chatSessions 迟到的收尾事件（可达分钟级）才消，表现为答案后的「…」波动。
      // _ut 标归属轮次：客户端按 ut 释放「已发未答」条目，不误清别轮在途条目。
      this.emit({
        type: 'COPILOT_DONE',
        requestIndex: -1,
        timestamp: rowTs,
        _ut: r.user_message || undefined,
        _sess: String(r.session_id || ''),
      } as PhoneEvent);
    }
  }

  /** catch-up：读取 chatSessions 文件逐行投影（补历史缺失回复）；大文件只读尾部 8MB */
  private catchUpFallback() {
    const file = this.fallbackFile;
    if (!file) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const MAX_BYTES = 8 * 1024 * 1024;
    let text: string;
    if (stat.size <= MAX_BYTES) {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return;
      }
      this.fallbackOffset = stat.size;
    } else {
      console.warn(
        `[TranscriptWatcher] catchUpFallback: ${path.basename(file)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB, reading last 8MB only`,
      );
      const fd = fs.openSync(file, 'r');
      try {
        const readLen = MAX_BYTES;
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
        this.fallbackOffset = stat.size;
        const raw = buf.toString('utf8');
        const firstNl = raw.indexOf('\n');
        text = firstNl >= 0 ? raw.slice(firstNl + 1) : raw;
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(s);
      } catch {
        continue; // 半行/损坏忽略（轮询增量会再次尝试）
      }
      this.projectFallbackLine(obj);
    }
  }

  /** 兜底轮询：读 fallbackFile 增量字节 → 逐行投影 */
  private pollFallback() {
    const file = this.fallbackFile;
    if (!file || this.disposed) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
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
        let obj: unknown;
        try {
          obj = JSON.parse(s);
          this.fallbackPending = '';
        } catch {
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
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 处理一次兜底增量：拼半行缓冲 → 按 \n 切行 → 逐行投影 */
  private processFallbackChunk(chunk: string) {
    let text = this.fallbackPending + chunk;
    this.fallbackPending = '';
    const parts = text.split('\n');
    this.fallbackPending = parts.pop() || ''; // 最后一段可能是写入中的半行
    for (const line of parts) {
      const s = line.trim();
      if (!s) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(s);
      } catch {
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
  private projectFallbackLine(obj: unknown) {
    const rec = asRecord(obj);
    if (!rec) return;
    if (
      rec.kind === 2 &&
      Array.isArray(rec.k) &&
      rec.k.length === 1 &&
      rec.k[0] === 'requests' &&
      Array.isArray(rec.v)
    ) {
      const fresh: unknown[] = [];
      // base index：与 JsonlProjector 一致（有 i 用 i，否则按已见 request 数）
      let base =
        typeof rec.i === 'number' && (rec.i as number) >= 0
          ? (rec.i as number)
          : this.fallbackRequestIndex.size;
      for (let n = 0; n < (rec.v as unknown[]).length; n++) {
        const req = (rec.v as unknown[])[n];
        const r = asRecord(req);
        const rid = r ? asString(r.requestId) : null;
        const userText = r ? this.normUserText(textOfUserReq(r)) : '';
        const gi = base + n;
        if (rid && userText) this.fallbackRequestUserText.set(rid, userText);
        if (rid) {
          const ts = r ? (typeof r.timestamp === 'number' ? r.timestamp : undefined) : undefined;
          if (ts != null) this.fallbackRequestTs.set(rid, ts);
          this.fallbackRequestIndex.set(gi, rid);
        }

        // 0.5.26 phone gap-fill：只投影「有待补用户文」且带完整 response 的 request
        if (this.suppressFallbackAgent) {
          if (rid) this.fallbackSeenRequestIds.add(rid);
          // reqerr/取消终态：errorDetails 落在 result 上，response 常为空或只剩
          // mcpServersStarting 占位——response 长度闸会把它跳过，requestId 又被
          // 记成 seen 永不重查 → 整轮零事件，手机端卡「正在输入」到硬超时。
          // 有待补用户文的错误请求直接合成 ⚠️ 正文 + DONE（带 _ut 归属）。
          const res = asRecord(r?.result);
          const errMsg =
            asString(asRecord(res?.errorDetails)?.message) ||
            asString(asRecord(res?.error)?.message) ||
            asString(asRecord(r?.errorDetails)?.message);
          const errored = !!errMsg || (r as any)?.isCanceled === true || (r as any)?.isCanceled === 1;
          if (
            errored &&
            rid &&
            userText &&
            this.hasPendingGap(userText) &&
            !this.gapFilledRequestIds.has(rid)
          ) {
            const ets = typeof (r as any)?.timestamp === 'number' ? (r as any).timestamp : undefined;
            const ee: PhoneEvent[] = [];
            if (errMsg) {
              ee.push({
                type: 'AGENT_MESSAGE',
                streamId: `reqerr/${rid}`,
                text: `⚠️ ${errMsg}`,
                requestIndex: gi,
                timestamp: ets,
                _ut: userText,
                gapFill: true,
              } as PhoneEvent);
            }
            ee.push({
              type: 'COPILOT_DONE',
              requestIndex: gi,
              // DONE 用当下时刻：它是终态信号不是内容——带请求起始 ts 会被仲裁器
              // stale 判定误杀（doneTs 早于最近 live USER → 丢件 → typing 不消）。
              timestamp: Date.now(),
              _ut: userText,
            } as PhoneEvent);
            this.emitAgentSide(ee);
          }
          if (!r || !Array.isArray(r.response) || !r.response.length) continue;
          if (rid && this.gapFilledRequestIds.has(rid)) continue;
          if (!userText || !this.hasPendingGap(userText)) continue;
          fresh.push(req);
          continue;
        }

        if (rid && this.fallbackSeenRequestIds.has(rid)) {
          if (r && Array.isArray(r.response) && r.response.length) {
            if (!this.gapFilledRequestIds.has(rid)) fresh.push(req);
          }
          continue;
        }
        if (rid) this.fallbackSeenRequestIds.add(rid);
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
    if (
      this.suppressFallbackAgent &&
      rec.kind === 2 &&
      Array.isArray(rec.k) &&
      rec.k.length === 3 &&
      typeof rec.k[1] === 'number' &&
      rec.k[2] === 'response'
    ) {
      const idx = rec.k[1] as number;
      const rid =
        this.fallbackRequestIndex.get(idx) ||
        [...this.fallbackSeenRequestIds][idx];
      const userText = rid ? this.fallbackRequestUserText.get(rid) : undefined;
      if (!userText || !this.hasPendingGap(userText)) return;
      if (rid && this.gapFilledRequestIds.has(rid)) return;
    }

    this.emitAgentSide(this.fallbackProjector.projectLine(rec));
    this.capCollections();
  }

  /** 解析投影事件真正所属的用户问题：_ut 已有直接用；否则按 requestId /
   *  streamId 的 requests/N 索引 / requestIndex 反查 fallbackRequestUserText。
   *  全查不到时返回 undefined——调用方宁缺毋滥，禁止拿 activeUserText 兜底归错。 */
  private resolveUtForFallbackEv(ev: PhoneEvent): string | undefined {
    const own = (ev as any)._ut;
    if (typeof own === 'string' && own.trim()) return own;
    let rid: string | undefined =
      typeof (ev as any).requestId === 'string' ? (ev as any).requestId : undefined;
    const streamId = String((ev as any).streamId || '');
    const m = streamId.match(/^requests\/(\d+)\//);
    let idx: number | undefined;
    if (m) idx = parseInt(m[1], 10);
    else if (typeof (ev as any).requestIndex === 'number' && (ev as any).requestIndex >= 0)
      idx = (ev as any).requestIndex;
    if (!rid && typeof idx === 'number') {
      rid = this.fallbackRequestIndex.get(idx) || [...this.fallbackSeenRequestIds][idx];
    }
    if (rid) {
      const ut = this.fallbackRequestUserText.get(rid);
      if (ut) return ut;
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
  private emitAgentSide(evs: PhoneEvent[]) {
    // sessiondb 行是「完成才入库」的新轮次，不是 catch-up 洪水，不走 suppress/pending 门槛
    const forceLive = evs.some(
      (e) => typeof (e as any)?.streamId === 'string' && (e as any).streamId.startsWith('sessiondb/'),
    );
    if (!this.suppressFallbackAgent || forceLive) {
      for (const ev of evs) {
        // 已答轮次的迟到 requests/N 死流：该问题答案已发过（sessiondb 快通道等），
        // START 则整流丢弃（含后续 CHUNK/SET/END），否则留「…」占位+停止态误吞发送。
        const evSid = (ev as { streamId?: string }).streamId;
        if (evSid && this.suppressedFallbackStreams.has(evSid)) {
          if (ev.type === 'AGENT_STREAM_END') this.suppressedFallbackStreams.delete(evSid);
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
            const rid = (ev as any).requestId;
            const ut = this.normUserText(String((ev as any).text || ''));
            if (rid && ut) {
              this.fallbackRequestUserText.set(rid, ut);
              const ri = (ev as any).requestIndex;
              if (typeof ri === 'number') this.fallbackRequestIndex.set(ri, rid);
            }
          }
          continue;
        }
        // 归属先行：投影事件本就缺 _ut 时 emit() 会拿 activeUserText 兜底——
        // 迟到事件会被错误归到当前新问题（幻影/双发根因）。先按 rid/streamId/
        // requestIndex 解析它真正的问题写进 _ut；解析不到宁可不带，也别归错。
        const evUt = this.resolveUtForFallbackEv(ev);
        if (evUt && !(ev as any)._ut) (ev as any)._ut = evUt;
        // chatSessions 写盘滞后数十秒：正文已在 transcript 通道发出时，迟到的
        // 同用户轮次重复投影（含 markdown 变体）按用户文键去重，避免双气泡。
        if (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET') {
          const text = String((ev as { text?: string }).text || '').trim();
          if (text) {
            const streamId = (ev as { streamId?: string }).streamId || '';
            const m = streamId.match(/^requests\/(\d+)\//);
            let rid: string | undefined;
            let reqIdx = (ev as any).requestIndex;
            if (m) {
              const idx = parseInt(m[1], 10);
              if (reqIdx == null) reqIdx = idx;
              rid = this.fallbackRequestIndex.get(idx) || [...this.fallbackSeenRequestIds][idx];
            }
            const ut = (ev as any)._ut ?? (rid ? this.fallbackRequestUserText.get(rid) : undefined);
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
                } as never);
              }
            };
            if (this.hasEmittedAgentText(text, { requestIndex: reqIdx, streamId, rid, userText: ut })) {
              this.opts.onLog?.(`[watch] 压制已投同文 sid=${streamId} len=${text.length}`);
              suppressLiveStream();
              continue;
            }
            // 自轮重投影：同一答案文本经另一流形态再投（requests/N 重放）→ 双气泡
            if (this.isReplayedFor(text, ut)) {
              this.opts.onLog?.(`[watch] 压制重投影 sid=${streamId} len=${text.length}`);
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
              if (
                (cur.slice(0, 40).length >= 12 && cur.slice(0, 40) === prev.slice(0, 40)) ||
                (cur.slice(-40).length >= 12 && cur.slice(-40) === prev.slice(-40))
              ) {
                this.opts.onLog?.(`[watch] 压制文本变体 sid=${streamId} len=${text.length}`);
                suppressLiveStream();
                continue;
              }
            }
          }
        }
        const delivered = this.emit(ev);
        // 投递成功的答案销掉其 pendingGap 账：不销的话该 ut 永久挂起，
        // isStalePendingReplay 用旧账把后续「不同问题同答案」的真答误杀
        // （R14：M14V2 答案与 M14V 逐字相同，被 V1 的残留 pending 条目压死）。
        if (
          delivered !== false &&
          evUt &&
          (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET')
        ) {
          const q = this.normUserText(String(evUt));
          if (this.removePendingGap(q)) this.completedGapUserTexts.add(q);
        }
      }
      return;
    }
    // 无待补用户轮 → 不发任何 fallback 助手；
    // 但流收尾事件仍放行——否则已开流的「…」占位泡/停止按钮会卡死
    if (!this.hasPendingGap()) {
      for (const ev of evs) {
        if (ev.type === 'AGENT_STREAM_END' || ev.type === 'COPILOT_DONE') {
          const doneUt = this.resolveUtForFallbackEv(ev);
          if (doneUt && !(ev as any)._ut) (ev as any)._ut = doneUt;
          this.emit(ev);
        }
      }
      return;
    }

    for (const ev of evs) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'USER_MESSAGE' || ev.type === 'COPILOT_TYPING') {
        if (ev.type === 'USER_MESSAGE') {
          const rid = (ev as any).requestId;
          const ut = this.normUserText(String((ev as any).text || ''));
          if (rid && ut) {
            this.fallbackRequestUserText.set(rid, ut);
            const ri = (ev as any).requestIndex;
            if (typeof ri === 'number') this.fallbackRequestIndex.set(ri, rid);
          }
        }
        continue;
      }
      if (ev.type === 'AGENT_STREAM_START' || ev.type === 'AGENT_STREAM_CHUNK') continue;
      if (ev.type === 'COPILOT_DONE') {
        const doneUt = this.resolveUtForFallbackEv(ev);
        if (doneUt && !(ev as any)._ut) (ev as any)._ut = doneUt;
        this.emit(ev);
        continue;
      }
      // 0.5.26：不 gap-fill TOOL——避免旧工具卡洪水；只补最终正文
      if (ev.type === 'TOOL_CALL') continue;
      if (ev.type === 'AGENT_STREAM_END') {
        this.emit(ev);
        continue;
      }

      if (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET') {
        const text = String((ev as { text?: string }).text || '').trim();
        if (!text) continue;
        if (isInternalMonologue(text)) continue;
        const streamId = (ev as { streamId?: string }).streamId || '';
        const m = streamId.match(/^requests\/(\d+)\//);
        let ts: number | undefined;
        let matchedUser: string | undefined;
        let matchedRid: string | undefined;
        let reqIdx = (ev as any).requestIndex;
        if (m) {
          const idx = parseInt(m[1], 10);
          if (reqIdx == null) reqIdx = idx;
          const rid =
            this.fallbackRequestIndex.get(idx) ||
            [...this.fallbackSeenRequestIds][idx];
          if (rid) {
            matchedRid = rid;
            ts = this.fallbackRequestTs.get(rid);
            matchedUser = this.fallbackRequestUserText.get(rid);
          }
        }
        // sessiondb 通道行自带用户文，直接用
        if (!matchedUser) matchedUser = (ev as any)._ut;
        // 单 pending 或顺序 FIFO 匹配：无 streamId 索引匹配时取队列首个匹配项
        if (!matchedUser) {
          if (this.pendingGapQueue.length === 1) {
            matchedUser = this.pendingGapQueue[0].userText;
          } else if (matchedRid && this.fallbackRequestUserText.has(matchedRid)) {
            matchedUser = this.fallbackRequestUserText.get(matchedRid);
          } else {
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
        if (!matchedUser || !this.hasPendingGap(matchedUser)) continue;

        if (this.hasEmittedAgentText(text, { requestIndex: reqIdx, streamId, rid: matchedRid, userText: matchedUser })) continue;

        // 投递成功才销账：emit() 内部可能因去重/压制返回 false——提前销账
        // 会让「上游丢了但 pending 已清」的轮次永远补不上（reqerr 轮实测）。
        const ok = this.emit({
          ...ev,
          type: 'AGENT_MESSAGE',
          text,
          streamId: streamId || `gap-${Date.now().toString(36)}`,
          gapFill: true,
          timestamp: ts,
          _ut: matchedUser,
        } as PhoneEvent);
        if (!ok) continue;
        if (matchedRid) this.gapFilledRequestIds.add(matchedRid);
        this.removePendingGap(matchedUser);
        this.completedGapUserTexts.add(matchedUser);
        continue;
      }
    }
    this.capCollections();
  }

  private normUserText(text: string): string {
    return String(text || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /** 当前 turn 缺可见正文 → 登记待补用户文（不重扫全文） */
  private markCurrentTurnGap() {
    const ut = this.normUserText(this.activeUserText);
    if (ut && !this.completedGapUserTexts.has(ut)) {
      this.pushPendingGap(ut);
    }
    this.capCollections();
  }

  private agentTextKey(text: string): string {
    // markdown 强调差异视为同文（"Fe" == "**Fe**"），用于跨通道重复判定
    return text.trim().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').slice(0, 160);
  }

  /** 会话域前缀：dedupe 键按会话隔离，重绑回来仍能命中本会话指纹 */
  private sessPrefix(): string {
    return this.boundSessionBase ? this.boundSessionBase.replace(/\.jsonl$/, '') + '::' : '';
  }

  private dedupeKeys(text: string, ctx?: { requestIndex?: number; streamId?: string; rid?: string; userText?: string }): string[] {
    const sess = this.sessPrefix();
    const base = this.agentTextKey(text);
    if (!base) return [];
    const b = sess + base;
    const keys: string[] = [];
    if (ctx?.rid) keys.push(`${b}::rid=${ctx.rid}`);
    // 负数 idx = 未知下标（sessiondb 恒为 -1）：出的键跨轮共享，会把
    // 「不同问题同答案」误杀（R15：M15B 撞 M15A 的 idx=-1 键被压）。
    if (ctx?.requestIndex != null && ctx.requestIndex >= 0)
      keys.push(`${b}::idx=${ctx.requestIndex}`);
    if (ctx?.streamId) keys.push(`${b}::sid=${ctx.streamId}`);
    // 用户文键：同一用户轮次的回复在 transcript 与 chatSessions 双通道下发时互斥，
    // 不同轮次得到同文字回复仍可各显一次（test_gapfill_pending F 段语义）。
    const ut = ctx?.userText ? this.normUserText(ctx.userText) : '';
    if (ut) keys.push(`${b}::ut=${ut}`);
    if (!keys.length) keys.push(b);
    return keys;
  }

  /** 该 ut 对应一个「真实问过且尚未答」的轮次：本条文本就是它的正当答案，
   *  哪怕与别轮答案同文（不同问题得到同答案：R14 M14V2/C2 实测被误杀）
   *  也不得按重投影压制。 */
  private isLiveUnansweredUt(userText?: string): boolean {
    if (!userText) return false;
    const q = this.normUserText(userText);
    if (!q) return false;
    return this.userSeqByUt.has(q) && !this.isUtAnswered(q);
  }

  private hasEmittedAgentText(text: string, ctx?: { requestIndex?: number; streamId?: string; rid?: string; userText?: string }): boolean {
    if (this.isStalePendingReplay(text) && !this.isLiveUnansweredUt(ctx?.userText)) return true;
    for (const k of this.dedupeKeys(text, ctx)) {
      if (k.includes('::ut=')) {
        // 永久 ut 键：该问题已发过同文回复且此后没重问同题 → 迟到重复，压制
        const s = this.emittedAgentUtKeys.get(k);
        if (s != null && (this.userSeqByUt.get(ctx?.userText ? this.normUserText(ctx.userText) : '') ?? 0) <= s) return true;
        continue;
      }
      if (this.emittedAgentTextKeys.has(k)) return true;
    }
    return false;
  }

  private noteEmittedAgentText(text: string, ctx?: { requestIndex?: number; streamId?: string; rid?: string; userText?: string }) {
    const keys = this.dedupeKeys(text, ctx);
    if (!keys.length) return;
    for (const k of keys) {
      if (k.includes('::ut=')) {
        this.emittedAgentUtKeys.set(k, this.userEmitSeq);
        const ut = k.slice(k.indexOf('::ut=') + 5);
        if (ut) this.emittedTextByUt.set(ut, this.agentTextKey(text));
      } else this.emittedAgentTextKeys.add(k);
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

  private capSet<T>(set: Set<T>, limit: number): void {
    if (set.size > limit) {
      const arr = [...set];
      set.clear();
      for (let i = arr.length >> 1; i < arr.length; i++) set.add(arr[i]);
    }
  }

  private capMap<K, V>(map: Map<K, V>, limit: number): void {
    if (map.size > limit) {
      const arr = [...map];
      map.clear();
      for (let i = arr.length >> 1; i < arr.length; i++) map.set(arr[i][0], arr[i][1]);
    }
  }

  private capCollections(): void {
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

  private bindWatchers(file: string) {
    this.closeWatchers();
    const onChange = () => this.scheduleTail();
    try {
      this.fileWatcher = fs.watch(file, { persistent: false }, onChange);
      this.fileWatcher.on('error', () => {
        try {
          this.fileWatcher?.close();
        } catch {
          /* ignore */
        }
        this.fileWatcher = undefined;
        this.updatePollInterval();
      });
    } catch {
      this.fileWatcher = undefined;
    }

    const parent = path.dirname(file);
    try {
      this.dirWatcher = fs.watch(parent, { persistent: false }, (_eventType, filename) => {
        if (filename && this.current && path.basename(this.current) === String(filename)) {
          this.scheduleTail();
        } else {
          // 新会话文件出现 / 当前文件被替换 → 双源重新扫描并读增量
          this.scanNewestBoth();
          this.scheduleTail();
        }
      });
      this.dirWatcher.on('error', () => {
        try {
          this.dirWatcher?.close();
        } catch {
          /* ignore */
        }
        this.dirWatcher = undefined;
      });
    } catch {
      this.dirWatcher = undefined;
    }
    this.updatePollInterval();
  }

  private closeWatchers() {
    try {
      this.fileWatcher?.close();
    } catch {
      /* ignore */
    }
    try {
      this.dirWatcher?.close();
    } catch {
      /* ignore */
    }
    this.fileWatcher = undefined;
    this.dirWatcher = undefined;
    this.updatePollInterval();
  }

  /** fs.watch 触发后的防抖 tail（追加频率高时合并多次读） */
  private scheduleTail() {
    if (this.disposed) return;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      this.tail();
    }, WATCH_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- tail 读取

  /** 读取增量字节 → 按行解析 → handleEvent */
  private tail() {
    if (!this.current || this.disposed) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(this.current);
    } catch {
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
      } else {
        this.pendingBytes = Buffer.alloc(0);
        this.processChunk(combined.toString('utf8'));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 处理一次增量读取的文本：拼 pending → 按 \n 切行 → 每行解析 */
  private processChunk(chunk: string) {
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
      if (!s) continue;
      // 同内容行指纹：防同 size 原地重写 / 极端重复追加
      const fp = s.length + ':' + s.slice(0, 64) + ':' + s.slice(-32);
      if (fp === this.lastLineFp) continue;
      this.lastLineFp = fp;
      this.handleLine(s);
    }
  }

  /** 同 size + mtime 前进：回退读取最后一行（上限 64KB 内找最后一个 \n） */
  private rereadLastLine(size: number) {
    const cur = this.current;
    if (!cur) return;
    let fd: number | undefined;
    let line: string | undefined;
    try {
      fd = fs.openSync(cur, 'r');
      const st = fs.fstatSync(fd);
      const actualSize = st.size;
      if (actualSize <= 0) return;
      const readLen = Math.min(actualSize, REREAD_LAST_LINE_BYTES);
      const startOffset = Math.max(0, actualSize - readLen);
      const buf = Buffer.alloc(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, startOffset);
      const s = buf.subarray(0, bytesRead).toString('utf8');
      const nl = s.lastIndexOf('\n');
      if (nl < 0) return; // 块内无换行：正在写入的半行，跳过
      line = s.slice(nl + 1).trim();
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    if (!line) return;
    const fp = line.length + ':' + line.slice(0, 64) + ':' + line.slice(-32);
    if (fp === this.lastLineFp) return; // 内容未变
    this.lastLineFp = fp;
    this.handleLine(line);
  }

  // ---------------------------------------------------------------- 行解析

  private handleLine(line: string) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // 半行/损坏，忽略
    }
    this.handleEvent(obj);
  }

  /** 事件分发（未知类型忽略）。id/timestamp 均为可选顶层字段。 */
  private handleEvent(obj: unknown) {
    const rec = asRecord(obj);
    if (!rec) return;
    const type = asString(rec.type);
    if (!type) return;
    const data = asRecord(rec.data);
    const id = asString(rec.id);
    const tsStr = asString(rec.timestamp);
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    this.evTsMs = tsMs;
    try {
      this.dispatchEvent(type, data, id, tsMs);
    } finally {
      this.evTsMs = NaN;
    }
  }

  private dispatchEvent(
    type: string,
    data: Record<string, unknown> | null,
    id: string | null,
    tsMs: number,
  ) {
    switch (type) {
      case 'session.start': {
        // 新会话：重置投影状态（不发事件）
        this.resetState();
        return;
      }
      case 'user.message': {
        if (!data) return;
        this.handleUserMessage(data, id, tsMs);
        return;
      }
      case 'assistant.turn_start': {
        if (!data) return;
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
        if (!data) return;
        this.handleAssistantMessage(data, tsMs);
        return;
      }
      case 'tool.execution_start': {
        if (!data) return;
        this.handleToolExecutionStart(data);
        return;
      }
      case 'tool.execution_complete': {
        if (!data) return;
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
  private handleUserMessage(
    data: Record<string, unknown>,
    id: string | null,
    tsMs: number,
  ) {
    const content = asString(data.content);
    if (content === null) return;
    if (isInternalUserMessage(content)) return;
    // ±3s 窗口去重：只保留第一条（保留后更新 lastUserTsMs 作为窗口基准）。
    // 严格小于：恰好 3s 间隔（如连续快速提问）不应被吞。
    if (!Number.isNaN(tsMs) && this.lastUserTsMs !== null && tsMs - this.lastUserTsMs < DUP_USER_MS) {
      return;
    }
    if (!Number.isNaN(tsMs)) {
      this.lastUserTsMs = tsMs;
      const utT = this.normUserText(content);
      if (utT) this.userTsByUt.set(utT, tsMs);
    }

    this.endActiveStream(); // 新用户输入：结束上一轮未结束的流
    this.clearTurnGapTimer();
    this.clearTurnHardTimer();
    const newUt = this.normUserText(content);
    // 快照「本问题开问前是否已答过」：同题重问时 completedGapUserTexts 仍有
    // 旧答案——本轮的新答不能按「跨通道已答」丢弃；orphan 检查要用这个基线。
    this.utCompletedBeforeTurn = !!newUt && this.completedGapUserTexts.has(newUt);
    this.activeUserText = newUt;
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
  private resolveUtForTs(tsMs: number): string {
    if (Number.isNaN(tsMs)) return this.activeUserText;
    let best: string | undefined;
    let bestTs = -1;
    for (const [ut, ts] of this.userTsByUt) {
      if (ts <= tsMs + 2000 && ts > bestTs) {
        best = ut;
        bestTs = ts;
      }
    }
    return best ?? this.activeUserText;
  }

  private handleAssistantMessage(data: Record<string, unknown>, tsMs = NaN) {
    const messageId = asString(data.messageId);
    const reasoning = asString(data.reasoningText);
    const content = asString(data.content);
    const toolReqs = Array.isArray(data.toolRequests) ? data.toolRequests : [];

    // 该 messageId 首次出现才处理 reasoning / toolRequests（重放/重读防重复）；
    // content 每次都走增量投影（同一 messageId 重写变长 → CHUNK）
    const firstSeen = !messageId || !this.seenMessageIds.has(messageId);
    if (messageId) this.seenMessageIds.add(messageId);

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
    if (this.activeTurnId) this.clearTurnGapTimer();

    if (content) {
      // 0.5.26：orphan assistant（无 activeTurn）不当正文投影——避免挂到旧用户气泡
      if (!this.activeTurnId) {
        if (isInternalMonologue(content) && firstSeen) {
          this.emit({
            type: 'THINKING_STEP',
            text: content,
            requestIndex: this.turnSeq,
            stepId: messageId ? 'orphan-mono-' + messageId : undefined,
          });
        } else if (this.hasPendingGap() && !this.turnEmittedVisibleAgent) {
          this.turnSeq += 1;
          this.activeTurnId = 'late';
          this.streamAccum = '';
          this.turnEmittedVisibleAgent = false;
          this.startTurnHardTimer();
          this.emitAssistantContent(content, messageId, tsMs);
        }
      } else if (isInternalMonologue(content)) {
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
      } else {
        // 本 turn 的待答在「开问后」才被其它通道（chatSessions gap-fill 等）
        // 销账——turn 仍开着但答案已投，此后挂到本 turn 的首段 content 是
        // 迟到的重投影/孤儿行（test_live_123_789：orphan-789 挂进 turn-123）。
        // utCompletedBeforeTurn=true 说明这是同题重问：completed 是上一轮的
        // 旧账，本轮新答照常放行。
        const turnUt = this.normUserText(this.activeUserText);
        const answeredElsewhere =
          !this.turnEmittedVisibleAgent &&
          !!turnUt &&
          !this.utCompletedBeforeTurn &&
          this.completedGapUserTexts.has(turnUt);
        if (!answeredElsewhere) {
          this.emitAssistantContent(content, messageId, tsMs);
        }
      }
    }

    if (firstSeen) {
      for (const tr of toolReqs) {
        const rec = asRecord(tr);
        if (!rec) continue;
        const name = asString(rec.name);
        const toolCallId = asString(rec.toolCallId);
        if (!name || !toolCallId) continue;
        // toolRequests.arguments 是 JSON 字符串：解析成对象，失败则原样透传
        let input: unknown = rec.arguments;
        if (typeof rec.arguments === 'string') {
          try {
            input = JSON.parse(rec.arguments);
          } catch {
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
  private emitAssistantContent(content: string, messageId: string | null, tsMs = NaN) {
    // 迟到重投影：上一轮 assistant.message 延迟落盘到达时，内容已是发过的答案 → 不开流。
    // ut 归属：按记录时间戳找回它所属的问题（activeUserText 可能已被新问覆盖）；
    // 同时查 stale pending 兜底。
    const resolvedUt = this.resolveUtForTs(tsMs);
    if (this.isReplayedFor(content, resolvedUt) || this.isStalePendingReplay(content)) return;
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
      if ((a.length >= 12 && a === b) || (at.length >= 12 && at === bt)) return;
    }
    // 用户可见正文（非 monologue 路径才会进这里）
    this.turnEmittedVisibleAgent = true;
    // 0.5.18：工具后的新正文用独立 streamId，避免与上一截正文/tool 合并成「堆积」
    // 同一 messageId 的流式增长仍复用 activeStreamId。
    let streamId = this.activeStreamId;
    if (!streamId) {
      if (messageId) streamId = 't' + this.turnSeq + 'm' + messageId.slice(0, 12);
      else streamId = 't' + this.turnSeq + 's' + Date.now().toString(36).slice(-4);
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
  private handleToolExecutionStart(data: Record<string, unknown>) {
    const toolCallId = asString(data.toolCallId);
    if (!toolCallId) return;
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
  private handleToolExecutionComplete(data: Record<string, unknown>) {
    const toolCallId = asString(data.toolCallId);
    if (!toolCallId) return;
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
  private completeOpenTools() {
    for (const [toolCallId, st] of this.toolStates) {
      if (st.complete) continue;
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
  private handleTurnEnd() {
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
    if (this.streamAccum && !isInternalMonologue(this.streamAccum)) {
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
  private endActiveStream() {
    const streamId = this.activeStreamId || (this.activeTurnId ? 't' + this.turnSeq : null);
    if (streamId) {
      if (this.streamAccum && !isInternalMonologue(this.streamAccum)) {
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
  private startTurnGapTimer() {
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
  private clearTurnGapTimer() {
    if (this.turnGapTimer) {
      clearTimeout(this.turnGapTimer);
      this.turnGapTimer = undefined;
    }
  }

  private startTurnHardTimer() {
    this.clearTurnHardTimer();
    this.turnHardTimer = setTimeout(() => {
      this.turnHardTimer = undefined;
      this.closeCurrentTurn();
    }, TranscriptWatcher.TURN_HARD_TIMEOUT_MS);
  }

  private clearTurnHardTimer() {
    if (this.turnHardTimer) {
      clearTimeout(this.turnHardTimer);
      this.turnHardTimer = undefined;
    }
  }

  private closeCurrentTurn() {
    const streamId = this.activeStreamId || (this.activeTurnId ? 't' + this.turnSeq : null);
    this.completeOpenTools();
    if (!this.turnEmittedVisibleAgent) {
      this.markCurrentTurnGap();
    }
    if (streamId) {
      if (this.streamAccum && !isInternalMonologue(this.streamAccum)) {
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
  private resetState(preserveDedupe = false) {
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
      this.utCompletedBeforeTurn = false;
      this.activeUserText = '';
      this.fallbackRequestUserText.clear();
      this.fallbackRequestTs.clear();
    }
    // suppressFallbackAgent 由 bindFile 设置，不在此清
  }

  /** 归一化用户文+回复文 → {emit 时间, 当时的提问 seq}：seq 语义让同题真实重发不被误吞 */
  private recentAgentEmits = new Map<string, { t: number; seq: number }>();
  /** 归一化用户文 → 最近一次投影时间/requestId：吞掉多通道迟到重影且不抬提问 seq */
  private recentUserEmitAt = new Map<string, number>();
  private recentUserEmitRid = new Map<string, string>();

  /** 事件出口：dispose 后不再发出；记录助手正文供 chatSessions gap-fill 去重 */
  /** catch-up 静默播种：emit() 照常走去重记账但不广播（见 bindFallback） */
  private catchUpQuiet = false;

  private emit(ev: PhoneEvent): boolean {
    if (this.disposed) return false;
    // transcript 通道事件盖上真实记录时间：Windows 慢落盘下 chatSessions/sessiondb
    // 与 transcript 互错数十秒，到达序 != 真实序，靠 ts 在 PWA 侧插回正确位置。
    if (ev && (ev as any).timestamp === undefined && Number.isFinite(this.evTsMs)) {
      (ev as any).timestamp = this.evTsMs;
    }
    // 会话标签：客户端按绑定会话过滤，任何通道的跨会话事件不得投影到当前 feed
    if (ev && this.boundSessionBase) {
      (ev as any)._sess = this.boundSessionBase.replace(/\.jsonl$/, '');
    }
    if (ev && ev.type === 'USER_MESSAGE') {
      // 同题多通道重影：transcript→sessiondb→chatSessions 各可能重投一次同一条
      // USER_MESSAGE。若每次都抬 userSeqByUt，迟到 AGENT 副本会被当成「重问后的
      // 新答」放行 → feed/重连回放双份（Windows 慢落盘把间隔拉到分钟级实测复现）。
      // 同 ut 在窗口内的重复投影吞掉（不投影也不抬 seq）；带不同 requestId 的视为
      // 真实重发（新请求新 rid），放行。无 rid 的事件无法区分 → 按重影处理。
      const utNow = Date.now();
      const utText = this.normUserText(String((ev as { text?: string }).text || ''));
      const uRid = typeof (ev as any).requestId === 'string' ? ((ev as any).requestId as string) : '';
      if (utText) {
        // requestId 级永久去重：Windows 上 transcript/chatSessions 可滞后分钟级，
        // 120s 重影窗过期后迟到副本仍会带同一 rid 重投 → 先按 rid 拦，迟到再久也吞。
        // 真实重发是同文本新 rid → 放行。
        if (uRid && this.fallbackSeenRequestIds.has(uRid)) return false;
        const lastAt = this.recentUserEmitAt.get(utText) ?? 0;
        const lastRid = this.recentUserEmitRid.get(utText) ?? '';
        const freshRid = uRid !== '' && lastRid !== '' && uRid !== lastRid;
        if (utNow - lastAt < USER_COPY_WINDOW_MS && !freshRid) return false;
        this.recentUserEmitAt.set(utText, utNow);
        if (uRid) {
          this.recentUserEmitRid.set(utText, uRid);
          this.fallbackSeenRequestIds.add(uRid);
        }
      }
      // 记录提问序号：迟到重复投影只有「之后真的重问了同题」才放行
      this.userEmitSeq += 1;
      this.userSeqByUt.set(utText, this.userEmitSeq);
    }
    // 正文类事件：通过门后先交给下游投递，投递成功才记「已投」指纹——
    // 先记名再投递会让桥端/仲裁器的丢弃变成假阳性「已投」，后续通道
    // 的同答案再被 isReplayedFor/已投去重压制 → 净丢一条答案（玻尔轮实测）。
    let pendingMark: { text: string; ctx: { requestIndex?: number; streamId?: string; rid?: string; userText?: string }; wkey: string; curSeq: number } | null = null;
    if (ev && (ev.type === 'AGENT_MESSAGE' || ev.type === 'AGENT_STREAM_SET')) {
      const text = String((ev as { text?: string }).text || '');
      if (text.trim() && !isInternalMonologue(text)) {
        // 同轮次去重：同一回答被 requests/N 重编号或双通道投影成不同 streamId 时
        // 只发一次。键含用户文——不同用户轮次得到同文字回复时各显一次（不误吞）。
        // ut 归属优先事件自带 _ut；否则按事件时间戳找回所属问题（activeUserText
        // 会把迟到投影归到新问题——幻影/双发根因）。都无 → 空键也绝不归错。
        const evTs = typeof (ev as any).timestamp === 'number' ? (ev as any).timestamp : NaN;
        const resolvedEvUt =
          (ev as any)._ut ??
          (Number.isNaN(evTs) ? this.activeUserText : this.resolveUtForTs(evTs));
        const ut = this.normUserText(String(resolvedEvUt ?? ''));
        // 跨通道去重：chatSessions 批量落盘可达 ~75s（Windows 实测），15s 旧窗
        // 必漏 → 窗宽 120s；同题真实重发会抬 userSeq → seq 变化时放行，不误吞新答。
        const akey = this.agentTextKey(text);
        const wkey = `${ut}|${akey}`;
        const curSeq = this.userSeqByUt.get(ut) ?? 0;
        const now = Date.now();
        const lastE = this.recentAgentEmits.get(wkey);
        if (lastE && now - lastE.t < 120_000 && lastE.seq === curSeq) {
          return false;
        }
        // 归属错位副本：live 侧 _ut 解析失败时同一条答案被记进空 ut 桶（键 `|key`），
        // 迟到通道随后带着真 _ut 到达（或反向）→ 与另一形态键撞车即同一回答重投影。
        // 仅当一侧归属为空才压：两侧各有归属的同文答案是不同轮次，不误吞。
        if (ut) {
          const bare = this.recentAgentEmits.get(`|${akey}`);
          if (bare && now - bare.t < 120_000 && (this.userSeqByUt.get('') ?? 0) <= bare.seq) {
            return false;
          }
        } else {
          const suffix = `|${akey}`;
          for (const [k, e] of this.recentAgentEmits) {
            if (k === `|${akey}` || !k.endsWith(suffix) || now - e.t >= 120_000) continue;
            const recUt = k.slice(0, k.length - suffix.length);
            if ((this.userSeqByUt.get(recUt) ?? 0) <= e.seq) {
              return false;
            }
          }
        }
        // 集中兜底：同 ut 已答且本条与已投版本前/后 40 字同形 → 跨通道迟到
        // 残缺重投影（前缀异/超时窗躲过上两层压制）。同轮 text→tool→text 的
        // 第二段正文内容不同、前后 40 字都不同 → 不误伤。
        if (ut && this.isUtAnswered(ut)) {
          const prev = this.emittedTextByUt.get(ut) || '';
          const cur = this.agentTextKey(text);
          if (
            (cur.slice(0, 40).length >= 12 && cur.slice(0, 40) === prev.slice(0, 40)) ||
            (cur.slice(-40).length >= 12 && cur.slice(-40) === prev.slice(-40))
          ) {
            return false;
          }
        }
        pendingMark = {
          text,
          ctx: {
            requestIndex: (ev as any).requestIndex,
            streamId: (ev as any).streamId,
            rid: (ev as any).requestId,
            userText: resolvedEvUt,
          },
          wkey,
          curSeq,
        };
      }
    }
    if (this.catchUpQuiet) {
      // 静默播种语义：内容已在回放里投递过，照记「已投」防 live 重投。
      if (pendingMark) {
        this.noteEmittedAgentText(pendingMark.text, pendingMark.ctx);
        this.recentAgentEmits.set(pendingMark.wkey, { t: Date.now(), seq: pendingMark.curSeq });
      }
      return true;
    }
    const delivered = this.opts.onEvent(ev);
    if (delivered !== false && pendingMark) {
      this.noteEmittedAgentText(pendingMark.text, pendingMark.ctx);
      this.recentAgentEmits.set(pendingMark.wkey, { t: Date.now(), seq: pendingMark.curSeq });
      if (this.recentAgentEmits.size > 300) {
        const cutoff = Date.now() - 150_000;
        for (const [k, e] of this.recentAgentEmits) if (e.t < cutoff) this.recentAgentEmits.delete(k);
      }
    } else if (delivered === false && pendingMark) {
      this.opts.onLog?.(
        `[watch] 投递被拒（回声/去重/仲裁器丢弃）未记已投 sid=${pendingMark.ctx.streamId || '-'}`,
      );
    }
    return delivered !== false;
  }

  /** (用户文,正文) 键是否已发过且此后没同题重问（迟到重投影判定） */
  private isReplayedFor(text: string, userText?: string): boolean {
    // 按「答案文本」查所有已投键：正文同一问题发出的答案只许出现一次。
    // 对每条匹配键用它自己的 ut 比较 seq——同题重问会抬 userSeqByUt[ut]，放行真重答；
    // 迟到重投影（无论归属到哪个 ut/哪个 sess）统一压制。
    // 豁免：本条 _ut 指向一个已问未答的轮次 → 这就是该轮的正当答案，
    // 与别轮同文也不算重投影。
    if (this.isLiveUnansweredUt(userText)) return false;
    const prefix = `${this.agentTextKey(text)}::ut=`;
    if (!prefix || prefix === '::ut=') return false;
    for (const [k, v] of this.emittedAgentUtKeys) {
      const i = k.indexOf(prefix);
      if (i < 0) continue;
      const keyUt = k.slice(i + prefix.length);
      if ((this.userSeqByUt.get(keyUt) ?? 0) <= v) return true;
    }
    return false;
  }

  /** 该问题的答案是否已发过（任一通道）：seq 语义同 isReplayedFor——
   *  答案记录在最新提问之后才算「已答」，同题重问会抬 seq 放行。 */
  private isUtAnswered(userText: string): boolean {
    const normUt = this.normUserText(userText);
    if (!normUt) return false;
    const suffix = `::ut=${normUt}`;
    for (const [k, v] of this.emittedAgentUtKeys) {
      if (k.endsWith(suffix) && (this.userSeqByUt.get(normUt) ?? 0) <= v) return true;
    }
    return false;
  }

  /** 该正文是否已是某个「仍挂起」问题的答案：上一轮答案发出后其 pending 未消耗（stale），
   *  迟到的 assistant.message/chatSessions 副本会在新轮次里把它整体重投 → 压制。 */
  private isStalePendingReplay(text: string): boolean {
    const k = this.agentTextKey(text);
    if (!k) return false;
    const sess = this.sessPrefix();
    for (const q of this.pendingGapQueue) {
      const s = this.emittedAgentUtKeys.get(`${sess}${k}::ut=${q.userText}`);
      if (s != null && (this.userSeqByUt.get(q.userText) ?? 0) <= s) return true;
    }
    return false;
  }
}


/**
 * 从 storageUri 推导 transcripts 目录。
 *
 * storageUri 形如 `<workspaceStorage>/<wsHash>/local.<hash>`（扩展自身的存储位置），
 * transcripts 实际位于 `<workspaceStorage>/<wsHash>/GitHub.copilot-chat/transcripts`，
 * 因此取 dirname(storageUri.fsPath) 后拼 `GitHub.copilot-chat/transcripts`，
 * 存在且为目录则返回，否则 undefined。
 */
export function findTranscriptsDir(storageUri?: { fsPath: string } | null): string | undefined {
  if (!storageUri || typeof storageUri.fsPath !== 'string' || !storageUri.fsPath) {
    return undefined;
  }
  const dir = path.join(path.dirname(storageUri.fsPath), 'GitHub.copilot-chat', 'transcripts');
  try {
    const st = fs.statSync(dir);
    if (st.isDirectory()) return dir;
  } catch {
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
export function findChatSessionsDir(storageUri?: { fsPath: string } | null): string | undefined {
  if (!storageUri || typeof storageUri.fsPath !== 'string' || !storageUri.fsPath) {
    return undefined;
  }
  const dir = path.join(path.dirname(storageUri.fsPath), 'chatSessions');
  try {
    const st = fs.statSync(dir);
    if (st.isDirectory()) return dir;
  } catch {
    /* 目录不存在 */
  }
  return undefined;
}
