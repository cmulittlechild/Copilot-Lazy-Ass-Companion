# R20 retest — 2072b63 fix for R19 BUG-3 (per-event _sess wins; fallback tags own file)

Build: vsix 04:50 == repo dist == HEAD 2072b63 (emit() `!ev._sess` guard so sessiondb `r.session_id` tag survives; fallback events get fbSess; d35e9e4 releaseDone sweep included). Installed dist verified byte-identical. Bridge pid 4864 :3010. Monitor → ~/mon_r20.log. Sends ASCII `M20`, `####` markers.

## Steps

1. **BUG-3 repro (primary)** — currently bound 9c6e9dd0. Send `M20L: write a 120 word essay about rivers` on it; ~3-4s into streaming open ☰ → select `4b0f0160` (硒的元素符号, 41 req) → IMMEDIATELY send `M20SW: reply with exactly: sw20 ok`.
   PASS: `AGENT_MESSAGE` for M20SW carries `sess=4b0f0160` LIVE ≤~15s and **renders** in feed (R19 stamped sess=old → filtered → stuck typing ~19s). Essay-tail events keep `sess=9c6e9dd0` on wire but do NOT appear in the 4b0f0160 feed (foreign filter). sessiondb row sess=4b0f0160; jsonl M20SW in 4b0f0160 only.
   FAIL: any `sess=9c6e9dd0` on M20SW's frames (mis-tag → dropped); feed shows no sw20 answer until a later replay; essay fragments leak into 4b0f0160 feed.
2. **BUG-2 regression (no tug-of-war)** — stay on 4b0f0160 ≥70s after the mid-turn select.
   PASS: zero `SESSION_SELECTED`/`REPLAY` to another session (same-direction follow to 4b0f0160 acceptable). FAIL: any opposite-direction bounce.
3. **BUG-1 regression (select-send race)** — ☰ → `83b72c09` → send `M19SW2`-style `M20S2: reply with exactly: s2 ok` within ~5s.
   PASS: live `AGENT_MESSAGE sess=83b72c09` ≤15s + renders.
4. **Forensics** — grep mon_r20.log: SESSION_SELECTED/REPLAY census; any `sess=` tag ≠ the turn's real session (compare vs sessiondb rows); CLOSED=0; dup AGENT per ut; jsonl M20 attribution; requests/END stragglers carry their own sess and don't render cross-feed.

## Notes
- Rebind window maximized by step-1's in-flight turn (R19 measured ~52s lag when select queues behind a running turn).
- _sess filter asserts at FEED level (what renders), not wire (global poll legitimately broadcasts other sessions' events tagged with their own sess).
