// Runs the extension-host test suite via @vscode/test-electron:
// downloads a clean VS Code into .vscode-test/, installs this extension,
// launches it, and runs the Mocha suite compiled into out/test/.
//
// Usage: npm run compile && tsc -p tsconfig.test.json && node scripts/run_vscode_tests.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Seed the downloaded VS Code's user settings: use port 3310 so the test
// bridge never collides with a dev bridge on the default 3010.
const settingsDir = path.join(root, '.vscode-test', 'user-data', 'User');
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(
  path.join(settingsDir, 'settings.json'),
  JSON.stringify(
    {
      'copilotSidecar.port': 3310,
      'copilotSidecar.enableTunnel': false,
      'copilotSidecar.downloadCloudflared': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
    },
    null,
    2,
  ),
);

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'index.js'),
    launchArgs: ['--disable-extensions'],
  });
  console.log('[vscode-tests] PASS');
} catch (err) {
  console.error('[vscode-tests] FAIL:', err && err.message ? err.message : err);
  process.exit(1);
}
