# R120 deep marathon — mac side (bb58e8f / vsix 1.0.6, post-R118)

Build: `copilot-sidecar-companion-1.0.6.vsix` (Oct 2 01:56) == installed `local-dev.copilot-sidecar-companion-1.0.6` byte-identical (dist+media diff clean); extension host pid 2040 respawned 02:21 AFTER install → running new build. Bridge :3010 healthy (clients≥1, pwaOk). Monitor → `~/mon_r120.log` + Terminal tail; markers `echo "#### TAG $(date +%T)" >> ~/mon_r120.log` before each action. Model deepseek-v4-flash, mode Agent, permission 默认审批 (tool calls need VS Code-side approve).

Sessions: A = `2edbd45d-…c7f8f` (bound, empty) — all R120 sends land here. B = `ee59cb36-…2c82` (empty) — switch target. Forensic anchor = `cd9ba14e-…30c4` (R119 sess: replay already shows req0 false-orphan + mis-slotted "testA ok" fragment — CONFIRMED pre-run via probe+PWA; re-verify during step 8).

All sends prefixed `R120`, ASCII-only, click #input before typing while a turn runs (send-btn focus trap).

## Steps

0. **Re-anchor A** — PWA ☰ → row "2edbd45d-…" → SESSION_SELECTED ok; feed empty. Warmup `R120W: reply with exactly: w120 ok` → AGENT_MESSAGE ≤15s. (proves pipeline)

1. **Identical-text ×3 LIVE + replay** — send `R120S: reply with exactly: same120 ok` → wait AGENT → send IDENTICAL → wait → send IDENTICAL.
   PASS wire: 3 `USER_MESSAGE` + 3 distinct answer deliveries (AGENT_MESSAGE or SET) each `ut="R120S:…"`; NO swallow (R119 signature = 2nd answer never broadcast / mis-ut'd `ut="R118M"` stray `id=t1m…`); zero wrong-sess paint.
   PASS UI: U A U A U A — each answer under its own bubble, no floating bare fragment, no 「该轮无回复」 under an answered live turn.
   Then Cmd+R → PASS replay: still U A U A U A aligned; req0/req1/req2 each own their answer — no false orphan, no mis-slotted dup under one bubble. **← adversarial vs cd9ba14e defect**

2. **Send +1.5s refresh (in-flight)** — `R120R: write a 150-word essay about lakes` → ~1.5s after send, Cmd+R.
   PASS UI post-reload: ONE R120R user bubble; answer completes in ONE card (no split/orphan/dup); NO 「发送可能未送达」 false banner (wire had USER_MESSAGE pre-reload; pendingSend false-positive = FAIL).
   PASS wire: answer delivered post-reload stamped `ut="R120R:…"`.

3. **Stop ×2 rapid alternation** — `R120T1: write a 500-word essay about mountains` → ~6s into stream, 停止 double-click ≤3s → IMMEDIATELY `R120T2: write a 500-word essay about rivers` → ~6s in, 停止 double-click → `R120T3: reply with exactly: t120 ok`.
   PASS wire: DONE[phone_stop|closedUt] for T1 ≤5s and T2 ≤5s after confirm click; T3 U→A ≤20s, not eaten/stuck queued.
   PASS UI: T1 partial mountain text under T1 bubble; T2 partial river text under T2 bubble — NO cross-attachment; T3 clean. Cmd+R → partials/orphan ordering still correct.

4. **Confirm card (tool call)** — `R120F: create a file named r120f.txt containing f120-ok then reply with exactly: f120 done` → VS Code approval prompt → PWA confirm card renders → approve in VS Code.
   PASS wire+UI: AGENT_CONFIRM once (no multi-id dup cards); resolves → card disappears zero-residue (no ghost card on later Cmd+R); file `~/sidecar-test-ws/r120f.txt` = f120-ok; answer `f120 done` arrives ≤30s of approve.

5. **Long-stream mid-flight refresh** — `R120L: 写一篇1200字以上技术长文介绍分布式系统，包含至少一个代码块和一个表格` → ~8s into visible stream Cmd+R.
   PASS UI: single card continues→completes incl. code block+table; no split/orphan/dup partial card; no re-render flicker of finished text.
   PASS wire: no stream frames for that streamId after its END reaches client.

6. **Queue ×2 + mid-flight switch** — `R120Q1: reply with exactly: q120-1 ok` → immediately `R120Q2: reply with exactly: q120-2 ok` (queued bubble/hint) → while Q2 in-flight ☰ → B(`ee59cb36`) → stay; wire: A's Q2 AGENT arrives `sess=2edbd45d` (NOT painted into B feed) → send `R120B: reply with exactly: b120 ok` in B → answer `sess=ee59cb36` → ☰ back to A.
   PASS: B feed showed ZERO A-session bubbles; back in A all R120 turns aligned U-A in order; Q1/Q2 each answered; Cmd+R on A → replay still correct.

7. **Cold reconnect replay** — Cmd+W close PWA tab ~10s → reopen `127.0.0.1:3010`.
   PASS: full replay ≤8s, correct tail; A feed complete & single-copy each turn; zero phantom/duplicate bubbles; clients back to 2 (PWA+monitor); no CLOSED storm on wire.

8. **Forensics** —
   - replay probe on A: dump messages → verify U/A pairing, ridx/_ut stamps (no mis-slot like cd9ba14e).
   - replay probe on `cd9ba14e`: re-confirm req0 false-orphan + ridx0 block under ridx1 (KNOWN-DEFECT evidence snapshot).
   - sessiondb: `select session_id,turn_index,substr(user_message,1,30),substr(assistant_response,1,30),timestamp from turns order by timestamp desc limit 15` — all R120 turns present in right session.
   - grep mon_r120: CLOSED census; every `R120*` USER has matching answer broadcast; foreign-sess paints=0; stray-ut census (`ut=` not matching any R120 text); dup AGENT_MESSAGE per ut; TOOL_CALL containment.
   - jsonl tail of A for upstream requestIndex slotting of the R120S triple.

## Judgement refs
- Answer latency ≤25s normal (sessiondb fast path); queued flush waits [result] DONE (~30-45s) — not a stall.
- Stop: double-click within 3s (armed stop); button back to 发送 ≤5s.
- Orphan placeholder 「该轮无回复」 is expected ONLY for genuinely-unanswered turns (stopped/failed) — and ONLY in replay, never live.
- Instant self-healing misorder (<2min) is known/benign — recheck before reporting.
- Input-field char-drop from typing driver = test artifact, distinguish before reporting.
