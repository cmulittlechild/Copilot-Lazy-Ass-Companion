#!/usr/bin/env node
// inject.ts 测试：消息注入、echo 追踪、会话文件校验、clipboard 回退、confirmation/cancel
// 使用 Module._resolveFilename 拦截 vscode 模块（同 test_chatcontrol.mjs 模式）
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const Module = require('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 可配置的 vscode stub ----
const calls = [];
let cfgValues = {};
let commandResults = {}; // cmd → () => result | throw
let activeChatPanelSessionResource;
let tabGroupsTabs = [];
let clipboardText = '';
let warningMessages = [];

function makeUri(scheme, authority, path) {
  return {
    scheme,
    authority,
    path,
    query: '',
    fragment: '',
    fsPath: path,
    toString() { return `${scheme}://${authority}${path}`; },
    with(changes) { return makeUri(changes.scheme ?? scheme, changes.authority ?? authority, changes.path ?? path); },
  };
}

const vscodeStub = {
  Uri: {
    from(parts) { return makeUri(parts.scheme, parts.authority, parts.path); },
    parse(str) {
      const m = str.match(/^([^:]+):\/\/([^/]*)(.*)$/);
      if (m) return makeUri(m[1], m[2], m[3]);
      return makeUri('', '', str);
    },
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      calls.push({ cmd, args });
      if (commandResults[cmd]) {
        return commandResults[cmd](...args);
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
    }),
    name: 'test-workspace',
  },
  window: {
    get activeChatPanelSessionResource() { return activeChatPanelSessionResource; },
    tabGroups: {
      get all() { return tabGroupsTabs; },
    },
    showWarningMessage: async (msg) => { warningMessages.push(msg); return undefined; },
  },
  env: {
    clipboard: {
      writeText: async (text) => { clipboardText = text; },
      readText: async () => clipboardText,
    },
  },
};

// 把 require('vscode') 重定向到 stub
const STUB_ID = '\0vscode-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: vscodeStub };

const inject = require(path.join(ROOT, 'dist/inject.js'));

