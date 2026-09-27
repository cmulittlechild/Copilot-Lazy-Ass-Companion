import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { JsonlProjector, PhoneEvent, textOfUserReq } from './jsonl';
import { SessionIndexReader } from './sessionIndex';
import { pathKey, samePath } from './pathutil';
import type { WorkspaceIndex, WorkspaceRecord } from './workspaceIndex';

/**
 * 超过此大小的会话文件不整读（只读尾部）。
 * 本机实测最大会话文件 325MB，整读耗时 4900ms 且堆增长 767MB，
 * 足以冻结扩展宿主甚至 OOM。
 */
const HISTORY_BIG_FILE_BYTES = 8 * 1024 * 1024;
/**
 * 大文件从尾部读取时的自适应窗口档位（字节）。
 *
 * 单个 kind=2 增量行可达 0.9MB，固定 4MB 窗口可能整个落在一行中间 ——
 * 丢弃被截断的首行后几乎不剩内容（实测 177MB/128MB 文件只剩 6~7 行，
 * 手机端切过去看到空白）。因此逐档扩大直到拿到足够行数。
 * 实测耗时：4MB ~14ms，16MB ~50ms，48MB ~215ms（仍远低于整读的 4900ms）。
 */
const HISTORY_TAIL_WINDOWS = [4 * 1024 * 1024, 16 * 1024 * 1024, 48 * 1024 * 1024];
/** 尾部窗口内至少需要的可解析行数，不足则升到下一档窗口。 */
const HISTORY_TAIL_MIN_LINES = 24;
/**
 * 参与历史回放的 kind≠0 增量行上限。
 * 实测有会话能投出 1446 个事件，而 bridge 侧最终只保留 HISTORY_MAX 条，
 * 全量投影纯属浪费。
 */
const HISTORY_MAX_MUTATIONS = 400;
/** 桌面消息兜底扫描周期（ms）：轮询新增 USER_MESSAGE 增量。 */
const USER_MSG_SCAN_MS = 1500;
/** 桌面消息扫描过滤阈值：仅扫描最近 10 分钟内修改过的文件 (10 * 60 * 1000 ms) */
const USER_MSG_SCAN_MAX_AGE_MS = 10 * 60 * 1000;
/** USER_MESSAGE 新鲜度阈值：请求时间戳超过 5 分钟视为历史，不广播 */
const USER_FRESH_MS = 5 * 60 * 1000;
/** 活跃 fs.watch 时的备份轮询间隔 (ms) */
const ADAPTIVE_POLL_ACTIVE_MS = 1500;

export interface SessionWatcherOptions {
  pollMs: number;
  rescanMs: number;
  liveOnly?: boolean;
  roots?: string[];
  preferChatSessionDirs?: string[];
  forceFile?: string;
  onEvent: (ev: PhoneEvent) => void;
  /** Debounce for fs.watch → tail (ms). Default 40. */
  watchDebounceMs?: number;
  /**
   * When liveOnly, still project the last N requests once on bind so the phone
   * can catch a mid-turn answer without replaying the whole history.
   * Default 1.
   */
  bootstrapLastRequests?: number;
  /** 会话索引读取器（state.vscdb 官方标题权威源），可选 */
  sessionIndex?: SessionIndexReader;
  /** 工作区索引（用于给会话标注归属），可选 */
  workspaceIndex?: WorkspaceIndex;
  /** 当前窗口的工作区 storageHash（用于标注 isCurrent），可选 */
  currentWorkspaceHash?: string;
}

export class SessionWatcher {
  private timer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private current: string | undefined;
  private offset = 0;
  private projector = new JsonlProjector();
  private disposed = false;
  private pending = '';
  private decoder = new StringDecoder('utf8');
  private readonly liveOnly: boolean;
  private fileWatcher: fs.FSWatcher | undefined;
  private dirWatcher: fs.FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private readonly watchDebounceMs: number;
  private lastSize = 0;
  private lastMtimeMs = 0;
  /** fingerprint of last complete line to detect same-offset rewrites */
  private lastLineFp = '';
  private bootstrapDoneFor: string | undefined;
  /** 桌面消息兜底扫描器 timer */
  private userMsgTimer: NodeJS.Timeout | undefined;
  /** 桌面消息兜底：上次检查过的 (文件, 字节偏移, mtime, 已看到的最新请求数) */
  private userMsgCursors = new Map<
    string,
    { offset: number; mtimeMs: number; lastReqCount: number }
  >();
  /** 已见桌面（非手机）用户消息 requestId，防重发 */
  private seenForeignReqIds = new Set<string>();
  /** enrichSessions 结果缓存：key=(file|size|mtime)，避免列表刷新重复读 jsonl */
  private enrichCache = new Map<string, { title?: string; requestCount?: number }>();
  /**
   * 手机端显式选定的会话（pin）。
   *
   * 不设这个标记时，scan() 每 2 秒会把 `current` 强制回绑到全局 mtime 最新的
   * 会话文件 —— 用户在手机上选了旧会话，两秒后就被抢回去，表现为「选不回来」。
   */
  private pinnedFile: string | undefined;

  constructor(private opts: SessionWatcherOptions) {
    this.liveOnly = opts.liveOnly !== false;
    this.watchDebounceMs = Math.max(8, opts.watchDebounceMs ?? 40);
  }

  get currentFile() {
    return this.current;
  }

  get readOffset() {
    return this.offset;
  }

