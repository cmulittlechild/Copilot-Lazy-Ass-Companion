# R14 — verify 651328b: subsequence-drop for content-stripped variant re-projections

Setup done: installed/media/pwa/app.js == repo == served (sha 691f9714). Bridge pid 4676 serves per-request. Need: restart monitor → ~/mon_r14.log, PWA Cmd+Shift+R. Fix reads: on non-replay AGENT_MESSAGE with _ut, if strip(incoming) is a subsequence of strip(rendered answer after the matching user bubble) AND len≥6 AND ≥40% coverage → drop (prevents orphan bubble).

## Tests (chronological)

1. **R13 repro — variant dropped** — send `M14V: create file m14v.txt containing m14-ok, then reply mentioning the filename in backticks` (want `m14v.txt` + bold-capable answer). Wait ~60s for the re-projection window (wire: second same-ut AGENT_MESSAGE with stripped text ~+16-45s).
   PASS: feed shows exactly ONE assistant card for the turn — no extra label-less orphan bubble (zoom verify); card retains `m14v.txt` code formatting; wire may still carry the variant broadcast (server-side unchanged) — the DROP is client-side.
   FAIL: second bubble/stripped text element appears, OR main card loses formatting.

2. **Reverse regression — short real answer must survive** — the guard must not kill normal short answers. Send `M14S: reply with exactly: ok` — "ok" (2 chars < 6) must render.
   PASS: single bubble "ok" rendered.
   Then same-question re-ask stress: send `M14Q: reply with exactly: same answer` twice back-to-back (second sent after first answered). Both answers must render — the second turn's answer must not be dropped even though text matches turn1's answer via identical _ut textKey (anchor must be NEWEST user bubble).
   PASS: two user bubbles each followed by an answer bubble.

3. **Longer-then-shorter answer regression** — send `M14L: reply with a 40 word sentence about stars` then `M14L2: reply with exactly: short ok`. Different _ut → subsequence gate can't fire on L2. Assert L2 renders.
   PASS: "short ok" bubble appears.

4. **Queue sanity (R13 tail-behavior)** — send `M14C1: reply with exactly: c1 ok` then immediately type+send `M14C2: reply with exactly: c2 ok` while running.
   PASS: C2 shows 已排队 bubble immediately, flushes and answers; no silent loss.

5. **Session switch sanity** — ☰ → 氢的元素符号 → back to M14 session. Title correct both ways, one replay each.

## Watch-fors
- Monitor: count same-ut AGENT_MESSAGE pairs; confirm variant broadcast still arrives (server side) but no bubble.
- Any "该轮无回复" phantom or missing answer = FAIL on the drop gate.
- Feed element count per turn.
