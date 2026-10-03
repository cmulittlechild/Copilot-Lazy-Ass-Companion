# R92 re-verification — HEAD 26dd258 (R91 findings fixes)

Lead checklist (~5min), PWA Chrome + ws_monitor_tok.mjs → ~/mon_r92.log + sessiondb. ASCII-only sends, R92x prefixes.

## Targeted regressions (R91 findings)

1. **Cross-session residue bubble** — pendingSend now carries sess; repaint only in origin session.
   Repro: in bound session A send `R92A: reply with exactly: alpha ok`, wait for answer; then ☰ → select EMPTY "New Chat" (ca928c48 or another 0-request session).
   PASS: session B feed contains ZERO bubbles from A (no stray user/assistant bubble).
2. **Parked tool re-projection** — TOOL_* deduped by toolId 5min; dup running frames dropped, done updates pass.
   Repro: `R92T: create file r92test.txt containing r92-ok` → watch tool card running→done on PWA.
   PASS: TOOL_CALL on wire once, card reaches done state; file exists.
3. **Orphan content to cross-channel-settled turn dropped** — same-text re-ask must still work.
   Repro: `R92D: reply with exactly: same2 ok` twice (wait A1 then identical again).
   PASS: two user bubbles + two answers.

## Regular regression
4. Multi-turn + rapid-fire pair (R92B/R92C) → strict U→A→U→A.
5. Stop key: send `R92S` mid-flight → double-click 停止 → DONE[phone_stop], button→发送 ≤5s, orphan placeholder.
6. Session switch: exactly ONE HISTORY_REPLAY per select both directions.
7. ~3min idle → `R92I` send broadcasts immediately + answer.
8. Stray watch: no late TOOL_CALL in wrong window, no dup-variant AGENT_MESSAGE surface (wire note), no post-END re-render, 0 CLOSED.

Forensics: grep mon log dup AGENT_MESSAGE / replay bursts / post-END / CLOSED; sessiondb tail.
