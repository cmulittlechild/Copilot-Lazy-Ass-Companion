#!/usr/bin/env node
// instances.ts 测试：实例发现、端口扫描、进程检测、WS 握手协议
// 使用 Module._resolveFilename 拦截 vscode 模块 + 真实 WebSocket 服务器
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import net from 'net';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const Module = require('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocketServer } = require(path.join(ROOT, 'node_modules/ws'));

// ---- 可配置的 vscode stub ----
let workspaceName = 'test-workspace';

const vscodeStub = {
  workspace: {
    get name() { return workspaceName; },
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

const { InstanceDiscovery, makeInstanceId } = require(path.join(ROOT, 'dist/instances.js'));

// ---- 测试框架 ----
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; failures.push(name); console.log(`  \u2717 ${name}${detail ? ` \u2192 ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- WebSocket 模拟 bridge 服务器 ----
function createMockBridge(port, status) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'PHONE_CONNECT') {
        ws.send(JSON.stringify({ type: 'CONNECTED_ACK' }));
      }
      if (msg.type === 'PHONE_INSTANCE_STATUS') {
        ws.send(JSON.stringify({ type: 'INSTANCE_STATUS', ...status }));
      }
    });
  });
  return wss;
}

function closeServer(wss) {
  return new Promise((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
}

function createTcpServer(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// 选一组不常用端口避免冲突
const BASE = 4830;

async function main() {

  // ================================================================
  console.log('=== A. makeInstanceId ===');

  workspaceName = 'my-project';
  const id1 = makeInstanceId();
  check('格式为 vscode-<pid>-<hash8>', /^vscode-\d+-[0-9a-f]{8}$/.test(id1),
    `got ${id1}`);
  check('包含当前进程 pid', id1.includes(`vscode-${process.pid}-`), `got ${id1}`);

  const expectedHash = crypto.createHash('md5').update('my-project').digest('hex').slice(0, 8);
  check('hash 基于 workspace.name', id1 === `vscode-${process.pid}-${expectedHash}`,
    `got ${id1}`);

  // 不同 workspace name 产生不同 id
  workspaceName = 'other-project';
  const id2 = makeInstanceId();
  check('不同 workspace name → 不同 id', id1 !== id2);

  // workspace.name 为空时用 'untitled'
  workspaceName = '';
  const id3 = makeInstanceId();
  const untitledHash = crypto.createHash('md5').update('untitled').digest('hex').slice(0, 8);
  check('空 workspace.name → 用 untitled',
    id3 === `vscode-${process.pid}-${untitledHash}`, `got ${id3}`);

  workspaceName = undefined;
  const id4 = makeInstanceId();
  check('undefined workspace.name → 用 untitled',
    id4 === `vscode-${process.pid}-${untitledHash}`, `got ${id4}`);

  workspaceName = null;
  const id5 = makeInstanceId();
  check('null workspace.name → 用 untitled',
    id5 === `vscode-${process.pid}-${untitledHash}`, `got ${id5}`);

  // 确定性：相同 workspace name → 相同 id
  workspaceName = 'deterministic-test';
  const idA = makeInstanceId();
  const idB = makeInstanceId();
  check('相同 workspace name → 确定性 id', idA === idB);

  // ================================================================
  console.log('\n=== B. isAvailable ===');

  // B1. 有服务监听 → true
  const tcpSrv = await createTcpServer(BASE);
  const disc1 = new InstanceDiscovery({ basePort: BASE, authToken: 'tok' });
  const avail1 = await disc1.isAvailable();
  check('端口有服务监听 → true', avail1 === true);
  tcpSrv.close();

  // B2. 无服务监听 → false
  const disc2 = new InstanceDiscovery({ basePort: BASE, authToken: 'tok' });
  const avail2 = await disc2.isAvailable();
  check('端口无服务监听 → false', avail2 === false);

  // B3. isAvailable 不依赖 authToken
  const disc3 = new InstanceDiscovery({ basePort: BASE + 100 });
  const avail3 = await disc3.isAvailable();
  check('端口 100 偏移无服务 → false', avail3 === false);

  // ================================================================
  console.log('\n=== C. scan 基本行为 ===');

  // C1. 无任何实例 → 返回空数组
  const discC1 = new InstanceDiscovery({ basePort: BASE + 200, range: 5, authToken: 'tok' });
  const scanC1 = await discC1.scan();
  check('无服务时 scan 返回空数组', Array.isArray(scanC1) && scanC1.length === 0);

  // C2. 单实例发现
  const portC2 = BASE + 210;
  const statusC2 = {
    instanceId: 'vscode-12345-abcdef01',
    workspaceName: 'project-c2',
    host: '127.0.0.1',
    port: portC2,
    isPrimary: true,
    pid: 12345,
  };
  const wssC2 = createMockBridge(portC2, statusC2);
  const discC2 = new InstanceDiscovery({ basePort: portC2, range: 2, authToken: 'tok' });
  const scanC2 = await discC2.scan();
  check('单实例 scan 返回 1 个', scanC2.length === 1, `got ${scanC2.length}`);
  if (scanC2.length === 1) {
    const info = scanC2[0];
    check('instanceId 正确', info.instanceId === 'vscode-12345-abcdef01', info.instanceId);
    check('workspaceName 正确', info.workspaceName === 'project-c2', info.workspaceName);
    check('port 正确', info.port === portC2, String(info.port));
    check('host 正确', info.host === '127.0.0.1', info.host);
    check('isPrimary 正确', info.isPrimary === true, String(info.isPrimary));
    check('pid 正确', info.pid === 12345, String(info.pid));
  }
  await closeServer(wssC2);

  // ================================================================
  console.log('\n=== D. scan 多实例枚举 ===');

  const portD1 = BASE + 220;
  const portD2 = BASE + 221;
  const portD3 = BASE + 222;
  const wssD1 = createMockBridge(portD1, {
    instanceId: 'vscode-111-aaaaaaaa', workspaceName: 'proj1', host: '127.0.0.1', port: portD1, isPrimary: true, pid: 111,
  });
  const wssD2 = createMockBridge(portD2, {
    instanceId: 'vscode-222-bbbbbbbb', workspaceName: 'proj2', host: '127.0.0.1', port: portD2, isPrimary: false, pid: 222,
  });
  const wssD3 = createMockBridge(portD3, {
    instanceId: 'vscode-333-cccccccc', workspaceName: 'proj3', host: '127.0.0.1', port: portD3, isPrimary: false, pid: 333,
  });

  const discD = new InstanceDiscovery({ basePort: portD1, range: 10, authToken: 'tok' });
  const scanD = await discD.scan();
  check('发现 3 个实例', scanD.length === 3, `got ${scanD.length}`);
  check('结果按 port 排序', scanD[0].port === portD1 && scanD[1].port === portD2 && scanD[2].port === portD3,
    scanD.map((s) => s.port).join(','));
  check('三个 instanceId 各不相同',
    new Set(scanD.map((s) => s.instanceId)).size === 3);

  await closeServer(wssD1);
  await closeServer(wssD2);
  await closeServer(wssD3);

  // ================================================================
  console.log('\n=== E. stale 实例过滤（端口无响应）===');

  // E1. basePort 有服务，basePort+1 无服务 → 只返回 1 个
  const portE1 = BASE + 240;
  const wssE1 = createMockBridge(portE1, {
    instanceId: 'vscode-444-dddddddd', workspaceName: 'alive', host: '127.0.0.1', port: portE1, isPrimary: true, pid: 444,
  });
  const discE = new InstanceDiscovery({ basePort: portE1, range: 5, authToken: 'tok' });
  const scanE = await discE.scan();
  check('只有 basePort 有服务 → 1 个', scanE.length === 1, `got ${scanE.length}`);
  if (scanE.length === 1) {
    check('stale 端口被过滤', scanE[0].port === portE1);
  }
  await closeServer(wssE1);

  // E2. 范围内部分端口有服务
  const portE2a = BASE + 250;
  const portE2c = BASE + 252;
  const wssE2a = createMockBridge(portE2a, {
    instanceId: 'vscode-555-eeeeeeee', workspaceName: 'a', host: '127.0.0.1', port: portE2a, isPrimary: true, pid: 555,
  });
  // basePort+1 不开服务
  const wssE2c = createMockBridge(portE2c, {
    instanceId: 'vscode-666-ffffffff', workspaceName: 'c', host: '127.0.0.1', port: portE2c, isPrimary: false, pid: 666,
  });
  const discE2 = new InstanceDiscovery({ basePort: portE2a, range: 5, authToken: 'tok' });
  const scanE2 = await discE2.scan();
  check('部分端口有服务 → 2 个', scanE2.length === 2, `got ${scanE2.length}`);
  check('跳过了无响应的端口',
    scanE2.every((s) => s.port === portE2a || s.port === portE2c));
  await closeServer(wssE2a);
  await closeServer(wssE2c);

  // ================================================================
  console.log('\n=== F. normalizeStatus 边界（通过 scan 间接测试）===');

  // F1. 缺少 instanceId → 不返回该实例
  const portF1 = BASE + 260;
  const wssF1 = createMockBridge(portF1, {
    // 不发 instanceId
    workspaceName: 'no-id', host: '127.0.0.1', port: portF1, isPrimary: true, pid: 777,
  });
  const discF1 = new InstanceDiscovery({ basePort: portF1, range: 1, authToken: 'tok' });
  const scanF1 = await discF1.scan();
  check('缺少 instanceId → 不发现', scanF1.length === 0, `got ${scanF1.length}`);
  await closeServer(wssF1);

  // F2. instanceId 为空字符串 → 不返回
  const portF2 = BASE + 270;
  const wssF2 = createMockBridge(portF2, {
    instanceId: '', workspaceName: 'empty-id', host: '127.0.0.1', port: portF2, isPrimary: true, pid: 888,
  });
  const discF2 = new InstanceDiscovery({ basePort: portF2, range: 1, authToken: 'tok' });
  const scanF2 = await discF2.scan();
  check('空 instanceId → 不发现', scanF2.length === 0, `got ${scanF2.length}`);
  await closeServer(wssF2);

  // F3. 缺少 workspaceName → 不返回
  const portF3 = BASE + 280;
  const wssF3 = createMockBridge(portF3, {
    instanceId: 'vscode-999-gggggggg', host: '127.0.0.1', port: portF3, isPrimary: true, pid: 999,
  });
  const discF3 = new InstanceDiscovery({ basePort: portF3, range: 1, authToken: 'tok' });
  const scanF3 = await discF3.scan();
  check('缺少 workspaceName → 不发现', scanF3.length === 0, `got ${scanF3.length}`);
  await closeServer(wssF3);

  // F4. 无效 pid（0 或负数）→ 不返回
  const portF4a = BASE + 290;
  const portF4b = BASE + 291;
  const wssF4a = createMockBridge(portF4a, {
    instanceId: 'vscode-aaa-hhhhhhhh', workspaceName: 'zero-pid', host: '127.0.0.1', port: portF4a, isPrimary: true, pid: 0,
  });
  const wssF4b = createMockBridge(portF4b, {
    instanceId: 'vscode-bbb-iiiiiiii', workspaceName: 'neg-pid', host: '127.0.0.1', port: portF4b, isPrimary: true, pid: -1,
  });
  const discF4 = new InstanceDiscovery({ basePort: portF4a, range: 5, authToken: 'tok' });
  const scanF4 = await discF4.scan();
  check('无效 pid (0 或负) → 不发现', scanF4.length === 0, `got ${scanF4.length}`);
  await closeServer(wssF4a);
  await closeServer(wssF4b);

  // F5. 缺少 port → 回退到 probedPort
  const portF5 = BASE + 300;
  const wssF5 = createMockBridge(portF5, {
    instanceId: 'vscode-ccc-jjjjjjjj', workspaceName: 'no-port', host: '127.0.0.1', isPrimary: true, pid: 1111,
  });
  const discF5 = new InstanceDiscovery({ basePort: portF5, range: 1, authToken: 'tok' });
  const scanF5 = await discF5.scan();
  check('缺少 port → 回退到 probedPort', scanF5.length === 1 && scanF5[0].port === portF5,
    `got ${scanF5.map((s) => s.port).join(',')}`);
  await closeServer(wssF5);

  // F6. 缺少 host → 默认 127.0.0.1
  const portF6 = BASE + 310;
  const wssF6 = createMockBridge(portF6, {
    instanceId: 'vscode-ddd-kkkkkkkk', workspaceName: 'no-host', port: portF6, isPrimary: true, pid: 2222,
  });
  const discF6 = new InstanceDiscovery({ basePort: portF6, range: 1, authToken: 'tok' });
  const scanF6 = await discF6.scan();
  check('缺少 host → 默认 127.0.0.1',
    scanF6.length === 1 && scanF6[0].host === '127.0.0.1',
    `got ${scanF6.map((s) => s.host).join(',')}`);
  await closeServer(wssF6);

  // F7. isPrimary 非 true → false
  const portF7 = BASE + 320;
  const wssF7 = createMockBridge(portF7, {
    instanceId: 'vscode-eee-llllllll', workspaceName: 'not-primary', host: '127.0.0.1', port: portF7, isPrimary: 'yes', pid: 3333,
  });
  const discF7 = new InstanceDiscovery({ basePort: portF7, range: 1, authToken: 'tok' });
  const scanF7 = await discF7.scan();
  check('isPrimary 非 boolean true → false',
    scanF7.length === 1 && scanF7[0].isPrimary === false,
    `got ${scanF7.map((s) => s.isPrimary).join(',')}`);
  await closeServer(wssF7);

  // ================================================================
  console.log('\n=== G. parseMessage 健壮性（通过 scan 间接测试）===');

  // G1. 非法 JSON 消息 → 不发现
  const portG1 = BASE + 330;
  const wssG1 = new WebSocketServer({ port: portG1, host: '127.0.0.1' });
  wssG1.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'PHONE_CONNECT') ws.send('not-json');
      if (msg.type === 'PHONE_INSTANCE_STATUS') ws.send('{broken');
    });
  });
  const discG1 = new InstanceDiscovery({ basePort: portG1, range: 1, authToken: 'tok' });
  const scanG1 = await discG1.scan();
  check('非法 JSON 消息 → 不发现', scanG1.length === 0);
  await closeServer(wssG1);

  // G2. 返回数组而非对象 → 不发现
  const portG2 = BASE + 340;
  const wssG2 = new WebSocketServer({ port: portG2, host: '127.0.0.1' });
  wssG2.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'PHONE_CONNECT') ws.send(JSON.stringify({ type: 'CONNECTED_ACK' }));
      if (msg.type === 'PHONE_INSTANCE_STATUS') ws.send(JSON.stringify([1, 2, 3])); // 数组
    });
  });
  const discG2 = new InstanceDiscovery({ basePort: portG2, range: 1, authToken: 'tok' });
  const scanG2 = await discG2.scan();
  check('数组 JSON → 不发现', scanG2.length === 0);
  await closeServer(wssG2);

  // G3. 返回 null → 不发现
  const portG3 = BASE + 350;
  const wssG3 = new WebSocketServer({ port: portG3, host: '127.0.0.1' });
  wssG3.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type === 'PHONE_CONNECT') ws.send(JSON.stringify({ type: 'CONNECTED_ACK' }));
      if (msg.type === 'PHONE_INSTANCE_STATUS') ws.send(JSON.stringify(null));
    });
  });
  const discG3 = new InstanceDiscovery({ basePort: portG3, range: 1, authToken: 'tok' });
  const scanG3 = await discG3.scan();
  check('null JSON → 不发现', scanG3.length === 0);
  await closeServer(wssG3);

  // ================================================================
  console.log('\n=== H. scan 参数与日志 ===');

  // H1. 默认 range=20
  const discH1 = new InstanceDiscovery({ basePort: BASE + 400, authToken: 'tok' });
  check('默认 range 不报错', typeof discH1.scan === 'function');

  // H2. 日志回调被调用
  const portH2 = BASE + 410;
  const wssH2 = createMockBridge(portH2, {
    instanceId: 'vscode-fff-mmmmmmmm', workspaceName: 'log-test', host: '127.0.0.1', port: portH2, isPrimary: true, pid: 4444,
  });
  const logsH2 = [];
  const discH2 = new InstanceDiscovery({ basePort: portH2, range: 1, authToken: 'tok', log: (l) => logsH2.push(l) });
  await discH2.scan();
  check('日志回调被调用', logsH2.length > 0, `got ${logsH2.length} logs`);
  check('日志包含 scan 关键字', logsH2.some((l) => l.includes('[instances]')));
  await closeServer(wssH2);

  // H3. 日志回调异常不崩溃
  const portH3 = BASE + 420;
  const wssH3 = createMockBridge(portH3, {
    instanceId: 'vscode-ggg-nnnnnnnn', workspaceName: 'bad-log', host: '127.0.0.1', port: portH3, isPrimary: true, pid: 5555,
  });
  const discH3 = new InstanceDiscovery({
    basePort: portH3, range: 1, authToken: 'tok',
    log: () => { throw new Error('log callback error'); },
  });
  let scanH3 = null;
  try { scanH3 = await discH3.scan(); } catch (e) { /* shouldn't happen */ }
  check('日志回调异常不崩溃', scanH3 !== null && scanH3.length === 1);
  await closeServer(wssH3);

  // ================================================================
  console.log(`\n${'='.repeat(52)}`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
