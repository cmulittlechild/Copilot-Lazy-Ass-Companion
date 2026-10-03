#!/usr/bin/env node
/**
 * 孤儿轮占位回归：连接回放里失败轮只剩 AGENT_STREAM_START/END 空流壳
 * 时（生命周期标记），不算「已答」→ 补「该轮无回复」占位；
 * 有正文的 STREAM_SET/CHUNK 仍算已答，不误补。
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { BridgeServer } = require(path.join(ROOT, 'dist/bridge.js'));

const HOST = '127.0.0.1';
const PORT = 34310;
const TOKEN = 'orphan-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name} → ${detail || ''}`); }
}

const bridge = new BridgeServer({ host: HOST, port: PORT, portRange: 0, authToken: TOKEN });
// 文件回放（权威源）含失败轮空流壳 + 有内容的流
bridge.historyProvider = () => [
  { type: 'USER_MESSAGE', text: 'q1 ok', timestamp: 1 },
  { type: 'AGENT_MESSAGE', text: 'a1', streamId: 's/1', timestamp: 2 },
  // 失败轮：只有流生命周期壳，无内容 → 应补占位
  { type: 'USER_MESSAGE', text: 'q2 reqerr', timestamp: 3 },
  { type: 'AGENT_STREAM_START', streamId: 's/2', timestamp: 4 },
  { type: 'AGENT_STREAM_END', streamId: 's/2', timestamp: 5 },
  // 失败轮：空 SET → 应补占位
  { type: 'USER_MESSAGE', text: 'q3 empty-set', timestamp: 6 },
  { type: 'AGENT_STREAM_SET', streamId: 's/3', text: '', timestamp: 7 },
  // 有正文块但无最终 MESSAGE → 算已答，不补占位
  { type: 'USER_MESSAGE', text: 'q4 partial', timestamp: 8 },
  { type: 'AGENT_STREAM_START', streamId: 's/4', timestamp: 9 },
  { type: 'AGENT_STREAM_CHUNK', streamId: 's/4', text: '半截内容', timestamp: 10 },
  { type: 'AGENT_STREAM_END', streamId: 's/4', timestamp: 11 },
  { type: 'AGENT_STREAM_SET', streamId: 's/4', text: '半截内容', timestamp: 12 },
  // 末尾未答 USER：可能在途，不补
  { type: 'USER_MESSAGE', text: 'q5 inflight', timestamp: 13 },
];
await bridge.start();

const received = [];
const ws = new WebSocket(`ws://${HOST}:${PORT}/?token=${TOKEN}`);
await new Promise((res) => ws.once('open', res));
ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch (_) {} });
ws.send(JSON.stringify({ type: 'PHONE_CONNECT', token: TOKEN }));
await sleep(600);

const replay = received.find((m) => m.type === 'HISTORY_REPLAY');
check('收到 HISTORY_REPLAY', !!replay);
const msgs = replay?.messages || [];
const texts = msgs.map((m) => `${m.type}:${String(m.text || '').slice(0, 24)}`);
console.log('  replay:', JSON.stringify(texts));

const afterU2 = msgs.findIndex((m) => m.type === 'USER_MESSAGE' && m.text === 'q2 reqerr');
check('q2 失败轮（空 START+END 壳）补占位', msgs[afterU2 + 1]?.type === 'AGENT_MESSAGE' && /该轮无回复/.test(msgs[afterU2 + 1]?.text || ''), texts[afterU2 + 1]);

const afterU3 = msgs.findIndex((m) => m.type === 'USER_MESSAGE' && m.text === 'q3 empty-set');
check('q3 失败轮（空 SET）补占位', msgs[afterU3 + 1]?.type === 'AGENT_MESSAGE' && /该轮无回复/.test(msgs[afterU3 + 1]?.text || ''), texts[afterU3 + 1]);

const afterU4 = msgs.findIndex((m) => m.type === 'USER_MESSAGE' && m.text === 'q4 partial');
const u4Next = msgs[afterU4 + 1];
check('q4 有正文流不误补占位', !(u4Next && u4Next.type === 'AGENT_MESSAGE' && /该轮无回复/.test(u4Next.text || '')), texts[afterU4 + 1]);

const placeholders = msgs.filter((m) => /该轮无回复/.test(String(m.text || '')));
check('占位恰为 2 条（q5 末尾在途不补）', placeholders.length === 2, `got ${placeholders.length}`);

ws.close();
await bridge.stop?.();
console.log(`\n${pass} pass, ${fail} fail`);
if (failures.length) console.log('failures:', failures);
process.exit(fail ? 1 : 0);
