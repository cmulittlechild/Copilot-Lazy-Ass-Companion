/**
 * sessionIndex.ts — 会话索引读取模块（替代/增强 jsonl 解析的标题来源）
 *
 * 背景：
 * - VS Code 把 workspaceStorage 下的键值库 state.vscdb（sqlite，表 ItemTable: key TEXT, value TEXT）。
 * - 官方会话索引 key = `chat.ChatSessionStore.index`，value 是 JSON：
 *   {"version":1,"entries":{"<sessionId>":{"sessionId":"...","title":"项目学习与理解",
 *    "lastMessageDate":1785974783181,"timing":{...},"isEmpty":false,...}}}
 * - title 是 LLM 生成的官方标题（customTitle 的权威来源）；isEmpty 标记空会话（标题通常为"新建聊天"）。
 *   相比 chatSessions/*.jsonl 的 customTitle（~60s 周期落盘、可能丢失），state.vscdb 索引更新更即时可靠。
 *
 * 实现要点：
 * - 纯 Node 实现（不 import vscode），供扩展宿主与独立脚本共用。
 * - node:sqlite 用顶部 try-require 防御式加载：宿主 Node < 22.5 不支持时降级（readAll 返回 []）。
 * - sqlite 以只读方式打开（VS Code 可能用 WAL 模式，只读打开兼容），用完 close()。
 * - 任何失败（模块不可用/文件不存在/锁/JSON 解析错）都返回 [] 并 log 一条，绝不抛异常。
 */

import * as path from 'path';

/** 官方会话索引里的单条记录（chat.ChatSessionStore.index JSON 中 entries 的 value）。 */
export interface SessionIndexEntry {
  /** 会话 ID（通常为 UUID）。 */
  sessionId: string;
  /** LLM 生成的官方标题（customTitle 权威值）；空会话通常是"新建聊天"。 */
  title?: string;
  /** 最后一条消息的时间戳（毫秒）。 */
  lastMessageDate?: number;
  /** 是否为空会话。 */
  isEmpty?: boolean;
}

// ---------------------------------------------------------------------------
// node:sqlite 防御式加载
// ---------------------------------------------------------------------------

/** node:sqlite 最小结构类型（不依赖 @types/node 版本，避免编译期耦合）。 */
interface SqliteStmtLike {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDbLike {
  prepare(sql: string): SqliteStmtLike;
  close(): void;
}
/** DatabaseSync 构造器的最小结构类型（readOnly 打开）。 */
type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDbLike;

/**
 * 顶部 try-require 拿 DatabaseSync 类：
 * 宿主 Node 不支持 node:sqlite（< 22.5）时捕获异常，DatabaseSyncCtor 置为 undefined，
 * 后续 readAll 直接降级返回 []（不 import，避免模块加载期抛错）。
 */
let DatabaseSyncCtor: DatabaseSyncCtor | undefined;
try {
  DatabaseSyncCtor = (require('node:sqlite') as { DatabaseSync?: unknown }).DatabaseSync as
    | DatabaseSyncCtor
    | undefined;
} catch {
  DatabaseSyncCtor = undefined;
}

/** state.vscdb 中官方会话索引的 key。 */
const INDEX_KEY = 'chat.ChatSessionStore.index';

/**
 * 从 state.vscdb 读取官方会话索引。
 * - vscdbPath 缺省时**不自动推导**，由调用方传路径（如 deriveVscdbPath 的结果）。
 * - log 可选，失败时回调一行说明。
 */
export class SessionIndexReader {
  /** 最近一次 readAll 的缓存（sessionId → entry）。 */
  private cache: Map<string, SessionIndexEntry> = new Map();
  /** 是否已执行过至少一次 readAll（用于 getTitle 首次调用时懒加载）。 */
  private loaded = false;
  /** 最近一次 readAll 的毫秒时刻（限频重读用）。 */
  private lastReadMs = 0;
  /** 未命中/占位标题时的最小重读间隔——state.vscdb 标题由 LLM 滞后生成，
   *  激活期一次性缓存会让新会话标题永久停在「新建聊天」。 */
  private static readonly REFRESH_MS = 5000;
  /** 官方占位标题（命中时也限频重读，等 LLM 真标题落地）。 */
  private static readonly PLACEHOLDER_TITLES = new Set([
    'new chat',
    '新建聊天',
    '新建会话',
    'untitled chat',
  ]);

  constructor(private opts: { vscdbPath?: string; log?: (line: string) => void }) {}

