#!/usr/bin/env node
// 隔离实验：dist/bridge.js + 与 extension.ts 相同结构的 onRequest handler
// 目的：区分「bridge dispatch 有问题」还是「extension handler 有问题」
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { BridgeServer } = require(path.join(ROOT, 'dist/bridge.js'));
const { WebSocket } = require(path.join(ROOT, 'node_modules/ws'));

const PORT = 3820;
const bridge = new BridgeServer({ host: '127.0.0.1', port: PORT, portRange: 5 });

// 完全照抄 extension.ts 的 handler 结构（含 switch + default: break）
let handlerCalls = [];
bridge.onRequest(async (msg, reply) => {
  handlerCalls.push(msg?.type);
  switch (msg?.type) {
    case 'PHONE_SESSION_LIST': {
      reply({ type: 'SESSION_LIST', sessions: [], timestamp: Date.now() });
      break;
    }
    case 'PHONE_MODEL_LIST': {
      reply({ type: 'MODEL_LIST', models: [], timestamp: Date.now() });
      break;
    }
    case 'PHONE_PERMISSION_LIST': {
      reply({ type: 'PERMISSION_LIST', levels: [], current: 'default', timestamp: Date.now() });
      break;
    }
    case 'PHONE_INSTANCE_STATUS': {
      reply({ type: 'INSTANCE_STATUS', workspaceName: 'iso-test', port: PORT, timestamp: Date.now() });
      break;
    }
    case 'PHONE_TERMINAL_LIST': {
      reply({ type: 'TERMINAL_LIST', terminals: [], timestamp: Date.now() });
      break;
    }
    default:
      break;
  }
});

await bridge.start();
console.log(`隔离 bridge 起于 :${bridge.port}`);

const health = await (await fetch(`http://127.0.0.1:${bridge.port}/health`)).json();
console.log(`  /health: msgH=${health.messageHandlers} reqH=${health.requestHandlers}`);
console.log();

const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
const got = new Map();
ws.on('message', (d) => {
  try {
    const m = JSON.parse(String(d));
    if (!got.has(m.type)) got.set(m.type, m);
  } catch { /* ignore */ }
});

const REQ = [
  'PHONE_SESSION_LIST',
  'PHONE_MODEL_LIST',
  'PHONE_PERMISSION_LIST',
  'PHONE_INSTANCE_STATUS',
  'PHONE_TERMINAL_LIST',
];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'PHONE_CONNECT' }));
  setTimeout(() => {
    for (const t of REQ) ws.send(JSON.stringify({ type: t }));
    setTimeout(async () => {
      const expect = {
        PHONE_SESSION_LIST: 'SESSION_LIST',
        PHONE_MODEL_LIST: 'MODEL_LIST',
        PHONE_PERMISSION_LIST: 'PERMISSION_LIST',
        PHONE_INSTANCE_STATUS: 'INSTANCE_STATUS',
        PHONE_TERMINAL_LIST: 'TERMINAL_LIST',
      };
      let pass = 0, fail = 0;
      console.log('=== 隔离实验结果（dist/bridge.js dispatch）===');
      for (const [req, resp] of Object.entries(expect)) {
        const ok = got.has(resp);
        console.log(`  ${ok ? '✓' : '✗'} ${req} → ${resp}`);
        ok ? pass++ : fail++;
      }
      console.log();
      console.log('handler 被调用的类型:', handlerCalls.join(', ') || '(一次都没被调用)');
      console.log('收到的全部类型:', [...got.keys()].join(', '));
      console.log();
      console.log(`结果: ${pass} 通过, ${fail} 失败`);
      console.log(
        fail === 0
          ? '→ bridge dispatch 正常 ⇒ 问题在 extension.ts 的 handler 路径'
          : '→ bridge dispatch 本身有问题',
      );
      ws.close();
      await bridge.stop();
      process.exit(fail === 0 ? 0 : 1);
    }, 1200);
  }, 400);
});
ws.on('error', (e) => {
  console.log('连接失败:', e.message);
  process.exit(2);
});
