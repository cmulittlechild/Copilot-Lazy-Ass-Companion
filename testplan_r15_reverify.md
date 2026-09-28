# R15 — verify 8d87f01 + cda409c: server-side live-answer loss + inlineReference stripping

Setup done: VS Code window reloaded → bridge pid 7134 runs new dist (transcriptWatcher.js cda409c, jsonl.js 8d87f01 — all installed hashes MATCH repo). app.js unchanged (691f9714). Monitor → ~/mon_r15.log. PWA hard-reloaded.

Fix semantics: ① asked-but-unanswered _ut answers exempt from isReplayedFor/isStalePendingReplay suppression (different question, same answer must NOT be swallowed); ② sessiondb fast-path consumes pendingGap after delivering; ③ transcript serializer emits `filename` for inlineReference parts (no more stripped variants/empty answers).

## Tests (chronological)

1. **R14-death repro: same answer text, different _ut** —
   a. Send `M15A: create file r15a.txt containing x, reply exactly: Created `r15a.txt` - **done**` → wait for answer.
   b. Then send `M15B: reply with exactly: Created `r15a.txt` - **done**` (same answer text as A, different _ut — this is what died in R14).
   PASS: wire shows `<<< AGENT_MESSAGE "Created `r15a.txt` - **done**"` for M15B's ut (NOT an END len=0-only turn); PWA renders the answer bubble; sessiondb turn exists.
   FAIL: sessiondb/requests END len=0 with no AGENT_MESSAGE (the R14 silent-loss signature), or bare user bubble >60s.

2. **inlineReference fidelity (fix ③)** — same turns produce file-reference answers. Check wire AGENT_MESSAGE text and rendered bubble: must contain backticked `r15a.txt` (NOT "Created  - **done**" double-space stripped form). Also watch +16-45s window: any re-projection must carry filename too — and client shouldn't render an orphan (R14 client fix still active).
   PASS: wire variant text retains `r15a.txt`; feed single card with code formatting.

3. **Regression — normal multi-turn**: `M15N1: reply with exactly: n1 ok` → answer → `M15N2: reply with exactly: n2 ok` → answer. PASS: both broadcast + render ≤25s.

4. **Regression — queue**: `M15C1: reply with exactly: c1 ok` → immediately `M15C2: reply with exactly: c2 ok` while in-flight. PASS: C2 queued bubble+hint, flushed after C1 teardown, answered; and crucially C2's ANSWER must broadcast (R14's C2 lost it — regression watch).

5. **Regression — stop**: `M15S: write a 300 word essay about deserts` → double-click stop while streaming. PASS: DONE[phone_stop], partial/or placeholder, then `M15S2: reply with exactly: s2 ok` answers (no dead-rr).

6. **Regression — switch**: ☰ → 氢的元素符号 → back. PASS: titles correct, one replay each, feed consistent.

## Watch-fors
- Wire: every turn should show AGENT_MESSAGE (not just END len=0). Count USER vs AGENT_MESSAGE with ut at end.
- Desktop mirror for missing answers.
- No orphan/duplicate bubbles; no 该轮无回复 phantom for answered turns.
