// Token-aware passive WS monitor (reads token from channel.json)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const chan = JSON.parse(readFileSync(join(homedir(), '.copilot-sidecar-companion/channel.json'), 'utf8'));
const port = chan.port || 3010, token = chan.token;
const t0 = Date.now();
const ts = () => {
  const el = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  const d = new Date();
  return `[${el}|${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(Math.floor(d.getMilliseconds()/10)).padStart(2,'0')}]`;
};
const trunc = (s, n = 60) => (s && s.length > n ? s.slice(0, n) : s);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.addEventListener('open', () => {
  console.log(ts(), '### CONNECTED (token-auth)');
  ws.send(JSON.stringify({ type: 'PHONE_CONNECT', token }));
});
ws.addEventListener('message', (e) => {
  let m; try { m = JSON.parse(e.data); } catch { console.log(ts(), 'RAW', trunc(String(e.data))); return; }
  const ty = m.type;
  if (ty === 'USER_MESSAGE' || ty === 'AGENT_MESSAGE') {
    const sess = m._sess ? ` sess=${String(m._sess).slice(0,8)}` : '';
    const ut = m._ut ? ` ut="${trunc(String(m._ut),30)}"` : '';
    console.log(ts(), `<<< ${ty} "${trunc(m.text || m.body || '',60)}"${sess}${ut}`);
  } else if (ty === 'AGENT_STREAM_START' || ty === 'AGENT_STREAM_SET' || ty === 'AGENT_STREAM_END') {
    const id = m.streamId || m.id || '';
    const extra = ty === 'AGENT_STREAM_SET' ? ` "${trunc(m.text || '',40)}"` : (ty === 'AGENT_STREAM_END' ? ` len=${m.text?.length ?? 0}` : '');
    console.log(ts(), `    ${ty}${extra} id=${id}`);
  } else if (ty === 'SESSION_SELECTED' || ty === 'MODEL_LIST' || ty === 'AGENT_LIST' || ty === 'CONNECTED_ACK') {
    const extra = m.file ? ` file=${String(m.file).split('/').pop()}` : (m.current !== undefined ? ` current=${m.current}` : (m.list ? ` n=${m.list.length || '?'}` : ''));
    console.log(ts(), `### ${ty}${m.name ? ' ' + m.name : ''}${extra}`);
  } else if (ty === 'HISTORY_REPLAY') {
    console.log(ts(), `    HISTORY_REPLAY n=${(m.messages?.length ?? m.entries?.length ?? '?')} ${m.file ? 'file=' + String(m.file).split('/').pop() : ''}`);
  } else if (ty === 'COPILOT_DONE' || ty === 'TOOL_CALL' || ty === 'THINKING_STEP' || ty === 'COPILOT_TYPING' || ty === 'TYPING') {
    const extra = m.reason ? ` [${m.reason}]` : (m.text ? ` "${trunc(m.text,40)}"` : '');
    console.log(ts(), `    ${ty}${extra}`);
  } else if (ty === 'PING') { console.log(ts(), '    PING'); }
  else { console.log(ts(), `    ${ty}`, trunc(JSON.stringify(m), 80)); }
});
ws.addEventListener('close', (e) => console.log(ts(), `### CLOSED code=${e.code}`));
ws.addEventListener('error', (e) => console.log(ts(), '### ERROR', e.message || ''));
setInterval(() => {}, 60000);
