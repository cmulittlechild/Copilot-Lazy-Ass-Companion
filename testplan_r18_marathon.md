# R18 Marathon (user iter-12) — full-scenario + NEW edges on installed 1.0.6

Build under test: installed ext dist == repo dist @ 6f0a194 ("8f1ab3f-era" per lead). NOTE: uncommitted turnArbiter.ts `isSessionDb` a3-exemption fix (R17 M17B bug) is **src-only, NOT in this build** — same-text re-ask via sessiondb remains a known latent bug; do not re-report.

~6-8 min continuous run, all ASCII sends prefixed `M18`. Layout: Chrome PWA `127.0.0.1:3010` left, VS Code (sidecar-test-ws, Chat pane) right, Terminal `ws_monitor_tok.mjs | tee ~/mon_m18.log` bottom. Mark each send in-log: `echo "#### <tag> $(date +%T)" >> ~/mon_m18.log` before clicking send. Screenshot input BEFORE every send click (IME/driver drops). While a turn is in-flight click #input before typing (send button = 停止 holds kb focus; Space re-fires it). Bound session on connect = whatever PWA shows; step 1 re-anchors explicitly.

## Sequence (chronological)

1. **Explicit-select replay** — PWA ☰ → row `9c6e9dd0` (634KB, ~80 turns, has orphan/reqerr turns).
   PASS: wire `HISTORY_REPLAY n>0 file=9c6e9dd0*` once; feed strict U/A interleave; orphan rows show 「该轮无回复」; zero dup bubbles; header shows that session.
2. **Cold-connect replay** — Cmd+Shift+R on PWA.
   PASS: `HISTORY_REPLAY n>0` once on reconnect (NO <0.2s ×5 storm); feed identical; no stray prior-answer bubble.
3. **Multi-turn** — `M18A: reply with exactly: m18a ok` → answer; `M18B: reply with exactly: m18b ok` → answer.
   PASS: `>>> USER_MESSAGE` then `<<< AGENT_MESSAGE` ≤25s each; exactly one answer bubble per ut; desktop chat mirrors.
4. **Tool turn** — `M18T: create file m18test.txt containing m18-ok`.
   PASS: TOOL_CALL on wire; `~/sidecar-test-ws/m18test.txt` contains m18-ok; tool card settles; answer bubble arrives.
5. **EDGE stop→immediate rapid-fire** — `M18S: write a 300 word essay about oceans`; ~2s in click 停止 once (arm: 「再次点击确认停止」) → click again <3s w/ empty input (confirm). IMMEDIATELY click #input, type `M18X1: reply with exactly: x1 ok`, send (rr may still hold → queued path); then `M18X2: reply with exactly: x2 ok` while X1 in-flight.
   PASS: `DONE[phone_stop]` ≤5s; button back to 发送; X1 queued-bubble (half-opacity) then broadcast once released; X2 waits X1 result-DONE (~30-45s); wire order U_x1 A_x1 U_x2 A_x2; both answers land; drain <90s. FAIL: sends swallowed (no `>>>`), bubbles lost, rr stuck >10s, answers misattributed.
6. **EDGE send mid-session-switch** — ☰ → click `83b72c09` (473KB) → during replay render click #input, type `M18SW: reply with exactly: sw18 ok`, Enter.
   PASS: wire `>>> USER_MESSAGE` carries `sess=83b72c09`; user bubble survives replay (present after render); answer lands in 83b72c09 feed; post-run `grep M18SW 83b72c09*.jsonl`>0 AND `grep M18SW 9c6e9dd0*.jsonl`==0; no 「发送可能未送达」 false alarm. FAIL: sess=9c6e9dd0 (routed to stale), message absent from both jsonl (swallowed), bubble vanished.
7. **Model switch** — composer pill → sheet → pick a DIFFERENT model → `M18M: reply with exactly: model18 ok` → answer; pill back to Auto.
   PASS: pill text updates instantly; no #modelError red bar; answer lands.
8. **Long-text render** — `M18L: write a 250 word markdown essay about tides, use ## headers and one code block`.
   PASS: real markdown render (styled headers/code, NOT `text|Copy` gray fallback); single bubble; no post-END re-render/dup; scroll ok.
9. **中空闲 ~105s** — touch nothing (PING health + boundHot 90s expiry for step 10).
   PASS: PING ~8s cadence throughout; 0 CLOSED; zero HISTORY_REPLAY during idle.
10. **EDGE follow-bind→send** — VS Code desktop: Chat pane → open a DIFFERENT old chat (history list item, e.g. 「氩的原子序数」/older row). Phone should follow: wire `SESSION_SELECTED file=<picked>` + `HISTORY_REPLAY`. Then send `M18F: reply with exactly: follow18 ok`.
    PASS: follow fires (boundHot expired by step 9); USER_MESSAGE sess=<picked file>; answer lands; desktop that-chat shows the turn. If suppressed instead: deferred follow must arrive ≤~90s more; send M18F after it lands — report which path ran. FAIL: follow never arrives AND no send-path works; M18F lands on stale session (wire sess wrong / jsonl attribution wrong).
11. **Bidirectional switch back** — ☰ → `83b72c09` → M18SW/M18M/M18L turns all present; ☰ → `9c6e9dd0` → M18A/B/T/X turns present.
    PASS: one HISTORY_REPLAY per select; correct per-session content; zero residue.
12. **Forensics** — grep `~/mon_m18.log`: HISTORY_REPLAY count vs selects (1 each); CLOSED=0; dup AGENT_MESSAGE per ut; USER vs DONE ordering; `sqlite3 session-store.db "select session_id,substr(user_message,1,24) from turns order by rowid desc limit 14"` all M18 turns answered; jsonl greps confirm M18SW/M18F attribution.

## Adversarial notes
- Step 5 probes: phone_stop teardown + queue-flush gate (sentAwaitingReply release) + endedStreams post-stop sends. The X1-during-teardown variant exercises flushPendingSendQueue after force rr-release.
- Step 6 probes: msg.file routing under in-flight switch (server `setActiveSessionFile(file)` races desktop inject), addUser during `replaying=true`, sentAwaitingReply sess-splice.
- Step 10 probes: SESSION_FOLLOW after boundHot expiry + first send on a follow-bound session (watcher.selectSession rebind + pendingFollowFile paths).
- If upstream returns "Sorry, no response was returned." the turn still counts (reqerr path) — verify vs desktop.
- VS Code "Update" badge is staged — do NOT reload/update VS Code mid-run (bridge dies); abort + report if it relaunches.
