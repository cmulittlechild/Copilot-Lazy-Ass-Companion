#!/usr/bin/env node
/**
 * Fake phone client for Copilot Remote protocol.
 * Connects to a local bridge and exchanges protocol messages.
 *
 * Usage:
 *   node fake_phone_client.mjs --url ws://127.0.0.1:3000
 *   node fake_phone_client.mjs --url ws://127.0.0.1:3000 --send hi --mode agent
 */
import WebSocket from 'ws';

function arg(name, def=null) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i+1] ?? def;
  return def;
}
const url = arg('--url', 'ws://127.0.0.1:3000');
const sendText = arg('--send', null);
const mode = arg('--mode', 'agent');
const confirm = arg('--confirm', null);

const ws = new WebSocket(url);
ws.on('open', () => {
  console.log('OPEN', url);
  ws.send(JSON.stringify({ type: 'PHONE_CONNECT', fcmToken: null }));
  if (sendText) {
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'PHONE_MESSAGE', text: sendText, mode }));
      console.log('SENT PHONE_MESSAGE', sendText, mode);
    }, 200);
  }
  if (confirm) {
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'PHONE_CONFIRM', button: confirm }));
      console.log('SENT PHONE_CONFIRM', confirm);
    }, 400);
  }
});
ws.on('message', (data) => {
  try {
    const msg = JSON.parse(String(data));
    console.log('RECV', JSON.stringify(msg).slice(0, 500));
  } catch {
    console.log('RECV raw', String(data).slice(0, 200));
  }
});
ws.on('close', () => console.log('CLOSE'));
ws.on('error', (e) => console.error('ERR', e.message));
setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, Number(arg('--timeout', '5000')));
