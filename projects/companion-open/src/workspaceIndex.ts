/**
 * workspaceIndex.ts — 工作区索引模块（解决"哪个会话属于哪个工作区"）
 *
 * 背景（已实测确认）：
 * - VS Code 的聊天会话按工作区隔离，落盘在
 *   `<workspaceStorage>/<hash>/chatSessions/*.jsonl`。
 * - `<hash>` = md5(fsPath + String(Math.round(birthtimeMs)))，含 birthtime 盐，
 *   **不可反推**：不能从工作区路径算出 hash，也不能从 hash 还原路径。
 * - 但每个 hash 目录里都有 `workspace.json`，这是权威的反向索引：
 *     本地文件夹  {"folder":"file:///Users/xin/Desktop/sidecar_remote"}
 *     远程 SSH    {"folder":"vscode-remote://ssh-remote%2B<authority>/<remote-path>"}
 *     多根工作区  {"workspace":"file:///path/to/x.code-workspace"}
 * - 远程 authority 有两种编码，实测都存在：
 *     1) hex 编码的 JSON（新版）：7b22686f73744e616d65223a2247435f747272227d
 *        → hex decode → {"hostName":"GC_trr"} → 主机名 GC_trr
 *     2) 明文别名（旧版）：gc_trr / workstation / 141.84.244.34 / xin@141.84.244.34
 * - URI 里的路径段是 URL 编码的（中文目录会变成 %E4%B8%AD... ），需要 decodeURIComponent。
 *
 * 建模纪律（借鉴 paseo）：
 * 1. **不透明 ID**：`workspaceId` 不透明、禁止当路径用；路径只出现在 `cwd`。
 * 2. **派生名 vs 用户覆盖分离**：`displayName` 自动派生，`title` 为用户覆盖
 *    （`null` 表示"用派生值"）。渲染时取 `title ?? displayName`。
 * 3. **来源标注**：下面每个字段的注释标明 observed（磁盘事实）/ derived（推断）。
 *
 * 工程约束：
 * - 纯 Node（fs/path/os），**不 import vscode**，方便脚本与单测直接跑。
 * - 所有 IO 都被 try/catch 包住：单个损坏的 workspace.json 不能让整次 scan 崩掉。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 工作区类型。 */
export type WorkspaceKind =
  /** 本地文件夹（workspace.json 的 folder 是 file:// URI） */
  | 'local_folder'
  /** 远程文件夹（folder 是 vscode-remote:// URI，SSH / WSL / 容器） */
  | 'remote_folder'
  /** 多根工作区（workspace 字段指向 .code-workspace 文件） */
  | 'workspace_file'
  /** 无文件夹窗口：目录里有 chatSessions 但没有 workspace.json */
  | 'empty_window'
  /** workspace.json 存在但无法识别（字段缺失 / 解析失败 / 未知 scheme） */
  | 'unknown';

/** 一个工作区记录（不透明 id，路径只在 cwd）。 */
export interface WorkspaceRecord {
  /**
   * 不透明 ID，形如 `wks_<storageHash 前 12 位>`。derived。
   * **禁止当路径使用**，也不要试图从它解析出主机或目录。
   */
  workspaceId: string;
  /** workspaceStorage 下的 hash 目录名。observed。内部/边界适配器使用。 */
  storageHash: string;
  /** `<workspaceStorage>/<hash>` 的绝对路径。observed。 */
  storageDir: string;
  /** 工作区类型。derived（由 workspace.json 的字段与 URI scheme 推断）。 */
  kind: WorkspaceKind;
  /**
   * 文件系统路径（远程时是**远程侧**路径）。observed（来自 workspace.json）。
   * 这是本记录唯一的路径入口；`empty_window` / `unknown` 时为 null。
   */
  cwd: string | null;
  /** 远程主机名（authority 解码后，如 `GC_trr`）。derived。本地为 null。 */
  machineName: string | null;
  /** 是否远程工作区。derived。 */
  isRemote: boolean;
  /** 自动派生的显示名（如 `fuse_seg`），由 cwd basename 得来。derived。 */
  displayName: string;
  /**
   * 用户覆盖的标题；`null` 表示"用派生的 displayName"。
   * 磁盘上没有这个信息，scan() 不会填它，只能由 setTitle() 设置。
   */
  title: string | null;
  /** 两级显示名：远程 `GC_trr:fuse_seg`，本地 `sidecar_remote`。derived。 */
  qualifiedName: string;
  /** chatSessions 目录（存在才有值）。observed。 */
  chatSessionsDir: string | null;
  /** transcripts 目录（存在才有值）。observed。 */
  transcriptsDir: string | null;
  /** 该工作区的会话文件（`*.jsonl`）数量。observed。 */
  sessionCount: number;
  /** 最近会话活动时间（会话文件最大 mtimeMs）；无会话为 0。observed。 */
  lastActivityAt: number;
}

