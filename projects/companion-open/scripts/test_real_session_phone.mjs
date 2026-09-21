
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { TranscriptWatcher } = require(path.join(ROOT, "dist/transcriptWatcher.js"));

const tDir = "/Users/xin/Library/Application Support/Code/User/workspaceStorage/6ea7fd91d95d0ee7b8771238283ff09b/GitHub.copilot-chat/transcripts";
const csDir = "/Users/xin/Library/Application Support/Code/User/workspaceStorage/6ea7fd91d95d0ee7b8771238283ff09b/chatSessions";
const sid = "8e8c55f7-05ea-4bc0-a471-f4ff3708e6a2";
const events = [];
const tw = new TranscriptWatcher({
  dir: tDir,
  chatSessionsDir: csDir,
  pollMs: 50,
  fallbackPollMs: 100,
  onEvent: (ev) => events.push(ev),
});
const tfile = path.join(tDir, `${sid}.jsonl`);
tw.bindFile(tfile, { replay: false });
tw.pinFile(tfile);
// simulate phone sending "回复我 1245" and gap-fill
tw.addPendingPhoneUserText("回复我 1245");

await new Promise(r => setTimeout(r, 5000));
tw.dispose();
const last = events.slice(-20);
console.log("last events:");
for (const e of last) {
  const text = (e.text || "").slice(0, 80).replace(/\n/g, " ");
  console.log(`${e.type.padEnd(18)} ${e.gapFill?"[gap]":"    "} | ${text}`);
}
