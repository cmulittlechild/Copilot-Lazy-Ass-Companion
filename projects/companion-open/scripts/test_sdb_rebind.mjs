#!/usr/bin/env node
/**
 * R109 归属窃取回归：sessiondb 行的 _ut 来自 user_message 字段，上游会把
 * 「被停在途生成」的内容写进下一请求的行。裁决器须按内容重叠改判真实
 * 归属轮，配对 DONE 随行改判；无 _ut 的行按 FIFO 归最老未获答轮。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESS = 'c752b399';

const K_TEXT = 'R109K: write a 200-word essay about mesas';
const L_TEXT = 'R109L: reply with exactly: lima109 ok';
const K_ANSWER =
  '**R109K: Mesas**\n\nMesas are flat-topped hills with steep sides. ' +
  'This essay is about mesas and their geological formation, written as a ' +
  '200-word essay exploring how mesas form over millions of years.';
const L_ANSWER = 'lima109 ok';

async function main() {
  const arb = new TurnArbiter();
  arb.accept({ type: 'SESSION_SELECTED', _sess: `${SESS}.jsonl` });

  // K 开启（手机发出，无 _sess——归 boundSess）
  const u1 = arb.accept({ type: 'USER_MESSAGE', text: K_TEXT, timestamp: Date.now() });
  check('K 的 USER 放行并打戳', u1 && u1._ut, JSON.stringify(u1 && u1._ut));

  // K 被 phone_stop 关掉（answered，但从未收到答案）
  const d1 = arb.accept({ type: 'COPILOT_DONE', reason: 'phone_stop', timestamp: Date.now() });
  check('stop DONE 放行且带 closedUt', d1 && d1.closedUt, '');

  // L 开启
  const u2 = arb.accept({ type: 'USER_MESSAGE', text: L_TEXT, timestamp: Date.now() });
  check('L 的 USER 放行', u2 && u2._ut, '');

  // 核心：sessiondb 行 user_message=L 但内容是 K 的作文 → 应改判回 K
  const a1 = arb.accept({
    type: 'AGENT_MESSAGE',
    text: K_ANSWER,
    streamId: `sessiondb/${SESS}/77`,
    requestIndex: -1,
    timestamp: Date.now(),
    _ut: L_TEXT,
    _sess: SESS,
  });
  check('错位行被改判回 K', a1 && a1._ut && a1._ut.startsWith('R109K'), `ut=${a1 && a1._ut}`);
  check('错位行仍放行', !!a1, '');

  // 配对 DONE 随行改判：_ut=L 的 DONE 应被改判为 K
  const d2 = arb.accept({
    type: 'COPILOT_DONE',
    requestIndex: -1,
    timestamp: Date.now(),
    _ut: L_TEXT,
    _sess: SESS,
  });
  check('配对 DONE 随行改判', d2 && String(d2._ut).startsWith('R109K'), `ut=${d2 && d2._ut}`);

  // L 自己的真答：内容匹配 L 的行不应被改判
  const a2 = arb.accept({
    type: 'AGENT_MESSAGE',
    text: L_ANSWER,
    streamId: `sessiondb/${SESS}/78`,
    requestIndex: -1,
    timestamp: Date.now(),
    _ut: L_TEXT,
    _sess: SESS,
  });
  check('L 真答不被改判', a2 && String(a2._ut).startsWith('R109L'), `ut=${a2 && a2._ut}`);

  // FIFO：无 _ut 的 sessiondb 行归最老未获答轮（新开轮 M，未获答）
  const u3 = arb.accept({ type: 'USER_MESSAGE', text: 'R109M: reply with exactly: mike109 ok', timestamp: Date.now() });
  check('M 的 USER 放行', !!u3, '');
  const a3 = arb.accept({
    type: 'AGENT_MESSAGE',
    text: 'mike109 ok',
    streamId: `sessiondb/${SESS}/79`,
    requestIndex: -1,
    timestamp: Date.now(),
    _sess: SESS,
  });
  check('无_ut 行 FIFO 归 M', a3 && String(a3._ut).startsWith('R109M'), `ut=${a3 && a3._ut}`);

  // AGENT_CONFIRM 回放副本去重：live 投过后，回放件再晚到都丢
  const c1 = arb.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-42', title: 'Run?', message: 'run ls',
    timestamp: Date.now(), _sess: SESS,
  });
  check('live 确认卡放行', !!c1, '');
  const c2 = arb.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-42', title: 'Run?', message: 'run ls',
    timestamp: Date.now(), _sess: SESS, replayed: true,
  });
  check('回放确认卡副本被丢', c2 === null, '');
  // live 复投在 30s 窗内也丢（原行为不回归）
  const c3 = arb.accept({
    type: 'AGENT_CONFIRM', toolCallId: 'tc-42', title: 'Run?', message: 'run ls',
    timestamp: Date.now(), _sess: SESS,
  });
  check('live 确认卡窗口内重投被丢', c3 === null, '');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('failed:', failures.join(', ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
