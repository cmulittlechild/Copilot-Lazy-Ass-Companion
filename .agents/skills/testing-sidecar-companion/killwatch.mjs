// Watch the sidecar WS; the instant a USER_MESSAGE containing "R28K" is
// echoed by the bridge, SIGKILL VS Code (mid-send, pre-persist kill).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
const chan = JSON.parse(readFileSync(join(homedir(), '.copilot-sidecar-companion/channel.json'), 'utf8'));
const ws = new WebSocket(`ws://127.0.0.1:${chan.port}`);
ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'PHONE_CONNECT', token: chan.token })));
ws.addEventListener('message', (e) => {
  try {
    const m = JSON.parse(e.data);
    if (m.type === 'USER_MESSAGE' && String(m.text || '').includes('R28K')) {
      console.log(new Date().toISOString(), 'SAW R28K ECHO -> KILLING VSCODE');
      try { execSync('pkill -9 -f "Visual Studio Code"'); } catch (_) {}
      process.exit(0);
    }
  } catch (_) {}
});
setInterval(() => {}, 60000);
