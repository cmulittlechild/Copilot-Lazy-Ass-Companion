#!/usr/bin/env node
/**
 * R132 三连回归：
 * F2/F3 同文同答连发时第 N 发答案+DONE 被「幻影重投影纠偏」误杀——纠偏把
 *       真答改写归旧轮后 altDup 整条吞。真答豁免：归属轮是事件发生时已存在
 *       的开启轮（evTs ≥ turn.ts）。
 * F4    同 sid 的 AGENT_STREAM_END 60s 内重投（transcript 游离帧，无 START）→ 丢。
 * F5    同文案 AGENT_CONFIRM 异构 cid 双通道各投一遍 → c2 内容指纹判重丢。
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { TurnArbiter } = require(path.join(ROOT, 'dist/turnArbiter.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name} → ${detail}`); }
}
const SESS = 'd00df00d';
const Q = 'R132: 用中文写一段关于秋天的短文';
const A = '秋天是金色的季节。树叶变黄，风渐凉，田野里一片丰收的景象，这是关于秋天的短文。';

async function main() {
  // ---- F2/F3：同文×3 连发，各轮答案同文必须都广播 ----
  const arb = new TurnArbiter();
  arb.accept({ type: 'SESSION_SELECTED', _sess: `${SESS}.jsonl` });
  const t0 = Date.now();

  // 轮 1：USER → 答案 → DONE（完全收尾）
  arb.accept({ type: 'USER_MESSAGE', text: Q, timestamp: t0 });
  const a1 = arb.accept({
    type: 'AGENT_MESSAGE', text: A, streamId: 't1aaaa',
    timestamp: t0 + 5000, _sess: SESS,
  });
  check('轮1答案放行', !!a1, '');
  const d1 = arb.accept({
    type: 'COPILOT_DONE', reason: 'result', timestamp: t0 + 5500, _sess: SESS,
    _ut: Q,
  });
  check('轮1 DONE 放行', !!d1, '');

  // 轮 2：同文 USER → 同文答案（transcript 通道：无 _ut、无 requestIndex）
  arb.accept({ type: 'USER_MESSAGE', text: Q, timestamp: t0 + 20000 });
  const a2 = arb.accept({
    type: 'AGENT_MESSAGE', text: A, streamId: 't2bbbb',
    timestamp: t0 + 25000, _sess: SESS,
  });
  check('轮2同文答案不被误杀', !!a2, '被纠偏吞掉了');
  const d2 = arb.accept({
    type: 'COPILOT_DONE', reason: 'result', timestamp: t0 + 25500, _sess: SESS,
    _ut: Q,
  });
  check('轮2 DONE 放行（recentClose）', !!d2, '');

  // 轮 3：连发形态——USER 紧接着再发，答案带 sid 经 sessiondb 通道（reqIdx=-1）
  arb.accept({ type: 'USER_MESSAGE', text: Q, timestamp: t0 + 30000 });
  const a3 = arb.accept({
    type: 'AGENT_MESSAGE', text: A, streamId: `sessiondb/${SESS}/9`,
    requestIndex: -1, timestamp: t0 + 36000, _sess: SESS,
  });
  check('轮3 sessiondb 同文答案放行', !!a3, '被 FIFO/gotAgent 误杀');

  // 反向：真正的幻影重投影仍被压——轮1答案无 _ut 无 ts 证据迟到重投，
  // 到达时无开启轮可证真身（全部已答）→ 判死。
  const phantom = arb.accept({
    type: 'AGENT_MESSAGE', text: A, streamId: 't1aaaa-ghost',
    timestamp: t0 + 40000, _sess: SESS,
  });
  // 注意：全部轮已答，幻影无开启轮可挂——ownerTurn 落空或已答 → 丢。
  check('轮1重投影仍被丢', phantom === null, `out=${phantom && phantom.type}`);

  // ---- F4：同 sid 重复 END 帧判死 ----
  const arb2 = new TurnArbiter();
  arb2.accept({ type: 'SESSION_SELECTED', _sess: `${SESS}.jsonl` });
  const e1 = arb2.accept({
    type: 'AGENT_STREAM_END', streamId: 't1f1f1', timestamp: Date.now(), _sess: SESS,
  });
  check('首个 END 放行', !!e1, '');
  const e2 = arb2.accept({
    type: 'AGENT_STREAM_END', streamId: 't1f1f1', timestamp: Date.now() + 2000, _sess: SESS,
  });
  check('60s 内重投 END 被丢', e2 === null, '');
  // 窗口按到达时刻计（now-上次 END 到达 <60s），伪造 ev.timestamp 测不了窗外。

  // ---- F5：同文案异构 cid 确认卡判重 ----
  const arb3 = new TurnArbiter();
  arb3.accept({ type: 'SESSION_SELECTED', _sess: `${SESS}.jsonl` });
  arb3.accept({ type: 'USER_MESSAGE', text: 'R132: run ls please', timestamp: Date.now() });
  const k1 = arb3.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-aaa', title: 'Run command?',
    message: 'ls -la', timestamp: Date.now(), _sess: SESS,
  });
  check('首张确认卡放行', !!k1, '');
  const k2 = arb3.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-bbb', title: 'Run command?',
    message: 'ls -la', timestamp: Date.now(), _sess: SESS,
  });
  check('异构 cid 同文案卡被丢', k2 === null, '');
  const k3 = arb3.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-ccc', title: 'Run command?',
    message: 'rm -rf /tmp/x', timestamp: Date.now(), _sess: SESS,
  });
  check('不同文案新卡放行', !!k3, '');
  // 回放副本经 emittedConfirms 也丢
  const k4 = arb3.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-ddd', title: 'Run command?',
    message: 'ls -la', timestamp: Date.now(), _sess: SESS, replayed: true,
  });
  check('回放同文案卡被丢', k4 === null, '');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('failed:', failures.join(', ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
