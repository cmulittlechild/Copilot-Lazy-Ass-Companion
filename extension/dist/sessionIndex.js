"use strict";
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
exports.SessionIndexReader = void 0;
exports.deriveVscdbPath = deriveVscdbPath;
exports.sessionTitleFromIndex = sessionTitleFromIndex;
const path = __importStar(require("path"));
/**
 * 顶部 try-require 拿 DatabaseSync 类：
 * 宿主 Node 不支持 node:sqlite（< 22.5）时捕获异常，DatabaseSyncCtor 置为 undefined，
 * 后续 readAll 直接降级返回 []（不 import，避免模块加载期抛错）。
 */
let DatabaseSyncCtor;
try {
    DatabaseSyncCtor = require('node:sqlite').DatabaseSync;
}
catch {
    DatabaseSyncCtor = undefined;
}
/** state.vscdb 中官方会话索引的 key。 */
const INDEX_KEY = 'chat.ChatSessionStore.index';
/**
 * 从 state.vscdb 读取官方会话索引。
 * - vscdbPath 缺省时**不自动推导**，由调用方传路径（如 deriveVscdbPath 的结果）。
 * - log 可选，失败时回调一行说明。
 */
class SessionIndexReader {
    opts;
    /** 最近一次 readAll 的缓存（sessionId → entry）。 */
    cache = new Map();
    /** 是否已执行过至少一次 readAll（用于 getTitle 首次调用时懒加载）。 */
    loaded = false;
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * 读取官方会话索引并刷新缓存，返回全部条目（顺序与 JSON entries 一致）。
     * 任何失败（node:sqlite 不可用/文件不存在/锁/JSON 解析错）都返回 [] 并 log 一条。
     */
    readAll() {
        const entries = this.tryRead();
        this.cache = new Map(entries.map((e) => [e.sessionId, e]));
        this.loaded = true;
        return entries;
    }
    /**
     * 从最近一次 readAll 的缓存中取会话官方标题；首次调用时先 readAll 一次。
     */
    getTitle(sessionId) {
        if (!this.loaded) {
            this.readAll();
        }
        return this.cache.get(sessionId)?.title;
    }
    /** 实际读取逻辑：打开 sqlite → 查询索引 JSON → 解析为条目数组。 */
    tryRead() {
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
        let db;
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
        }
        catch (err) {
            this.log(`读取会话索引失败: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
        finally {
            if (db) {
                try {
                    db.close();
                }
                catch {
                    // 关闭失败可忽略
                }
            }
        }
    }
    log(line) {
        this.opts.log?.(`[sessionIndex] ${line}`);
    }
}
exports.SessionIndexReader = SessionIndexReader;
/**
 * 解析 chat.ChatSessionStore.index 的 JSON value 为条目数组。
 * 结构：{"version":1,"entries":{"<sessionId>":{...}}}；字段逐个防御性取值。
 */
function parseIndexJson(raw, log) {
    let obj;
    try {
        obj = JSON.parse(raw);
    }
    catch (err) {
        log(`会话索引 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
    if (typeof obj !== 'object' || obj === null) {
        return [];
    }
    const entries = obj.entries;
    if (typeof entries !== 'object' || entries === null) {
        return [];
    }
    const out = [];
    for (const [id, rawEntry] of Object.entries(entries)) {
        if (typeof rawEntry !== 'object' || rawEntry === null) {
            continue;
        }
        const e = rawEntry;
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
function deriveVscdbPath(workspaceStorageRoot) {
    return path.join(workspaceStorageRoot, 'state.vscdb');
}
/**
 * 从索引缓存中取会话标题的便捷函数：
 * - index 中有该会话 → 原样返回官方 title（空会话的"新建聊天"等也照常返回）；
 * - 否则返回 fallbackTitle（可为 undefined）。
 */
function sessionTitleFromIndex(index, sessionId, fallbackTitle) {
    const entry = index?.get(sessionId);
    if (entry?.title) {
        return entry.title;
    }
    return fallbackTitle;
}
//# sourceMappingURL=sessionIndex.js.map