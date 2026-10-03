#!/usr/bin/env node
/**
 * Mock bridge for reproducing the "switch session scrolls from head to tail" bug.
 *
 * Serves media/pwa statically, exposes a WS endpoint that mimics bridge.ts:
 *   1. on PHONE_CONNECT → CONNECTED_ACK + HISTORY_REPLAY (initial session A)
 *   2. on PHONE_SESSION_SELECT → SESSION_SELECTED + HISTORY_REPLAY (session B, with
 *      realistic delay matching extension.ts's sync projectHistory() work)
 *
 * Usage: node scripts/mock_bridge_ws.mjs [port=8900]
 * Configurable via env:
 *   REPLAY_MSG_COUNT   how many messages in the second HISTORY_REPLAY (default 40)
 *   SELECT_DELAY_MS    artificial delay before HISTORY_REPLAY after SESSION_SELECTED (default 120)
 */
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PWA = path.join(ROOT, 'media', 'pwa');

const PORT = Number(process.env.PORT || 8900);
const REPLAY_MSG_COUNT = Number(process.env.REPLAY_MSG_COUNT || 40);
const SELECT_DELAY_MS = Number(process.env.SELECT_DELAY_MS || 120);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

function makeHistory(prefix, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      out.push({
        type: 'USER_MESSAGE',
        text: `${prefix} 用户问题 #${i / 2 + 1}`,
        timestamp: Date.now() - (count - i) * 1000,
      });
    } else {
      out.push({
        type: 'AGENT_MESSAGE',
        text:
          `${prefix} 这是助手回答 #${Math.floor(i / 2) + 1}，包含一些 **markdown** 内容。\n\n` +
          '```ts\nconst x = 1;\n```\n\n- 列表项 A\n- 列表项 B\n\n这是一段较长的说明文字，用来撑高消息的高度，让滚动距离更明显。'.repeat(2),
        timestamp: Date.now() - (count - i) * 1000,
      });
    }
  }
  return out;
}

const sessions = {
  A: makeHistory('会话A', 12),
  B: makeHistory('会话B', REPLAY_MSG_COUNT),
};

const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(PWA, rel);
  // prevent path traversal
  if (!file.startsWith(PWA)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  let current = 'A';
  let replaySent = false;

  ws.send(JSON.stringify({ type: 'AGENT_LIST', agents: ['GitHub Copilot'], active: 'GitHub Copilot' }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    console.log('[ws] <-', msg.type, msg.file || '');

    if (msg.type === 'PHONE_CONNECT') {
      ws.send(JSON.stringify({ type: 'CONNECTED_ACK', timestamp: Date.now(), vapidPublicKey: null }));
      if (!replaySent) {
        replaySent = true;
        const hist = sessions[current];
        ws.send(JSON.stringify({ type: 'HISTORY_REPLAY', messages: hist, timestamp: Date.now() }));
        console.log(`[ws] -> HISTORY_REPLAY (${hist.length} msgs, session ${current})`);
      }
    } else if (msg.type === 'PHONE_SESSION_LIST') {
      ws.send(
        JSON.stringify({
          type: 'SESSION_LIST',
          sessions: [
            { file: '/fake/sessionA.jsonl', title: '会话A', workspaceId: 'w1', qualifiedName: 'w1', displayName: '会话A', name: 'sessionA', mtime: Date.now() - 100000, requestCount: 6 },
            { file: '/fake/sessionB.jsonl', title: '会话B', workspaceId: 'w1', qualifiedName: 'w1', displayName: '会话B', name: 'sessionB', mtime: Date.now() - 50000, requestCount: 20 },
          ],
          timestamp: Date.now(),
        }),
      );
    } else if (msg.type === 'PHONE_SESSION_SELECT') {
      current = 'B';
      // Mimic extension.ts: synchronous file projection work + reply, then replaySession broadcast
      ws.send(JSON.stringify({ type: 'SESSION_SELECTED', file: msg.file, ok: true, timestamp: Date.now() }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'HISTORY_REPLAY', messages: sessions.B, timestamp: Date.now() }));
        console.log(`[ws] -> HISTORY_REPLAY (${sessions.B.length} msgs, session B)`);
      }, SELECT_DELAY_MS);
    }
  });

  ws.on('close', () => console.log('[ws] client closed'));
});

httpServer.listen(PORT, () => {
  console.log(`[mock] PWA at http://localhost:${PORT}/  (ws /ws)`);
});