  /**
   * 扫描一个 chatSessions 目录，把其中的 `*.jsonl` 汇总成 SessionSummary。
   *
   * @param dir  目标目录（不存在/不可读时静默跳过）
   * @param out  结果收集数组
   * @param rec  已知的工作区记录；传入时跳过路径反查（省一次上溯查找）。
   *             未传入且配了 workspaceIndex 时，用 resolveBySessionFile 反查。
   */
  private collectSessionsFromDir(dir: string, out: SessionSummary[], rec?: WorkspaceRecord): void {
    if (!fs.existsSync(dir)) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }
    const currentHash = this.opts.currentWorkspaceHash;
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const sessionId = f.replace(/\.jsonl$/, '');
        // 标题优先级：state.vscdb 官方索引 > jsonl customTitle/首条消息截断
        const indexTitle = this.opts.sessionIndex?.getTitle(sessionId);
        // 工作区归属：优先用调用方给的记录，否则按文件路径反查；拿不到就留 undefined（不造假）
        let ws: WorkspaceRecord | undefined = rec;
        if (!ws) {
          try {
            ws = this.opts.workspaceIndex?.resolveBySessionFile(full);
          } catch {
            ws = undefined;
          }
        }
        out.push({
          file: full,
          name: sessionId,
          // 只取便宜来源（state.vscdb 内存索引）；缺失时留空，
          // 由 enrichSessions 在排序截断后从 jsonl 补全
          title: indexTitle,
          mtime: st.mtimeMs,
          size: st.size,
          // requestCount 同样延迟到 enrichSessions（避开全量读文件）
          workspaceId: ws?.workspaceId,
          qualifiedName: ws?.qualifiedName,
          machineName: ws ? ws.machineName : undefined,
          isRemote: ws?.isRemote,
          displayName: ws?.displayName,
          isCurrent: ws && currentHash ? ws.storageHash === currentHash : undefined,
        });
      } catch {
        // ignore unreadable
      }
    }
  }

  /**
   * 补全昂贵字段（标题兜底 + 请求数）。
   *
   * 这两项都需要读 jsonl 内容。本机实测有 432 个会话文件、共 3GB，
   * 若在扇出阶段逐个读取会同步阻塞事件循环约 1.4 秒，导致扩展宓主卡死、
   * 手机端所有请求超时。因此只对排序截断后真正要返回的少量条目执行。
   */
  private enrichSessions(list: SessionSummary[]): SessionSummary[] {
    for (const s of list) {
      try {
        const key = `${s.file}|${s.size}|${Math.round(s.mtime)}`;
        const cached = this.enrichCache.get(key);
        if (cached) {
          s.title = cached.title;
          s.requestCount = cached.requestCount;
          continue;
        }
        let title = s.title;
        let count = s.requestCount;
        if (!title) title = resolveSessionTitle(s.file);
        if (count === undefined) count = countRequestsQuick(s.file);
        this.enrichCache.set(key, { title, requestCount: count });
        if (this.enrichCache.size > 400) {
          // 防止长时间运行无限增长
          const first = this.enrichCache.keys().next().value as string;
          this.enrichCache.delete(first);
        }
        s.title = title;
        s.requestCount = count;
      } catch {
        // 单条补全失败不影响整体
      }
    }
    return list;
  }

  /**
   * 列出可发现的历史会话（当前工作区优先，其次 mtime 倒序）。
   * 手机端通过 PHONE_SESSION_LIST 获取后可在多个会话间切换。
   *
   * 扫描顺序（靠 seenDirs 去重，先到先得）：
   * 1. workspaceIndex.all() 里每条记录的 chatSessionsDir —— 已过滤不存在的目录，
   *    且能直接带上工作区元数据，省掉路径反查；
   * 2. preferChatSessionDirs（扩展宿主给的当前工作区目录）；
   * 3. 遍历 roots 下的 `<hash>/chatSessions` —— 兜底，保证跨工作区全局可见。
   */
  listSessions(limit = 40): SessionSummary[] {
    const dirs = this.opts.preferChatSessionDirs ?? [];
    const roots = this.opts.roots ?? defaultSessionRoots();
    const all: SessionSummary[] = [];
    const seenDirs = new Set<string>();

    // 1) 工作区索引优先：目录已验证存在，元数据现成
    const records = this.opts.workspaceIndex?.all() ?? [];
    for (const rec of records) {
      if (!rec.chatSessionsDir) continue;
      const n = path.normalize(rec.chatSessionsDir);
      const k = pathKey(n);
      if (seenDirs.has(k)) continue;
      seenDirs.add(k);
      this.collectSessionsFromDir(n, all, rec);
    }

    // 2) 扩展宿主提供的偏好目录
    for (const d of dirs) {
      const n = path.normalize(d);
      const k = pathKey(n);
      if (seenDirs.has(k)) continue;
      seenDirs.add(k);
      this.collectSessionsFromDir(n, all);
    }

    // 3) 兜底：全局遍历 workspaceStorage
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const id of entries) {
        const dir = path.join(root, id, 'chatSessions');
        const n = path.normalize(dir);
        const k = pathKey(n);
        if (seenDirs.has(k)) continue;
        seenDirs.add(k);
        this.collectSessionsFromDir(n, all);
      }
    }

    // 当前工作区的会话排最前，其余按 mtime 倒序
    all.sort((a, b) => {
      const ca = a.isCurrent === true ? 1 : 0;
      const cb = b.isCurrent === true ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return b.mtime - a.mtime;
    });
    // 只对最终返回的少量条目做昂贵补全（读文件头）
    return this.enrichSessions(all.slice(0, limit));
  }

  /**
   * 列出指定工作区的会话（按 mtime 倒序）。
   * 需要构造时传入 workspaceIndex；工作区不存在或没有 chatSessions 目录时返回空数组。
   */
  listSessionsByWorkspace(workspaceId: string, limit = 40): SessionSummary[] {
    const rec = this.opts.workspaceIndex?.byId(workspaceId);
    if (!rec?.chatSessionsDir) return [];
    const out: SessionSummary[] = [];
    this.collectSessionsFromDir(path.normalize(rec.chatSessionsDir), out, rec);
    out.sort((a, b) => b.mtime - a.mtime);
    return this.enrichSessions(out.slice(0, limit));
  }

  /**
   * 切换到指定会话文件：重新绑定 watcher、live-only 下从 EOF 继续、
   * 并 bootstrap 最近请求让手机端能立即看到内容。
   */
  selectSession(file: string, opts?: { bootstrap?: boolean }): boolean {
    if (!file) return false;
    if (!this.isAllowedSessionFile(file)) return false;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return false;
    } catch {
      return false;
    }
    // 钉住选中会话，防止周期 scan() 把它抢回最新会话
    this.pinnedFile = file;
    // 即使已经绑定同一文件也要重新 bind：
    // 手机端切走再切回时 feed 已被清空，必须重新投影才能恢复内容。
    this.bindFile(file, { skipBootstrap: opts?.bootstrap !== true });
    // 默认不 bootstrap：手机切会话走 projectHistory → HISTORY_REPLAY 单通道。
    // bootstrap 会把最近 N 轮再经 onEvent 灌进 live，与 REPLAY 叠加造成：
    // 重复气泡、错序、Copilot 一直「正在输入」（COPILOT_TYPING 无配对 DONE）。
    if (opts?.bootstrap === true) {
      this.bootstrapLastRequests(file);
    }
    return true;
  }

  /**
   * 投影指定会话的最近 N 轮历史，**返回**事件数组而不走 onEvent。
   *
   * 工业级时序保证（0.5.9 根因修复）：
   * - 旧实现：先投影全部 USER/TOOL，再 finalize 全部 AGENT → 手机端看到
   *   「用户消息挤在中间、助手消息堆在末尾」的错乱时间线，再被 HISTORY_MAX
   *   截断后只剩 0.5.4 验证表等旧助手碎片。
   * - 新实现：按 request 轮次投影（每轮：USER → 该轮 response mutations →
   *   该轮收尾），保证 USER/AGENT 交错顺序与 VS Code 一致。
   */
  projectHistory(file: string, maxRequests = 20): PhoneEvent[] {
    const out: PhoneEvent[] = [];
    let raw = '';
    try {
      const st = fs.statSync(file);
      if (st.size > HISTORY_BIG_FILE_BYTES) {
        raw = readTailLines(file, st.size);
      } else {
        raw = fs.readFileSync(file, 'utf8');
      }
    } catch {
      return out;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    if (!lines.length) return out;

    // 解析全部行，按「请求轮次」重排投影，保证时间线正确。
    type Mut = { obj: any; reqIndex: number | null; isAppend: boolean; isResponse: boolean; isFinalize: boolean };
    const muts: Mut[] = [];
    let kind0: any = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj?.kind === 0) {
          kind0 = obj;
          continue;
        }
        const k = obj?.k;
        let reqIndex: number | null = null;
        let isAppend = false;
        let isResponse = false;
        let isFinalize = false;
        if (Array.isArray(k) && k[0] === 'requests') {
          if (k.length === 1) {
            isAppend = true;
            // splice index if present
            if (typeof obj.i === 'number') reqIndex = obj.i;
          } else if (typeof k[1] === 'number') {
            reqIndex = k[1];
            if (k[2] === 'response') isResponse = true;
            if (k[2] === 'elapsedMs' || k[2] === 'result' || k[2] === 'isCanceled') isFinalize = true;
          }
        }
        muts.push({ obj, reqIndex, isAppend, isResponse, isFinalize });
      } catch {
        /* 单行损坏忽略 */
      }
    }

    // 从 kind0 + append 推导请求列表（权威顺序）
    const requests: any[] = [];
    if (kind0?.v && Array.isArray(kind0.v.requests)) {
      for (const r of kind0.v.requests) requests.push(r);
    }
    for (const m of muts) {
      if (!m.isAppend) continue;
      const v = m.obj?.v;
      if (!Array.isArray(v)) continue;
      const base = typeof m.obj.i === 'number' && m.obj.i >= 0 ? m.obj.i : requests.length;
      for (let n = 0; n < v.length; n++) {
        const gi = base + n;
        while (requests.length <= gi) requests.push(null);
        requests[gi] = v[n];
      }
    }

    // 只保留最近 maxRequests 轮
    const total = requests.length;
    const startIdx = Math.max(0, total - Math.max(1, maxRequests));
    const proj = new JsonlProjector();
    // done 事件并入 out，但按轮次 flush
    const pendingDone: PhoneEvent[] = [];
    proj.setDoneSink((ev) => pendingDone.push(ev));

    try {
      for (let ri = startIdx; ri < total; ri++) {
        const req = requests[ri];
        if (!req) continue;
        // 0.5.22：从 request 提取 timestamp 透传到事件，PWA 按时间戳排序
        const reqTs = typeof req.timestamp === 'number' ? req.timestamp : undefined;
        // 1) USER_MESSAGE for this request — 剥离内嵌 response：append 行的
        //    projectLine 会顺带投影 v[n].response（jsonl.ts），与 step-2 的
        //    独立 response 突变或 step-3 的显式内嵌投影重复 → 同 streamId 双投。
        //    统一由 step-3（无突变时）处理内嵌兜底，此处只出 USER。
        for (const ev of proj.projectLine({
          kind: 2,
          k: ['requests'],
          i: ri,
          v: [{ ...req, response: undefined }],
        })) {
          if (reqTs != null && ev && !(ev as any).timestamp) (ev as any).timestamp = reqTs;
          out.push(ev);
        }
        // 2) response mutations belonging to this request (in file order)
        for (const m of muts) {
          if (m.reqIndex !== ri) continue;
          if (!m.isResponse && !m.isFinalize) continue;
          for (const ev of proj.projectLine(m.obj)) {
            if (reqTs != null && ev && !(ev as any).timestamp) (ev as any).timestamp = reqTs;
            out.push(ev);
          }
        }
        // 3) also project any response already embedded on the request object —
        //    仅当该请求在文件里没有真正的 response 突变时才走这条兜底：
        //    两者同投会把同一答案渲染成相邻双块（mutations 先收尾，内嵌再投一遍）。
        const hasResponseMuts = muts.some((m) => m.reqIndex === ri && m.isResponse);
        if (!hasResponseMuts && Array.isArray(req.response) && req.response.length) {
          for (const ev of proj.projectLine({
            kind: 2,
            k: ['requests', ri, 'response'],
            v: req.response,
          })) {
            if (reqTs != null && ev && !(ev as any).timestamp) (ev as any).timestamp = reqTs;
            out.push(ev);
          }
        }
        // 4) force finalize this request's streams so AGENT_MESSAGE lands next to its USER
        for (const ev of proj.finalizeAllStreams()) {
          if (reqTs != null && ev && !(ev as any).timestamp) (ev as any).timestamp = reqTs;
          out.push(ev);
        }
        // 5) flush any debounced COPILOT_DONE immediately for ordering
        if (pendingDone.length) {
          for (const ev of pendingDone.splice(0)) {
            if (reqTs != null && ev && !(ev as any).timestamp) (ev as any).timestamp = reqTs;
            out.push(ev);
          }
        }
      }
      // leftover
      for (const ev of proj.finalizeAllStreams()) out.push(ev);
      if (pendingDone.length) out.push(...pendingDone.splice(0));
    } catch {
      /* 投影失败返回已收集部分 */
    } finally {
      try {
        proj.dispose();
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  private userMsgScanRunning = false;

  start() {
    this.projector.setDoneSink((ev) => {
      if (!this.disposed) this.opts.onEvent(ev);
    });
    this.scan();
    this.timer = setInterval(() => this.scan(), this.opts.rescanMs);
    // Adaptive poll: fallback poll running at configured pollMs or backed off when fs.watch is healthy
    this.updatePollInterval();
    // 兜底用户消息扫描：桌面在「非选中」会话直接发消息时，当前 watcher 只 tail
    // 被 pin 的选中文件，其它会话的新 USER_MESSAGE 会丢失。轻量扫描器定期检查
    // 所有 chatSessions 文件尾部，只投 USER_MESSAGE（不投 assistant 侧，避免与
    // transcript/兜底双渲染），保证手机端任何会话都看不到丢消息。
    this.userMsgTimer = setInterval(() => {
      void this.scanForeignUserMessages();
    }, USER_MSG_SCAN_MS);
  }

  private updatePollInterval() {
    if (this.disposed) return;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const isWatchHealthy = !!this.fileWatcher;
    const interval = isWatchHealthy ? ADAPTIVE_POLL_ACTIVE_MS : this.opts.pollMs;
    this.pollTimer = setInterval(() => this.tail(), interval);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.userMsgTimer) clearInterval(this.userMsgTimer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.closeWatchers();
    this.projector.dispose();
  }

  /**
   * 桌面→手机 USER_MESSAGE 兜底扫描（根因修复，issue2）：
   *
   * 背景：主 watcher 只 tail「选中/pin」的一个会话文件；TranscriptWatcher 同样
   * 单文件。用户直接在桌面 Copilot 插件的「其它」会话发消息时，该文件的增量
   * 永远不会被读到 → 手机看不到。
   *
   * 方案：周期扫描所有 chatSessions 目录里每个文件的新增字节（增量读），
   * 只挑出 `kind=0/kind=2` 中「新出现且属于桌面发出」的 USER_MESSAGE 并 onEvent。
   * - 不投 assistant 流（避免双渲染 / 性能开销）
   * - 用 requestId 记忆去重（JsonlProjector 的 seenRequestIds 只认单个文件投影
   *   顺序，这里用独立全局 seen 保证跨扫描、跨文件不重复投）
   * - 增量 offset 记录避免整文件反复解析
   */
  /**
   * 桌面→手机 USER_MESSAGE 兜底扫描（根因修复，issue2）：
   *
   * 背景：主 watcher 只 tail「选中/pin」的一个会话文件；TranscriptWatcher 同样
   * 单文件。用户直接在桌面 Copilot 插件的「其它」会话发消息时，该文件的增量
   * 永远不会被读到 → 手机看不到。
   *
   * 方案：周期扫描所有 chatSessions 目录里每个文件的新增字节（增量读），
   * 只挑出 `kind=0/kind=2` 中「新出现且属于桌面发出」的 USER_MESSAGE 并 onEvent。
   * - 不投 assistant 流（避免双渲染 / 性能开销）
   * - 用 requestId 记忆去重（JsonlProjector 的 seenRequestIds 只认单个文件投影
   *   顺序，这里用独立全局 seen 保证跨扫描、跨文件不重复投）
   * - 增量 offset 记录避免整文件反复解析
   * - 仅扫描最近 10 分钟内活跃修改的文件，并在批次间通过 setImmediate 让出事件循环
   */
  private async scanForeignUserMessages() {
    if (this.disposed || this.userMsgScanRunning) return;
    this.userMsgScanRunning = true;
    try {
      const dirs = this.opts.preferChatSessionDirs ?? [];
      const roots = this.opts.roots ?? defaultSessionRoots();
      const seenDirs = new Set<string>();
      const queue: string[] = [];
      for (const d of dirs) {
        const n = path.normalize(d);
        const k = pathKey(n);
        if (seenDirs.has(k)) continue;
        seenDirs.add(k);
        queue.push(n);
      }
      for (const root of roots) {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(root);
        } catch {
          continue;
        }
        for (const e of entries) {
          const d = path.join(root, e, 'chatSessions');
          const n = path.normalize(d);
          const k = pathKey(n);
          if (seenDirs.has(k)) continue;
          seenDirs.add(k);
          queue.push(n);
        }
      }

      const now = Date.now();
      let processedInBatch = 0;

      for (const dir of queue) {
        if (this.disposed) break;
        let files: string[] = [];
        try {
          files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const f of files) {
          if (this.disposed) break;
          const full = path.join(dir, f);
          // 已选中的会话由主 watcher 负责，这里跳过，避免重复
          if (this.current === full) continue;
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            // 过滤：仅检查 10 分钟内活跃修改过的文件
            if (now - st.mtimeMs > USER_MSG_SCAN_MAX_AGE_MS) continue;

            const cursor = this.userMsgCursors.get(full) ?? { offset: 0, mtimeMs: 0, lastReqCount: 0 };
            if (st.mtimeMs === cursor.mtimeMs && st.size === cursor.offset) {
              // 文件未变化，快速跳过
              continue;
            }
            if (st.size < cursor.offset) {
              // 文件被重写/截断：重置增量
              cursor.offset = 0;
              cursor.lastReqCount = 0;
            }
            if (cursor.offset === 0 && !this.userMsgCursors.has(full)) {
              // 首次看到此文件：从尾部开始，只投「之后新增」的桌面消息。
              cursor.offset = st.size;
              cursor.mtimeMs = st.mtimeMs;
              this.userMsgCursors.set(full, cursor);
              continue;
            }
            if (st.size <= cursor.offset) {
              cursor.mtimeMs = st.mtimeMs;
              this.userMsgCursors.set(full, cursor);
              continue;
            }
            const len = st.size - cursor.offset;
            // 限制单次读取，防止超大文件卡死（一次最多 4MB）
            if (len > 4 * 1024 * 1024) {
              cursor.offset = st.size - 4 * 1024 * 1024;
              continue;
            }
            const fd = fs.openSync(full, 'r');
            let buf: Buffer;
            try {
              buf = Buffer.alloc(len);
              fs.readSync(fd, buf, 0, len, cursor.offset);
            } finally {
              fs.closeSync(fd);
            }
            cursor.offset = st.size;
            const lines = buf.toString('utf8').split('\n');
            for (const line of lines) {
              const s = line.trim();
              if (!s) continue;
              try {
                const obj = JSON.parse(s);
                const reqs = this.extractRequestsFromObj(obj);
                if (!reqs || !reqs.length) continue;
                // kind0 快照含整段历史：只投「数组尾部真正新追加」的请求，
                // 否则重绑后外会话会把全部历史用户轮 dump 成气泡
                for (let ri = 0; ri < reqs.length; ri++) {
                  const r = reqs[ri];
                  const rid = r?.requestId ?? '';
                  if (!rid || this.seenForeignReqIds.has(rid)) continue;
                  this.seenForeignReqIds.add(rid);
                  const text = textOfUserReq(r);
                  if (!text) continue;
                  // 手机端已 pin 某会话时，禁止把「其他会话」的桌面消息灌进当前 feed
                  if (this.pinnedFile) continue;
                  // kind0 快照含整段历史：只投时间戳足够新的用户消息（dump 防御）。
                  // lastReqCount 兜底：无 timestamp 的老版本数据退化为按追加位置过滤
                  const rts = typeof r?.timestamp === 'number' ? r.timestamp : undefined;
                  if (rts != null) {
                    if (now - rts > USER_FRESH_MS) continue;
                  } else if (ri < cursor.lastReqCount || ri < reqs.length - 1) {
                    // 无时间戳：kind0 快照整段重放时只有数组尾部那条才可能是新追加的，
                    // 位置在前的历史轮一律丢弃（lastReqCount 兜底跨行追踪）
                    continue;
                  }
                  this.opts.onEvent({
                    type: 'USER_MESSAGE',
                    text,
                    requestId: rid,
                    foreign: true,
                    // 来源会话标 _sess：否则 PWA 跨会话过滤不认它，外会话泡会漏进当前 feed
                    _sess: f.replace(/\.jsonl$/i, ''),
                  });
                }
                if (reqs.length > cursor.lastReqCount) cursor.lastReqCount = reqs.length;
              } catch {
                /* 单行损坏忽略 */
              }
            }
            // 记录最新 mtime + offset：下次 mtime/size 相同则快速跳过
            cursor.mtimeMs = st.mtimeMs;
            this.userMsgCursors.set(full, cursor);
          } catch {
            /* stat/read 失败忽略 */
          }

          processedInBatch++;
          if (processedInBatch >= 20) {
            processedInBatch = 0;
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }

      // 防止 seenForeignReqIds 无限增长：滑动窗口 FIFO 淘汰（保留最新的 10,000 个）
      if (this.seenForeignReqIds.size > 20000) {
        const arr = [...this.seenForeignReqIds];
        this.seenForeignReqIds = new Set(arr.slice(-10000));
      }
    } finally {
      this.userMsgScanRunning = false;
    }
  }

  /** 从任意 jsonl 行（kind=0 快照或 kind=2 增量）中提取 request 数组 */
  private extractRequestsFromObj(obj: any): any[] | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    if (obj.kind === 0 && Array.isArray(obj?.v?.requests)) {
      return obj.v.requests as any[];
    }
    if (
      obj.kind === 2 &&
      Array.isArray(obj.k) &&
      obj.k.length >= 1 &&
      obj.k[0] === 'requests' &&
      Array.isArray(obj.v)
    ) {
      // k 可能为 ['requests']（整组追加）或 ['requests', idx, 'request']
      // （单项变异）。两者 v 里都可能是单个 request 或数组。
      const v = obj.v;
      if (Array.isArray(v)) {
        // 若 v 也是数组且内含 request 对象 → 整组/多项
        return v;
      }
      if (v && typeof v === 'object') {
        return [v];
      }
    }
    return undefined;
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

  private scheduleTailFromWatch() {
    if (this.disposed) return;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined;
      this.tail();
    }, this.watchDebounceMs);
  }

  private bindWatchers(file: string) {
    this.closeWatchers();
    const onChange = () => this.scheduleTailFromWatch();
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
      this.dirWatcher = fs.watch(parent, { persistent: false }, (eventType, filename) => {
        if (filename && this.current && path.basename(this.current) === String(filename)) {
          this.scheduleTailFromWatch();
        } else if (eventType === 'rename' || eventType === 'change') {
          this.scan();
          this.scheduleTailFromWatch();
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

  private scan() {
    if (this.disposed) return;
    // 手机端显式选定了会话 → 不再自动跟随最新文件（否则会把选中的会话抢走）
    if (this.pinnedFile) {
      if (!samePath(this.current, this.pinnedFile)) this.bindFile(this.pinnedFile);
      return;
    }
    const newest =
      this.opts.forceFile ||
      findNewestSessionFile({
        preferDirs: this.opts.preferChatSessionDirs,
        roots: this.opts.roots ?? defaultSessionRoots(),
      });
    if (!newest) return;
    if (!samePath(newest, this.current)) {
      this.bindFile(newest);
    }
  }

  private bindFile(file: string, opts?: { skipBootstrap?: boolean }) {
    this.current = file;
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
    this.projector.reset();
    this.lastLineFp = '';
    this.bootstrapDoneFor = undefined;

    let startOffset = 0;
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(file);
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
    } catch {
      this.lastSize = 0;
      this.lastMtimeMs = 0;
    }

    if (this.liveOnly) {
      startOffset = st?.size ?? 0;
    }
    this.offset = startOffset;

    const mode = this.liveOnly ? 'live-only@EOF' : 'catch-up@0';
    // Tag internal so bridge/PWA can drop chrome noise from the phone feed.
    this.opts.onEvent({
      type: 'SYSTEM_MESSAGE',
      text: `Watching session: ${path.basename(file)} (${mode})`,
      visibility: 'internal',
      internal: true,
    } as PhoneEvent);

    this.bindWatchers(file);

    if (!this.liveOnly) {
      this.tail(true);
    } else if (opts?.skipBootstrap) {
      // 手机 PHONE_SESSION_SELECT：历史只走 HISTORY_REPLAY，live 从 EOF 收增量
      this.bootstrapDoneFor = file;
    } else {
      // Catch mid-turn: project last request(s) once without full history flood.
      this.bootstrapLastRequests(file);
    }
  }

  /**
   * Read the full file once and project only the last N requests via a fresh
   * temporary projector path — actually reuses main projector after reset so
   * subsequent live diffs continue correctly.
   */
  private bootstrapLastRequests(file: string) {
    if (this.bootstrapDoneFor === file) return;
    const n = Math.max(0, this.opts.bootstrapLastRequests ?? 1);
    if (n === 0) {
      this.bootstrapDoneFor = file;
      return;
    }
    let raw = '';
    try {
      const st = fs.statSync(file);
      raw = st.size > HISTORY_BIG_FILE_BYTES
        ? readTailLines(file, st.size)
        : fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    if (!lines.length) {
      this.bootstrapDoneFor = file;
      return;
    }

    // Prefer the last kind=0 snapshot if present; else walk all lines.
    let kind0: any = null;
    const mutations: any[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj?.kind === 0) kind0 = obj;
        else mutations.push(obj);
      } catch {
        /* ignore */
      }
    }

    // Reset projector and only emit last N requests worth of content.
    this.projector.reset();
    if (kind0) {
      try {
        // Temporarily project kind0 but filter to last N requests by mutating a shallow copy
        const v = kind0.v && typeof kind0.v === 'object' ? { ...kind0.v } : kind0.v;
        if (v && Array.isArray(v.requests) && v.requests.length > n) {
          v.requests = v.requests.slice(-n);
          // renumber is not needed — projector uses array indices as requestIndex
        }
        const evs = this.projector.projectLine({ ...kind0, v });
        // bootstrap 是历史补全：不投 USER_MESSAGE（最新一轮用户气泡由 live 增量/foreign 扫描负责）
        for (const ev of evs) if (ev.type !== 'USER_MESSAGE') this.opts.onEvent(ev);
      } catch {
        /* ignore */
      }
    }

    // Apply trailing mutations so mid-turn kind2/1 after snapshot still land.
    // Cap work: only last ~80 mutation lines.
    const tailMut = mutations.slice(-80);
    for (const obj of tailMut) {
      try {
        const evs = this.projector.projectLine(obj);
        // 同上：追赶段不投历史 USER；时间戳过期或缺失都丢，只留新鲜新轮
        let lastUser = -1;
        evs.forEach((e, i) => {
          if (e.type === 'USER_MESSAGE') lastUser = i;
        });
        evs.forEach((e, i) => {
          if (e.type !== 'USER_MESSAGE') {
            this.opts.onEvent(e);
            return;
          }
          const ets = typeof (e as any).timestamp === 'number' ? (e as any).timestamp : undefined;
          if (i === lastUser && ets != null && Date.now() - ets <= USER_FRESH_MS) this.opts.onEvent(e);
        });
      } catch {
        /* ignore */
      }
    }

    this.bootstrapDoneFor = file;
    // Stay at EOF for live tail; pending empty.
    try {
      const st = fs.statSync(file);
      this.offset = st.size;
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
    } catch {
      /* ignore */
    }
    this.pending = '';
  }

  private tail(fromStart = false) {
    if (!this.current || this.disposed) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(this.current);
    } catch {
      return;
    }

    // Truncation / full rewrite: size went backwards.
    if (st.size < this.offset || st.size < this.lastSize) {
      this.offset = 0;
      this.pending = '';
      this.decoder = new StringDecoder('utf8');
      this.projector.reset();
      this.lastLineFp = '';
      // After rewrite, bootstrap again so phone gets current turn.
      if (this.liveOnly) {
        this.bootstrapDoneFor = undefined;
        this.lastSize = st.size;
        this.lastMtimeMs = st.mtimeMs;
        this.bootstrapLastRequests(this.current);
        return;
      }
    }

    if (fromStart) {
      this.offset = 0;
      this.decoder = new StringDecoder('utf8');
    }

    // Same size but mtime advanced: possible in-place rewrite of last line(s).
    // Re-read from a safe earlier point: re-bootstrap for liveOnly, else full re-tail.
    if (
      st.size === this.offset &&
      st.size === this.lastSize &&
      st.mtimeMs > this.lastMtimeMs + 5 &&
      this.liveOnly
    ) {
      this.lastMtimeMs = st.mtimeMs;
      this.bootstrapDoneFor = undefined;
      this.decoder = new StringDecoder('utf8');
      this.projector.reset();
      this.bootstrapLastRequests(this.current);
      return;
    }

    if (st.size === this.offset) {
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;
      return;
    }

    const fd = fs.openSync(this.current, 'r');
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      this.lastSize = st.size;
      this.lastMtimeMs = st.mtimeMs;

      const decoded = this.decoder.write(buf);
      const chunk = this.pending + decoded;
      const parts = chunk.split('\n');
      this.pending = parts.pop() || '';
      for (const line of parts) {
        const s = line.trim();
        if (!s) continue;
        // Detect identical re-append of same line (rare)
        const fp = s.length + ':' + s.slice(0, 64) + ':' + s.slice(-32);
        if (fp === this.lastLineFp) continue;
        this.lastLineFp = fp;
        try {
          const obj = JSON.parse(s);
          // Full kind0 snapshot mid-session: project (projector dedupes requests/text)
          const evs = this.projector.projectLine(obj);
          // kind0 快照会重投整段历史的 USER_MESSAGE（桌面发送后 chatSessions
          // 落盘的同一条）。只保留时间戳新鲜的最后一条 USER，旧轮不广播。
          // kind=2 增量里的 USER 都是本 mutation 新落盘的请求（projector 的
          // seenRequestIds 已去重），不套快照门槛——否则无 timestamp 的
          // 新请求或同 mutation 里靠前的请求会被整条吞掉。
          const isSnapshot = obj.kind === 0;
          let lastUser = -1;
          if (isSnapshot) {
            evs.forEach((e, i) => {
              if (e.type === 'USER_MESSAGE') lastUser = i;
            });
          }
          evs.forEach((e, i) => {
            if (e.type !== 'USER_MESSAGE') {
              this.opts.onEvent(e);
              return;
            }
            if (!isSnapshot) {
              this.opts.onEvent(e);
              return;
            }
            const ets = typeof (e as any).timestamp === 'number' ? (e as any).timestamp : undefined;
            if (i === lastUser && (ets == null || Date.now() - ets <= USER_FRESH_MS)) this.opts.onEvent(e);
          });
        } catch {
          // ignore bad line
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private isAllowedSessionFile(file: string): boolean {
    if (!/\.jsonl$/i.test(file)) return false;
    let realFile: string;
    try {
      realFile = fs.realpathSync(file);
    } catch {
      return false;
    }
    const allowedDirs = new Set<string>();
    for (const dir of this.opts.preferChatSessionDirs ?? []) {
      try { allowedDirs.add(fs.realpathSync(dir)); } catch { /* ignore */ }
    }
    for (const dir of allowedDirs) {
      const rel = path.relative(dir, realFile);
      if (rel && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) && !rel.includes(path.sep)) {
        return true;
      }
    }
    for (const root of this.opts.roots ?? []) {
      let realRoot: string;
      try { realRoot = fs.realpathSync(root); } catch { continue; }
      const rel = path.relative(realRoot, realFile).split(path.sep);
      if (rel.length === 3 && rel[1] === 'chatSessions' && rel[2] && /\.jsonl$/i.test(rel[2])) {
        return true;
      }
    }
    return false;
  }
}

/**
 * 从文件尾部读取内容，自适应扩大窗口直到拿到足够多的可解析行。
 * 返回已丢弃截断首行的文本；失败返回空串。
 */
function readTailLines(file: string, size: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    let best = '';
    for (const win of HISTORY_TAIL_WINDOWS) {
      const len = Math.min(win, size);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, size - len);
      let text = buf.subarray(0, n).toString('utf8');
      // 只有真的截断了才需要丢首行（整文件读到时首行是完整的）
      if (len < size) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      best = text;
      let lines = 0;
      for (const l of text.split('\n')) {
        if (l.trim()) lines++;
      }
      // 行数够了，或已经读到整个文件，就不必再扩
      if (lines >= HISTORY_TAIL_MIN_LINES || len >= size) break;
    }
    return best;
  } catch {
    return '';
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

function newestInChatSessionsDir(dir: string): { file: string; mtime: number } | undefined {
  if (!fs.existsSync(dir)) return undefined;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  let best: { file: string; mtime: number } | undefined;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const mt = fs.statSync(full).mtimeMs;
      if (!best || mt > best.mtime) best = { file: full, mtime: mt };
    } catch {
      // ignore
    }
  }
  return best;
}

