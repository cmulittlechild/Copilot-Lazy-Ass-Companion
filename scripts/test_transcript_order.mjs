#!/usr/bin/env node
/**
 * 0.5.18 回归：transcript 投影顺序 / 工具完成 / phone live 不双通道
 *
 * A. text → tool → text 必须穿插（多段 streamId），不能只剩最终大段正文
 * B. execution_complete → TOOL_CALL isComplete:true
 * C. turn_end 强制未完成工具 done + COPILOT_DONE
 * D. bindFile({replay:false}) 后 chatSessions fallback 不投助手事件
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'txord-'));
const dir = path.join(tmp, 'transcripts');
const csDir = path.join(tmp, 'chatSessions');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(csDir, { recursive: true });

const sid = 'sess-order-1';
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

async function main() {
  console.log('=== A/B/C. 穿插顺序 + complete + turn_end ===');
  tw.bindFile(tfile, { replay: false });
  tw.pinFile(tfile);
  await sleep(120);

  const n0 = events.length;
  append(tfile, {
    type: 'user.message',
    data: { content: '2', messageId: 'u1' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.turn_start',
    data: { turnId: 'turn-a' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.message',
    data: { messageId: 'a1', content: '第一段正文 before tool' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'tool.execution_start',
    data: {
      toolCallId: 'call-1',
      toolName: 'run_in_terminal',
      arguments: { command: 'npm test' },
    },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'tool.execution_complete',
    data: { toolCallId: 'call-1', success: true },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'assistant.message',
    data: { messageId: 'a2', content: '第二段正文 after tool' },
    timestamp: new Date().toISOString(),
  });
  append(tfile, {
    type: 'tool.execution_start',
    data: { toolCallId: 'call-2', toolName: 'read_file', arguments: { filePath: 'x' } },
    timestamp: new Date().toISOString(),
  });
  // call-2 故意不 complete，靠 turn_end 强制 done
  append(tfile, {
    type: 'assistant.turn_end',
    data: {},
    timestamp: new Date().toISOString(),
  });

  // 等 poll/watch
  for (let i = 0; i < 25; i++) {
    await sleep(80);
    const slice = events.slice(n0);
    if (slice.some((e) => e.type === 'COPILOT_DONE')) break;
  }

  const slice = events.slice(n0);
  const types = slice.map((e) => e.type);
  console.log('  types:', types.join(' → '));

  check('有 USER_MESSAGE', types.includes('USER_MESSAGE'));
  check('有 TOOL_CALL', types.includes('TOOL_CALL'));

  const tools = slice.filter((e) => e.type === 'TOOL_CALL');
  const t1 = tools.filter((t) => t.toolId === 'call-1');
  check(
    'call-1 先 incomplete 再 complete',
    t1.some((t) => t.isComplete === false) && t1.some((t) => t.isComplete === true),
    JSON.stringify(t1.map((t) => t.isComplete)),
  );
  const t2 = tools.filter((t) => t.toolId === 'call-2');
  check(
    'call-2 在 turn_end 被强制 complete',
    t2.some((t) => t.isComplete === true),
    JSON.stringify(t2.map((t) => t.isComplete)),
  );

  // 顺序：第一段正文事件应在 call-1 start 之前；第二段在 call-1 complete 之后
  const idx = (pred) => types.findIndex(pred);
  // 用事件数组细查
  let iFirstText = slice.findIndex(
    (e) =>
      (e.type === 'AGENT_STREAM_SET' || e.type === 'AGENT_STREAM_CHUNK' || e.type === 'AGENT_MESSAGE') &&
      String(e.text || '').includes('第一段'),
  );
  let iTool1 = slice.findIndex((e) => e.type === 'TOOL_CALL' && e.toolId === 'call-1' && e.isComplete === false);
  let iSecondText = slice.findIndex(
    (e) =>
      (e.type === 'AGENT_STREAM_SET' || e.type === 'AGENT_STREAM_CHUNK' || e.type === 'AGENT_MESSAGE') &&
      String(e.text || '').includes('第二段'),
  );
  check(
    '正文1 在 tool1 之前',
    iFirstText >= 0 && iTool1 >= 0 && iFirstText < iTool1,
    `first=${iFirstText} tool=${iTool1}`,
  );
  check(
    '正文2 在 tool1 之后',
    iSecondText >= 0 && iTool1 >= 0 && iSecondText > iTool1,
    `second=${iSecondText} tool=${iTool1}`,
  );

  // 两段正文 streamId 应不同（tool 切开）
  const s1 = slice[iFirstText]?.streamId;
  const s2 = slice[iSecondText]?.streamId;
  check('tool 切开后 streamId 不同', !!(s1 && s2 && s1 !== s2), `s1=${s1} s2=${s2}`);
  check('有 COPILOT_DONE', types.includes('COPILOT_DONE'));

  console.log('\n=== D. phone live 抑制 chatSessions 助手双通道 ===');
  const n1 = events.length;
  // 写入 chatSessions 一整轮助手回复（若未抑制会投 AGENT_* / TOOL）
  append(cfile, {
    kind: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'req-dup-1',
        message: { text: 'should-not-user-from-fallback' },
        response: [
          { kind: 'markdownContent', value: '这是 chatSessions 双通道重复正文，不该出现' },
          {
            kind: 'toolInvocation',
            toolCallId: 'cs-tool-1',
            invocationMessage: { value: 'run_in_terminal' },
            isComplete: true,
          },
        ],
        isComplete: true,
      },
    ],
  });
  await sleep(500);
  const after = events.slice(n1);
  const leaked = after.filter(
    (e) =>
      (e.type === 'AGENT_MESSAGE' || e.type === 'AGENT_STREAM_SET' || e.type === 'TOOL_CALL') &&
      (String(e.text || '').includes('双通道') || e.toolId === 'cs-tool-1'),
  );
  check('phone live 不投 chatSessions 助手重复', leaked.length === 0, JSON.stringify(leaked.slice(0, 3)));

  tw.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + '='.repeat(52));
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
