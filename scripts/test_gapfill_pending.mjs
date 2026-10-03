#!/usr/bin/env node
/**
 * 0.5.26 回归：per-request gap-fill
 *
 * 根因：旧版 transcriptHadGap 全局开闸 + fallbackOffset=0 全文重扫，
 * 会把历史 789 / paseo 贴到新用户「回复我 123」气泡下。
 *
 * 覆盖：
 * A. 旧完整 request 已在 CS；新用户 pending 后仅 gap-fill 匹配用户文的 response
 * B. turn_start 超时后 orphan assistant.message 不挂到旧用户
 * C. response 增量 k=['requests',N,'response'] 仍能补 pending
 * D. 无 pending 时 phone live 不投任何 CS 助手
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

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function agentTexts(events) {
  return events
    .filter((e) => e && (e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET'))
    .map((e) => String(e.text || '').trim())
    .filter(Boolean);
}

async function waitFor(pred, timeoutMs = 2500, step = 80) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

async function scenarioA() {
  console.log('\n=== A. 旧 789 不贴到新 123；只 gap-fill 匹配 pending ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gapA-'));
  const dir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'sess-123';
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, '');
  // 历史 CS：旧轮 789 / paseo 已完整
  fs.writeFileSync(
    cfile,
    JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) +
      '\n' +
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
            response: [{ kind: 'markdownContent', value: 'paseo 是一款 workspace 调度器长文……' }],
            isComplete: true,
          },
        ],
      }) +
      '\n',
  );

  const events = [];
  const tw = new TranscriptWatcher({
    dir,
    chatSessionsDir: csDir,
    pollMs: 40,
    fallbackPollMs: 60,
    onEvent(ev) {
      events.push(ev);
    },
  });
  tw.bindFile(tfile, { replay: false });
  tw.pinFile(tfile);
  await sleep(200);

  // 新用户轮：TR 只有 user + turn_start，无正文（真实 123 场景）
  const n0 = events.length;
  append(tfile, {
    type: 'user.message',
    data: { content: '回复我 123', messageId: 'u-123' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 'turn-123' },
    timestamp: new Date().toISOString(),
  });
  // 等 turn gap timer (3s) + fallback poll
  await sleep(3600);

  // 此时不应因旧 CS 全文出现 789/paseo
  let after = events.slice(n0);
  let texts = agentTexts(after);
  check('A1 超时后未 gap 旧 789', !texts.some((t) => t === '789' || t.includes('paseo')), JSON.stringify(texts));
  check('A1b 有 USER 123', after.some((e) => e.type === 'USER_MESSAGE' && String(e.text || '').includes('123')));

  // CS 追加完整 123 回复（模拟 chatSessions 落盘）
  const n1 = events.length;
  append(cfile, {
    kind: 2,
    i: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'rid-123',
        timestamp: 3000,
        message: { text: '回复我 123' },
        response: [{ kind: 'markdownContent', value: '123' }],
        isComplete: true,
      },
    ],
  });
  await waitFor(() => agentTexts(events.slice(n1)).some((t) => t.includes('123')), 3000);
  after = events.slice(n1);
  texts = agentTexts(after);
  check('A2 gap-fill 得到 123', texts.some((t) => t === '123' || t.includes('123')), JSON.stringify(texts));
  check('A2b 仍不出现 789/paseo', !texts.some((t) => t === '789' || t.includes('paseo')), JSON.stringify(texts));
  // 全会话助手正文不应混入旧文（自 n0 起）
  const allTexts = agentTexts(events.slice(n0));
  check(
    'A3 全程无 789/paseo 助手',
    !allTexts.some((t) => t === '789' || t.includes('paseo')),
    JSON.stringify(allTexts),
  );

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function scenarioB() {
  console.log('\n=== B. 3s 后无 parentId 的迟到正文仍应投影 ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gapB-'));
  const dir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'sess-late';
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, '');
  fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n');

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
  tw.bindFile(tfile, { replay: false });
  tw.pinFile(tfile);
  await sleep(120);

  append(tfile, {
    type: 'user.message',
    data: { content: '回复我 123', messageId: 'u1' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 't1' },
    timestamp: new Date().toISOString(),
  });
  await sleep(3600);

  const n1 = events.length;
  append(tfile, {
    type: 'assistant.message',
    data: { messageId: 'late-123', content: '123', parentId: null },
    timestamp: new Date().toISOString(),
  });
  await waitFor(() => agentTexts(events.slice(n1)).some((t) => t.includes('123')), 2000);
  const texts = agentTexts(events.slice(n1));
  check('B1 3s 后无 parentId 的 123 仍投影', texts.some((t) => t.includes('123')), JSON.stringify(texts));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function scenarioC() {
  console.log('\n=== C. requests/N/response 增量仍能补 pending ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gapC-'));
  const dir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'sess-mut';
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, '');
  fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n');

  const events = [];
  const tw = new TranscriptWatcher({
    dir,
    chatSessionsDir: csDir,
    pollMs: 40,
    fallbackPollMs: 60,
    onEvent(ev) {
      events.push(ev);
    },
  });
  tw.bindFile(tfile, { replay: false });
  tw.pinFile(tfile);
  await sleep(120);

  append(tfile, {
    type: 'user.message',
    data: { content: '回复我 456', messageId: 'u456' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 't456' },
    timestamp: new Date().toISOString(),
  });

  // 先写无 response 的 request 行（登记 index/userText）
  append(cfile, {
    kind: 2,
    i: 0,
    k: ['requests'],
    v: [
      {
        requestId: 'rid-456',
        timestamp: 4000,
        message: { text: '回复我 456' },
        response: [],
        isComplete: false,
      },
    ],
  });
  await sleep(3600); // pending gap

  const n1 = events.length;
  // 增量 response
  append(cfile, {
    kind: 2,
    k: ['requests', 0, 'response'],
    v: [{ kind: 'markdownContent', value: '456' }],
  });
  await waitFor(() => agentTexts(events.slice(n1)).some((t) => t.includes('456')), 3000);
  const texts = agentTexts(events.slice(n1));
  check('C1 response 增量 gap-fill 456', texts.some((t) => t.includes('456')), JSON.stringify(texts));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function scenarioD() {
  console.log('\n=== D. 无 pending 时 phone live 不投 CS 助手 ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gapD-'));
  const dir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'sess-nop';
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, '');
  fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n');

  const events = [];
  const tw = new TranscriptWatcher({
    dir,
    chatSessionsDir: csDir,
    pollMs: 40,
    fallbackPollMs: 60,
    onEvent(ev) {
      events.push(ev);
    },
  });
  tw.bindFile(tfile, { replay: false });
  tw.pinFile(tfile);
  await sleep(120);

  // 有完整 TR 正文 → 不应 pending
  append(tfile, {
    type: 'user.message',
    data: { content: '你好', messageId: 'u-hi' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 't-hi' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.message',
    data: { messageId: 'a-hi', content: '你好，我是 Copilot' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_end',
    data: {},
    timestamp: new Date().toISOString(),
  });
  await sleep(500);

  const n1 = events.length;
  append(cfile, {
    kind: 2,
    i: 0,
    k: ['requests'],
    v: [
      {
        requestId: 'rid-hi',
        timestamp: 5000,
        message: { text: '你好' },
        response: [{ kind: 'markdownContent', value: 'CS 重复的你好回复不该出现' }],
        isComplete: true,
      },
    ],
  });
  await sleep(800);
  const leaked = agentTexts(events.slice(n1)).filter((t) => t.includes('CS 重复'));
  check('D1 无 pending 不投 CS 助手', leaked.length === 0, JSON.stringify(leaked));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  console.log('0.5.26 per-request gap-fill 回归');
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioF();
  await scenarioE();
  await scenarioG();
  console.log('\n' + '='.repeat(52));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

async function scenarioE() {
  console.log("\n=== E. transcript stale，phone live 仍能从 chatSessions gap-fill ===");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gapE-"));
  const dir = path.join(tmp, "transcripts");
  const csDir = path.join(tmp, "chatSessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = "sess-stale";
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, "{\n" + JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + "\n");
  fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + "\n");

  const events = [];
  const tw = new TranscriptWatcher({
    dir,
    chatSessionsDir: csDir,
    pollMs: 40,
    fallbackPollMs: 60,
    onEvent(ev) {
      events.push(ev);
    },
  });
  tw.bindFile(tfile, { replay: false, phoneSelectLive: true });
  tw.pinFile(tfile);
  await sleep(120);

  const n1 = events.length;
  // phone sends "回复我 777" (no transcript user.message), only chatSessions later writes it
  tw.addPendingPhoneUserText('回复我 777');
  fs.appendFileSync(cfile, JSON.stringify({
    kind: 2,
    i: 0,
    k: ["requests"],
    v: [{
      requestId: "rid-777",
      timestamp: 1000,
      message: { text: "回复我 777" },
      response: [{ kind: "markdownContent", value: "777" }],
      isComplete: true,
    }],
  }) + "\n");
  await waitFor(() => agentTexts(events.slice(n1)).some((t) => t.includes("777")), 3000);
  const texts = agentTexts(events.slice(n1));
  check("E1 transcript stale 仍 gap 出 777", texts.some((t) => t.includes("777")), JSON.stringify(texts));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

async function scenarioF() {
  console.log('\n=== F. 同一回复文字（123）在不同轮次应各显示一次 ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gapF-'));
  const dir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'sess-sametext';
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, '');
  fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n');

  const events = [];
  const tw = new TranscriptWatcher({
    dir,
    chatSessionsDir: csDir,
    pollMs: 40,
    fallbackPollMs: 60,
    onEvent(ev) { events.push(ev); },
  });
  tw.bindFile(tfile, { replay: false, phoneSelectLive: true });
  tw.pinFile(tfile);
  await sleep(120);

  // phone sends two different user texts that both get reply '123'
  tw.addPendingPhoneUserText('回复我 123');
  const n1 = events.length;
  fs.appendFileSync(cfile, JSON.stringify({
    kind: 2,
    i: 0,
    k: ['requests'],
    v: [{
      requestId: 'rid-123-1',
      timestamp: 1000,
      message: { text: '回复我 123' },
      response: [{ kind: 'markdownContent', value: '123' }],
      isComplete: true,
    }],
  }) + '\n');
  await waitFor(() => agentTexts(events.slice(n1)).some((t) => t === '123'), 2000);
  check('F1 第一轮 123 正常', agentTexts(events.slice(n1)).some((t) => t === '123'));

  tw.addPendingPhoneUserText('回复我哦123');
  const n2 = events.length;
  fs.appendFileSync(cfile, JSON.stringify({
    kind: 2,
    i: 1,
    k: ['requests'],
    v: [{
      requestId: 'rid-123-2',
      timestamp: 2000,
      message: { text: '回复我哦123' },
      response: [{ kind: 'markdownContent', value: '123' }],
      isComplete: true,
    }],
  }) + '\n');
  await waitFor(() => events.slice(n2).some((e) => e.type === 'AGENT_MESSAGE' && String(e.text).includes('123')), 2000);
  const after = events.slice(n2);
  const texts = agentTexts(after);
  check('F2 第二轮同样 123 也应显示', texts.some((t) => t === '123'), JSON.stringify(texts));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function scenarioG() {
  console.log('\n=== G. 二次 bind 后仍能 gap-fill ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gapG-'));
  const dir = path.join(tmp, 'transcripts');
  const csDir = path.join(tmp, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(csDir, { recursive: true });
  const sid = 'sess-rebind';
  const tfile = path.join(dir, `${sid}.jsonl`);
  const cfile = path.join(csDir, `${sid}.jsonl`);
  fs.writeFileSync(tfile, '');
  fs.writeFileSync(cfile, JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n');

  const events = [];
  const tw = new TranscriptWatcher({
    dir,
    chatSessionsDir: csDir,
    pollMs: 40,
    fallbackPollMs: 60,
    onEvent(ev) { events.push(ev); },
  });
  tw.bindFile(tfile, { replay: false, phoneSelectLive: true });
  tw.pinFile(tfile);
  await sleep(80);

  tw.addPendingPhoneUserText('回复我 888');
  tw.bindFile(tfile, { replay: false, phoneSelectLive: true });
  tw.addPendingPhoneUserText('回复我 888');

  const n1 = events.length;
  fs.appendFileSync(cfile, JSON.stringify({
    kind: 2,
    i: 0,
    k: ['requests'],
    v: [{
      requestId: 'rid-888',
      timestamp: 1000,
      message: { text: '回复我 888' },
      response: [{ kind: 'markdownContent', value: '888' }],
      isComplete: true,
    }],
  }) + '\n');
  await waitFor(() => agentTexts(events.slice(n1)).some((t) => t.includes('888')), 3000);
  check('G1 二次 bind 后仍能 gap 888', agentTexts(events.slice(n1)).some((t) => t.includes('888')), JSON.stringify(agentTexts(events.slice(n1))));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}

