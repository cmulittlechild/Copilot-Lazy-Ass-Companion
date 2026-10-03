# R17 — verify 6f0a194: sessiondb fast-path revived (own poll timer)

Setup done: VS Code reloaded → bridge pid 8197 (installed transcriptWatcher.js == repo, contains the independent sessiondb poll timer + prior cda409c/6f2ba29/8d87f01 chain). Monitor → ~/mon_r17.log, PWA hard-reloaded.

Expected vs R16 (where zero sessiondb events fired): `sessiondb/` prefixed events should reappear on the wire, and same-answer-different-question answers should arrive via `sessiondb/N AGENT_MESSAGE` within ~seconds rather than ~50s via requests/N.

## Tests (chronological)

1. **sessiondb channel alive** — any turn should produce a `sessiondb/...` event (END or content) on the wire. Baseline watch during test 2.
   PASS: ≥1 `sessiondb/` line appears in mon_r17.log during the run (R16 had zero).
   FAIL: still zero sessiondb events.

2. **Same-answer-different-question direct delivery (R14 death + R15/R16 slow-path)** —
   a. `M17A: create file r17a.txt containing x, reply exactly: Created `r17a.txt` - **done**` → wait for answer.
   b. `M17B: reply with exactly: Created `r17a.txt` - **done**` (same answer text, different _ut).
   PASS: wire shows `sessiondb/... AGENT_MESSAGE "Created `r17a.txt` - **done**"` (or an AGENT_MESSAGE broadcast) for M17B's ut within ~5-10s of send — NOT a 40-55s wait for requests/N SET. Bubble renders `r17a.txt` code+bold, single card.
   FAIL: no sessiondb event and answer only arrives ~+45s via requests/N (same as R15/R16).

3. **Filename fidelity on any re-projection** — watch +16-45s post-answer for a second same-ut broadcast; must contain `r17a.txt` (not stripped) and must not create an orphan bubble.
   PASS: either no variant, or variant carries filename / gets dropped — feed stays single-card.

4. **Regression — quick turns**: `M17N1: reply with exactly: n1 ok` → answer; `M17N2: reply with exactly: n2 ok` → answer. PASS: fast delivery, single bubbles.

5. **Regression — queue**: `M17C1: reply with exactly: c1 ok` then immediately `M17C2: reply with exactly: c2 ok` while in-flight. PASS: C2 queued+hint, flushed after teardown, both answers broadcast.

## Watch-fors
- Grep mon_r17.log at end: count `sessiondb` lines (expect >0), USER vs AGENT_MESSAGE per ut, CLOSED=0.
- If sessiondb events appear but only as END len=0 with content still arriving late → partial: channel alive but content race persists.
