"use strict";
/**
 * chatControl.ts — 模型与审批级别控制模块
 *
 * 目标：让手机端能够
 *   1) 列出并切换 Copilot Chat 使用的语言模型（vscode.lm + workbench.action.chat.changeModel）
 *   2) 查看并切换审批级别（default / assisted / autoApprove / autopilot）
 *
 * 设计约束：
 *   - 本模块不 import 项目内其他模块，避免耦合；需要读取会话 permissionLevel 时
 *     由外部通过构造参数注入 `getSessionPermissionLevel` 回调（通常由 SessionIndexReader 提供）。
 *   - 所有 executeCommand / 配置读写都必须 try/catch：命令 id 与配置键在不同 VS Code
 *     版本上并不稳定，缺失时应静默降级而非抛错到 WebSocket 层。
 *   - 严格类型，不使用 any。
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
exports.ChatControl = void 0;
const vscode = __importStar(require("vscode"));
// ---------------------------------------------------------------------------
// 内部常量
// ---------------------------------------------------------------------------
/** 命令 id 集中管理，便于将来按版本调整 */
const CMD = {
    changeModel: 'workbench.action.chat.changeModel',
    chatOpen: 'workbench.action.chat.open',
    openPermissionPicker: 'workbench.action.chat.openPermissionPicker',
    openModelPicker: 'workbench.action.chat.openModelPicker',
};
/** 配置键集中管理 */
const CFG = {
    permissionsDefault: 'chat.permissions.default',
    assistedEnabled: 'chat.assistedPermissions.enabled',
    globalAutoApprove: 'chat.tools.global.autoApprove',
    defaultModel: 'chat.defaultModel',
};
/**
 * workbench 面板当前模型的存储位置（globalStorage state.vscdb）：
 * - 新版（1.139+）：chat.modelConfiguration.panel = {"<vendor>/<id>": {…config}}
 *   首 key 即面板当前选中模型的 identifier。
 * - 旧版：chat.currentLanguageModel.panel 等直接存 identifier 字符串。
 * settings.json 的 chat.defaultModel 常滞后，仅作兜底。
 */
const MODEL_CONFIG_PANEL_KEY = 'chat.modelConfiguration.panel';
const CURRENT_MODEL_KEYS = [
    'chat.currentLanguageModel.panel',
    'chat.currentLanguageModel.panel.agent-host-copilotcli',
    'chat.currentLanguageModel.editor',
];
/**
 * 桌面模型选择器的「用户可选」过滤源：
 * chat.cachedLanguageModels.v2 = [{identifier, metadata:{isUserSelectable, targetChatSessionType,...}}]
 * vscode.lm.selectChatModels() 是全量（含 copilot-utility / dictation / gpt-4o-mini 等
 * 内部不可选模型）；桌面 picker 只展示 isUserSelectable===true 且 targetChatSessionType
 * 为空（普通 chat 面板；copilotcli / agent-host-copilotcli 是别的会话目标）的模型。
 */
const CACHED_MODELS_KEY = 'chat.cachedLanguageModels.v2';
/**
 * 审批级别 → slash 命令。
 * chat.open 注入 slash 命令时 workbench 内部按 `executeImmediately/silent` 处理，
 * 不会在会话里留下可见的用户气泡。
 * 注意：`assisted` 没有对应 slash 命令，只能引导用户在桌面端手动选择。
 */
