# R91 re-verification — HEAD 449bdb3 (R90 fixes + win r71)

Targeted regression per lead checklist (~5min), PWA Chrome tab + ws_monitor_tok.mjs + sessiondb. All sends use R91x prefixes, ASCII-only.

1. **Stop + focus trap** — send `R91A: write a 400 word essay on rain`; while streaming press 停止 once via UI → expect DONE[phone_stop], button back to 发送 within ~5s; then press Space (button must NOT re-arm/stop — blur fix).
   PASS: release ≤5s; Space produces no phone_stop/no arm UI.
2. **Rapid-fire pair** — send `R91B: reply with exactly: bravo ok`; while running type+send `R91C: reply with exactly: charlie ok` (click input first).
   PASS: strict U→A→U→A in feed; wire U2 broadcast only after B's result-DONE; queue delay <30s.
3. **Same-text re-ask** — send `R91D: reply with exactly: same ok` twice in a row (wait for A1 then send identical text again).
   PASS: TWO user bubbles + TWO answers; second answer not swallowed by same-text dedupe.
4. **Replay storm throttle** — phone ☰ → switch session → back.
   PASS: monitor shows exactly ONE HISTORY_REPLAY per select (no 0.2s ×5 burst).
5. **Stray surfaces** — watch wire during all sends.
   PASS: no late TOOL_CALL inside another turn's window; no prior-answer text re-broadcast under new _ut; no extra bubble vs desktop.
6. **Regular coverage** — tool turn (`R91T: create file r91test.txt containing r91-ok`), model switch once, then ~3min idle → send `R91I: reply with exactly: idle ok`.
   PASS: file exists; pill updates; post-idle send broadcasts immediately + answer arrives.

Forensics: grep mon log for dup AGENT_MESSAGE / HISTORY_REPLAY bursts / STREAM after END / CLOSED; sessiondb tail for turns.
