# R19 retest — a27de87 fixes for R18 BUG-1/BUG-2 (installed vsix==HEAD 776524c)

Build: vsix packed 04:27 == repo dist == HEAD 776524c (a27de87 global sessiondb poll + select-as-bound-activity + stale-follow drop; dc0a8b9 arbiter isSessionDb a3-exempt; 3fb1edb tail-rr fix; 776524c deferred phone stop). Installed dir verified byte-identical except bridge.js/qrPanel.js (whitespace-only HTML template diffs). Bridge pid 4057 :3010. Monitor → ~/mon_r19.log. All sends ASCII `M19`, `####` markers in log.

## Steps

1. **REG select replay** — PWA ☰ → `9c6e9dd0` already bound post-reload; verify feed intact, no residue.
2. **BUG-1 retest (live delivery on select-send race)** — ☰ → `83b72c09` row → IMMEDIATELY click #input, type `M19SW: reply with exactly: sw19 ok`, Enter (~1.5-4s after select click).
   PASS: `>>> USER_MESSAGE sess=83b72c09`; live answer frames within ~15s (AGENT_MESSAGE/STREAM possibly `id=sessiondb/83b72c09*/<row>` + DONE) — NOT silent-until-replay like R18. FAIL: zero live frames again; answer only via later replay.
3. **BUG-2 retest (no tug-of-war)** — remain on 83b72c09 idle ≥65s after step-2 select.
   PASS: zero SESSION_SELECTED/REPLAY after the select's own replay (R18 had backward follow at +20.8s and 34adae78 yanks at +20-23s). FAIL: any bounce.
4. **REG multi-turn** — `M19A: reply with exactly: a19 ok` → answer; `M19B: reply with exactly: b19 ok` → answer (both sess=83b72c09).
   PASS: U→A ≤25s each, exactly one bubble per ut.
5. **REG queue rapid-fire** — `M19Q1: reply with exactly: q1 ok` then `M19Q2: reply with exactly: q2 ok` while Q1 in-flight.
   PASS: Q2 queued half-opacity → drains after Q1 result-DONE; wire U A U A; drain <90s.
6. **Cross-session `_sess` filtering (NEW mechanism probe)** — send `M19X: reply with exactly: x19 ok` on 83b72c09, then IMMEDIATELY ☰ → `9c6e9dd0` while X in-flight.
   PASS: wire delivers X answer with `sess=83b72c09*`; 9c6e9dd0 feed does NOT show "x19 ok"/M19X (client-side _sess filter, app.js:2040); switching back to 83b72c09 shows M19X+answer. FAIL: x19 bubble renders inside 9c6e9dd0 feed; or answer lost entirely.
7. **dc0a8b9 bonus (same-text re-ask)** — `M19DUP: reply with exactly: dup19 ok` twice on same session.
   PASS: both turns get answers (old a3 dedupe killed second same-text answer via sessiondb path).
8. **Forensics** — grep mon_r19.log: SESSION_SELECTED/REPLAY pairs (expect only real selects/follows), CLOSED=0, `sessiondb/` frames for M19SW, dup AGENT per ut, `_sess` on broadcast events; sessiondb rows for all M19; jsonl greps M19SW/X→83b72c09 only.

## Notes
- After global poll, monitor will show `sess=<file>` on sessiondb events for OTHER sessions too — that's expected broadcast behavior; the assertion is feed-level (what renders), not wire-level (what broadcasts).
- Keep sends ASCII-only; screenshot input before sends; click #input while rr armed.
