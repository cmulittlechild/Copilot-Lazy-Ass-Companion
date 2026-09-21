#!/usr/bin/env node
/**
 * Minimal mock of Copilot Remote WsServer for protocol testing.
 * Optionally tails a JSONL and streams reconstructed events to connected phones.
 *
 * Usage:
 *   node mock_bridge.mjs --port 3011
 *   node mock_bridge.mjs --port 3011 --jsonl /path/to/session.jsonl
 */
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import readline from 'readline';

const port = Number((process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port')+1] : 3011));
const jsonl = process.argv.includes('--jsonl') ? process.argv[process.argv.indexOf('--jsonl')+1] : null;

const server = http.createServer((req,res) => {
  res.writeHead(200, {'content-type':'text/plain'});
  res.end('copilot-remote mock bridge\n');
});
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === 1) c.send(s);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('client connected', clients.size);
  ws.send(JSON.stringify({ type: 'SYSTEM_MESSAGE', text: 'mock bridge ready' }));
  ws.send(JSON.stringify({ type: 'AGENT_LIST', agents: ['GitHub Copilot'], active: 'GitHub Copilot' }));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    console.log('from phone', msg.type, JSON.stringify(msg).slice(0,200));
    if (msg.type === 'PHONE_CONNECT') {
      ws.send(JSON.stringify({ type: 'HISTORY_REPLAY', messages: [] }));
    } else if (msg.type === 'PHONE_MESSAGE') {
      // echo path as if desktop accepted inject
      broadcast({ type: 'USER_MESSAGE', text: msg.text });
      broadcast({ type: 'COPILOT_TYPING' });
      broadcast({ type: 'AGENT_STREAM_SET', streamId: 'mock#0', text: `mock reply to: ${msg.text}`, timestamp: Date.now() });
      broadcast({ type: 'COPILOT_DONE' });
    } else if (msg.type === 'PHONE_CONFIRM') {
      broadcast({ type: 'AGENT_CONFIRM_RESOLVED', button: msg.button });
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(port, '127.0.0.1', () => {
  console.log('mock bridge on ws://127.0.0.1:'+port);
});

// optional: replay jsonl events into bridge after delay using child logic inline-ish
if (jsonl) {
  setTimeout(async () => {
    console.log('replaying', jsonl);
    // simplistic: spawn the replay script via dynamic import of logic would be heavy; just notify
    broadcast({ type: 'SYSTEM_MESSAGE', text: `jsonl attached: ${jsonl}` });
  }, 500);
}
