# R95 re-verification — HEAD 202e08c (R94 failures fixed)

① stale-gate exemption: _ut matching latest user bubble bypasses evTs<lastUserTs-2s drop (cross-clock kill). ② repaintAwaitingUserBubbles strictly gated mBase===boundBase (missing sess also blocks).
Monitor → ~/mon_r95.log. ASCII sends, R95x prefixes.

## Priority (R94 failures)
1. **Same-text re-ask LIVE** — send `R95D: reply with exactly: live2 ok`, wait answer, send identical.
   PASS: live feed = `R95D → live2 ok → R95D → live2 ok` exactly — no floating card, no 「该轮无回复」 under 2nd bubble, no refresh needed.
   Then Cmd+Shift+R → layout still correct.
2. **In-flight switch residue** — send `R95A`, IMMEDIATELY (while desktop still "Thinking") ☰ → empty New Chat.
   PASS: empty session feed has ZERO bubbles (R94 leaked the pending user bubble).
   Switch back → PASS iff R95A turn intact (bubble + answer).

## Regular regression
3. Rapid-fire R95B/R95C → strict U→A→U→A, no phantom placeholder row.
4. Tool turn `R95T: create file r95test.txt containing r95-ok` → card running→done, file on disk.
5. Stop key: R95S mid-flight → DONE[phone_stop], button→发送 ≤5s, orphan placeholder.
6. Stray watch: no wrong-window TOOL_CALL/late file-link card, replays single per select, 0 CLOSED.

Forensics: grep mon log; sessiondb tail.
