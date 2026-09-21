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
            const models = await lm.selectChatModels();
            this.lastModels = models.map((m) => ({
                id: m.id,
                name: m.name,
                vendor: m.vendor,
                family: m.family,
                version: m.version,
                maxInputTokens: m.maxInputTokens,
                isCurrent: this.currentModelId ? m.id === this.currentModelId : undefined,
            }));
            return this.lastModels;
        }
        catch (err) {
            this.log(`[chatControl] listModels 失败: ${errText(err)}`);
            return [];
        }
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
        try {
            await vscode.commands.executeCommand(CMD.changeModel, { id, vendor, family });
        }
        catch (err) {
            const msg = errText(err);
            this.log(`[chatControl] changeModel 失败: ${msg}`);
            return { ok: false, error: `切换模型失败: ${msg}` };
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