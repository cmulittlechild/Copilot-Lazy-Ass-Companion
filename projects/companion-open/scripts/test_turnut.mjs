#!/usr/bin/env node
/**
 * 轮级 _ut 归属回归：注入侧 addPendingPhoneUserText 盖戳 userTsByUt/activeUserText
 * 后，旧轮 transcript 记录（文件序在前的 user/turn_start/assistant/turn_end，
 * 记录 ts 与新问题戳相距 <2s）不得被 +2s 宽限错挂到后开的问题下。
 *
 * 实机场景：BURST3 注入→用户消息进 transcript；BURST1 排队出队注入→
 * addPendingPhoneUserText 把 activeUserText/userTsByUt 盖成 B1；随后 transcript
 * 才轮到 B3 轮的 assistant.message → 旧 resolveUtForTs 把 _ut 错判为 B1。
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { TranscriptWatcher } = require(path.join(ROOT, 'dist/transcriptWatcher.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turnut-'));
const dir = path.join(tmp, 'transcripts');
const csDir = path.join(tmp, 'chatSessions');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(csDir, { recursive: true });

const sid = 'sess-turnut-1';
const tfile = path.join(dir, `${sid}.jsonl`);
const cfile = path.join(csDir, `${sid}.jsonl`);
fs.writeFileSync(tfile, '');
fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n');

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

const events = [];
const tw = new TranscriptWatcher({
  dir,
  chatSessionsDir: csDir,
  pollMs: 40,
  fallbackPollMs: 80,
  onEvent(ev) {
    events.push(ev);
  },
});

const B3 = 'Reply with exactly: BURST3-PROBE';
const B1 = 'Reply with exactly: BURST1-PROBE';

async function main() {
  console.log('=== 注入盖戳 + 旧轮 transcript 迟到 → _ut 归属 ===');
  tw.bindFile(tfile, { replay: false });
  tw.pinFile(tfile);
  await sleep(120);

  // 1) B3 注入：问题进 transcript（记录 ts ≈ now-1s，模拟上游已落盘）
  const tUser3 = Date.now() - 1500;
  const tTs3 = Date.now() - 1400;
  const tAsst3 = Date.now() - 1000;
  const tEnd3 = Date.now() - 900;
  append(tfile, {
    type: 'user.message',
    data: { content: B3, messageId: 'u-b3' },
    timestamp: new Date(tUser3).toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 'turn-b3' },
    timestamp: new Date(tTs3).toISOString(),
  });
  append(tfile, {
    type: 'assistant.message',
    data: { messageId: 'a-b3', content: 'BURST3-PROBE' },
    timestamp: new Date(tAsst3).toISOString(),
  });
  append(tfile, { type: 'assistant.turn_end', data: {}, timestamp: new Date(tEnd3).toISOString() });

  // 2) B1 出队注入（transcript 尚未写入其记录）——盖戳发生在 B3 记录被读之前
  tw.addPendingPhoneUserText(B1);

  // 等 poll 读完 B3 整轮
  for (let i = 0; i < 30; i++) {
    await sleep(80);
    if (events.some((e) => e.type === 'COPILOT_DONE')) break;
  }

  const sets = events.filter((e) => e.type === 'AGENT_STREAM_SET' || e.type === 'AGENT_MESSAGE');
  const done = events.filter((e) => e.type === 'COPILOT_DONE' || e.type === 'AGENT_STREAM_END');
  const utOf = (e) => String(e._ut || '');
  console.log('  _ut:', JSON.stringify(sets.map(utOf)), '| done:', JSON.stringify(done.map(utOf)));

  check('B3 轮正文 _ut = B3（不被 B1 偷走）', sets.length > 0 && sets.every((e) => utOf(e) === B3), JSON.stringify(sets.map(utOf)));
  check('B3 轮收尾 _ut = B3', done.length > 0 && done.every((e) => utOf(e) === B3 || utOf(e) === ''), JSON.stringify(done.map(utOf)));

  // 3) B1 自己的轮随后正常开启：_ut 应正确归到 B1
  const tUser1 = Date.now();
  append(tfile, {
    type: 'user.message',
    data: { content: B1, messageId: 'u-b1' },
    timestamp: new Date(tUser1).toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 'turn-b1' },
    timestamp: new Date(tUser1 + 100).toISOString(),
  });
  append(tfile, {
    type: 'assistant.message',
    data: { messageId: 'a-b1', content: 'BURST1-PROBE' },
    timestamp: new Date(tUser1 + 4000).toISOString(),
  });
  append(tfile, { type: 'assistant.turn_end', data: {}, timestamp: new Date(tUser1 + 4100).toISOString() });

  for (let i = 0; i < 30; i++) {
    await sleep(80);
    const tail = events.slice(sets.length);
    if (tail.some((e) => e.type === 'COPILOT_DONE')) break;
  }
  const b1Sets = events.filter(
    (e) => (e.type === 'AGENT_STREAM_SET' || e.type === 'AGENT_MESSAGE') && utOf(e) === B1,
  );
  check('B1 轮正文 _ut = B1（新轮不被旧轮污染）', b1Sets.length > 0, JSON.stringify(b1Sets.map(utOf)));

  tw.dispose();
  console.log(`\n====================================================`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
