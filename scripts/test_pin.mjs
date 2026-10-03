#!/usr/bin/env node
// pin 机制回归测试：手动选择旧会话后，周期 rescan 不得按 mtime 抢回最新会话
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
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
const dir = path.join(tmp, 'transcripts');
const csDir = path.join(tmp, 'chatSessions');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(csDir, { recursive: true });

const W = (f, o) => fs.writeFileSync(f, JSON.stringify(o) + '\n');
const a = path.join(dir, 'A.jsonl');
const b = path.join(dir, 'B.jsonl');
W(a, { type: 'session.start', data: { sessionId: 'A' } });
W(b, { type: 'session.start', data: { sessionId: 'B' } });
const ca = path.join(csDir, 'A.jsonl');
const cb = path.join(csDir, 'B.jsonl');
W(ca, { kind: 0, v: { requests: [] } });
W(cb, { kind: 0, v: { requests: [] } });
// A 是最新 mtime（模拟「项目学习与理解」正在活跃）
const now = Date.now();
fs.utimesSync(a, now / 1000, now / 1000);
fs.utimesSync(b, now / 1000 - 60000, now / 1000 - 60000);
fs.utimesSync(ca, now / 1000, now / 1000);
fs.utimesSync(cb, now / 1000 - 60000, now / 1000 - 60000);

const tw = new TranscriptWatcher({
  dir,
  chatSessionsDir: csDir,
  pollMs: 50,
  fallbackPollMs: 100,
  onEvent() {},
});

const t0 = Date.now();
let currentFile = null;

async function main() {
  console.log('=== A. 启动默认绑定最新 (A) ===');
  tw.start();
  await sleep(600);
  currentFile = tw.currentFile;
  check('启动绑定最新会话 A', path.basename(String(currentFile)) === 'A.jsonl', path.basename(String(currentFile)));

  console.log();
  console.log('=== B. 手动选择旧会话 B 并 pin ===');
  tw.bindFile(b, { replay: true });
  tw.pinFile(b);
  currentFile = tw.currentFile;
  check('bindFile(B) 后 current=B', path.basename(String(currentFile)) === 'B.jsonl', path.basename(String(currentFile)));

  console.log();
  console.log('=== C. 等 3 个 rescan 周期（A 仍最新但 B 也活跃），pin 保持 ===');
  const touchB = setInterval(() => {
    const t2 = Date.now() / 1000;
    fs.utimesSync(b, t2, t2);
  }, 500);
  await sleep(2500); // 2s rescan 周期 × 1+ 
  currentFile = tw.currentFile;
  check('pin 期间未被抢回 A', path.basename(String(currentFile)) === 'B.jsonl', path.basename(String(currentFile)));
  // 再等一轮，确认稳定
  await sleep(2200);
  currentFile = tw.currentFile;
  check('pin 持续有效（6s 后仍是 B）', path.basename(String(currentFile)) === 'B.jsonl', path.basename(String(currentFile)));

  console.log();
  clearInterval(touchB);

  console.log('=== D. pin 文件沉默 > PIN_STALE_MS 后应自动切回最新 A ===');
  const now2 = Date.now();
  fs.utimesSync(b, now2 / 1000, now2 / 1000 - 20000);
  await sleep(12000);
  currentFile = tw.currentFile;
  check('沉默 pin 自动切换回 A', path.basename(String(currentFile)) === 'A.jsonl', path.basename(String(currentFile)));

  console.log('=== E. 解除 pin 后恢复自动跟随最新 ===');
  tw.pinFile(null);
  await sleep(2500);
  currentFile = tw.currentFile;
  check('解除 pin 后自动跟随回 A', path.basename(String(currentFile)) === 'A.jsonl', path.basename(String(currentFile)));

  console.log();
  console.log('='.repeat(52));
  console.log(`结果: ${pass} 通过, ${fail} 失败   (耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(2);
});
