# Round-12 Marathon — full-scenario regression on installed 1.0.6 (HEAD 202e08c + uncommitted emittedA2 dist rebuild; lead reports vsix=8f1ab3f-era latest)

~8 min continuous run. Layout: Chrome PWA `http://127.0.0.1:3010/` left, VS Code Copilot chat right, Terminal running `node .agents/skills/testing-sidecar-companion/ws_monitor_tok.mjs | tee ~/mon_m12.log` bottom strip. Send times via `date`. Bridge has no token (tokenPresent:false). Bound session `9c6e9dd0…jsonl` (80 turns — has history incl. orphan/reqerr turns for replay test).

All sends prefixed `M12`, ASCII-only (IME driver drops CJK). Before EVERY send click: screenshot input to prove text landed (empty-click while armed = phone_stop kills in-flight turn). While a turn is in-flight, click #input BEFORE typing (send button is 停止 and holds keyboard focus — Space would re-fire it).

## Sequence (chronological)

1. **Cold replay** — Cmd+Shift+R on PWA (bound session).
   PASS: HISTORY_REPLAY n>0 once (no <0.2s ×5 storm); feed strict U/A interleave; orphan turns show 「该轮无回复」; ZERO dup bubbles; ZERO stray prior-answer bubble.
2. **Multi-turn** — send `M12A: reply with exactly: m12a ok` → answer → `M12B: reply with exactly: m12b ok`.
   PASS: wire `>>> USER_MESSAGE` then `<<< AGENT_MESSAGE` ≤25s each; one answer bubble per turn; desktop chat mirrors same Q&A.
3. **Tool turn** — send `M12T: create file m12test.txt containing m12-ok`.
   PASS: TOOL_CALL on wire; `~/sidecar-test-ws/m12test.txt` exists containing m12-ok; tool card settles done; answer bubble arrives.
4. **TRIPLE rapid-fire (aggressive)** — send `M12C1: reply with exactly: c1 ok`; while in-flight click input → type+send `M12C2: reply with exactly: c2 ok`; repeat `M12C3: reply with exactly: c3 ok`.
   PASS: C2/C3 queued bubbles render IMMEDIATELY at half-opacity (e780955); wire U2 only after t1 result-DONE, U3 only after t2 DONE — (U2−U1)>(A1−U1); feed strict U A U A U A (queued bubble re-stamps ts on dequeue, no U1U2U3 clump); total drain <90s (NO 135s rr-hang = 8f1ab3f probe); no 「该轮无回复」 phantom row between turns.
5. **Send→immediate switch (aggressive)** — send `M12D: reply with exactly: m12d ok`; WHILE desktop still Thinking, ☰ → session `8096841a` (2 turns) or newest empty `83b72c09`.
   PASS: target feed shows ONLY that session's own history — ZERO residue of M12D bubble (sentAwaitingReply sess-gate, R94 fix); switch back → M12D bubble+answer intact.
6. **Stop→immediate re-send (aggressive)** — send `M12S: write a 300 word essay about oceans`; ~2s in press 停止 (click once; if still armed/streaming click again <3s).
   PASS: DONE[phone_stop] on wire; button→发送 ≤5s; if zero content, 「该轮无回复」 placeholder; IMMEDIATELY send `M12S2: reply with exactly: afterstop ok` → broadcasts at once + answer arrives (no dead-rr swallow / no post-END stream re-arm).
7. **Idle ~2min** — touch nothing.
   PASS: PING ~8s cadence throughout; 0 CLOSED; no HISTORY_REPLAY storm; then send `M12I: reply with exactly: idle12 ok` → reaches wire immediately, answer ≤25s.
8. **Model switch** — composer pill → sheet → pick DIFFERENT model → pill text updates; send `M12M: reply with exactly: model12 ok` → answer; switch pill back.
   PASS: pill changes instantly; no #modelError red bar; answer lands.
9. **Long-text render** — send `M12L: write a 250 word markdown essay about tides, use ## headers and one code block`.
   PASS: renders real markdown (headers/code styled — NOT `text|Copy` gray fallback pre); single bubble; no re-render/duplication after stream END (endedStreams); feed stays scrolled correctly.
10. **Bidirectional switch** — ☰ → `8096841a` → back to bound 9c6e9dd0 → optionally desktop picks another chat history item (phone should follow or stay consistent).
    PASS: one HISTORY_REPLAY per select; each feed swaps to correct content; return lands on bound session with all M12 turns.
11. **Forensics** — grep ~/mon_m12.log: HISTORY_REPLAY count vs selects; CLOSED count (expect 0); dup AGENT_MESSAGE per ut; USER_MESSAGE timing vs DONE[result]; sessiondb last 12 rows all M12 turns answered.

## Adversarial notes
- endedStreams (8f1ab3f) probed by 4 (queue drain), 6 (post-stop resend), 9 (post-END re-render).
- Queued-bubble fix (e780955) probed by 4 — bubbles must appear at enqueue time, half-opacity.
- Residue gates (26dd258 + uncommitted sentAwaitingReply) probed by 5 — in-flight switch is the R94 failure path.
- If upstream returns "Sorry, no response was returned." the turn is still valid coverage (reqerr path) — note in report, verify vs desktop.
- VS Code "Update" badge is staged — if VS Code relaunches mid-run the bridge dies; abort and report.
