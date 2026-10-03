# R21 retest — 3744a06 fix for R20 BUG-4 (phantom reprojection re-attributed to owner turn)

Build: vsix 05:07 == repo dist == HEAD 3744a06 (arbiter: unproven same-text AGENT_MESSAGE whose text was already emitted under a different turn instance gets `utKey=altPrev.ut, ownerTurn=altPrev.turn` → a2 dedupe eats the phantom; same-ut re-ask exempt). Installed dist verified byte-identical. Bridge pid 5443 :3010. Monitor → ~/mon_r21.log. Bound session: 83b72c09.

## Steps

1. **BUG-4 repro** — on 83b72c09 send `M21S: reply with exactly: s21 ok` → wait DONE → ~20s idle → send `M21E: write a 150 word essay about forests` (keeps next turn open ~20s). Watch wire ≥30s.
   PASS: no `AGENT_MESSAGE "s21 ok" ut="M21E:..."` anywhere; if a late reprojection emits at all it carries `ut="M21S:..."` (old owner) and produces no extra AGENT_MESSAGE broadcast (a2-eaten). Feed: M21E shows only the essay — no "s21 ok" bubble under it.
   FAIL: `AGENT_MESSAGE "s21 ok" ut="M21E:..."` broadcast (phantom under new turn) or feed shows s21 ok under M21E.
2. **同题重问对抗** — send `M21DUP: reply with exactly: dup21 ok` → answer → send SAME text again.
   PASS: second identical turn also gets an answer (`ut="M21DUP:..."`), not eaten as dup; sessiondb gets a 2nd row.
   FAIL: second send produces no answer or its answer attributed to turn 1.
3. **BUG-1/3 regression (select-send race + stamp)** — ☰ → `4b0f0160` → send `M21SW: reply with exactly: sw21 ok` within ~3s.
   PASS: live `AGENT_MESSAGE sess=4b0f0160` ≤15s, rendered.
4. **BUG-2 regression** — stay ≥60s on 4b0f0160 post-select.
   PASS: zero opposite-direction SESSION_SELECTED/REPLAY.
5. **Follow on content-ful session (lead ask)** — PWA input: type `M21D: reply with exactly: d21 ok` (do NOT send) → VS Code desktop composer → paste+Enter (desktop send on its current session 34adae78 which HAS content).
   PASS: `SESSION_SELECTED file=34adae78` + `HISTORY_REPLAY` (SESSION_FOLLOW fires; R20 saw zero follows all run — the lead's pending-content theory says content-ful should follow). Then phone send `M21F` → `sess=34adae78`. FAIL: no follow within ~30s → report as over-suppression.
6. **Forensics** — mon_r21.log: dup-per-ut census (M21E must be ×1); any `s21 ok` re-emission's ut; SESSION_SELECTED census; CLOSED=0; sessiondb rows all M21 turns; jsonl attribution M21SW→4b0f0160, M21D→34adae78.

## Notes
- Phantom in R20 fired ~89s after prev DONE / +1.8s into new turn — exact trigger uncertain; essay keeps window open ~20s. If no phantom appears at all (nor old-ut version), mark repro inconclusive-but-clean.
- Monitor prints `sess=`/`ut=` on U/A frames and `id=` on stream frames; a2-eaten phantoms should emit NOTHING — absence of a frame is the assertion.
