# R22 marathon regression — b35c7e6 (hadOwnUt gate on phantom reassign)

Build: vsix 05:30 == repo dist == HEAD b35c7e6 (arbiter gate: `hadOwnUt` — only _ut-less events get owner-turn reassign; sessiondb events keep own _ut → same-text re-ask second answer no longer eaten). Installed dist byte-identical; gate at dist/turnArbiter.js:410-413. Bridge :3010 clients=2, bound 34adae78. Monitor → ~/mon_r22.log. Sends ASCII `M22` + `####` markers.

## Steps

1. **Cold-connect replay** — PWA Cmd+Shift+R → feed re-renders 34adae78 history (unicast replay; monitor shows nothing — feed is the assertion).
   PASS: full history visible ≤5s.
2. **Multi-turn** — `M22A: reply with exactly: a22 ok` then `M22B: reply with exactly: b22 ok`.
   PASS: each `AGENT_MESSAGE sess=34adae78` ≤15s, rendered, correct ut.
3. **Tool call** — `M22T: create a file named r22test.txt containing r22-ok then reply with exactly: t22 ok`.
   PASS: `TOOL_CALL` on wire; `~/sidecar-test-ws/r22test.txt` exists w/ content; answer renders.
4. **Double race (lead emphasis)** — on 4b0f0160 send `M22L: write a 120 word essay about oceans` → ~4-6s into streaming ☰→select `9c6e9dd0` → IMMEDIATELY send `M22SW: reply with exactly: sw22 ok`.
   PASS: M22SW answer arrives LIVE `sess=9c6e9dd0` ≤15s rendered; ocean essay tail keeps `sess=4b0f0160` on wire but NOT in 9c6e9dd0 feed; no `sess` mis-tag; no opposite-direction SESSION_SELECTED bounce ≥70s.
5. **Rapid-fire queue** — `M22Q1: reply with exactly: q22 ok` then IMMEDIATELY `M22Q2: reply with exactly: q2b ok`.
   PASS: Q2 queues (已排队/半透明) → flushes after Q1 result-DONE → both answered in order U A U A.
6. **Stop** — `M22E: write a 150 word essay about volcanoes` → press 停止 within ~8s of stream start.
   PASS: `COPILOT_DONE [phone_stop]` or stop wire signal; composer recovers; feed shows stopped state; next send `M22R: reply with exactly: r22 ok` answers normally.
   (best-effort: essay may finish before click — note coverage)
7. **Short idle** — ~60s no sends.
   PASS: PING ~8s cadence, CLOSED=0, no replay storm.
8. **Same-text re-ask (hadOwnUt adversarial)** — `M22DUP: reply with exactly: dup22 ok` → DONE → send SAME text again.
   PASS: BOTH turns answered (sessiondb gets 2 rows) — THE gate regression: second answer must NOT be eaten by phantom-reassign branch.
9. **Phantom watch (incidental)** — all run: `grep "<<< AGENT_MESSAGE" | grep -v "sess="` census.
   PASS: zero bare projections that duplicate a prior answer under a different ut (if any bare projection appears, verify it's either absent→a2-eaten or carries its real owner's ut).
10. **Forensics** — sessiondb rows all M22 turns correct-session; jsonl token-attribution (M22SW only in 9c6e9dd0, M22L only in 4b0f0160); CLOSED=0; replays=1/select+follow pairs only; dup-ut census = M22DUP×2 only.

## Notes
- Bound start = 34adae78; drawer rows re-sort — screenshot before click.
- Essay ~15-25s stream window for stop/select racing; prepare clicks early.
- Assert _sess filtering at FEED level (wire legitimately carries other sessions' events).