/** WorkspaceIndex 构造参数。 */
export interface WorkspaceIndexOptions {
  /** workspaceStorage 根目录列表；缺省用 defaultWorkspaceStorageRoots()。 */
  roots?: string[];
  /** 可选日志回调（每条一行，不含换行）。 */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// 根目录发现
// ---------------------------------------------------------------------------

/**
 * 默认的 workspaceStorage 根目录（跨平台，含 Insiders）。
 * 只返回候选路径，**不检查存在性**（由 scan() 逐个 try 读取）。
 */
export function defaultWorkspaceStorageRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  // macOS
  roots.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
  roots.push(
    path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
  );
  // Linux
  roots.push(path.join(home, '.config', 'Code', 'User', 'workspaceStorage'));
  roots.push(path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'));
  // Windows
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage'));
    roots.push(path.join(process.env.APPDATA, 'Code - Insiders', 'User', 'workspaceStorage'));
  }
  // 去重（不同分支可能落到同一路径）
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const n = path.normalize(r);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// authority / URI 解码
// ---------------------------------------------------------------------------

/** 形如 `ssh-remote+` / `wsl+` / `dev-container+` 的 authority 前缀。 */
const AUTHORITY_PREFIX_RE = /^[a-z][a-z0-9-]*\+/i;
/** 偶数长度的纯 hex（hex 编码 JSON 的必要条件）。 */
const EVEN_HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * 解码 vscode-remote authority → 主机名。同时支持两种实测编码：
 *
 * - hex-JSON（新版）：`ssh-remote%2B7b22...227d`
 *   → decodeURIComponent → 去 `ssh-remote+` 前缀 → hex decode → `{"hostName":"GC_trr"}`
 *   → 返回 `GC_trr`
 * - 明文别名（旧版）：`ssh-remote%2Bgc_trr` → 返回 `gc_trr`；
 *   `xin@141.84.244.34` 形式**原样保留**（含用户名，不做拆分）。
 *
 * 任何一步失败都退回"去前缀后的原始字符串"，绝不抛异常。
 */
export function decodeRemoteAuthority(authority: string): string {
  if (!authority) return '';
  // 1) URL 解码（%2B → +）；非法转义序列时退回原串
  let raw = authority;
  try {
    raw = decodeURIComponent(authority);
  } catch {
    raw = authority;
  }
  // 2) 去掉 ssh-remote+ / wsl+ / dev-container+ 之类的前缀
  const body = raw.replace(AUTHORITY_PREFIX_RE, '');
  if (!body) return raw;
  // 3) 偶数长度纯 hex → 尝试 hex-JSON 解码取 hostName
  //    非 hex、或解码后不是含 hostName 的 JSON，都退回明文（如 gc_trr / xin@1.2.3.4）
  if (EVEN_HEX_RE.test(body) && body.length >= 8) {
    try {
      const text = Buffer.from(body, 'hex').toString('utf8');
      const obj: unknown = JSON.parse(text);
      if (obj && typeof obj === 'object') {
        const host = (obj as { hostName?: unknown }).hostName;
        if (typeof host === 'string' && host) return host;
      }
    } catch {
      // 不是 hex-JSON，落到下面原样返回
    }
  }
  return body;
}

/** URI 解析结果（内部用）。 */
interface ParsedUri {
  /** 文件系统路径（远程时是远程侧路径）。 */
  fsPath: string;
  /** 远程主机名；本地为 null。 */
  machineName: string | null;
  isRemote: boolean;
}

/** 尽力 decodeURIComponent；失败退回原串（避免 `%` 字面量炸掉整次 scan）。 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 把 workspace.json 里的 URI 字符串解析成路径 + 主机名。
 * 支持 `file://`（本地）与 `vscode-remote://<authority>/<path>`（远程）。
 * 无法识别的 scheme 返回 undefined。
 */
function parseWorkspaceUri(uri: string): ParsedUri | undefined {
  if (!uri || typeof uri !== 'string') return undefined;

  if (uri.startsWith('file://')) {
    let rest = uri.slice('file://'.length);
    // file://host/share/... 形式（UNC）：authority 非空时保留成 //host/share
    if (rest && !rest.startsWith('/')) rest = '//' + rest;
    let p = safeDecode(rest);
    // Windows 盘符：/C:/foo → C:/foo
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return { fsPath: p, machineName: null, isRemote: false };
  }

  if (uri.startsWith('vscode-remote://')) {
    const rest = uri.slice('vscode-remote://'.length);
    // authority 到第一个 `/` 为止；其后是远程侧路径
    const slash = rest.indexOf('/');
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    const rawPath = slash >= 0 ? rest.slice(slash) : '/';
    return {
      fsPath: safeDecode(rawPath),
      machineName: decodeRemoteAuthority(authority) || null,
      isRemote: true,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 派生显示名
// ---------------------------------------------------------------------------

/**
 * 由 cwd 派生 displayName：
 * - 一般取 basename（`/a/b/fuse_seg` → `fuse_seg`）
 * - basename 为空（根目录 `/`、盘符 `C:/`）时用 cwd 本身
 * - workspace_file 去掉 `.code-workspace` 后缀
 */
function deriveDisplayName(cwd: string, kind: WorkspaceKind): string {
  // 远程路径永远是 POSIX 风格，本地在 Windows 上可能是 `\`；两种分隔符都切
  const parts = cwd.split(/[/\\]+/).filter((s) => s.length > 0);
  let base = parts.length > 0 ? parts[parts.length - 1]! : '';
  if (!base) base = cwd;
  if (kind === 'workspace_file' && base.endsWith('.code-workspace')) {
    base = base.slice(0, -'.code-workspace'.length) || base;
  }
  return base;
}

/** 两级显示名：远程 `host:name`，本地就是 name。 */
function deriveQualifiedName(displayName: string, machineName: string | null): string {
  return machineName ? `${machineName}:${displayName}` : displayName;
}

// ---------------------------------------------------------------------------
// 目录探测
// ---------------------------------------------------------------------------

/** transcripts 的父目录名候选（实测扩展 ID 大小写不一致）。 */
const COPILOT_CHAT_DIRS = ['GitHub.copilot-chat', 'github.copilot-chat'];

/** 目录存在则返回路径，否则 null（任何 IO 错误都当"不存在"）。 */
function dirOrNull(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/** 在 hash 目录下找 transcripts 目录（大小写两种扩展目录名都试）。 */
function findTranscriptsDir(storageDir: string): string | null {
  for (const d of COPILOT_CHAT_DIRS) {
    const hit = dirOrNull(path.join(storageDir, d, 'transcripts'));
    if (hit) return hit;
  }
  return null;
}

/** 统计目录下 `*.jsonl` 的数量与最大 mtimeMs；单文件 stat 失败忽略。 */
function statSessions(dir: string | null): { count: number; lastActivityAt: number } {
  if (!dir) return { count: 0, lastActivityAt: 0 };
  let count = 0;
  let last = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { count: 0, lastActivityAt: 0 };
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    count++;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.mtimeMs > last) last = st.mtimeMs;
    } catch {
      // 单个文件 stat 失败（被删/权限）不影响计数
    }
  }
  return { count, lastActivityAt: last };
}

// ---------------------------------------------------------------------------
// WorkspaceIndex
// ---------------------------------------------------------------------------

/**
 * 工作区索引：扫描 workspaceStorage 下所有 hash 目录的 workspace.json，
 * 建立 hash ↔ 工作区（路径 / 主机 / 会话统计）的双向映射。
 */
export class WorkspaceIndex {
  private readonly roots: string[];
  private readonly log: (line: string) => void;

  /** 上次 scan 的结果（按 lastActivityAt 降序）。 */
  private records: WorkspaceRecord[] = [];
  private byHashMap = new Map<string, WorkspaceRecord>();
  private byIdMap = new Map<string, WorkspaceRecord>();
  /** normalize 后的 storageDir → record，供 resolveBySessionFile 走父目录查找。 */
  private byStorageDir = new Map<string, WorkspaceRecord>();
  /** 用户标题覆盖（workspaceId → title），跨 scan 保留。 */
  private titleOverrides = new Map<string, string>();

  constructor(opts?: WorkspaceIndexOptions) {
    this.roots = opts?.roots ?? defaultWorkspaceStorageRoots();
    this.log = opts?.log ?? (() => {});
  }

  /**
   * 扫描所有 roots 下的 `<hash>/workspace.json`，重建索引并返回结果。
   * - 没有 workspace.json 但有 chatSessions 的目录 → `empty_window`
   * - 既没有 workspace.json 也没有 chatSessions 的目录 → 跳过（无价值）
   * - 单个目录出错只记一行日志，不影响整体
   */
  scan(): WorkspaceRecord[] {
    const records: WorkspaceRecord[] = [];
    const seenDirs = new Set<string>();

    for (const root of this.roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue; // root 不存在（其它平台的候选路径）
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const storageDir = path.join(root, ent.name);
        const norm = path.normalize(storageDir);
        if (seenDirs.has(norm)) continue;
        seenDirs.add(norm);
        try {
          const rec = this.buildRecord(storageDir, ent.name);
          if (rec) records.push(rec);
        } catch (e) {
          this.log(`[workspaceIndex] 跳过 ${ent.name}: ${String(e)}`);
        }
      }
    }

    // 最近活动优先，同活动时间按名字稳定排序
    records.sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt || a.qualifiedName.localeCompare(b.qualifiedName),
    );

    this.records = records;
    this.byHashMap = new Map(records.map((r) => [r.storageHash, r]));
    this.byIdMap = new Map(records.map((r) => [r.workspaceId, r]));
    this.byStorageDir = new Map(records.map((r) => [path.normalize(r.storageDir), r]));
    this.log(
      `[workspaceIndex] scan: ${records.length} 个工作区（远程 ${
        records.filter((r) => r.isRemote).length
      }，有会话 ${records.filter((r) => r.sessionCount > 0).length}）`,
    );
    return records;
  }

