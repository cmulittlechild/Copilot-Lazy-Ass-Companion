#!/usr/bin/env node
/**
 * 会话切换回归测试（锁定 0.5.2 修复的三个真实 bug）
 *
 * Bug1  选中会话后看不到历史        → PHONE_SESSION_SELECT 传空数组给 replaySession
 * Bug2  切走再切回就选不回来        → 周期 scan() 把 current 抢回全局最新文件
 * Bug3  活跃会话显示「0 次请求」    → countRequestsQuick 只看 kind=0 快照（常为空）
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SessionWatcher } = require(path.join(ROOT, 'dist/sessionWatcher.js'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name + (detail ? ` (${detail})` : ''));
  } else {
    fails.push(name + (detail ? ` (${detail})` : ''));
    console.log('  ✗ ' + name + (detail ? ` (${detail})` : ''));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 构造夹具
// 关键：kind=0 快照 requests 为空，真实请求全在 kind=2 增量里（复刻真实数据形态）
function makeSession(dir, id, turns, sinceMs) {
  const lines = [];
  lines.push(JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }));
  // 真实格式：customTitle 是独立的 kind=1 变更行，不是 kind=0 快照里的字段
  lines.push(JSON.stringify({ kind: 1, k: ['customTitle'], v: `会话-${id}` }));
  for (let i = 0; i < turns; i++) {
    lines.push(
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [
          {
            requestId: `request_${id}_${i}`,
            timestamp: Date.now() - sinceMs,
            message: { text: `问题${i}@${id}` },
            response: [{ value: `回答${i}@${id}` }],
            isCanceled: false,
          },
        ],
      }),
    );
  }
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const t = (Date.now() - sinceMs) / 1000;
  fs.utimesSync(f, t, t);
  return f;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sesssel-'));
const csDir = path.join(root, 'hash_a', 'chatSessions');
fs.mkdirSync(csDir, { recursive: true });

const fileOld = makeSession(csDir, 'aaa-old', 3, 600_000); // 10 分钟前
const fileNew = makeSession(csDir, 'bbb-new', 2, 1_000); // 最新

// ---------------------------------------------------------------- Bug3
console.log('=== Bug3: requestCount 不能只看 kind=0 快照 ===');
{
  const w = new SessionWatcher({
    pollMs: 50,
    rescanMs: 100_000,
    liveOnly: true,
    roots: [root],
    onEvent() {},
  });
  const list = w.listSessions(20);
  const so = list.find((x) => x.file === fileOld);
  const sn = list.find((x) => x.file === fileNew);
  ok('列出两个会话', list.length >= 2, `${list.length} 条`);
  ok('旧会话 requestCount>0', (so?.requestCount ?? 0) > 0, `= ${so?.requestCount}`);
  ok('新会话 requestCount>0', (sn?.requestCount ?? 0) > 0, `= ${sn?.requestCount}`);
  ok('计数与实际轮次一致', so?.requestCount === 3 && sn?.requestCount === 2, `${so?.requestCount}/${sn?.requestCount}`);
  ok('customTitle 被解析', so?.title === '会话-aaa-old', so?.title);
  w.dispose();
}

// ---------------------------------------------------------------- Bug1
console.log('\n=== Bug1: projectHistory 必须返回历史事件（含 kind=2 增量）===');
{
  const w = new SessionWatcher({
    pollMs: 50,
    rescanMs: 100_000,
    liveOnly: true,
    roots: [root],
    onEvent() {},
  });
  const hist = w.projectHistory(fileOld, 20);
  const users = hist.filter((e) => e.type === 'USER_MESSAGE');
  const agents = hist.filter((e) => e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET');
  ok('返回非空历史', hist.length > 0, `${hist.length} 个事件`);
  ok('含全部用户消息', users.length === 3, `${users.length}/3`);
  ok('含助手回复', agents.length > 0, `${agents.length} 条`);
  ok('内容来自目标会话', users.every((u) => String(u.text).includes('aaa-old')));
  ok('不串入其他会话', !hist.some((e) => String(e.text || '').includes('bbb-new')));

  // 不污染 live 投影状态：projectHistory 用独立 projector
  const live = [];
  const w2 = new SessionWatcher({
    pollMs: 50,
    rescanMs: 100_000,
    liveOnly: true,
    roots: [root],
    onEvent(e) {
      live.push(e);
    },
  });
  w2.projectHistory(fileOld, 20);
  ok('projectHistory 不走 onEvent（不污染 live）', live.length === 0, `live=${live.length}`);
  w2.dispose();
  w.dispose();
}

// ---------------------------------------------------------------- Bug2
console.log('\n=== Bug2: 选中的会话不能被周期 scan 抢回最新文件 ===');
{
  const w = new SessionWatcher({
    pollMs: 30,
    rescanMs: 60, // 高频 rescan，放大抢占问题
    liveOnly: true,
    roots: [root],
    onEvent() {},
  });
  w.start();
  await sleep(150);
  ok('未选择时自动跟随最新会话', w.currentFile === fileNew, path.basename(String(w.currentFile)));

  // 选旧会话，等多轮 rescan
  ok('selectSession(旧) 返回 true', w.selectSession(fileOld) === true);
  await sleep(400);
  ok('多轮 rescan 后仍停留在旧会话', w.currentFile === fileOld, path.basename(String(w.currentFile)));

  // 即使目标会话被写入变成最新，也不能漂移
  fs.appendFileSync(
    fileNew,
    JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'r_new_x', message: { text: '新活动' } }] }) + '\n',
  );
  await sleep(300);
  ok('其他会话有新活动也不漂移', w.currentFile === fileOld, path.basename(String(w.currentFile)));

  // 切走再切回（用户实际操作路径）
  ok('切到新会话', w.selectSession(fileNew) === true);
  await sleep(200);
  ok('已切到新会话', w.currentFile === fileNew, path.basename(String(w.currentFile)));

  ok('切回旧会话返回 true（关键：修复前重复选同一文件会短路）', w.selectSession(fileOld) === true);
  await sleep(200);
  ok('成功切回旧会话', w.currentFile === fileOld, path.basename(String(w.currentFile)));

  // 重复选同一会话必须仍能重新投影（feed 已被清空，需要重放）
  const before = w.currentFile;
  ok('重复选同一会话仍返回 true', w.selectSession(fileOld) === true);
  ok('重复选后绑定不变', w.currentFile === before);

  w.dispose();
}

// ---------------------------------------------------------------- 清理
fs.rmSync(root, { recursive: true, force: true });

console.log('\n' + '='.repeat(52));
console.log(`结果: ${pass} 通过, ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
