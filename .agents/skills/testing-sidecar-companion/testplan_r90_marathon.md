# R90 Marathon — full-scenario regression on HEAD 4aa92be (includes 8f1ab3f endedStreams)

~8 min continuous run on the installed 1.0.6 extension (installed dist .js == repo dist, verified byte-identical).
Layout (same as last round): Chrome PWA `http://127.0.0.1:3010/?token=…` left, extension QR panel middle, VS Code Copilot chat right.
Monitor: `node .agents/skills/testing-sidecar-companion/ws_monitor_tok.mjs | tee ~/mon_r90.log` (token-authed PHONE_CONNECT, wall-clock stamps). Send times recorded via `date`.

All prompts prefixed `R90` and kept short/ASCII (IME driver drops CJK chars — known artifact). Every send: screenshot input BEFORE clicking to prove text landed (empty-click = stop, kills in-flight turn).

## Sequence (chronological, ≈8 min)

1. **Cold-connect replay** — Cmd+Shift+R hard reload PWA on bound session `9c6e9dd0…jsonl` (has history incl. failed reqerr turns).
   PASS: monitor shows HISTORY_REPLAY n>0 for bound file; feed renders strict U/A interleave; failed turns show 「该轮无回复」 placeholder; ZERO duplicate bubbles; ZERO phantom previous-answer bubble within 2s of any repaint.
2. **Multi-turn** — send `R90A: reply with exactly: alpha ok` → wait answer → send `R90B: reply with exactly: beta ok`.
   PASS: each USER_MESSAGE >>> on wire then AGENT_MESSAGE <<< (≤25s to answer); exactly one answer bubble per turn; desktop chat shows same Q&A; sessiondb `turns` gains rows.
3. **Tool turn** — send `R90C: create file r90test.txt containing exactly "r90-ok" then reply with: file done`.
   PASS: TOOL_CALL/THINKING events on wire; file `~/sidecar-test-ws/r90test.txt` exists with `r90-ok`; answer bubble + desktop Keep/Undo appears.
4. **Session switch both ways** — phone ☰ drawer → pick a different session → HISTORY_REPLAY of that file renders; then switch back to bound; then on DESKTOP pick another chat history item → phone feed follows (SESSION_FOLLOW) or at minimum doesn't wedge.
   PASS: each phone-side select emits HISTORY_REPLAY n>0 matching file; feed swaps content; no error toast; return to bound session works.
5. **Rapid-fire queue** — send `R90D: reply with exactly: delta ok`; while streaming/running type `R90E: reply with exactly: echo ok` and press send (queues client-side; hint expected); after A1+DONE, U2 auto-flushes.
   PASS: wire shows U2 broadcast ONLY after turn-1 DONE (U2−U1 > A1−U1); queued hint visible during wait; both answers land in order U1A1U2A2 in feed (not U1U2A1A2).
6. **Stop** — send `R90S: write a 500 word essay about oceans`; ~2s in, empty-input press 停止 twice (<3s apart).
   PASS: generation halts; button returns to 发送; NO late AGENT_MESSAGE re-renders the essay (endedStreams drop); next send not blocked (no 135s hang); if zero content was emitted, 「该轮无回复」placeholder appears.
7. **Short idle** — do nothing ~90s. PASS: monitor PING continues (~8s cadence), zero CLOSED; next send reaches bridge immediately (no swallow).
8. **Model switch** — composer pill → model sheet → pick a DIFFERENT model → pill text updates instantly; send `R90M: reply with exactly: model ok`; switch back.
   PASS: pill changes; answer arrives under new model; no #modelError red bar (or if bar shows, capture it).
9. **Post-run forensics** (monitor log + sessiondb): grep `STREAM_START` count (dead-stream suppression), duplicate AGENT_MESSAGE same streamId, `压制` suppressions, queue timing (U2−U1 vs A1−U1), sessiondb last rows.

## Adversarial notes
- endedStreams (8f1ab3f) is directly probed by test 6: late frames after END must not re-render or re-arm rr (was 135s queue hang).
- If upstream keeps returning "Sorry, no response was returned." (seen on desktop), turns degrade to reqerr — still valid: verifies live orphan placeholder + no stuck 停止 button; flag coverage gap in report.
- Desktop-visible verification at each answer (chat panel mirrors bubbles).