function findNewestSessionFile(opts: {
  preferDirs?: string[];
  roots: string[];
}): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  for (const dir of opts.preferDirs || []) {
    const hit = newestInChatSessionsDir(dir);
    if (hit && (!best || hit.mtime > best.mtime)) best = hit;
  }
  if (best) return best.file;

  for (const root of opts.roots) {
    if (!fs.existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const id of entries) {
      const dir = path.join(root, id, 'chatSessions');
      const hit = newestInChatSessionsDir(dir);
      if (hit && (!best || hit.mtime > best.mtime)) best = hit;
    }
  }
  return best?.file;
}

export function defaultSessionRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  roots.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
  roots.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'));
  roots.push(path.join(home, '.config', 'Code', 'User', 'workspaceStorage'));
  roots.push(path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'));
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage'));
    roots.push(path.join(process.env.APPDATA, 'Code - Insiders', 'User', 'workspaceStorage'));
  }
  return roots;
}

export function sessionDiscoveryFromExtension(
  storageUri?: { fsPath: string } | null,
  globalStorageUri?: { fsPath: string } | null,
): { preferChatSessionDirs: string[]; roots: string[] } {
  const preferChatSessionDirs: string[] = [];
  const roots: string[] = [];
  const seen = new Set<string>();
  const pushRoot = (r: string) => {
    const n = path.normalize(r);
    const k = pathKey(n);
    if (seen.has(k)) return;
    seen.add(k);
    roots.push(n);
  };
  // storageUri is extension workspaceStorage/<wsHash>/local.xxx — parent is wsHash dir
  if (storageUri?.fsPath) {
    const wsHashDir = path.dirname(storageUri.fsPath);
    const wsRoot = path.dirname(wsHashDir);
    preferChatSessionDirs.push(path.join(wsHashDir, 'chatSessions'));
    pushRoot(wsRoot);
  }
  if (globalStorageUri?.fsPath) {
    const globalStorageRoot = path.dirname(globalStorageUri.fsPath);
    const userDir = path.dirname(globalStorageRoot);
    pushRoot(path.join(userDir, 'workspaceStorage'));
    const copilotChat = path.join(globalStorageRoot, 'github.copilot-chat');
    if (fs.existsSync(copilotChat)) {
      preferChatSessionDirs.push(path.join(copilotChat, 'chatSessions'));
    }
  }
  for (const r of defaultSessionRoots()) pushRoot(r);
  return { preferChatSessionDirs, roots };
}

