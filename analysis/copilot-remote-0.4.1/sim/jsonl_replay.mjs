#!/usr/bin/env node
/**
 * Replay a VS Code chatSessions JSONL through Copilot-Remote-like semantics.
 * No license, no phone, no official extension required.
 *
 * Usage:
 *   node jsonl_replay.mjs <session.jsonl> [--max N] [--out events.jsonl]
 */
import fs from 'fs';
import readline from 'readline';
import path from 'path';

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('Usage: node jsonl_replay.mjs <session.jsonl> [--max N] [--out events.jsonl]');
  process.exit(1);
}
const file = args[0];
let max = Infinity;
let outFile = null;
for (let i=1;i<args.length;i++) {
  if (args[i]==='--max') max = Number(args[++i]);
  else if (args[i]==='--out') outFile = args[++i];
}

const IGNORE = new Set([
  'thinking',
  'progressTaskSerialized',
  'progressMessage',
  'mcpServersStarting',
  'undoStop',
  'prepareToolInvocation',
]);

const seenRequestIds = new Set();
const respParts = new Map();
const events = [];
const lastEmittedText = new Map();
let lineNo = 0;

function emit(type, payload={}) {
  const ev = { type, ts: Date.now(), ...payload };
  events.push(ev);
  console.log(JSON.stringify(ev));
}

function textOfUserReq(t) {
  if (!t || typeof t !== 'object') return '';
  const msg = t.message;
  if (msg && typeof msg === 'object') {
    if (typeof msg.text === 'string') return msg.text;
    if (typeof msg.value === 'string') return msg.value;
  }
  for (const k of ['text','prompt','content','value']) {
    if (typeof t[k] === 'string' && t[k]) return t[k];
  }
  return '';
}

function handleUserRequest(t) {
  const rid = t?.requestId ?? '';
  if (!rid || seenRequestIds.has(rid)) return;
  seenRequestIds.add(rid);
  const text = textOfUserReq(t);
  if (!text) return;
  emit('USER_MESSAGE', { text, requestId: rid });
  emit('COPILOT_TYPING', { requestId: rid });
}

function renderBlocks(parts) {
  const blocks = [];
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    const kind = p.kind ?? '';
    if (IGNORE.has(kind)) continue;
    if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
      const inv = p.invocationMessage ?? p.pastTenseMessage ?? {};
      const name = typeof inv === 'string' ? inv : (inv.value ?? inv.content ?? '');
      blocks.push({
        type: 'tool',
        toolId: p.toolCallId ?? p.toolId ?? null,
        text: name || p.toolId || 'tool',
        input: p.toolSpecificData ?? p.input ?? null,
        isComplete: p.isComplete !== false,
      });
    } else if (kind === 'confirmation') {
      blocks.push({
        type: 'confirm',
        title: p.title ?? 'Confirm Action',
        message: p.message ?? '',
        buttons: p.buttons ?? ['Continue', 'Cancel'],
      });
    } else if (!kind && typeof p.value === 'string') {
      blocks.push({ type: 'text', text: p.value });
    }
  }
  return blocks;
}

function applyResponseMutation(pathKey, reqIndex, v, i) {
  let cur = respParts.get(pathKey) ?? [];
  if (typeof i !== 'number') {
    cur = Array.isArray(v) ? v.slice() : [];
  } else {
    if (!Array.isArray(cur)) cur = [];
    const add = Array.isArray(v) ? v : [v];
    cur.splice(i, 0, ...add);
  }
  respParts.set(pathKey, cur);
  const blocks = renderBlocks(cur);
  for (let n=0; n<blocks.length; n++) {
    const b = blocks[n];
    if (b.type === 'text') {
      const streamId = `${pathKey}#${n}`;
      if (lastEmittedText.get(streamId) === b.text) continue;
      lastEmittedText.set(streamId, b.text);
      emit('AGENT_STREAM_SET', { streamId, text: b.text, requestIndex: reqIndex });
    } else if (b.type === 'tool') {
      emit('TOOL_CALL', { toolId: b.toolId, text: b.text, isComplete: b.isComplete, input: b.input, requestIndex: reqIndex });
    } else if (b.type === 'confirm') {
      emit('AGENT_CONFIRM', { ...b, requestIndex: reqIndex });
    }
  }
}

function processChatEntry(t) {
  const k = t.k;
  if (!Array.isArray(k) || k.length === 0 || k[0] !== 'requests') return;
  // finalize markers (kind usually 1)
  if (k.length === 3 && typeof k[1] === 'number' && ['elapsedMs','result','isCanceled'].includes(k[2])) {
    emit('COPILOT_DONE', { requestIndex: k[1], reason: k[2], v: t.v });
    return;
  }
  // Remote only processes kind===2 for request/response body mutations
  if (t.kind !== 2) return;
  if (k.length === 1) {
    const v = t.v;
    if (!Array.isArray(v)) return;
    for (const req of v) handleUserRequest(req);
    return;
  }
  if (k.length === 3 && typeof k[1] === 'number' && k[2] === 'response') {
    const pathKey = `requests/${k[1]}/response`;
    applyResponseMutation(pathKey, k[1], t.v, t.i);
  }
}

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (lineNo >= max) break;
  const s = line.trim();
  if (!s) continue;
  lineNo++;
  try {
    processChatEntry(JSON.parse(s));
  } catch {}
}

const summary = {
  file,
  linesRead: lineNo,
  eventCounts: events.reduce((a,e)=>{a[e.type]=(a[e.type]||0)+1;return a;}, {}),
  requestIds: seenRequestIds.size,
};
console.error(JSON.stringify(summary, null, 2));
if (outFile) {
  fs.writeFileSync(outFile, events.map(e=>JSON.stringify(e)).join('\n'));
  console.error('wrote', outFile);
}
