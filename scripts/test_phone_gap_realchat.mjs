
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { TranscriptWatcher } = require(path.join(ROOT, "dist/transcriptWatcher.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phonegap-"));
const tDir = path.join(tmp, "transcripts");
const csDir = path.join(tmp, "chatSessions");
fs.mkdirSync(tDir, { recursive: true });
fs.mkdirSync(csDir, { recursive: true });
const sid = "phonegap-session";
const tfile = path.join(tDir, `${sid}.jsonl`);
const cfile = path.join(csDir, `${sid}.jsonl`);

// initial empty transcript and chatSessions with some old 123/456/789 history
fs.writeFileSync(tfile, "");
fs.writeFileSync(
  cfile,
  JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }) + "\n" +
    JSON.stringify({
      kind: 2,
      i: 0,
      k: ["requests"],
      v: [
        { requestId: "rid-1", timestamp: 1000, message: { text: "回复我 789" }, response: [{ kind: "markdownContent", value: "789" }], isComplete: true },
        { requestId: "rid-2", timestamp: 2000, message: { text: "回复我 123" }, response: [{ kind: "markdownContent", value: "123" }], isComplete: true },
        { requestId: "rid-3", timestamp: 3000, message: { text: "回复我 456" }, response: [{ kind: "markdownContent", value: "456" }], isComplete: true },
      ],
    }) + "\n",
);

const events = [];
const tw = new TranscriptWatcher({
  dir: tDir,
  chatSessionsDir: csDir,
  pollMs: 50,
  fallbackPollMs: 80,
  onEvent: (ev) => {
    events.push(ev);
    const t = (ev.text || "").slice(0, 60).replace(/\n/g, " ");
    console.log(`${ev.type.padEnd(18)} gap=${ev.gapFill ? 1 : 0} idx=${(ev.requestIndex ?? "-").toString().padEnd(3)} | ${t}`);
  },
});

// simulate phone session select and sending a new message
tw.bindFile(tfile, { replay: false });
tw.pinFile(tfile);
await new Promise((r) => setTimeout(r, 150));

console.log("--- phone sends 回复我哦123 ---");
tw.addPendingPhoneUserText("回复我哦123");

// simulate VS Code writing the new user request then response to chatSessions (stale transcript)
await new Promise((r) => setTimeout(r, 200));
fs.appendFileSync(
  cfile,
  JSON.stringify({
    kind: 2,
    i: 3,
    k: ["requests"],
    v: [{ requestId: "rid-4", timestamp: 4000, message: { text: "回复我哦123" }, response: [], isComplete: false }],
  }) + "\n",
);

await new Promise((r) => setTimeout(r, 200));
fs.appendFileSync(
  cfile,
  JSON.stringify({
    kind: 2,
    k: ["requests", 3, "response"],
    v: [{ kind: "markdownContent", value: "123" }],
  }) + "\n",
);

await new Promise((r) => setTimeout(r, 800));
tw.dispose();

const agent = events.filter((e) => e.type === "AGENT_MESSAGE" || e.type === "AGENT_STREAM_SET");
console.log("\n--- agent events ---");
for (const e of agent) console.log(`${e.type} gap=${e.gapFill ? 1 : 0} idx=${e.requestIndex} | ${(e.text || "").slice(0, 80)}`);

if (agent.some((e) => String(e.text).includes("123"))) {
  console.log("\nPASS: phone reply 123 gap-filled");
} else {
  console.log("\nFAIL: no phone reply");
}

fs.rmSync(tmp, { recursive: true, force: true });