export interface SessionSummary {
  file: string;
  /** 会话文件名（不含 .jsonl，即 UUID） */
  name: string;
  /** 会话标题：优先 customTitle（LLM 生成，与官方侧栏一致），缺失时用首条用户消息截断 */
  title?: string;
  mtime: number;
  size: number;
  requestCount?: number;
  // --- 工作区归属（由 WorkspaceIndex 填充；索引缺失时全部 undefined） ---
  /** 不透明工作区 ID（来自 WorkspaceIndex），禁止当路径用 */
  workspaceId?: string;
  /** 两级显示名："GC_trr:fuse_seg" 或 "sidecar_remote" */
  qualifiedName?: string;
  /** 远程主机名；本地为 null */
  machineName?: string | null;
  /** 是否远程工作区 */
  isRemote?: boolean;
  /** 工作区显示名（不含主机前缀） */
  displayName?: string;
  /** 是否为当前窗口所属工作区（未提供 currentWorkspaceHash 时为 undefined） */
  isCurrent?: boolean;
}

/**
 * 解析会话标题（与 VS Code 官方侧栏一致）：
 * 1. chatSessions/<id>.jsonl 中 kind=1 且 k==['customTitle'] 的 v（LLM 生成，权威源）
 * 2. 缺失时：首个用户 request 的 message 文本第一行截断 200 字符（官方 fallback）
 * 3. 空会话：'新建聊天'
 */