const SLASH = {
    default: '/exitAutopilot',
    autoApprove: '/yolo',
    autopilot: '/autopilot',
};
/** 中文标签与说明 */
const LEVEL_META = {
    default: { label: '默认审批', description: '每次工具调用都询问' },
    assisted: { label: '辅助审批', description: '由模型辅助判断风险' },
    autoApprove: { label: '绕过审批', description: '自动批准所有工具调用' },
    autopilot: { label: 'Autopilot（预览）', description: '全自动执行，含自动回复' },
};
/** 需要提权确认的级别 */
const ELEVATED = new Set(['autoApprove', 'autopilot']);
const ALL_LEVELS = ['default', 'assisted', 'autoApprove', 'autopilot'];
// ---------------------------------------------------------------------------
// ChatControl
// ---------------------------------------------------------------------------
class ChatControl {
    log;
    getSessionPermissionLevel;
    /** 最近一次 listModels 的结果缓存，用于 selectModel 补全 vendor/family */
    lastModels = [];
    /** 最近一次成功切换的模型 id（best-effort，VS Code 未提供读取当前模型的 API） */
    currentModelId;
    /** 最近一次成功设置的审批级别 */
    lastSetLevel;
    disposables = [];
    disposed = false;
    constructor(opts) {
        this.log = opts?.log ?? (() => undefined);
        this.getSessionPermissionLevel = opts?.getSessionPermissionLevel;
    }
    // -------------------------------------------------------------------------
    // 模型
    // -------------------------------------------------------------------------
    /**
     * 列出所有可用模型。
     * 不传 selector 时返回全部模型，且仅列举不会触发 consent 弹窗。
     * 失败返回空数组并记日志。
     */
    async listModels() {
        const lm = this.lm();
        if (!lm) {
            this.log('[chatControl] vscode.lm 不可用（VS Code 版本过低）');
            return [];
        }
        try {
            // 0.5.18 当前模型权威源（按优先级）：
            // 1) 本模块最近成功 selectModel
            // 2) globalStorage state.vscdb: chat.currentLanguageModel.panel（= 面板实际选中）
            // 3) settings chat.defaultModel（常滞后，仅兜底）
            let configured;
            try {
                const v = vscode.workspace.getConfiguration().get(CFG.defaultModel);
                if (typeof v === 'string' && v.trim())
                    configured = v.trim();
            }
            catch {
                /* ignore */
            }
            const fromPanel = this.readCurrentPanelModelId();
            const preferred = (this.currentModelId || fromPanel || configured || '').trim();
            if (!this.currentModelId && (fromPanel || configured)) {
                this.currentModelId = fromPanel || configured;
            }
            if (fromPanel && fromPanel !== configured) {
                this.log(`[chatControl] 当前面板模型=${fromPanel}` +
                    (configured ? `（settings defaultModel=${configured} 已忽略作 isCurrent）` : ''));
            }
            const allModels = await lm.selectChatModels();
            // 只展示桌面 picker 同款「用户可选」模型：selectChatModels() 是全量，
            // 含 copilot-utility / dictation-cleanup / gpt-4o-mini 等内部不可选项，
            // 选了也切不动（假成功）。缓存不可用时不过滤（宁可多列不可空列）。
            const selectable = this.readUserSelectableModelIds();
            const models = selectable
                ? allModels.filter((m) => selectable.has(`${m.vendor}/${m.id}`) ||
                    selectable.has(`${m.vendor}:${m.id}`) ||
                    selectable.has(m.id))
                : allModels;
            if (selectable && models.length < allModels.length) {
                this.log(`[chatControl] 模型列表过滤: ${allModels.length} → ${models.length}（仅用户可选）`);
            }
            // 先按分数选唯一 winner 下标（同 id 多 vendor 时只标一条，避免双 current）
            let winnerIdx = -1;
            if (preferred) {
                let best = -1;
                for (let i = 0; i < models.length; i++) {
                    const s = modelMatchScore(models[i], preferred);
                    // 严格大于才换人：同分保留先出现的（通常是主 vendor）
                    if (s > best) {
                        best = s;
                        winnerIdx = i;
                    }
                }
                if (best <= 0)
                    winnerIdx = -1;
            }
            this.lastModels = models.map((m, i) => ({
                id: m.id,
                name: m.name,
                vendor: m.vendor,
                family: m.family,
                version: m.version,
                maxInputTokens: m.maxInputTokens,
                isCurrent: winnerIdx >= 0 && i === winnerIdx ? true : undefined,
            }));
            if (winnerIdx >= 0) {
                this.currentModelId = models[winnerIdx].id;
            }
            return this.lastModels;
        }
        catch (err) {
            this.log(`[chatControl] listModels 失败: ${errText(err)}`);
            return [];
        }
    }
    /**
     * 从 globalStorage/state.vscdb 读面板当前模型 identifier（vendor/id 形式）。
     * 失败返回 undefined（不抛）。
     */
    readCurrentPanelModelId() {
        try {
            // 新版（1.139+）：chat.modelConfiguration.panel = {"<identifier>": {…}}，首 key 即当前模型
            const cfg = this.readVscdbValue(MODEL_CONFIG_PANEL_KEY);
            if (cfg) {
                try {
                    const obj = JSON.parse(cfg);
                    const first = Object.keys(obj)[0];
                    if (first)
                        return first;
                }
                catch {
                    /* 非 JSON，继续旧版 key */
                }
            }
            // 旧版：直接存 identifier 字符串的 key
            for (const key of CURRENT_MODEL_KEYS) {
                const val = this.readVscdbValue(key);
                if (val && val !== 'true' && val !== 'false')
                    return val;
            }
        }
        catch (err) {
            this.log(`[chatControl] 读面板当前模型失败: ${errText(err)}`);
        }
        return undefined;
    }
    /** state.vscdb 候选路径（macOS/Linux/Windows/Insiders） */
    vscdbCandidates() {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (!home)
            return [];
        return [
            // macOS
            pathJoin(home, 'Library/Application Support/Code/User/globalStorage/state.vscdb'),
            pathJoin(home, 'Library/Application Support/Code - Insiders/User/globalStorage/state.vscdb'),
            // Linux
            pathJoin(home, '.config/Code/User/globalStorage/state.vscdb'),
            // Windows
            process.env.APPDATA
                ? pathJoin(process.env.APPDATA, 'Code/User/globalStorage/state.vscdb')
                : '',
        ].filter(Boolean);
    }
    /** 打开第一个可用的 state.vscdb（只读），返回 db 与 user 根目录；失败返回 undefined。 */
    openVscdb() {
        let DatabaseSync;
        try {
            DatabaseSync = require('node:sqlite').DatabaseSync;
        }
        catch {
            DatabaseSync = undefined;
        }
        if (!DatabaseSync)
            return undefined;
        const fs = require('fs');
        for (const dbPath of this.vscdbCandidates()) {
            try {
                if (!fs.existsSync(dbPath))
                    continue;
                const db = new DatabaseSync(dbPath, { readOnly: true });
                // globalStorage/state.vscdb → User 根 = 上两级目录
                const userDir = dbPath.split(/[\\/]/).slice(0, -2).join(process.platform === 'win32' ? '\\' : '/');
                return { db, userDir };
            }
            catch {
                /* 下一候选 */
            }
        }
        return undefined;
    }
    /** 读单个 vscdb key；失败/缺失返回 undefined。 */
    readVscdbValue(key) {
        const ctx = this.openVscdb();
        if (!ctx)
            return undefined;
        try {
            const row = ctx.db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
            const v = row && typeof row.value === 'string' ? row.value.trim() : '';
            return v || undefined;
        }
        catch {
            return undefined;
        }
        finally {
            try {
                ctx.db.close();
            }
            catch {
                /* ignore */
            }
        }
    }
    /**
     * 用户可选模型 identifier 集合（desktop picker 同款过滤）：
     * chat.cachedLanguageModels.v2 中 isUserSelectable===true 且无 targetChatSessionType 的项。
     * 返回 undefined = 缓存不可用（调用方应放弃过滤而非列出空表）。
     */
    readUserSelectableModelIds() {
        const raw = this.readVscdbValue(CACHED_MODELS_KEY);
        if (!raw)
            return undefined;
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr))
                return undefined;
            const set = new Set();
            for (const item of arr) {
                const it = item;
                if (typeof it?.identifier === 'string' &&
                    it.metadata?.isUserSelectable === true &&
                    !it.metadata?.targetChatSessionType) {
                    set.add(it.identifier);
                }
            }
            return set;
        }
        catch (err) {
            this.log(`[chatControl] 解析 ${CACHED_MODELS_KEY} 失败: ${errText(err)}`);
            return undefined;
        }
    }
    /**
     * 最近写入的 chatSessions 文件里最后一条 inputState.selectedModel 的 identifier。
     * 模型切换会作为 delta 行落盘到当前会话文件，是「切换是否真的生效」的直接证据。
     * sinceMs：只接受 mtime ≥ sinceMs-2000 的文件（只看切换之后的新写入���。
     */
    readNewestSessionSelectedModelId(sinceMs = 0) {
        try {
            const fs = require('fs');
            const path = require('path');
            const ctx = this.openVscdb();
            if (!ctx)
                return undefined;
            try {
                ctx.db.close();
            }
            catch {
                /* ignore */
            }
            const wsRoot = path.join(ctx.userDir, 'workspaceStorage');
            if (!fs.existsSync(wsRoot))
                return undefined;
            let newest;
            for (const dir of fs.readdirSync(wsRoot)) {
                const csDir = path.join(wsRoot, dir, 'chatSessions');
                try {
                    for (const f of fs.readdirSync(csDir)) {
                        if (!f.endsWith('.jsonl'))
                            continue;
                        const fp = path.join(csDir, f);
                        const st = fs.statSync(fp);
                        if (sinceMs && st.mtimeMs < sinceMs - 2000)
                            continue;
                        if (!newest || st.mtimeMs > newest.mtime)
                            newest = { file: fp, mtime: st.mtimeMs };
                    }
                }
                catch {
                    /* 该目录无 chatSessions */
                }
            }
            if (!newest)
                return undefined;
            // 尾读 64KB，找最后一条 inputState.selectedModel delta
            const fd = fs.openSync(newest.file, 'r');
            try {
                const st = fs.fstatSync(fd);
                const cap = Math.min(st.size, 64 * 1024);
                const buf = Buffer.alloc(cap);
                fs.readSync(fd, buf, 0, cap, st.size - cap);
                const tail = buf.toString('utf8');
                const re = /"inputState"\s*,\s*"selectedModel"\s*\][^\n]*?"identifier"\s*:\s*"([^"]+)"/g;
                let m;
                let last;
                while ((m = re.exec(tail)))
                    last = m[1];
                return last;
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch {
            return undefined;
        }
    }
    /**
     * 等「模型切换已生效」的落盘证据（最长 timeoutMs）：
     *   a) state.vscdb chat.modelConfiguration.panel 首 key 变为目标 identifier
     *   b) 最近 chatSessions 文件最后一条 inputState.selectedModel = 目标 identifier
     */
    async waitSwitchEvidence(identifier, sinceMs, timeoutMs = 6000) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            const cfg = this.readVscdbValue(MODEL_CONFIG_PANEL_KEY);
            if (cfg) {
                try {
                    const first = Object.keys(JSON.parse(cfg))[0];
                    if (first && identifierEq(first, identifier))
                        return true;
                }
                catch {
                    /* ignore */
                }
            }
            const fileId = this.readNewestSessionSelectedModelId(sinceMs);
            if (fileId && identifierEq(fileId, identifier))
                return true;
            await new Promise((r) => setTimeout(r, 250));
        }
        return false;
    }
    /**
     * 切换模型。
     * changeModel 命令要求 id / vendor / family 三个字段都是 string，否则内部断言失败，
     * 因此只给 id 时会先从缓存（必要时重新拉取）补全。
     */
    async selectModel(sel) {
        const id = (sel.id ?? '').trim();
        if (!id)
            return { ok: false, error: '缺少模型 id' };
        let vendor = sel.vendor;
        let family = sel.family;
        // 补全 vendor / family
        if (!vendor || !family) {
            let hit = this.lastModels.find((m) => m.id === id);
            if (!hit) {
                // 缓存未命中，重新拉一次
                const fresh = await this.listModels();
                hit = fresh.find((m) => m.id === id);
            }
            if (hit) {
                vendor = vendor || hit.vendor;
                family = family || hit.family;
            }
        }
        if (typeof vendor !== 'string' || !vendor || typeof family !== 'string' || !family) {
            return { ok: false, error: '模型信息不完整（需要 vendor/family）' };
        }
        // changeModel 作用于「最近聚焦的 chat widget」——先确保面板聊天输入框有焦点，
        // 否则命令静默打在没有 widget 的上下文中，手机端收到假成功。
        try {
            await vscode.commands.executeCommand(CMD.chatOpen);
        }
        catch {
            /* ignore */
        }
        try {
            await vscode.commands.executeCommand('workbench.action.chat.focusInput');
        }
        catch {
            /* ignore */
        }
        const switchStart = Date.now();
        try {
            await vscode.commands.executeCommand(CMD.changeModel, { id, vendor, family });
        }
        catch (err) {
            const msg = errText(err);
            this.log(`[chatControl] changeModel 失败: ${msg}`);
            return { ok: false, error: `切换模型失败: ${msg}` };
        }
        // 校验切换是否真的生效：等 modelConfiguration.panel / 会话 inputState.selectedModel
        // 落盘为目标模型。命令不抛错 ≠ 生效（免费账号选付费模型、内部模型都不报错但不切换）。
        const identifier = `${vendor}/${id}`;
        const applied = await this.waitSwitchEvidence(identifier, switchStart);
        if (!applied) {
            this.log(`[chatControl] 切换模型未生效: ${id}（面板模型未变化）`);
            return {
                ok: false,
                error: `切换未生效：桌面面板模型未变为 ${id}（该模型当前可能不可选或需升级）`,
            };
        }
        this.currentModelId = id;
        // 同步缓存里的 isCurrent 标记
        this.lastModels = this.lastModels.map((m) => ({ ...m, isCurrent: m.id === id }));
        this.log(`[chatControl] 已切换模型: ${id} (${vendor}/${family})`);
        // 可选持久化：仅在该配置键真实存在时写入，失败不影响主流程
        try {
            const cfg = vscode.workspace.getConfiguration();
            if (cfg.inspect(CFG.defaultModel)) {
                await cfg.update(CFG.defaultModel, id, vscode.ConfigurationTarget.Global);
            }
        }
        catch (err) {
            this.log(`[chatControl] 持久化 ${CFG.defaultModel} 失败（忽略）: ${errText(err)}`);
        }
        return { ok: true };
    }
    /** 订阅模型变更（包装 onDidChangeChatModels；事件无 payload，回调里需重查） */
    onModelsChanged(cb) {
        const lm = this.lm();
        const event = lm?.onDidChangeChatModels;
        if (typeof event !== 'function') {
            this.log('[chatControl] onDidChangeChatModels 不可用，返回 no-op Disposable');
            return new vscode.Disposable(() => undefined);
        }
        try {
            const d = event(() => {
                try {
                    cb();
                }
                catch (err) {
                    this.log(`[chatControl] onModelsChanged 回调抛错: ${errText(err)}`);
                }
            });
            this.disposables.push(d);
            return d;
        }
        catch (err) {
            this.log(`[chatControl] 订阅 onDidChangeChatModels 失败: ${errText(err)}`);
            return new vscode.Disposable(() => undefined);
        }
    }
    /** 降级交互：让桌面端弹出模型选择器（手机点一下、桌面端选） */
    async openModelPicker() {
        return this.tryCommand(CMD.openModelPicker);
    }
    // -------------------------------------------------------------------------
    // 审批级别
    // -------------------------------------------------------------------------
    /** 列出 4 档审批级别，并给出当前环境的可用性判定 */
    listPermissionLevels() {
        const assistedEnabled = this.readBool(CFG.assistedEnabled) === true;
        const policyBlocked = this.autoApprovePolicyBlocked();
        return ALL_LEVELS.map((id) => {
            const meta = LEVEL_META[id];
            let available = true;
            let unavailableReason;
            if (id === 'assisted' && !assistedEnabled) {
                available = false;
                unavailableReason = `需先开启设置 ${CFG.assistedEnabled}`;
            }
            else if (policyBlocked && ELEVATED.has(id)) {
                available = false;
                unavailableReason = '已被组织策略禁用';
            }
            const info = {
                id,
                label: meta.label,
                description: meta.description,
                available,
            };
            if (unavailableReason)
                info.unavailableReason = unavailableReason;
            return info;
        });
    }
    /**
     * 当前审批级别（best-effort）。
     * 优先级：本模块记录 > 会话索引（state.vscdb） > chat.permissions.default 配置 > 'default'
     */
    currentPermissionLevel(sessionId) {
        if (this.lastSetLevel)
            return this.lastSetLevel;
        if (sessionId && this.getSessionPermissionLevel) {
            try {
                const raw = this.getSessionPermissionLevel(sessionId);
                const lv = toPermissionLevel(raw);
                if (lv)
                    return lv;
            }
            catch (err) {
                this.log(`[chatControl] 读取会话 permissionLevel 失败: ${errText(err)}`);
            }
        }
        const fromCfg = toPermissionLevel(this.readString(CFG.permissionsDefault));
        if (fromCfg)
            return fromCfg;
        return 'default';
    }
    /**
     * 设置审批级别。
     * - assisted：无 slash 命令 → 打开桌面端权限选择器并返回失败 + notice
     * - 其余三档：注入对应 slash 命令（静默执行）
     * - opts.persist：额外写 chat.permissions.default（Global），影响后续新会话
     */
    async setPermissionLevel(level, opts) {
        const info = this.listPermissionLevels().find((x) => x.id === level);
        if (!info) {
            return { ok: false, error: `未知的审批级别: ${String(level)}` };
        }
        if (!info.available) {
            return { ok: false, error: `「${info.label}」不可用：${info.unavailableReason ?? '当前环境不支持'}` };
        }
        // assisted 没有 slash 命令，只能引导桌面端手动选择
        if (level === 'assisted') {
            const picker = await this.tryCommand(CMD.openPermissionPicker);
            return {
                ok: false,
                error: '辅助审批需在桌面端手动选择',
                notice: picker.ok ? '已为你打开权限选择器' : '请在桌面端手动打开权限选择器',
            };
        }
        const slash = SLASH[level];
        if (!slash) {
            return { ok: false, error: `「${info.label}」没有对应的切换命令` };
        }
        try {
            await vscode.commands.executeCommand(CMD.chatOpen, { query: slash, isPartialQuery: false });
        }
        catch (err) {
            const msg = errText(err);
            this.log(`[chatControl] 注入 ${slash} 失败: ${msg}`);
            return { ok: false, error: `切换审批级别失败: ${msg}` };
        }
        this.lastSetLevel = level;
        this.log(`[chatControl] 已切换审批级别: ${level} (via ${slash})`);
        const notices = [];
        if (ELEVATED.has(level)) {
            notices.push('首次切换可能需要在桌面端确认对话框');
        }
        if (opts?.persist) {
            try {
                // 配置枚举只有 default / autoApprove / autopilot，assisted 不在其中
                await vscode.workspace
                    .getConfiguration()
                    .update(CFG.permissionsDefault, level, vscode.ConfigurationTarget.Global);
                notices.push('已写入默认审批级别（对后续新会话生效）');
            }
            catch (err) {
                this.log(`[chatControl] 持久化 ${CFG.permissionsDefault} 失败（忽略）: ${errText(err)}`);
                notices.push('默认审批级别写入失败，仅本次会话生效');
            }
        }
        const result = { ok: true };
        if (notices.length)
            result.notice = notices.join('；');
        return result;
    }
    /** 降级交互：让桌面端弹出权限选择器 */
    async openPermissionPicker() {
        return this.tryCommand(CMD.openPermissionPicker);
    }
    // -------------------------------------------------------------------------
    // 生命周期
    // -------------------------------------------------------------------------
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const d of this.disposables.splice(0)) {
            try {
                d.dispose();
            }
            catch {
                // 忽略单个 disposable 的异常
            }
        }
        this.lastModels = [];
    }
    // -------------------------------------------------------------------------
    // 内部工具
    // -------------------------------------------------------------------------
    /** 安全获取 vscode.lm（旧版本可能整个命名空间缺失） */
    lm() {
        const host = vscode;
        const lm = host.lm;
        if (!lm || typeof lm.selectChatModels !== 'function')
            return undefined;
        return lm;
    }
    /** 执行命令并把异常转成结果对象 */
    async tryCommand(cmd) {
        try {
            await vscode.commands.executeCommand(cmd);
            return { ok: true };
        }
        catch (err) {
            const msg = errText(err);
            this.log(`[chatControl] 执行 ${cmd} 失败: ${msg}`);
            return { ok: false, error: msg };
        }
    }
    /** 读 boolean 配置，异常返回 undefined */
    readBool(section) {
        try {
            return vscode.workspace.getConfiguration().get(section);
        }
        catch (err) {
            this.log(`[chatControl] 读取配置 ${section} 失败: ${errText(err)}`);
            return undefined;
        }
    }
    /** 读 string 配置，异常返回 undefined */
    readString(section) {
        try {
            return vscode.workspace.getConfiguration().get(section);
        }
        catch (err) {
            this.log(`[chatControl] 读取配置 ${section} 失败: ${errText(err)}`);
            return undefined;
        }
    }
    /**
     * 企业 policy 是否禁用了自动批准。
     * `chat.tools.global.autoApprove` 的 policyValue === false 时，任何提权都会被静默降回 default，
     * 所以此时把 autoApprove / autopilot 标为不可用，避免手机端“切了但没生效”。
     */
    autoApprovePolicyBlocked() {
        try {
            const raw = vscode.workspace.getConfiguration().inspect(CFG.globalAutoApprove);
            const info = raw;
            return info?.policyValue === false;
        }
        catch (err) {
            this.log(`[chatControl] inspect ${CFG.globalAutoApprove} 失败: ${errText(err)}`);
            return false;
        }
    }
}
exports.ChatControl = ChatControl;
// ---------------------------------------------------------------------------
// 模块级辅助函数
// ---------------------------------------------------------------------------
/** path.join 的轻量替代（避免 chatControl 顶部硬依赖 path，保持纯 vscode 模块） */
function pathJoin(...parts) {
    const sep = process.platform === 'win32' ? '\\' : '/';
    return parts
        .filter((p) => typeof p === 'string' && p.length > 0)
        .join(sep)
        .replace(/[\\/]+/g, sep);
}
/**
 * preferred（可能是 oaicopilot/grok-4.5-high）与 LanguageModelChat 条目是否匹配。
 *
 * 0.5.19 关键：禁止用 `p.includes(nameSlug)` 这类弱包含——
 * `oaicopilot/...` 包含子串 `auto`，会把 Auto 模型误标为 isCurrent（远程显示 Auto）。
 */
