# R94 re-verification — HEAD 35c692b (live-render _ut attribution fix)

Client fix: appendFeedChronological keys by _ut text (locks to last same-named user bubble); stream/answer/orphan cards all carry _ut. Monitor → ~/mon_r94.log. ASCII sends, R94x prefixes.

## Priority (R93 live-render failure)
1. **Same-text re-ask, LIVE state** — send `R94D: reply with exactly: live ok`, wait answer, send identical again.
   PASS: feed shows exactly `R94D → live ok → R94D → live ok` — NO floating extra card, NO 「该轮无回复」 placeholder under the second bubble, WHILE LIVE (no refresh needed).
   Then Cmd+Shift+R → PASS iff layout still correct.
2. **Phantom placeholder row control** — rapid-fire `R94B` then queue `R94C` while in-flight.
   PASS: strict U→A→U→A AND no 「该轮无回复」 row between B's answer and C's bubble (R93 stray must be gone); wire: no doubled same-ms DONE[result]-driven empty card.

## Regular regression
3. Tool turn `R94T: create file r94test.txt containing r94-ok` → card running→done, file on disk.
4. Cross-session residue → send R94A, switch to empty New Chat, feed empty; back → intact.
5. Stray watch: no wrong-window TOOL_CALL, no dup-variant AGENT surface, replay single per select, 0 CLOSED.

Forensics: grep mon log USER/AGENT per ut, replays, CLOSED; sessiondb tail.