function resolveSessionTitle(file: string): string | undefined {
  let customTitle: string | undefined;
  let firstPrompt: string | undefined;
  let hasRequests = false;
  try {
    const st = fs.statSync(file);
    if (st.size < 20) return '新建聊天';
    const fd = fs.openSync(file, 'r');
    try {
      // kind=0 快照常是超大单行（实测 8MB+），1MB 截断会导致 JSON.parse 失败，
      // customTitle 在行首却拿不到 → 回落「新建聊天」。扩到 12MB 并用正则兜底。
      // Titles and the first prompt are written near the beginning of the file.
      // Keep this bounded: allocating 12MB for every item in a 40-session list
      // blocks the extension host even when only a title is needed.
      const cap = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(cap);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, read).toString('utf8');

      // 1) 正则直接抽 customTitle / initialTitle（不依赖换行或完整 JSON）
      // 覆盖两种落盘形式：快照内 "customTitle": "x" 与 delta 行 "k":["customTitle"],"v":"x"。
      // 注意：不抓裸 "title"——selectedModel.configurationSchema 等嵌套字段里也有
      // "title"（如 "Optimize for"），会污染标题；kind=0 顶层 title 由下方 JSON 解析处理。
      for (const key of ['customTitle', 'initialTitle'] as const) {
        const res = [
          new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`),
          new RegExp(`"k"\\s*:\\s*\\[\\s*"${key}"\\s*\\]\\s*,\\s*"v"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`),
        ];
        for (const re of res) {
          const m = head.match(re);
          if (m?.[1]) {
            const t = m[1]
              .replace(/\\n/g, ' ')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\')
              .trim();
            if (t && t !== 'New Chat' && t !== '新建聊天') {
              customTitle = t;
              break;
            }
          }
        }
        if (customTitle) break;
      }
      if (customTitle) return customTitle;
      for (const line of head.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const obj = JSON.parse(s);
          if (!obj || typeof obj !== 'object') continue;
          if (
            obj.kind === 1 &&
            Array.isArray(obj.k) &&
            obj.k.length === 1 &&
            obj.k[0] === 'customTitle' &&
            typeof obj.v === 'string'
          ) {
            customTitle = obj.v.trim() || customTitle;
          } else if (obj.kind === 0 && obj.v && typeof obj.v === 'object') {
            const v = obj.v as Record<string, unknown>;
            for (const key of ['customTitle', 'initialTitle', 'title'] as const) {
              const val = typeof v[key] === 'string' ? String(v[key]).trim() : '';
              if (val && val !== 'New Chat' && val !== '新建聊天') {
                customTitle = customTitle || val;
                break;
              }
            }
            if (Array.isArray(v.requests) && v.requests.length) {
              hasRequests = true;
              if (!firstPrompt) {
                const first = v.requests[0] as any;
                const msg = first?.message;
                const text =
                  typeof msg?.text === 'string'
                    ? msg.text
                    : Array.isArray(msg?.parts)
                      ? msg.parts
                          .map((p: any) =>
                            typeof p?.text === 'string'
                              ? p.text
                              : typeof p?.value === 'string'
                                ? p.value
                                : '',
                          )
                          .join('')
                      : '';
                if (String(text).trim()) {
                  firstPrompt = String(text).trim().split('\n')[0].slice(0, 200);
                }
              }
            }
          } else if (obj.kind === 2 && Array.isArray(obj.k) && obj.k[0] === 'requests' && Array.isArray(obj.v)) {
            if (!hasRequests && obj.v.length) hasRequests = true;
            for (const r of obj.v) {
              if (firstPrompt) break;
              const msg = r?.message;
              const text =
                typeof msg?.text === 'string'
                  ? msg.text
                  : typeof msg?.value === 'string'
                    ? msg.value
                    : Array.isArray(msg?.parts)
                      ? msg.parts
                          .map((p: any) =>
                            typeof p?.text === 'string'
                              ? p.text
                              : typeof p?.value === 'string'
                                ? p.value
                                : '',
                          )
                          .join('')
                      : '';
              if (text.trim()) {
                firstPrompt = text.trim().split('\n')[0].slice(0, 200);
              }
            }
          }
        } catch {
          // ignore bad / truncated line
        }
        if (customTitle && firstPrompt) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (customTitle) return customTitle;
  if (firstPrompt) return firstPrompt;
  if (hasRequests) return '对话';
  return '新建聊天';
}

/**
 * 快速统计会话文件中的请求数：只读文件前 ~256KB 找 kind=0 快照的 requests
 * 长度；找不到快照则数行数作为粗略估计。大文件不整读。
 */
function countRequestsQuick(file: string): number | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, read).toString('utf8');
      let requests: number | undefined;
      for (const line of head.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const obj = JSON.parse(s);
          if (obj && obj.kind === 0 && obj.v && Array.isArray(obj.v.requests)) {
            requests = obj.v.requests.length;
            break;
          }
        } catch {
          // ignore bad line
        }
      }
      // kind=0 快照往往是空的（requests: []），真实请求都在后续 kind=2 增量里，
      // 只看快照会把活跃会话显示成「0 次请求」。因此另做 requestId 去重计数。
      const ids = new Set<string>();
      const re = /"requestId"\s*:\s*"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(head)) !== null) ids.add(m[1]);
      if (requests !== undefined || ids.size > 0) {
        return Math.max(requests ?? 0, ids.size);
      }
      // 粗略估计：按行数 / 2（快照 + 增量各占一部分）
      const lineCount = head.split('\n').filter((l) => l.trim()).length;
      return Math.max(0, Math.round(lineCount / 2));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