function modelMatchesPreferred(m, preferred) {
    const p = preferred.trim();
    if (!p)
        return false;
    // agent-host-copilotcli:oaicopilot/grok-4.5-high → 剥宿主前缀再比
    let raw = p;
    if (raw.includes(':') && !raw.startsWith('http')) {
        raw = raw.slice(raw.lastIndexOf(':') + 1);
    }
    const pLow = raw.toLowerCase();
    const short = pLow.includes('/') ? pLow.slice(pLow.lastIndexOf('/') + 1) : pLow;
    const idLow = (m.id || '').toLowerCase();
    const famLow = (m.family || '').toLowerCase();
    const nameLow = (m.name || '').toLowerCase();
    const nameSlug = nameLow.replace(/\s+/g, '-');
    // 1) 精确
    if (idLow === pLow || famLow === pLow || nameLow === pLow || nameSlug === pLow)
        return true;
    if (short && (idLow === short || famLow === short || nameSlug === short || nameLow === short)) {
        return true;
    }
    // 2) 后缀 / 段相等：oaicopilot/grok-4.5-high vs id grok-4.5-high
    if (short.length >= 4) {
        if (idLow === short || idLow.endsWith('/' + short) || idLow.endsWith(':' + short))
            return true;
        if (famLow === short)
            return true;
        if (nameSlug === short || nameSlug.endsWith('-' + short))
            return true;
    }
    // 3) preferred 以 model id 结尾（id 足够长，避免 "auto"/"gpt" 误伤）
    if (idLow.length >= 4 && (pLow === idLow || pLow.endsWith('/' + idLow) || pLow.endsWith(':' + idLow))) {
        return true;
    }
    if (famLow.length >= 4 && (pLow === famLow || pLow.endsWith('/' + famLow)))
        return true;
    // 明确拒绝：短通用名（auto 等）只有精确相等才算，上面已处理
    return false;
}
/** 给候选打分，分越高越像「当前模型」（用于多命中消歧） */
function modelMatchScore(m, preferred) {
    if (!modelMatchesPreferred(m, preferred))
        return 0;
    let raw = preferred.trim();
    if (raw.includes(':') && !raw.startsWith('http'))
        raw = raw.slice(raw.lastIndexOf(':') + 1);
    const pLow = raw.toLowerCase();
    const short = pLow.includes('/') ? pLow.slice(pLow.lastIndexOf('/') + 1) : pLow;
    const idLow = (m.id || '').toLowerCase();
    const famLow = (m.family || '').toLowerCase();
    let score = 10;
    if (idLow === pLow)
        score += 100;
    if (idLow === short)
        score += 80;
    if (idLow.endsWith('/' + short))
        score += 70;
    if (famLow === short)
        score += 50;
    if ((m.name || '').toLowerCase().replace(/\s+/g, '-') === short)
        score += 40;
    // 惩罚泛化 Auto
    if (idLow === 'auto' || (m.name || '').toLowerCase() === 'auto')
        score -= 100;
    return score;
}
/**
 * 模型 identifier 等价比较：归一化 `host:vendor/id` → `vendor/id` 后小写对比。
 * identifier 形式不统一（copilot/auto 用 /，agent-host-copilotcli:auto 用 :）。
 */
function identifierEq(a, b) {
    const norm = (s) => {
        let x = s.trim().toLowerCase();
        if (x.includes(':') && !x.startsWith('http'))
            x = x.slice(x.lastIndexOf(':') + 1);
        return x;
    };
    const na = norm(a);
    const nb = norm(b);
    return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}
/** 校验并收窄为合法的 PermissionLevel */
function toPermissionLevel(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const v = raw.trim();
    return ALL_LEVELS.includes(v) ? v : undefined;
}
/** 统一的错误文本提取 */
function errText(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === 'string')
        return err;
    try {
        return JSON.stringify(err);
    }
    catch {
        return String(err);
    }
}
//# sourceMappingURL=chatControl.js.map