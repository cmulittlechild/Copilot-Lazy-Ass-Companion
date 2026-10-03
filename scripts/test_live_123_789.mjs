#!/usr/bin/env node
/**
 * 0.5.26 真实场景回归：live 下「回复我 123」不应出现旧 789/paseo
 * 通过 BridgeServer + WebSocket 模拟 PWA 消费者。
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { BridgeServer } = require(path.join(ROOT, 'dist/bridge.js'));
const { TranscriptWatcher } = require(path.join(ROOT, 'dist/transcriptWatcher.js'));
const WebSocket = require(path.join(ROOT, 'node_modules/ws'));

const PORT = 3018;
const HOST = '127.0.0.1';
const TOKEN = 'live-token';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function waitFor(pred, ms = 5000, step = 40) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live123-'));
  const tDir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(tDir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'live-123';
  const tFile = path.join(tDir, `${sid}.jsonl`);
  const cFile = path.join(csDir, `${sid}.jsonl`);

  // chatSessions 已有旧 789 / paseo 完整历史
  fs.writeFileSync(
    cFile,
    JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n' +
      JSON.stringify({
        kind: 2,
        i: 0,
        k: ['requests'],
        v: [
          {
            requestId: 'rid-789',
            timestamp: 1000,
            message: { text: '回复我 789' },
            response: [{ kind: 'markdownContent', value: '789' }],
            isComplete: true,
          },
          {
            requestId: 'rid-paseo',
            timestamp: 2000,
            message: { text: '介绍 paseo' },
            response: [{ kind: 'markdownContent', value: 'paseo 是 workspace 调度器长文……' }],
            isComplete: true,
          },
        ],
      }) + '\n',
  );
  fs.writeFileSync(tFile, '');

  const bridge = new BridgeServer({ host: HOST, port: PORT, authToken: TOKEN, pwaDir: path.join(ROOT, 'media/pwa') });
  await bridge.start();

  const tw = new TranscriptWatcher({
    dir: tDir,
    chatSessionsDir: csDir,
    pollMs: 30,
    fallbackPollMs: 60,
    onEvent: (ev) => bridge.sendToPhone(ev),
  });
  tw.bindFile(tFile, { replay: false });
  tw.pinFile(tFile);

  const clientEvents = [];
  const ws = new WebSocket(`ws://${HOST}:${PORT}/?token=${TOKEN}`);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (d) => { try { clientEvents.push(JSON.parse(String(d))); } catch {} });
  ws.send(JSON.stringify({ type: 'PHONE_CONNECT', token: TOKEN }));
  await waitFor(() => clientEvents.some((e) => e.type === 'HISTORY_REPLAY'), 2000);

  // 写入新用户 123 + turn_start
  const n0 = clientEvents.length;
  fs.appendFileSync(tFile, JSON.stringify({
    type: 'user.message',
    data: { content: '回复我 123', messageId: 'u-123' },
    timestamp: new Date().toISOString(),
  }) + '\n');
  fs.appendFileSync(tFile, JSON.stringify({
    type: 'assistant.turn_start',
    data: { turnId: 'turn-123' },
    timestamp: new Date().toISOString(),
  }) + '\n');
  // 等 turn gap timer 3s + fallback 轮询
  await sleep(3600);

  // 此时不应有 789 / paseo 助手
  const after = clientEvents.slice(n0);
  const agentTexts = after
    .filter((e) => e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET')
    .map((e) => String(e.text || '').trim())
    .filter(Boolean);
  assert(!agentTexts.some((t) => t === '789' || t.includes('paseo')), `旧回复泄漏: ${JSON.stringify(agentTexts)}`);

  // chatSessions 追加 123 完整 response
  const n1 = clientEvents.length;
  fs.appendFileSync(cFile, JSON.stringify({
    kind: 2,
    i: 2,
    k: ['requests'],
    v: [{
      requestId: 'rid-123',
      timestamp: 3000,
      message: { text: '回复我 123' },
      response: [{ kind: 'markdownContent', value: '123' }],
      isComplete: true,
    }],
  }) + '\n');
  await waitFor(() => clientEvents.slice(n1).some((e) => e.type === 'AGENT_MESSAGE' && String(e.text).includes('123')), 3000);
  const final = clientEvents.slice(n1)
    .filter((e) => e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET')
    .map((e) => String(e.text || '').trim())
    .filter(Boolean);
  assert(final.some((t) => t === '123'), `应 gap 出 123: ${JSON.stringify(final)}`);
  assert(!final.some((t) => t === '789' || t.includes('paseo')), `旧 789 混入: ${JSON.stringify(final)}`);

  // 追加 orphan 789（parentId null）不应出现
  const n2 = clientEvents.length;
  fs.appendFileSync(tFile, JSON.stringify({
    type: 'assistant.message',
    data: { messageId: 'orphan-789', content: '789', parentId: null },
    timestamp: new Date().toISOString(),
  }) + '\n');
  await sleep(500);
  const orphan = clientEvents.slice(n2)
    .filter((e) => e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET')
    .map((e) => String(e.text || '').trim())
    .filter(Boolean);
  assert(!orphan.some((t) => t === '789'), `orphan 789 不应投影: ${JSON.stringify(orphan)}`);

  tw.dispose();
  try { ws.close(); } catch {}
  await bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('结果: 全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