  /**
   * 读取官方会话索引并刷新缓存，返回全部条目（顺序与 JSON entries 一致）。
   * 任何失败（node:sqlite 不可用/文件不存在/锁/JSON 解析错）都返回 [] 并 log 一条。
   */
  readAll(): SessionIndexEntry[] {
    const entries = this.tryRead();
    this.cache = new Map(entries.map((e) => [e.sessionId, e]));
    this.loaded = true;
    this.lastReadMs = Date.now();
    return entries;
  }

  /**
   * 从最近一次 readAll 的缓存中取会话官方标题；首次调用时先 readAll 一次。
   * 未命中或命中占位标题（「新建聊天」等）时限频重读：索引在会话创建后、
   * LLM 生成标题后才写入，固定缓存会把标题钉死在占位值上。
   */
  getTitle(sessionId: string): string | undefined {
    if (!this.loaded) {
      this.readAll();
    }
    let title = this.cache.get(sessionId)?.title;
    const isPlaceholder =
      title != null && SessionIndexReader.PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
    if ((title == null || isPlaceholder) && Date.now() - this.lastReadMs >= SessionIndexReader.REFRESH_MS) {
      this.readAll();
      title = this.cache.get(sessionId)?.title;
    }
    return title;
  }

  /** 实际读取逻辑：打开 sqlite → 查询索引 JSON → 解析为条目数组。 */
  private tryRead(): SessionIndexEntry[] {
    const dbPath = this.opts.vscdbPath;
    if (!dbPath) {
      this.log('缺少 vscdbPath，跳过会话索引读取');
      return [];
    }
    if (!DatabaseSyncCtor) {
      this.log('当前 Node 不支持 node:sqlite，会话索引不可用');
      return [];
    }
    // 用 const 局部变量持有构造器，避免模块级 let 的收窄问题
    const DatabaseSync = DatabaseSyncCtor;
    let db: SqliteDbLike | undefined;
    try {
      // 只读打开：VS Code 可能用 WAL 模式，只读连接兼容；不落任何写锁
      db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
      const row = stmt.get(INDEX_KEY);
      if (!row || typeof row.value !== 'string') {
        // 索引尚未写入属正常状态（首次启动/无会话），不视为失败
        return [];
      }
      return parseIndexJson(row.value, (line) => this.log(line));
    } catch (err) {
      this.log(`读取会话索引失败: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // 关闭失败可忽略
        }
      }
    }
  }

  private log(line: string): void {
    this.opts.log?.(`[sessionIndex] ${line}`);
  }
}

/**
 * 解析 chat.ChatSessionStore.index 的 JSON value 为条目数组。
 * 结构：{"version":1,"entries":{"<sessionId>":{...}}}；字段逐个防御性取值。
 */
function parseIndexJson(raw: string, log: (line: string) => void): SessionIndexEntry[] {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    log(`会话索引 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (typeof obj !== 'object' || obj === null) {
    return [];
  }
  const entries = (obj as { entries?: unknown }).entries;
  if (typeof entries !== 'object' || entries === null) {
    return [];
  }
  const out: SessionIndexEntry[] = [];
  for (const [id, rawEntry] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }
    const e = rawEntry as Record<string, unknown>;
    out.push({
      sessionId: typeof e.sessionId === 'string' ? e.sessionId : id,
      title: typeof e.title === 'string' ? e.title : undefined,
      lastMessageDate: typeof e.lastMessageDate === 'number' ? e.lastMessageDate : undefined,
      isEmpty: typeof e.isEmpty === 'boolean' ? e.isEmpty : undefined,
    });
  }
  return out;
}

/**
 * 由 workspaceStorage 根目录推导 state.vscdb 的完整路径。
 * 例：.../workspaceStorage/6ea7fd91d95d0ee7b8771238283ff09b → .../state.vscdb
 */
export function deriveVscdbPath(workspaceStorageRoot: string): string {
  return path.join(workspaceStorageRoot, 'state.vscdb');
}

/**
 * 从索引缓存中取会话标题的便捷函数：
 * - index 中有该会话 → 原样返回官方 title（空会话的"新建聊天"等也照常返回）；
 * - 否则返回 fallbackTitle（可为 undefined）。
 */
export function sessionTitleFromIndex(
  index: Map<string, SessionIndexEntry> | undefined,
  sessionId: string,
  fallbackTitle?: string
): string | undefined {
  const entry = index?.get(sessionId);
  if (entry?.title) {
    return entry.title;
  }
  return fallbackTitle;
}