  /** 读一个 hash 目录，组装 WorkspaceRecord；无价值目录返回 undefined。 */
  private buildRecord(storageDir: string, storageHash: string): WorkspaceRecord | undefined {
    const chatSessionsDir = dirOrNull(path.join(storageDir, 'chatSessions'));
    const transcriptsDir = findTranscriptsDir(storageDir);

    // 读 workspace.json（不存在 / 损坏都当作"没有"）
    let meta: { folder?: unknown; workspace?: unknown } | undefined;
    try {
      const text = fs.readFileSync(path.join(storageDir, 'workspace.json'), 'utf8');
      const obj: unknown = JSON.parse(text);
      if (obj && typeof obj === 'object') meta = obj as { folder?: unknown; workspace?: unknown };
    } catch {
      meta = undefined;
    }

    let kind: WorkspaceKind;
    let cwd: string | null = null;
    let machineName: string | null = null;
    let isRemote = false;
    let displayName: string;

    if (!meta) {
      // 无 workspace.json：只有还留着聊天数据才值得记一笔
      if (!chatSessionsDir && !transcriptsDir) return undefined;
      kind = 'empty_window';
      displayName = '(无文件夹窗口)';
    } else {
      const folderUri = typeof meta.folder === 'string' ? meta.folder : undefined;
      const wsFileUri = typeof meta.workspace === 'string' ? meta.workspace : undefined;
      const uri = folderUri ?? wsFileUri;
      const parsed = uri ? parseWorkspaceUri(uri) : undefined;
      if (!parsed) {
        kind = 'unknown';
        displayName = '(未知工作区)';
      } else {
        cwd = parsed.fsPath;
        machineName = parsed.machineName;
        isRemote = parsed.isRemote;
        kind = wsFileUri && !folderUri ? 'workspace_file' : parsed.isRemote ? 'remote_folder' : 'local_folder';
        displayName = deriveDisplayName(cwd, kind);
      }
    }

    const { count, lastActivityAt } = statSessions(chatSessionsDir);
    const workspaceId = 'wks_' + storageHash.slice(0, 12);

    return {
      workspaceId,
      storageHash,
      storageDir,
      kind,
      cwd,
      machineName,
      isRemote,
      displayName,
      title: this.titleOverrides.get(workspaceId) ?? null,
      qualifiedName: deriveQualifiedName(displayName, machineName),
      chatSessionsDir,
      transcriptsDir,
      sessionCount: count,
      lastActivityAt,
    };
  }

