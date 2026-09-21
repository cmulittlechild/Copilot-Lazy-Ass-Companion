#!/usr/bin/env node
/**
 * 大会话文件历史回放回归测试。
 *
 * 锁定两个真实 bug（0.5.2 修复）：
 *   A. projectHistory 整读文件 → 325MB 会话耗时 4900ms、堆 +767MB，冻结扩展宿主
 *   B. 固定 4MB 尾部窗口可能整个落在一个 0.9MB 超大行中间，
 *      丢弃截断首行后几乎不剩内容（实测 177MB/128MB 文件只投出 2 个事件，
 *      手机端切过去看到空白）
 *
 * 断言核心：耗时/内存不随文件总大小线性增长，且大文件仍能投出足够事件。
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { fileURLToPath } = await import('url');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SessionWatcher } = require(path.join(ROOT, 'dist/sessionWatcher.js'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` (${detail})` : ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bigsess-'));
const dir = path.join(tmp, 'hash1', 'chatSessions');
fs.mkdirSync(dir, { recursive: true });

/** 造一个会话文件：kind=0 空快照 + N 条 kind=2 增量，可选插入超大行 */
function makeSession(name, opts) {
  const { requests, padPerLine = 0, giantLineMB = 0 } = opts;
  const file = path.join(dir, name);
  const out = fs.createWriteStream(file);
  out.write(
    JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + '\n',
  );
  // customTitle 独立行（真实格式）
  out.write(
    JSON.stringify({ kind: 1, k: ['customTitle'], v: '大文件测试会话' }) + '\n',
  );
  for (let i = 0; i < requests; i++) {
    const pad = padPerLine ? 'x'.repeat(padPerLine) : '';
    out.write(
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [
          {
            requestId: `req_${i}`,
            timestamp: Date.now() - (requests - i) * 1000,
            message: { text: `问题 ${i}${pad ? ' ' + pad.slice(0, 40) : ''}` },
            response: [{ value: `回答 ${i}${pad}` }],
            isComplete: true,
          },
        ],
      }) + '\n',
    );
  }
  // 尾部前插一个超大行，模拟真实的 0.9MB 单行（触发 bug B）
  if (giantLineMB > 0) {
    out.write(
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [
          {
            requestId: 'req_giant',
            timestamp: Date.now(),
            message: { text: '超大请求' },
            response: [{ value: 'G'.repeat(giantLineMB * 1024 * 1024) }],
            isComplete: true,
          },
        ],
      }) + '\n',
    );
    // 超大行之后只留极少几行 —— 固定 4MB 窗口会正好卡在超大行中间
    for (let i = 0; i < 3; i++) {
      out.write(
        JSON.stringify({
          kind: 2,
          k: ['requests'],
          v: [
            {
              requestId: `tail_${i}`,
              timestamp: Date.now(),
              message: { text: `尾部问题 ${i}` },
              response: [{ value: `尾部回答 ${i}` }],
              isComplete: true,
            },
          ],
        }) + '\n',
      );
    }
  }
  out.end();
  return new Promise((res) => out.on('close', () => res(file)));
}

console.log('=== 构造测试夹具 ===');
// 小文件：低于大文件阈值，走整读路径
const small = await makeSession('small.jsonl', { requests: 30 });
// 大文件：远超 8MB 阈值（每行约 20KB × 1200 行 ≈ 24MB）
const big = await makeSession('big.jsonl', { requests: 1200, padPerLine: 20 * 1024 });
// 超大行文件：尾部有 6MB 单行，固定 4MB 窗口必然落在其中间
const giant = await makeSession('giant.jsonl', {
  requests: 600,
  padPerLine: 20 * 1024,
  giantLineMB: 6,
});
for (const [n, f] of [['small', small], ['big', big], ['giant', giant]]) {
  console.log(`  ${n}: ${(fs.statSync(f).size / 1048576).toFixed(1)}MB`);
}

const w = new SessionWatcher({
  pollMs: 100,
  rescanMs: 60000,
  liveOnly: true,
  roots: [tmp],
  onEvent() {},
});

function measure(file) {
  const m0 = process.memoryUsage().heapUsed;
  const t = Date.now();
  const h = w.projectHistory(file, 20);
  const ms = Date.now() - t;
  const heapMB = (process.memoryUsage().heapUsed - m0) / 1048576;
  return {
    ms,
    heapMB,
    events: h.length,
    users: h.filter((e) => e.type === 'USER_MESSAGE').length,
    agents: h.filter((e) => e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET')
      .length,
  };
}

console.log('\n=== A. 小文件（整读路径）不受影响 ===');
const rs = measure(small);
ok('小文件能回放', rs.events > 0, `${rs.events} 事件`);
ok('含用户消息', rs.users > 0, `user=${rs.users}`);
ok('含助手消息', rs.agents > 0, `agent=${rs.agents}`);
ok('小文件够快', rs.ms < 300, `${rs.ms}ms`);

console.log('\n=== B. 大文件不整读（bug A 回归）===');
const rb = measure(big);
const bigMB = fs.statSync(big).size / 1048576;
ok('大文件能回放', rb.events > 0, `${rb.events} 事件`);
ok('含用户消息', rb.users > 0, `user=${rb.users}`);
ok(
  '耗时不随文件大小线性增长',
  rb.ms < 500,
  `${bigMB.toFixed(0)}MB → ${rb.ms}ms`,
);
// 堆增长的下限由尾窗大小（4MB）的解析开销决定，与文件总大小无关，
// 所以这里用绝对上限而不是文件大小的比例。
// 真实数据佐证：325MB 会话文件实测 34ms / 堆 +13MB。
ok(
  '堆增长有绝对上限（未整读）',
  rb.heapMB < 80,
  `堆+${rb.heapMB.toFixed(0)}MB（文件 ${bigMB.toFixed(0)}MB）`,
);

console.log('\n=== C. 尾部超大行自适应扩窗（bug B 回归）===');
const rg = measure(giant);
const giantMB = fs.statSync(giant).size / 1048576;
ok(
  '超大行文件仍能投出足够事件',
  rg.events >= 10,
  `${giantMB.toFixed(0)}MB → ${rg.events} 事件（修复前仅 2）`,
);
ok('含用户消息（非空白）', rg.users > 0, `user=${rg.users}`);
ok('扩窗后仍在可接受耗时内', rg.ms < 800, `${rg.ms}ms`);

console.log('\n=== D. 事件量有上限（避免手机端洪水）===');
// 造一个请求数极多的文件，验证 mutations 截断生效
const many = await makeSession('many.jsonl', { requests: 3000 });
const rm = measure(many);
ok('事件数被截断', rm.events < 4000, `${rm.events} 事件（3000 请求）`);
ok('多请求文件也不慢', rm.ms < 800, `${rm.ms}ms`);

console.log('\n=== E. 异常输入不崩 ===');
const bad = path.join(dir, 'bad.jsonl');
fs.writeFileSync(bad, 'not json\n{"kind":0,\n\x00\x01garbage\n');
let threw = false;
try {
  w.projectHistory(bad, 20);
} catch {
  threw = true;
}
ok('损坏文件不抛错', !threw);
let threw2 = false;
try {
  w.projectHistory(path.join(dir, 'nonexistent.jsonl'), 20);
} catch {
  threw2 = true;
}
ok('不存在的文件不抛错', !threw2);
const empty = path.join(dir, 'empty.jsonl');
fs.writeFileSync(empty, '');
ok('空文件返回空数组', w.projectHistory(empty, 20).length === 0);

w.dispose();
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '='.repeat(52));
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
