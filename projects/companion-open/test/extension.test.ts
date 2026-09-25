import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';

// Port seeded into .vscode-test/user-data/User/settings.json by
// scripts/run_vscode_tests.mjs (3310 avoids clashing with a dev bridge on 3010).
const EXT_ID = 'local-dev.copilot-sidecar-companion';
const PORT = 3310;
const BASE = `http://127.0.0.1:${PORT}`;

const COMMANDS = [
  'copilotSidecar.start',
  'copilotSidecar.stop',
  'copilotSidecar.showStatus',
  'copilotSidecar.copyWsUrl',
  'copilotSidecar.showQr',
  'copilotSidecar.startTunnel',
  'copilotSidecar.stopTunnel',
  'copilotSidecar.restartTunnel',
  'copilotSidecar.copyToken',
];

interface HttpResult {
  status: number;
  body: string;
}

function httpGet(url: string, timeoutMs = 5000): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForHealth(timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await httpGet(`${BASE}/health`, 3000);
      if (r.status === 200) {
        return JSON.parse(r.body) as Record<string, unknown>;
      }
      lastErr = new Error(`status ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`bridge /health never came up: ${String(lastErr)}`);
}

async function expectBridgeDown(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await httpGet(`${BASE}/health`, 1500);
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      return;
    }
  }
  throw new Error('bridge still serving /health after stop');
}

suite('copilot-sidecar-companion (extension host)', () => {
  test('extension is installed and activates', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not installed in test VS Code`);
    await ext.activate();
    assert.ok(ext.isActive, 'extension did not reach isActive');
  });

  test('all contributed commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of COMMANDS) {
      assert.ok(all.includes(c), `missing command ${c}`);
    }
  });

  test('configuration applies seeded values and defaults', () => {
    const cfg = vscode.workspace.getConfiguration('copilotSidecar');
    assert.strictEqual(cfg.get<number>('port'), PORT, 'seeded port not applied');
    assert.strictEqual(cfg.get<boolean>('autoStart'), true);
    assert.strictEqual(cfg.get<boolean>('liveOnly'), true);
    assert.strictEqual(cfg.get<boolean>('enableTunnel'), false);
  });

  test('bridge auto-starts and /health reports ok', async () => {
    const h = await waitForHealth(90000);
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.name, 'copilot-sidecar-companion');
    assert.strictEqual(h.port, PORT);
  });

  test('PWA is served at /', async () => {
    await waitForHealth(30000);
    const r = await httpGet(`${BASE}/`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.length > 100, 'PWA page body suspiciously small');
    assert.ok(/<html/i.test(r.body), 'PWA page is not HTML');
  });

  test('stop/start commands drive the bridge lifecycle', async () => {
    await waitForHealth(30000);
    await vscode.commands.executeCommand('copilotSidecar.stop');
    await expectBridgeDown();
    await vscode.commands.executeCommand('copilotSidecar.start');
    const h = await waitForHealth(30000);
    assert.strictEqual(h.ok, true);
  });
});
