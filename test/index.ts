import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

// Runs inside the VS Code extension host (via @vscode/test-electron runTests).
// Collects every compiled *.test.js next to this file.
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 90000 });
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const f of files) {
    mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) =>
        failures ? reject(new Error(`${failures} test(s) failed`)) : resolve(),
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
