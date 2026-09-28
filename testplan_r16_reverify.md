# R16 — verify 6f2ba29: negative-requestIndex dedupe key fix (sessiondb fast-path direct delivery)

Setup done: VS Code reloaded → bridge pid 7590 runs new dist (installed transcriptWatcher.js == repo). Monitor → ~/mon_r16.log, PWA hard-reloaded.
Fix semantics: sessiondb events have requestIndex=-1; the `::idx=-1` dedupe key was shared across turns so a same-text answer under a different question got suppressed → now negative idx emits no key.

## Tests (chronological)

1. **R15-repro — same answer, different question, direct delivery** —
   a. `M16A: create file r16a.txt containing x, reply exactly: Created `r16a.txt` - **done**` → wait for answer (AGENT_MESSAGE with filename backticks).
   b. `M16B: reply with exactly: Created `r16a.txt` - **done**` (same answer text, different _ut).
   PASS (the R16 claim): wire shows `<<< AGENT_MESSAGE "Created `r16a.txt` - **done**" ut="M16B..."` arriving within ~10s — ideally via the sessiondb fast-path — NOT a lone `sessiondb/N END len=0` then +45s requests SET. Bubble renders immediately, single card, code+bold intact.
   FAIL (old behavior): sessiondb END len=0 only, answer arrives ~+45s via requests/N SET, or never.

2. **Filename fidelity on re-projection** — after M16B, watch +16-45s for any second broadcast of the same ut: if one comes it must carry `r16a.txt` (not "Created  - **done**" stripped) and must NOT produce an orphan bubble (R14 client fix still active).

3. **Regression — normal turns**: `M16N1: reply with exactly: n1 ok` → answer ≤10s; `M16N2: reply with exactly: n2 ok` → answer. PASS: prompt AGENT_MESSAGE on wire, single bubbles.

4. **Regression — quick queue**: `M16C1: reply with exactly: c1 ok` then immediately `M16C2: reply with exactly: c2 ok`. PASS: C2 queued with hint, flushes, BOTH answers broadcast.

## Watch-fors
- The exact delivery path for M16B: AGENT_MESSAGE (sessiondb) vs STREAM_SET (requests/N). Time-to-wire.
- No orphan bubbles, no phantom 该轮无回复 for answered turns.
- 0 CLOSED.