  /** 上次 scan 的结果（不重扫）。 */
  all(): WorkspaceRecord[] {
    return this.records;
  }

  /** 按 storageHash 查。 */
  byHash(hash: string): WorkspaceRecord | undefined {
    return this.byHashMap.get(hash);
  }

  /** 按 workspaceId 查。 */
  byId(workspaceId: string): WorkspaceRecord | undefined {
    return this.byIdMap.get(workspaceId);
  }

  /**
   * 边界适配器：给定任意会话文件路径（chatSessions 或 transcripts 下的 jsonl），
   * 沿父目录往上找到匹配的 `<workspaceStorage>/<hash>`，反查所属工作区。
   * 这样调用方拿到一个文件路径就够了，不必自己拆 hash。
   */
  resolveBySessionFile(file: string): WorkspaceRecord | undefined {
    if (!file) return undefined;
    let dir: string;
    try {
      dir = path.dirname(path.resolve(file));
    } catch {
      return undefined;
    }
    // 逐级上溯，直到根（parent === dir 时停）
    for (;;) {
      const hit = this.byStorageDir.get(path.normalize(dir));
      if (hit) return hit;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /**
   * 按 cwd 精确匹配（用于识别"当前窗口的工作区"）。
   * 同一路径可能对应多个 hash 目录（重开工作区会换 birthtime 盐），
   * 这里返回**最近活动**的那个。
   */
  resolveByCwd(cwd: string): WorkspaceRecord | undefined {
    if (!cwd) return undefined;
    const want = normalizeCwd(cwd);
    let best: WorkspaceRecord | undefined;
    for (const r of this.records) {
      if (!r.cwd || normalizeCwd(r.cwd) !== want) continue;
      if (!best || r.lastActivityAt > best.lastActivityAt) best = r;
    }
    return best;
  }

  /**
   * 设置/清除用户标题覆盖（`null` = 回到派生的 displayName）。
   * 覆盖值跨 scan 保留，scan() 会把它重新写回记录的 `title`。
   */
  setTitle(workspaceId: string, title: string | null): void {
    if (title === null || title === '') this.titleOverrides.delete(workspaceId);
    else this.titleOverrides.set(workspaceId, title);
    const rec = this.byIdMap.get(workspaceId);
    if (rec) rec.title = this.titleOverrides.get(workspaceId) ?? null;
  }
}

/** cwd 比较用的归一化：去掉尾部分隔符；Windows 上大小写不敏感。 */
function normalizeCwd(p: string): string {
  let s = path.normalize(p);
  while (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
