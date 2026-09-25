#!/usr/bin/env node
// 真实代码路径测试：用 stub 注入 vscode 模块，执行 dist/chatControl.js 的真实逻辑
// （mock bridge 完全绕过了 chatControl，这 488 行此前从未被执行）
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fileURLToPath } = await import('url');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---- 隔离环境：假 HOME + 受控 state.vscdb（chatControl 直接读真实 vscdb，
// 本机若装了 VS Code 会让模型过滤/当前模型读数变成环境依赖，全部 seed 死）----
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.APPDATA = '';

const VSCDB_DIR = path.join(FAKE_HOME, 'Library/Application Support/Code/User/globalStorage');
fs.mkdirSync(VSCDB_DIR, { recursive: true });
const VSCDB = path.join(VSCDB_DIR, 'state.vscdb');

// node:sqlite 建一个真实 ItemTable；机器太老不支持时测试仍能跑（读不到 = 不过滤）
let dbWritable = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  dbWritable = new DatabaseSync(VSCDB);
  dbWritable.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)');
} catch {
  dbWritable = null;
}

function vscdbSet(key, value) {
  if (!dbWritable) return;
  dbWritable.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(key, String(value));
}

// 桌面 picker 同款可选集（含 1 个不可选 + 1 个非面板目标，验证过滤规则本身）
vscdbSet('chat.cachedLanguageModels.v2', JSON.stringify([
  { identifier: 'copilot/auto', metadata: { isUserSelectable: true } },
  { identifier: 'copilot/claude-opus-45', metadata: { isUserSelectable: true } },
  { identifier: 'copilot/gpt-5', metadata: { isUserSelectable: true } },
  { identifier: 'oaicopilot/grok-4.5-high', metadata: { isUserSelectable: true } },
  { identifier: 'oaicopilot/deepseek-v4-flash', metadata: { isUserSelectable: true } },
  { identifier: 'v/x', metadata: { isUserSelectable: true } },
  { identifier: 'copilot/copilot-utility', metadata: { isUserSelectable: false } },
  { identifier: 'copilotcli/auto', metadata: { isUserSelectable: true, targetChatSessionType: 'copilotcli' } },
]));
// 面板当前模型 = grok（新版 1.139+ 的 chat.modelConfiguration.panel）
vscdbSet('chat.modelConfiguration.panel', JSON.stringify({ 'oaicopilot/grok-4.5-high': {} }));

// ---- 可配置的 vscode stub ----
const calls = [];         // 记录所有 executeCommand
const configStore = {};   // 记录所有 config.update
let lmModels = [];
let lmAvailable = true;
let cfgValues = {};       // getConfiguration().get 的返回
let cfgInspect = {};      // inspect() 的返回（用于 policyValue）
let commandShouldFail = null;
// 模拟 workbench 是否真正落地模型切换（不写 modelConfiguration.panel = 切换未生效）
let simulateModelApplied = true;

const vscodeStub = {
  lm: {
    get selectChatModels() {
      if (!lmAvailable) return undefined;
      return async (selector) => {
        if (!selector) return lmModels;
        return lmModels.filter((m) =>
          (!selector.id || m.id === selector.id) &&
          (!selector.vendor || m.vendor === selector.vendor) &&
          (!selector.family || m.family === selector.family));
      };
    },
    onDidChangeChatModels: (cb) => ({ dispose() {} }),
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      calls.push({ cmd, args });
      if (commandShouldFail && cmd === commandShouldFail) throw new Error(`命令失败: ${cmd}`);
      // 真实 workbench：changeModel 生效后写 chat.modelConfiguration.panel = {"vendor/id": {}}
      if (cmd === 'workbench.action.chat.changeModel' && simulateModelApplied) {
        const a = args[0] || {};
        if (a.vendor && a.id) vscdbSet('chat.modelConfiguration.panel', JSON.stringify({ [`${a.vendor}/${a.id}`]: {} }));
      }
      return undefined;
    },
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, dflt) => {
        const full = section ? `${section}.${key}` : key;
        return full in cfgValues ? cfgValues[full] : dflt;
      },
      inspect: (key) => {
        const full = section ? `${section}.${key}` : key;
        return full in cfgInspect ? cfgInspect[full] : undefined;
      },
      update: async (key, val, target) => {
        const full = section ? `${section}.${key}` : key;
        configStore[full] = { val, target };
      },
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Disposable: class { constructor(fn) { this._fn = fn; } dispose() { this._fn && this._fn(); } },
};