// ---- 测试框架 ----
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u2717 ${name}${detail ? ` \u2192 ${detail}` : ''}`); }
}
function reset() {
  calls.length = 0;
  cfgValues = {};
  commandResults = {};
  activeChatPanelSessionResource = undefined;
  tabGroupsTabs = [];
  clipboardText = '';
  warningMessages = [];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {

  // ================================================================
  console.log('=== A. echo 追踪 (noteInjectedText / isInjectedEcho) ===');
  reset();

  inject.noteInjectedText('hello world');
  check('刚注入的文本被识别为 echo', inject.isInjectedEcho('hello world') === true);
  check('未注入的文本不被识别', inject.isInjectedEcho('something else') === false);
  check('trim 后比较（前后空格）', inject.isInjectedEcho('  hello world  ') === true);

  reset();
  inject.noteInjectedText('  ');
  check('空白文本被忽略（不记录）', inject.isInjectedEcho('  ') === false);
  inject.noteInjectedText('');
  check('空字符串被忽略', inject.isInjectedEcho('') === false);
  inject.noteInjectedText(null);
  check('null 被忽略', inject.isInjectedEcho(null) === false);

  // FIFO 上限 20
  reset();
  for (let i = 0; i < 25; i++) inject.noteInjectedText(`msg-${i}`);
  check('FIFO 保留最近 20 条（msg-24 在）', inject.isInjectedEcho('msg-24') === true);
  check('FIFO 淘汰最早的（msg-0 不在）', inject.isInjectedEcho('msg-0') === false);
  check('FIFO 中间项仍在（msg-10 在）', inject.isInjectedEcho('msg-10') === true);

  // ================================================================
  console.log('\n=== B. 会话文件状态 (setActiveSessionFile / getActiveSessionFile) ===');
  reset();

  inject.setActiveSessionFile('/path/to/chatSessions/abc-123.jsonl');
  check('set 后 get 返回正确路径', inject.getActiveSessionFile() === '/path/to/chatSessions/abc-123.jsonl');

  inject.setActiveSessionFile('  ');
  check('空白字符串被归一化为 undefined', inject.getActiveSessionFile() === undefined);

  inject.setActiveSessionFile('');
  check('空字符串被归一化为 undefined', inject.getActiveSessionFile() === undefined);

  inject.setActiveSessionFile('/some/path.jsonl');
  inject.setActiveSessionFile(undefined);
  check('设为 undefined 后清除', inject.getActiveSessionFile() === undefined);

  // ================================================================
  console.log('\n=== C. sessionIdFromFile ===');
  reset();

  check('从 .jsonl 路径提取 sessionId',
    inject.sessionIdFromFile('/data/chatSessions/abc-123.jsonl') === 'abc-123');
  check('仅文件名也正常',
    inject.sessionIdFromFile('xyz.jsonl') === 'xyz');
  check('无 .jsonl 后缀时返回文件名本身',
    inject.sessionIdFromFile('myfile.txt') === 'myfile.txt');
  check('大小写 .JSONL 也能处理',
    inject.sessionIdFromFile('SESSION.JSONL') === 'SESSION');

  // ================================================================
  console.log('\n=== D. localChatSessionUri ===');
  reset();

  const uri = inject.localChatSessionUri('test-session-1');
  check('scheme 正确', uri.scheme === 'vscode-chat-session');
  check('authority 正确', uri.authority === 'local');
  check('path 以 / 开头', typeof uri.path === 'string' && uri.path.startsWith('/'));
  // base64url 编码验证
  const expectedEncoded = Buffer.from('test-session-1', 'utf8').toString('base64url');
  check('base64url 编码正确', uri.path === '/' + expectedEncoded);
  check('toString 返回完整 URI',
    uri.toString() === `vscode-chat-session://local/${expectedEncoded}`);

  // 验证同一 sessionId 产生确定性 URI
  const uri2 = inject.localChatSessionUri('test-session-1');
  check('相同 sessionId 产生相同 toString', uri.toString() === uri2.toString());

  // ================================================================
  console.log('\n=== E. waitForInjectInSessionFile ===');
  reset();

  // 注：该函数用 baseline diff 检测「新增」文本，而非检测已有文本。
  // 即：启动时快照当前内容，之后只检测快照之后追加的文本。

  // E1. 文件不存在时启动，后续创建并写入文本 → true（baseline="" → delta=全文）
  const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-e1-'));
  const file1 = path.join(tmpDir1, 'session1.jsonl');
  setTimeout(() => {
    fs.writeFileSync(file1, '{"text":"hello inject test"}\n');
  }, 150);
  const e1 = await inject.waitForInjectInSessionFile(file1, 'hello inject test', 3000, 50);
  check('文件后创建并写入文本 → true', e1 === true);

  // E2. 文件不存在且永不创建 → 超时后返回 false
  const e2 = await inject.waitForInjectInSessionFile(path.join(tmpDir1, 'nonexistent.jsonl'), 'text', 500, 50);
  check('文件不存在 → 超时 false', e2 === false);

  // E3. 文件初始有内容，后续追加目标文本 → true（delta 检测）
  const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-e3-'));
  const file3 = path.join(tmpDir3, 'session3.jsonl');
  fs.writeFileSync(file3, '{"initial":"data"}\n');
  setTimeout(() => {
    fs.appendFileSync(file3, '{"text":"appended later"}\n');
  }, 200);
  const e3 = await inject.waitForInjectInSessionFile(file3, 'appended later', 3000, 50);
  check('后续追加文本 → true', e3 === true);

  // E4. 空参数 → false
  check('file 为空 → false', await inject.waitForInjectInSessionFile('', 'text', 100) === false);
  check('text 为空 → false', await inject.waitForInjectInSessionFile(file1, '', 100) === false);
  check('空白 text → false', await inject.waitForInjectInSessionFile(file1, '   ', 100) === false);

  // E5. transcript 候选路径：chatSessions 目录下同时检查 transcripts/
  // chatSessions 文件不含 needle；transcript 文件在 baseline 后写入 needle
  const tmpDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-e5-'));
  const csDir5 = path.join(tmpDir5, 'workspaceStorage', 'HASH123', 'chatSessions');
  const transcriptDir5 = path.join(tmpDir5, 'workspaceStorage', 'HASH123', 'GitHub.copilot-chat', 'transcripts');
  fs.mkdirSync(csDir5, { recursive: true });
  fs.mkdirSync(transcriptDir5, { recursive: true });
  const chatSessionFile = path.join(csDir5, 'sess5.jsonl');
  fs.writeFileSync(chatSessionFile, '{}\n'); // chatSessions 文件无 needle
  const transcriptFile = path.join(transcriptDir5, 'sess5.jsonl');
  fs.writeFileSync(transcriptFile, '{}\n'); // transcript 初始也无 needle
  setTimeout(() => {
    fs.appendFileSync(transcriptFile, '{"text":"found in transcript"}\n');
  }, 150);
  const e5 = await inject.waitForInjectInSessionFile(chatSessionFile, 'found in transcript', 3000, 50);
  check('transcript 候选路径被发现', e5 === true);

  // 清理
  for (const d of [tmpDir1, tmpDir3, tmpDir5]) { fs.rmSync(d, { recursive: true, force: true }); }

  // ================================================================
  console.log('\n=== F. detectCrossSessionLeak ===');
  reset();

  // F1. 无其它文件 → undefined
  const tmpF1 = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-f1-'));
  const csDir1 = path.join(tmpF1, 'workspaceStorage', 'HASH1', 'chatSessions');
  fs.mkdirSync(csDir1, { recursive: true });
  const targetFile1 = path.join(csDir1, 'target.jsonl');
  fs.writeFileSync(targetFile1, '{"text":"my message"}\n');
  const leak1 = await inject.detectCrossSessionLeak(targetFile1, 'my message', 20000);
  check('无其它文件 → undefined', leak1 === undefined);

  // F2. 其它文件包含文本 → 返回该文件路径
  const otherFile2 = path.join(csDir1, 'other.jsonl');
  fs.writeFileSync(otherFile2, '{"text":"leaked secret"}\n');
  const leak2 = await inject.detectCrossSessionLeak(targetFile1, 'leaked secret', 20000);
  check('发现泄漏文件 → 返回路径', leak2 === otherFile2);

  // F3. 目标文件自身包含文本但不泄漏（应跳过目标文件）
  const leak3 = await inject.detectCrossSessionLeak(targetFile1, 'my message', 20000);
  check('跳过目标文件自身 → undefined', leak3 === undefined);

  // F4. 过期文件不检查（mtime > lookbackMs）
  const oldFile4 = path.join(csDir1, 'old.jsonl');
  fs.writeFileSync(oldFile4, '{"text":"old leaked"}\n');
  const oldTime = (Date.now() - 30000) / 1000; // 30s ago
  fs.utimesSync(oldFile4, oldTime, oldTime);
  const leak4 = await inject.detectCrossSessionLeak(targetFile1, 'old leaked', 20000); // lookback 20s
  check('过期文件被跳过 → undefined', leak4 === undefined);

  // F5. 空参数 → undefined
  check('空 targetFile → undefined', await inject.detectCrossSessionLeak('', 'text', 20000) === undefined);
  check('空 text → undefined', await inject.detectCrossSessionLeak(targetFile1, '', 20000) === undefined);

  // 清理
  fs.rmSync(tmpF1, { recursive: true, force: true });

  // ================================================================
  console.log('\n=== G. injectMessage ===');

  // G1. 无 sid（无 activeSessionFile）→ focused-only → chat.open 成功
  reset();
  inject.setActiveSessionFile(undefined);
  commandResults['workbench.action.chat.open'] = () => undefined; // 成功
  const r1 = await inject.injectMessage('hello from test', 'agent');
  check('无 sid + chat.open 成功 → ok:true', r1.ok === true);
  check('via 为 chat.open', r1.via === 'chat.open');
  check('injectPath 为 focused-only', r1.injectPath === 'focused-only');
  check('sessionActivated 为 false', r1.sessionActivated === false);
  check('调用了 chat.open 命令', calls.some((c) => c.cmd === 'workbench.action.chat.open'));

  // G2. 无 sid → chat.open 失败 → clipboard fallback
  reset();
  inject.setActiveSessionFile(undefined);
  commandResults['workbench.action.chat.open'] = () => { throw new Error('no chat'); };
  const r2 = await inject.injectMessage('fallback test', 'agent');
  check('无 sid + chat.open 失败 → clipboard fallback', r2.via === 'clipboard');
  check('clipboard 写入了消息', clipboardText === 'fallback test');
  check('injectPath 包含 no-path', r2.injectPath === 'clipboard:no-path');
  check('显示了警告消息', warningMessages.length > 0);

  // G3. 有 sid + bind 策略 + submit 失败 → clipboard fallback
  reset();
  inject.setActiveSessionFile('/workspaceStorage/HASH/chatSessions/sess-g3.jsonl');
  cfgValues['copilotSidecar.injectSessionOpen'] = 'editor';
  // activateSessionForInject 需要各种命令成功
  commandResults['vscode.open'] = () => undefined;
  commandResults['workbench.action.chat.focusInput'] = () => undefined;
  // submitFocusedQuery 调用 workbench.action.chat.open → 让它抛错
  commandResults['workbench.action.chat.open'] = () => { throw new Error('submit failed'); };
  const r3 = await inject.injectMessage('test submit fail', 'agent');
  check('有 sid + submit 失败 → clipboard fallback', r3.via === 'clipboard');
  check('clipboard 写入了消息', clipboardText === 'test submit fail');
  check('injectPath 包含 submit-failed', r3.injectPath === 'clipboard:submit-failed');
  check('sessionActivated 为 true（已激活但提交失败）', r3.sessionActivated === true);

  // G4. 有 sid + bind 策略 + submit 成功 + 无 targetFile verify（无法写文件）→ soft-unverified
  reset();
  inject.setActiveSessionFile('/workspaceStorage/HASH/chatSessions/sess-g4.jsonl');
  cfgValues['copilotSidecar.injectSessionOpen'] = 'editor';
  commandResults['vscode.open'] = () => undefined;
  commandResults['workbench.action.chat.focusInput'] = () => undefined;
  commandResults['workbench.action.chat.open'] = () => undefined; // submit 成功
  const r4 = await inject.injectMessage('test soft unverified', 'agent');
  check('有 sid + submit 成功 → via=chat.open', r4.via === 'chat.open');
  check('verified 为 false（文件不存在）', r4.verified === false);
  check('injectPath 包含 soft-unverified', r4.injectPath === 'bind+chat.open+soft-unverified');
  check('sessionActivated 为 true', r4.sessionActivated === true);
  check('sessionId 正确提取', r4.sessionId === 'sess-g4');

  // G5. 有 sid + bind 策略 + submit 成功 + 文件 verify 成功
  reset();
  const tmpG5 = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-g5-'));
  const g5File = path.join(tmpG5, 'workspaceStorage', 'HASH', 'chatSessions', 'sess-g5.jsonl');
  fs.mkdirSync(path.dirname(g5File), { recursive: true });
  fs.writeFileSync(g5File, '{}\n');
  inject.setActiveSessionFile(g5File);
  cfgValues['copilotSidecar.injectSessionOpen'] = 'editor';
  commandResults['vscode.open'] = () => undefined;
  commandResults['workbench.action.chat.focusInput'] = () => undefined;
  commandResults['workbench.action.chat.open'] = () => {
    // 模拟 chat 落盘
    setTimeout(() => fs.appendFileSync(g5File, '{"text":"verified message"}\n'), 100);
    return undefined;
  };
  const r5 = await inject.injectMessage('verified message', 'agent');
  check('有 sid + verified 成功 → via=chat.open', r5.via === 'chat.open');
  check('verified 为 true', r5.verified === true);
  check('injectPath 包含 verified', r5.injectPath === 'bind+chat.open+verified');
  fs.rmSync(tmpG5, { recursive: true, force: true });

  // G6. 有 sid + focused-only 策略
  reset();
  inject.setActiveSessionFile('/workspaceStorage/HASH/chatSessions/sess-g6.jsonl');
  cfgValues['copilotSidecar.injectSessionOpen'] = 'focused-only';
  commandResults['workbench.action.chat.open'] = () => undefined;
  commandResults['workbench.action.chat.openAgentMode'] = () => undefined;
  const r6 = await inject.injectMessage('focused only test', 'agent');
  check('focused-only 策略 → via=chat.open', r6.via === 'chat.open');
  check('sessionActivated 为 false', r6.sessionActivated === false);
  check('injectPath 包含 focused-only', r6.injectPath.startsWith('focused-only'));

  // ================================================================
  console.log('\n=== H. handleConfirmation ===');
  reset();

  // H1. 接受（非拒绝按钮）
  commandResults['chat.action.acceptToolConfirmation'] = () => undefined;
  await inject.handleConfirmation('Continue');
  check('Continue → 调用 accept 命令', calls.some((c) => c.cmd === 'chat.action.acceptToolConfirmation'));

  // H2. 拒绝按钮
  reset();
  commandResults['chat.action.rejectToolConfirmation'] = () => undefined;
  await inject.handleConfirmation('Cancel');
  check('Cancel → 调用 reject 命令', calls.some((c) => c.cmd === 'chat.action.rejectToolConfirmation'));

  // H3. 中文拒绝按钮
  reset();
  commandResults['chat.action.rejectToolConfirmation'] = () => undefined;
  await inject.handleConfirmation('拒绝');
  check('拒绝 → 调用 reject 命令', calls.some((c) => c.cmd === 'chat.action.rejectToolConfirmation'));

  // H4. 中文取消
  reset();
  commandResults['chat.action.rejectToolConfirmation'] = () => undefined;
  await inject.handleConfirmation('取消');
  check('取消 → 调用 reject 命令', calls.some((c) => c.cmd === 'chat.action.rejectToolConfirmation'));

  // H5. 所有命令都失败 → 抛错
  reset();
  // 不设置任何 commandResults，所有命令返回 undefined（不抛错）
  // 第一个命令不抛错就不会进入 catch，所以需要让所有候选命令都抛错
  const rejectCmds = [
    'chat.action.acceptToolConfirmation',
    'workbench.action.chat.acceptTool',
    'github.copilot.chat.acceptToolConfirmation',
  ];
  for (const cmd of rejectCmds) commandResults[cmd] = () => { throw new Error('all failed'); };
  let threw = false;
  try { await inject.handleConfirmation('Continue'); } catch { threw = true; }
  check('所有候选命令失败 → 抛错', threw === true);

  // ================================================================
  console.log('\n=== I. cancelChatRequest ===');
  reset();

  // I1. 第一个命令成功
  commandResults['workbench.action.chat.cancel'] = () => undefined;
  const c1 = await inject.cancelChatRequest();
  check('第一个候选成功 → ok:true', c1.ok === true);
  check('via 记录成功命令', c1.via === 'workbench.action.chat.cancel');

  // I2. 第一个失败，第二个成功
  reset();
  commandResults['workbench.action.chat.cancel'] = () => { throw new Error('not found'); };
  commandResults['workbench.action.chat.stop'] = () => undefined;
  const c2 = await inject.cancelChatRequest();
  check('第一个失败第二个成功 → ok:true', c2.ok === true);
  check('via 为第二个命令', c2.via === 'workbench.action.chat.stop');

  // I3. 全部失败 → ok:false + error
  reset();
  const cancelCmds = [
    'workbench.action.chat.cancel',
    'workbench.action.chat.stop',
    'workbench.action.chat.abort',
    'workbench.action.chat.stopResponse',
    'workbench.action.chat.cancelRequest',
    'chat.action.stop',
    'chat.action.cancel',
  ];
  for (const cmd of cancelCmds) commandResults[cmd] = () => { throw new Error(`${cmd} err`); };
  const c3 = await inject.cancelChatRequest();
  check('全部失败 → ok:false', c3.ok === false);
  check('包含 error 消息', typeof c3.error === 'string' && c3.error.length > 0);

  // ================================================================
  console.log(`\n${'='.repeat(52)}`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
