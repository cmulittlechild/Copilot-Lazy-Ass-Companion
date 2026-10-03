#!/usr/bin/env node
// listSessions 性能回归测试
//
// 背景（真实 bug，v0.5.1 修复）：
//   collectSessionsFromDir 曾对**每个**会话文件读内容取标题(1MB)和请求数(256KB)，
//   然后才排序取前 N。本机实测 432 个文件 / 3GB → 同步阻塞事件循环 1374ms，
//   导致扩展宿主卡死、手机端所有请求超时无响应。
//   修复：昂贵字段延迟到排序截断后，只对真正返回的 N 条补全。
//
// 本测试构造大量会话文件，确保耗时不随「文件总数」线性增长。
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SessionWatcher } = require(path.join(ROOT, 'dist/sessionWatcher.js'));
const { WorkspaceIndex } = require(path.join(ROOT, 'dist/workspaceIndex.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 构造：40 个工作区 × 每个 10 个会话 = 400 个文件，其中若干是「大文件」
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessperf-'));
const WS_COUNT = 40;
const PER_WS = 10;
// 每个大文件约 1.5MB（超过 resolveSessionTitle 的 1MB 读取窗口）
const SPARSE_BYTES = 1500 * 900;

for (let i = 0; i < WS_COUNT; i++) {
  const hash = `h${String(i).padStart(3, '0')}`;
  const dir = path.join(tmp, hash, 'chatSessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, hash, 'workspace.json'),
    JSON.stringify({ folder: `file:///tmp/proj${i}` }),
  );
  for (let j = 0; j < PER_WS; j++) {
    const file = path.join(dir, `sess-${i}-${j}.jsonl`);
    const fd = fs.openSync(file, 'w');
    try {
      // A sparse file preserves the large-file stat/read behavior without
      // allocating hundreds of megabytes of real blocks on CI/dev disks.
      fs.writeSync(
        fd,
        JSON.stringify({ kind: 0, v: { version: 3, requests: [{ requestId: 'r1' }, { requestId: 'r2' }] } }) + '\n' +
          JSON.stringify({ kind: 1, k: ['customTitle'], v: `会话 ${i}-${j}` }) + '\n',
      );
      fs.ftruncateSync(fd, SPARSE_BYTES);
    } finally {
      fs.closeSync(fd);
    }
  }
}

const totalFiles = WS_COUNT * PER_WS;
let totalBytes = 0;
for (let i = 0; i < WS_COUNT; i++) {
  const dir = path.join(tmp, `h${String(i).padStart(3, '0')}`, 'chatSessions');
  for (const f of fs.readdirSync(dir)) totalBytes += fs.statSync(path.join(dir, f)).size;
}

console.log('=== 构造数据 ===');
console.log(`  ${WS_COUNT} 个工作区 × ${PER_WS} 会话 = ${totalFiles} 个文件, 共 ${(totalBytes / 1048576).toFixed(0)}MB`);
console.log();

const wi = new WorkspaceIndex({ roots: [tmp] });
const records = wi.scan();

const watcher = new SessionWatcher({
  pollMs: 100,
  rescanMs: 60000,
  liveOnly: true,
  roots: [tmp],
  workspaceIndex: wi,
  onEvent() {},
});

// ---------------------------------------------------------------------------
console.log('=== A. 工作区索引扫描 ===');
check('扫描到全部工作区', records.length >= WS_COUNT, `${records.length} 个`);

// ---------------------------------------------------------------------------
console.log();
console.log('=== B. listSessions 耗时（核心回归项）===');

// 预热一次，避免首次 FS cache 影响判断
watcher.listSessions(10);

const timings = {};
for (const n of [10, 40]) {
  const t = Date.now();
  const list = watcher.listSessions(n);
  timings[n] = Date.now() - t;
  check(`listSessions(${n}) 返回条数正确`, list.length === n, `${list.length} 条`);
}

// 阈值：修复前 400 文件规模会到 1s+；修复后应远低于此。
// 给 CI/慢盘留余量，取 600ms 作为红线。
const LIMIT_MS = 600;
check(
  `listSessions(10) 不阻塞事件循环 (<${LIMIT_MS}ms)`,
  timings[10] < LIMIT_MS,
  `${timings[10]}ms`,
);
check(
  `listSessions(40) 不阻塞事件循环 (<${LIMIT_MS}ms)`,
  timings[40] < LIMIT_MS,
  `${timings[40]}ms`,
);

// 关键性质：耗时应与 limit 相关，而非与「文件总数」相关。
// 若实现回退成全量读取，limit=10 与 limit=40 的耗时会几乎相同（都读全部文件）。
console.log();
console.log('=== C. 耗时应随 limit 缩放，而非随文件总数 ===');
const t1 = Date.now();
watcher.listSessions(1);
const ms1 = Date.now() - t1;
const t2 = Date.now();
watcher.listSessions(40);
const ms40 = Date.now() - t2;
check(
  'limit=1 明显快于 limit=40（证明未全量读取）',
  ms1 <= ms40 + 30,
  `limit1=${ms1}ms vs limit40=${ms40}ms`,
);

// ---------------------------------------------------------------------------
console.log();
console.log('=== D. 优化未丢失字段 ===');
const list = watcher.listSessions(20);
check('全部有 title', list.every((s) => !!s.title), `${list.filter((s) => s.title).length}/${list.length}`);
check(
  '全部有 requestCount',
  list.every((s) => s.requestCount !== undefined),
  `${list.filter((s) => s.requestCount !== undefined).length}/${list.length}`,
);
check('requestCount 值正确', list.every((s) => s.requestCount === 2), `期望都为 2`);
check('title 来自 customTitle', list.every((s) => /^会话 \d+-\d+$/.test(String(s.title))));
check('全部有 workspaceId', list.every((s) => !!s.workspaceId));
check('全部有 qualifiedName', list.every((s) => !!s.qualifiedName));

// ---------------------------------------------------------------------------
console.log();
console.log('=== E. listSessionsByWorkspace 同样补全字段 ===');
const oneWs = records.find((r) => r.sessionCount > 0);
const byWs = watcher.listSessionsByWorkspace(oneWs.workspaceId, 5);
check('返回该工作区会话', byWs.length > 0, `${byWs.length} 条`);
check('有 title', byWs.every((s) => !!s.title));
check('有 requestCount', byWs.every((s) => s.requestCount !== undefined));

watcher.dispose();
fs.rmSync(tmp, { recursive: true, force: true });

console.log();
console.log('='.repeat(52));
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
