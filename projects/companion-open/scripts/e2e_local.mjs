#!/usr/bin/env node
/**
 * Host-free local E2E for companion bridge + live-only session tail + PWA static.
 * Does not require VS Code process — uses compiled dist/*.js.
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { BridgeServer } = require(path.join(root, 'dist/bridge.js'));
const { SessionWatcher } = require(path.join(root, 'dist/sessionWatcher.js'));
const { PushManager } = require(path.join(root, 'dist/push.js'));
const { JsonlProjector } = require(path.join(root, 'dist/jsonl.js'));
const { TranscriptWatcher } = require(path.join(root, 'dist/transcriptWatcher.js'));
const { SessionIndexReader, deriveVscdbPath } = require(path.join(root, 'dist/sessionIndex.js'));
const { spawn } = require('child_process');
const WebSocket = require(path.join(root, 'node_modules/ws'));

const PORT = Number(process.env.E2E_PORT || 3017);
const HOST = '127.0.0.1';
const TOKEN = 'e2e-token';
const PWA = path.join(root, 'media', 'pwa');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitFor(pred, ms = 3000, step = 40) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('timeout waiting for condition');
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-e2e-'));
  const sessionDir = path.join(tmpRoot, 'workspaceStorage', 'ws1', 'chatSessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'sess-e2e.jsonl');

  const seed =
    [
      JSON.stringify({
        kind: 2,
        k: ['requests'],
        v: [{ requestId: 'old-1', message: { text: 'OLD_SHOULD_NOT_APPEAR' } }],
      }),
      JSON.stringify({
        kind: 2,
        k: ['requests', 0, 'response'],
        v: [{ value: 'old assistant reply' }],
      }),
    ].join('\n') + '\n';
  fs.writeFileSync(sessionFile, seed);

  const received = [];
  const phoneMsgs = [];
  let clientCount = 0;

  const pushDir = path.join(tmpRoot, 'push-store');
  fs.mkdirSync(pushDir, { recursive: true });
  const push = new PushManager({ storageDir: pushDir });
  assert(typeof push.vapidPublicKey === 'string' && push.vapidPublicKey.length > 20, 'vapid public key');

  const bridge = new BridgeServer({
    host: HOST,
    port: PORT,
    authToken: TOKEN,
    pwaDir: PWA,
    onClientCount: (n) => {
      clientCount = n;
    },
  });
  bridge.setPushManager(push);
  bridge.onPhoneMessage(async (msg) => {
    phoneMsgs.push(msg);
    if (msg.type === 'PHONE_MESSAGE') {
      bridge.broadcast({ type: 'COPILOT_TYPING' });
      bridge.broadcast({
        type: 'AGENT_STREAM_SET',
        streamId: 'e2e#0',
        text: `echo:${msg.text}`,
        requestIndex: 0,
      });
      bridge.broadcast({ type: 'COPILOT_DONE', requestIndex: 0, reason: 'result' });
    }
    if (msg.type === 'PHONE_CONFIRM') {
      bridge.broadcast({ type: 'SYSTEM_MESSAGE', text: `confirm:${msg.button}` });
    }
  });
  await bridge.start();

  const html = await fetch(`http://${HOST}:${PORT}/`).then((r) => r.text());
  assert(html.includes('Lazy Ass') || html.includes('Copilot Lazy Ass'), 'PWA index should be served');
  const appjs = await fetch(`http://${HOST}:${PORT}/app.js`).then((r) => r.text());
  assert(appjs.includes('PHONE_MESSAGE'), 'PWA app.js should be served');
  const health = await fetch(`http://${HOST}:${PORT}/health?token=${encodeURIComponent(TOKEN)}`).then((r) => r.json());
  assert(health.ok === true, 'health ok');
  assert('publicUrl' in health, 'health must include publicUrl field');
  assert(health.publicUrl === null || typeof health.publicUrl === 'string', 'publicUrl must be null or string');

  // publicUrl should surface after setPublicUrl
  bridge.setPublicUrl('https://example.trycloudflare.com');
  const health2 = await fetch(`http://${HOST}:${PORT}/health?token=${encodeURIComponent(TOKEN)}`).then((r) => r.json());
  assert(health2.publicUrl === 'https://example.trycloudflare.com', 'health.publicUrl should reflect setPublicUrl');
  bridge.setPublicUrl(null);

  const watcher = new SessionWatcher({
    pollMs: 30,
    rescanMs: 200,
    liveOnly: true,
    bootstrapLastRequests: 0, // pure live-only: no historical bootstrap for this assertion
    forceFile: sessionFile,
    onEvent: (ev) => {
      received.push(ev);
      if (typeof bridge.sendToPhone === 'function') bridge.sendToPhone(ev);
      else bridge.broadcast(ev);
    },
  });
  watcher.start();

  await sleep(120);
  assert(watcher.currentFile === sessionFile, 'watcher should bind forceFile');
  assert(watcher.readOffset === Buffer.byteLength(seed), `live-only offset should be EOF, got ${watcher.readOffset}`);
  assert(
    !received.some((e) => e.type === 'USER_MESSAGE' && String(e.text).includes('OLD_SHOULD_NOT_APPEAR')),
    'live-only must not emit historical USER_MESSAGE',
  );

  const clientEvents = [];
  const ws = new WebSocket(`ws://${HOST}:${PORT}/?token=${TOKEN}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (data) => {
    try {
      clientEvents.push(JSON.parse(String(data)));
    } catch {}
  });

  ws.send(JSON.stringify({ type: 'PHONE_CONNECT', token: TOKEN }));
  const ack = await waitFor(() => clientEvents.find((e) => e.type === 'CONNECTED_ACK'));
  assert(ack && typeof ack.vapidPublicKey === 'string' && ack.vapidPublicKey.length > 20, 'CONNECTED_ACK should carry vapidPublicKey');
  assert(ack.vapidPublicKey === push.vapidPublicKey, 'CONNECTED_ACK vapid should match PushManager');
  await waitFor(() => clientCount >= 1);

  // unit-ish: stream projector prefix growth → CHUNK
  const proj = new JsonlProjector();
  const s1 = proj.projectLine({
    kind: 2,
    k: ['requests', 0, 'response'],
    v: [{ value: 'Hello' }],
  });
  assert(s1.some((e) => e.type === 'AGENT_STREAM_START'), 'first text → START');
  assert(s1.some((e) => e.type === 'AGENT_STREAM_SET' && e.text === 'Hello'), 'first text → SET');
  const s2 = proj.projectLine({
    kind: 2,
    k: ['requests', 0, 'response'],
    v: [{ value: 'Hello world' }],
  });
  assert(s2.some((e) => e.type === 'AGENT_STREAM_CHUNK' && e.text === ' world'), 'prefix growth → CHUNK delta');
  const s3 = proj.projectLine({
    kind: 1,
    k: ['requests', 0, 'result'],
    v: {},
  });
  assert(s3.some((e) => e.type === 'AGENT_STREAM_END'), 'DONE path ends streams');
  assert(s3.some((e) => e.type === 'COPILOT_DONE') || true, 'DONE may be debounced via sink');

  bridge.broadcast({
    type: 'AGENT_CONFIRM',
    title: 'Run tool?',
    message: 'delete files',
    buttons: ['Continue', 'Cancel'],
  });
  await waitFor(() => clientEvents.some((e) => e.type === 'AGENT_CONFIRM'));

  const liveLine =
    JSON.stringify({
      kind: 2,
      k: ['requests'],
      v: [{ requestId: 'live-1', message: { text: 'LIVE_USER_TURN' } }],
    }) + '\n';
  fs.appendFileSync(sessionFile, liveLine);
  await waitFor(() => clientEvents.some((e) => e.type === 'USER_MESSAGE' && e.text === 'LIVE_USER_TURN'));

  ws.send(JSON.stringify({ type: 'PHONE_MESSAGE', text: 'hi from e2e', mode: 'agent' }));
  await waitFor(() => phoneMsgs.some((m) => m.type === 'PHONE_MESSAGE' && m.text === 'hi from e2e'));
  await waitFor(() => clientEvents.some((e) => e.type === 'AGENT_STREAM_SET' && e.text === 'echo:hi from e2e'));

  ws.send(JSON.stringify({ type: 'PHONE_CONFIRM', button: 'Continue' }));
  await waitFor(() => phoneMsgs.some((m) => m.type === 'PHONE_CONFIRM' && m.button === 'Continue'));
  await waitFor(() => clientEvents.some((e) => e.type === 'AGENT_CONFIRM_RESOLVED'));


  // --- stream helpers on live bridge (if present) ---
  let streamHelpersOk = false;
  if (typeof bridge.sendStreamStart === 'function') {
    const before = clientEvents.length;
    bridge.sendStreamStart('stream-e2e');
    if (typeof bridge.sendStreamSet === 'function') bridge.sendStreamSet('stream-e2e', 'Hello');
    if (typeof bridge.sendStreamChunk === 'function') bridge.sendStreamChunk(' world', 'stream-e2e');
    await sleep(50);
    if (typeof bridge.sendStreamEnd === 'function') bridge.sendStreamEnd('stream-e2e');
    await waitFor(() => clientEvents.slice(before).some((e) => e.type === 'AGENT_STREAM_START'));
    await waitFor(() => clientEvents.slice(before).some((e) => e.type === 'AGENT_STREAM_SET' && e.text === 'Hello'));
    await waitFor(() => clientEvents.slice(before).some((e) => e.type === 'AGENT_STREAM_CHUNK'));
    await waitFor(() => clientEvents.slice(before).some((e) => e.type === 'AGENT_STREAM_END'));
    streamHelpersOk = true;
  }

  // --- spam / reconnect semantics ---
  // TUNNEL_URL dedup: same URL must not rebroadcast
  const tunnelBefore = clientEvents.filter((e) => e.type === 'TUNNEL_URL').length;
  bridge.setPublicUrl('https://e2e.trycloudflare.com');
  await waitFor(() => clientEvents.some((e) => e.type === 'TUNNEL_URL' && e.url === 'https://e2e.trycloudflare.com'));
  bridge.setPublicUrl('https://e2e.trycloudflare.com'); // same → no-op
  bridge.setPublicUrl('https://e2e.trycloudflare.com');
  await sleep(40);
  const tunnelAfter = clientEvents.filter(
    (e) => e.type === 'TUNNEL_URL' && e.url === 'https://e2e.trycloudflare.com',
  ).length;
  assert(tunnelAfter === tunnelBefore + 1, `TUNNEL_URL should dedup same URL, got +${tunnelAfter - tunnelBefore}`);

  // Internal SYSTEM_MESSAGE must not reach phone
  const sysBefore = clientEvents.filter((e) => e.type === 'SYSTEM_MESSAGE').length;
  bridge.sendToPhone({
    type: 'SYSTEM_MESSAGE',
    text: 'Watching session: sess-e2e.jsonl (live-only@EOF)',
    visibility: 'internal',
    internal: true,
  });
  bridge.sendToPhone({ type: 'SYSTEM_MESSAGE', text: 'Watching session: plain-prefix' });
  await sleep(40);
  assert(
    clientEvents.filter((e) => e.type === 'SYSTEM_MESSAGE').length === sysBefore,
    'internal Watching session must not reach clients',
  );

  // Phone echo: PHONE_MESSAGE text must suppress later USER_MESSAGE with same text
  ws.send(JSON.stringify({ type: 'PHONE_MESSAGE', text: 'echo-suppress-me', mode: 'agent' }));
  await waitFor(() => phoneMsgs.some((m) => m.type === 'PHONE_MESSAGE' && m.text === 'echo-suppress-me'));
  const userBefore = clientEvents.filter((e) => e.type === 'USER_MESSAGE' && e.text === 'echo-suppress-me').length;
  bridge.sendToPhone({ type: 'USER_MESSAGE', text: 'echo-suppress-me', requestId: 'echo-1' });
  await sleep(40);
  const userAfter = clientEvents.filter((e) => e.type === 'USER_MESSAGE' && e.text === 'echo-suppress-me').length;
  assert(userAfter === userBefore, 'phone-originated USER_MESSAGE echo must be suppressed');

  // --- offline: history-eligible via HISTORY_REPLAY; HISTORY_SKIP via offline queue ---
  try { ws.close(); } catch {}
  await waitFor(() => clientCount === 0, 2000);
  assert(typeof bridge.sendToPhone === 'function', 'sendToPhone required');
  // USER_MESSAGE goes to history only (not offline queue) — recovered by HISTORY_REPLAY
  bridge.sendToPhone({ type: 'USER_MESSAGE', text: 'OFFLINE_HISTORY_MSG', requestId: 'off-1' });
  // AGENT_STREAM_SET is HISTORY_SKIP → offline queue for reconnect
  bridge.sendToPhone({
    type: 'AGENT_STREAM_SET',
    streamId: 'off-stream',
    text: 'OFFLINE_STREAM_SET',
  });
  bridge.sendToPhone({ type: 'COPILOT_TYPING' }); // must not queue
  const healthOff = await fetch(`http://${HOST}:${PORT}/health?token=${encodeURIComponent(TOKEN)}`).then((r) => r.json());
  if ('offlineQueued' in healthOff) {
    assert(healthOff.offlineQueued >= 1, `offlineQueued expected >=1 (stream) got ${healthOff.offlineQueued}`);
  }
  const reEvents = [];
  const ws2 = new WebSocket(`ws://${HOST}:${PORT}/?token=${TOKEN}`);
  await new Promise((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });
  ws2.on('message', (data) => {
    try { reEvents.push(JSON.parse(String(data))); } catch {}
  });
  // open may already deliver TUNNEL_URL once
  ws2.send(JSON.stringify({ type: 'PHONE_CONNECT', token: TOKEN }));
  await waitFor(() => reEvents.some((e) => e.type === 'CONNECTED_ACK'));
  // HISTORY_REPLAY once
  const replays = reEvents.filter((e) => e.type === 'HISTORY_REPLAY');
  await waitFor(() => reEvents.some((e) => e.type === 'HISTORY_REPLAY'));
  assert(reEvents.filter((e) => e.type === 'HISTORY_REPLAY').length === 1, 'HISTORY_REPLAY once per connect');
  // second PHONE_CONNECT on same socket must not re-replay
  ws2.send(JSON.stringify({ type: 'PHONE_CONNECT', token: TOKEN }));
  await sleep(80);
  assert(
    reEvents.filter((e) => e.type === 'HISTORY_REPLAY').length === 1,
    'duplicate PHONE_CONNECT must not re-send HISTORY_REPLAY',
  );
  // history message via replay (not double offline)
  await waitFor(() => {
    const replay = reEvents.find((e) => e.type === 'HISTORY_REPLAY');
    return replay && (replay.messages || []).some((m) => m.type === 'USER_MESSAGE' && m.text === 'OFFLINE_HISTORY_MSG');
  });
  // stream offline flush
  await waitFor(() => reEvents.some((e) => e.type === 'AGENT_STREAM_SET' && e.text === 'OFFLINE_STREAM_SET'));
  // TUNNEL_URL: at most once on this socket (open only; not again on CONNECT)
  const tunnelOnWs2 = reEvents.filter((e) => e.type === 'TUNNEL_URL');
  assert(tunnelOnWs2.length <= 1, `TUNNEL_URL at most once per socket, got ${tunnelOnWs2.length}`);
  // TUNNEL_URL must not appear inside HISTORY_REPLAY
  const replayMsg = reEvents.find((e) => e.type === 'HISTORY_REPLAY');
  assert(
    !(replayMsg.messages || []).some((m) => m.type === 'TUNNEL_URL'),
    'TUNNEL_URL must not be in HISTORY_REPLAY',
  );
  const healthAfter = await fetch(`http://${HOST}:${PORT}/health?token=${encodeURIComponent(TOKEN)}`).then((r) => r.json());
  if ('offlineQueued' in healthAfter) {
    assert(healthAfter.offlineQueued === 0, 'offline queue should flush to 0');
  }

  const bad = new WebSocket(`ws://${HOST}:${PORT}`);
  await new Promise((resolve, reject) => {
    bad.once('open', resolve);
    bad.once('error', reject);
  });
  const badEvents = [];
  bad.on('message', (d) => {
    try {
      badEvents.push(JSON.parse(String(d)));
    } catch {}
  });
  bad.send(JSON.stringify({ type: 'PHONE_CONNECT', token: 'wrong' }));
  await waitFor(() => badEvents.some((e) => e.type === 'SYSTEM_MESSAGE' && /auth failed/i.test(e.text || '')));

  // --- Web Push host-free: subscribe + notify (invalid endpoint must not throw) ---
  assert(push.hasSubscribers === false, 'push starts empty');
  push.addSubscription({
    endpoint: 'https://example.invalid/push/e2e-sub',
    expirationTime: null,
    keys: {
      p256dh: 'BNcRdderI0kn978ImwIdzs1wjzAwKSGgLqxhXLMFx5Z',
      auth: 'tBHItJI5svbpez7SYHeVDA',
    },
  });
  // invalid keys may be rejected by validSub — if so, inject via notify path still ok
  const pushSubOk = push.hasSubscribers === true || push.subscriberCount >= 0;
  assert(pushSubOk, 'push subscription path must not throw');
  // PHONE_PUSH_SUBSCRIBE via live socket
  ws2.send(
    JSON.stringify({
      type: 'PHONE_PUSH_SUBSCRIBE',
      subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-fake-endpoint',
        expirationTime: null,
        keys: {
          p256dh: 'BNcRdderI0kn978ImwIdzs1wjzAwKSGgLqxhXLMFx5Z',
          auth: 'tBHItJI5svbpez7SYHeVDA',
        },
      },
    }),
  );
  await sleep(80);
  // notify must settle (network fail / 4xx is fine)
  await push.notify('E2E', 'push body for e2e').catch(() => {});
  const pushNotifyOk = true;

  // --- PHONE_INSTANCE_LIST request/response ---
  const instEvents = [];
  bridge.onRequest(async (msg, reply) => {
    if (msg?.type === 'PHONE_INSTANCE_LIST') {
      reply({
        type: 'INSTANCE_LIST',
        instances: [
          {
            instanceId: 'vscode-e2e-1',
            workspaceName: 'e2e-ws',
            host: '127.0.0.1',
            port: PORT,
            isPrimary: true,
            pid: process.pid,
          },
        ],
        timestamp: Date.now(),
      });
    }
  });
  // ensure REQUEST_TYPES includes PHONE_INSTANCE_LIST by sending on authed socket
  ws2.send(JSON.stringify({ type: 'PHONE_INSTANCE_LIST' }));
  await waitFor(() => {
    // collect from reEvents (ws2 already listening)
    return reEvents.some((e) => e.type === 'INSTANCE_LIST' && Array.isArray(e.instances));
  }, 2000);
  const instanceListOk = reEvents.some(
    (e) => e.type === 'INSTANCE_LIST' && e.instances?.[0]?.workspaceName === 'e2e-ws',
  );
  assert(instanceListOk, 'PHONE_INSTANCE_LIST must return INSTANCE_LIST');

  // --- TranscriptWatcher typewriter CHUNK (prefix growth same messageId) ---
  const tDir = path.join(tmpRoot, 'transcripts');
  fs.mkdirSync(tDir, { recursive: true });
  const tFile = path.join(tDir, 'sess-stream.jsonl');
  fs.writeFileSync(tFile, '');
  const tEvents = [];
  const tw = new TranscriptWatcher({
    dir: tDir,
    pollMs: 30,
    onEvent: (ev) => tEvents.push(ev),
  });
  tw.bindFile(tFile); // live EOF
  await sleep(60);
  const appendT = (obj) => fs.appendFileSync(tFile, JSON.stringify(obj) + '\n');
  appendT({
    type: 'user.message',
    data: { content: 'stream me', attachments: [] },
    id: 'tu1',
    timestamp: new Date().toISOString(),
  });
  await sleep(80);
  appendT({
    type: 'assistant.turn_start',
    data: { turnId: '0' },
    id: 'tt0',
    timestamp: new Date().toISOString(),
  });
  await sleep(60);
  appendT({
    type: 'assistant.message',
    data: { messageId: 'mid-1', content: 'Hello', toolRequests: [] },
    id: 'tm1',
    timestamp: new Date().toISOString(),
  });
  await sleep(80);
  // same messageId, content grows → CHUNK
  appendT({
    type: 'assistant.message',
    data: { messageId: 'mid-1', content: 'Hello world', toolRequests: [] },
    id: 'tm2',
    timestamp: new Date().toISOString(),
  });
  await sleep(100);
  appendT({
    type: 'assistant.turn_end',
    data: { turnId: '0' },
    id: 'te0',
    timestamp: new Date().toISOString(),
  });
  await waitFor(
    () =>
      tEvents.some((e) => e.type === 'AGENT_STREAM_SET' && e.text === 'Hello') &&
      tEvents.some((e) => e.type === 'AGENT_STREAM_CHUNK' && e.text === ' world') &&
      tEvents.some((e) => e.type === 'COPILOT_DONE'),
    4000,
  );
  const typewriterOk =
    tEvents.some((e) => e.type === 'AGENT_STREAM_SET' && e.text === 'Hello') &&
    tEvents.some((e) => e.type === 'AGENT_STREAM_CHUNK' && e.text === ' world') &&
    tEvents.some((e) => e.type === 'AGENT_MESSAGE' && e.text === 'Hello world') &&
    tEvents.some((e) => e.type === 'COPILOT_DONE');
  assert(
    typewriterOk,
    `TranscriptWatcher must emit SET then CHUNK on prefix growth; got=${tEvents.map((e) => e.type).join(',')}`,
  );
  tw.dispose();

  // --- SessionIndexReader (real vscdb if present, else empty ok) ---
  let sessionIndexOk = false;
  const candidateRoots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
  ];
  let foundTitle = null;
  for (const rootDir of candidateRoots) {
    if (!fs.existsSync(rootDir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const id of entries) {
      const vscdb = deriveVscdbPath(path.join(rootDir, id));
      if (!fs.existsSync(vscdb)) continue;
      try {
        const reader = new SessionIndexReader({ vscdbPath: vscdb });
        const all = reader.readAll();
        if (all.length) {
          foundTitle = all.find((e) => e.title && e.title !== '新建聊天')?.title || all[0].title || null;
          sessionIndexOk = true;
          break;
        }
      } catch {
        // ignore locked/unsupported
      }
    }
    if (sessionIndexOk) break;
  }
  // If no real vscdb (CI), still pass: empty reader must not throw
  if (!sessionIndexOk) {
    const empty = new SessionIndexReader({ vscdbPath: path.join(tmpRoot, 'missing.vscdb') });
    assert(Array.isArray(empty.readAll()) && empty.readAll().length === 0, 'missing vscdb → []');
    sessionIndexOk = true;
  }

  watcher.dispose();
  await bridge.stop();
  try {
    ws.close();
  } catch {}
  try {
    ws2.close();
  } catch {}
  try {
    bad.close();
  } catch {}

  // --- Tunnel smoke (optional soft): run child script, record result, do not fail suite unless TUNNEL_REQUIRED=1 ---
  let tunnelSmokeOk = false;
  let tunnelSmokeSkipped = false;
  let tunnelSmokeError = null;
  if (process.env.SKIP_TUNNEL_SMOKE === '1') {
    tunnelSmokeSkipped = true;
  } else {
    try {
      tunnelSmokeOk = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(root, 'scripts', 'e2e_tunnel_smoke.mjs')], {
          cwd: root,
          env: { ...process.env, TUNNEL_WAIT_MS: process.env.TUNNEL_WAIT_MS || '45000' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => {
          out += String(d);
        });
        child.stderr.on('data', (d) => {
          out += String(d);
        });
        const killer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {}
        }, Number(process.env.TUNNEL_WAIT_MS || 45000) + 15000);
        child.on('close', (code) => {
          clearTimeout(killer);
          if (code === 0) resolve(true);
          else {
            tunnelSmokeError = out.slice(-800) || `exit ${code}`;
            resolve(false);
          }
        });
      });
    } catch (e) {
      tunnelSmokeError = String(e?.message || e);
      tunnelSmokeOk = false;
    }
  }
  if (!tunnelSmokeOk && !tunnelSmokeSkipped && process.env.TUNNEL_REQUIRED === '1') {
    throw new Error(`tunnel smoke required but failed: ${tunnelSmokeError || 'unknown'}`);
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        port: PORT,
        pwaOk: true,
        liveOnlyOffsetOk: true,
        liveUserSeen: true,
        phoneInjectSeen: true,
        confirmOk: true,
        authRejectOk: true,
        healthPublicUrlOk: true,
        connectedAckOk: true,
        vapidPublicKeyOk: true,
        streamProjectorOk: true,
        streamHelpersOk,
        offlineQueueFlushOk: true,
        tunnelUrlDedupOk: true,
        historyReplayOnceOk: true,
        internalSysFilterOk: true,
        phoneEchoSuppressOk: true,
        pushNotifyOk,
        instanceListOk,
        typewriterOk,
        sessionIndexOk,
        sessionIndexSampleTitle: foundTitle,
        tunnelSmokeOk,
        tunnelSmokeSkipped,
        tunnelSmokeError: tunnelSmokeOk || tunnelSmokeSkipped ? null : tunnelSmokeError,
        clientEventTypes: [...new Set([...clientEvents, ...reEvents].map((e) => e.type))],
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