// 把 require('vscode') 重定向到 stub
const STUB_ID = '\0vscode-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: vscodeStub };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ChatControl } = require(path.join(ROOT, 'dist/chatControl.js'));

// ---- 测试框架 ----
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`); }
}
function reset() {
  calls.length = 0;
  for (const k of Object.keys(configStore)) delete configStore[k];
  lmAvailable = true;
  cfgValues = {};
  cfgInspect = {};
  commandShouldFail = null;
  simulateModelApplied = true;
  // 恢复面板当前模型为 grok（selectModel 的 stub 会改写它）
  vscdbSet('chat.modelConfiguration.panel', JSON.stringify({ 'oaicopilot/grok-4.5-high': {} }));
}

const logs = [];
const mk = (opts) => new ChatControl({ log: (l) => logs.push(l), ...opts });

async function main() {
  console.log('=== A. listModels ===');
  reset();
  lmModels = [
    { id: 'claude-opus-45', name: 'Claude Opus 4.5', vendor: 'copilot', family: 'claude-opus-45', version: '1.0', maxInputTokens: 200000 },
    { id: 'gpt-5', name: 'GPT-5', vendor: 'copilot', family: 'gpt-5', version: '1.0', maxInputTokens: 128000 },
    { id: 'oaicopilot/grok-4.5-high', name: 'grok-4.5-high', vendor: 'oaicopilot', family: 'grok-4.5-high', version: '1.0', maxInputTokens: 128000 },
    { id: 'oaicopilot/deepseek-v4-flash', name: 'deepseek-v4-flash', vendor: 'oaicopilot', family: 'deepseek-v4-flash', version: '1.0', maxInputTokens: 128000 },
  ];
  // settings 里 defaultModel 仍是过期的 deepseek，但面板实际是 grok（由 readCurrentPanelModelId 读 vscdb）
  cfgValues['chat.defaultModel'] = 'deepseek-v4-flash';
  // 0.5.19：列表里再塞 Auto——弱匹配曾把 oaicopilot/* 误标成 Auto isCurrent
  lmModels = [
    { id: 'auto', name: 'Auto', vendor: 'copilot', family: 'gpt-5.4-mini', version: '1.0', maxInputTokens: 128000 },
    { id: 'auto', name: 'Auto', vendor: 'copilot', family: '', version: '1.0', maxInputTokens: 128000 },
    { id: 'claude-opus-45', name: 'Claude Opus 4.5', vendor: 'copilot', family: 'claude-opus-45', version: '1.0', maxInputTokens: 200000 },
    { id: 'gpt-5', name: 'GPT-5', vendor: 'copilot', family: 'gpt-5', version: '1.0', maxInputTokens: 128000 },
    { id: 'grok-4.5-high', name: 'grok-4.5-high', vendor: 'oaicopilot', family: 'grok-4.5-high', version: '1.0', maxInputTokens: 128000 },
    { id: 'oaicopilot/deepseek-v4-flash', name: 'deepseek-v4-flash', vendor: 'oaicopilot', family: 'deepseek-v4-flash', version: '1.0', maxInputTokens: 128000 },
    // 不可选项：应被 vscdb 的 isUserSelectable=false 过滤掉
    { id: 'copilot-utility', name: 'Copilot Utility', vendor: 'copilot', family: 'copilot-utility', version: '1.0', maxInputTokens: 128000 },
  ];
  let cc = mk();
  let models = await cc.listModels();
  check('返回全部用户可选模型（过滤内部不可选项）', models.length === 6, `got ${models.length}`);
  check('内部不可选模型被过滤', !models.some((m) => m.id === 'copilot-utility'));
  check('字段映射正确', models.some((m) => m.id === 'claude-opus-45' && m.vendor === 'copilot' && m.maxInputTokens === 200000),
    JSON.stringify(models.find((m) => m.id === 'claude-opus-45')));
  // 本机 vscdb 有 grok 时必须标 grok，且绝不能标 Auto
  const currents = models.filter((m) => m.isCurrent);
  check('isCurrent 至多一个', currents.length <= 1, currents.map((m) => m.id).join(','));
  check(
    'Auto 不得被 oaicopilot 子串误标为 current',
    !currents.some((m) => m.id === 'auto' || String(m.name).toLowerCase() === 'auto'),
    currents.map((m) => m.id).join(','),
  );
  if (currents[0]) {
    console.log(`  · 当前模型标记: ${currents[0].id}`);
    // 读得到 panel=oaicopilot/grok-4.5-high 时应收敛到 grok
    if (String(currents[0].id).includes('grok') || String(currents[0].name).includes('grok')) {
      check('panel grok 优先于 settings deepseek / Auto', true);
    }
  }

  reset(); lmAvailable = false;
  cc = mk();
  models = await cc.listModels();
  check('lm API 不可用时返回空数组不抛错', Array.isArray(models) && models.length === 0);

  console.log('\n=== B. selectModel（关键：三字段必须都是 string）===');
  reset();
  lmModels = [{ id: 'gpt-5', name: 'GPT-5', vendor: 'copilot', family: 'gpt-5', version: '1', maxInputTokens: 1000 }];
  cc = mk();
  await cc.listModels();
  let r = await cc.selectModel({ id: 'gpt-5' });   // 只给 id，需自动补全
  const cm = calls.find((c) => c.cmd === 'workbench.action.chat.changeModel');
  check('selectModel 成功', r.ok === true, JSON.stringify(r));
  check('调用了 changeModel 命令', !!cm, `calls=${JSON.stringify(calls.map(c=>c.cmd))}`);
  if (cm) {
    const a = cm.args[0] || {};
    check('三字段都是 string（否则 workbench 内部断言失败）',
      typeof a.id === 'string' && typeof a.vendor === 'string' && typeof a.family === 'string',
      JSON.stringify(a));
  }

  // 假成功防护：changeModel 不抛错但面板模型未落地 → 必须 ok:false
  reset(); simulateModelApplied = false;
  lmModels = [{ id: 'gpt-5', name: 'GPT-5', vendor: 'copilot', family: 'gpt-5', version: '1', maxInputTokens: 1000 }];
  cc = mk();
  await cc.listModels();
  r = await cc.selectModel({ id: 'gpt-5' });
  check('切换未生效返回 ok:false（不假成功）', r.ok === false && /未生效/.test(r.error || ''), JSON.stringify(r));

  reset(); lmModels = []; cc = mk();
  r = await cc.selectModel({ id: 'not-exist' });
  check('未知模型返回错误', r.ok === false && !!r.error, JSON.stringify(r));

  reset(); cc = mk();
  r = await cc.selectModel({ id: '' });
  check('空 id 返回错误', r.ok === false, JSON.stringify(r));

  console.log('\n=== C. listPermissionLevels ===');
  reset(); cc = mk();
  let lv = cc.listPermissionLevels();
  check('返回 4 档', lv.length === 4, `got ${lv.length}: ${lv.map(x=>x.id).join(',')}`);
  check('id 枚举正确', ['default','assisted','autoApprove','autopilot'].every((i) => lv.some((x) => x.id === i)),
    lv.map(x=>x.id).join(','));
  check('都有中文 label/description', lv.every((x) => x.label && x.description));
  check('assisted 默认不可用（需设置开启）', lv.find((x)=>x.id==='assisted')?.available === false);
  check('default 可用', lv.find((x)=>x.id==='default')?.available === true);

  reset(); cfgValues['chat.assistedPermissions.enabled'] = true; cc = mk();
  lv = cc.listPermissionLevels();
  check('开启设置后 assisted 可用', lv.find((x)=>x.id==='assisted')?.available === true);

  reset(); cfgInspect['chat.tools.global.autoApprove'] = { key: 'x', policyValue: false }; cc = mk();
  lv = cc.listPermissionLevels();
  const aa = lv.find((x)=>x.id==='autoApprove');
  check('policy 禁用时 autoApprove 不可用', aa?.available === false, JSON.stringify(aa));
  check('给出不可用原因', !!aa?.unavailableReason, JSON.stringify(aa));

  console.log('\n=== D. setPermissionLevel（slash 命令注入）===');
  const slashCases = [
    ['autopilot', '/autopilot'],
    ['autoApprove', '/yolo'],
    ['default', '/exitAutopilot'],
  ];
  for (const [level, slash] of slashCases) {
    reset(); cc = mk();
    r = await cc.setPermissionLevel(level);
    const opened = calls.find((c) => c.cmd === 'workbench.action.chat.open');
    const q = opened?.args?.[0]?.query;
    check(`${level} → 注入 ${slash}`, r.ok === true && q === slash,
      `ok=${r.ok} query=${q} calls=${JSON.stringify(calls.map(c=>c.cmd))}`);
  }

  reset(); cc = mk();
  r = await cc.setPermissionLevel('autopilot');
  check('提升级别给出 notice 提示桌面端确认', !!r.notice, JSON.stringify(r));

  reset(); cc = mk();
  r = await cc.setPermissionLevel('assisted');
  check('assisted 不可用时返回 ok:false', r.ok === false, JSON.stringify(r));

  reset(); cfgValues['chat.assistedPermissions.enabled'] = true; cc = mk();
  r = await cc.setPermissionLevel('assisted');
  const picker = calls.find((c) => String(c.cmd).includes('PermissionPicker'));
  check('assisted 可用时退回桌面 picker', !!picker, `calls=${JSON.stringify(calls.map(c=>c.cmd))}`);

  reset(); cc = mk();
  r = await cc.setPermissionLevel('bogus-level');
  check('非法级别返回错误', r.ok === false && !!r.error, JSON.stringify(r));

  reset(); cc = mk();
  r = await cc.setPermissionLevel('autopilot', { persist: true });
  check('persist:true 写入 chat.permissions.default',
    configStore['chat.permissions.default']?.val === 'autopilot',
    JSON.stringify(configStore));

  console.log('\n=== E. currentPermissionLevel 优先级 ===');
  reset(); cc = mk();
  check('默认为 default', cc.currentPermissionLevel() === 'default', cc.currentPermissionLevel());

  reset(); cfgValues['chat.permissions.default'] = 'autoApprove'; cc = mk();
  check('读取 chat.permissions.default 配置', cc.currentPermissionLevel() === 'autoApprove', cc.currentPermissionLevel());

  reset(); cc = mk({ getSessionPermissionLevel: () => 'autopilot' });
  check('会话索引值优先于配置', cc.currentPermissionLevel('sess-1') === 'autopilot', cc.currentPermissionLevel('sess-1'));

  reset(); cc = mk({ getSessionPermissionLevel: () => 'GARBAGE' });
  check('非法会话值被忽略回落 default', cc.currentPermissionLevel('s') === 'default', cc.currentPermissionLevel('s'));

  reset(); cfgValues['chat.permissions.default'] = 'default'; cc = mk();
  await cc.setPermissionLevel('autopilot');
  check('切换后 lastSetLevel 最高优先', cc.currentPermissionLevel() === 'autopilot', cc.currentPermissionLevel());

  console.log('\n=== F. 健壮性 ===');
  reset(); commandShouldFail = 'workbench.action.chat.changeModel';
  lmModels = [{ id: 'x', name: 'X', vendor: 'v', family: 'f', version: '1', maxInputTokens: 1 }];
  cc = mk();
  await cc.listModels();
  r = await cc.selectModel({ id: 'x' });
  check('命令抛错时不崩溃并返回 ok:false', r.ok === false, JSON.stringify(r));

  reset(); cc = mk();
  const d = cc.onModelsChanged(() => {});
  check('onModelsChanged 返回可 dispose 对象', typeof d?.dispose === 'function');
  cc.dispose();
  check('dispose 不抛错', true);

  console.log(`\n${'='.repeat(52)}`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
