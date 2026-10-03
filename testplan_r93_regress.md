# R93 re-verification — HEAD 876dd92 (R92 regression fix)

Per-turn-instance a2 dedupe: same-turn dual-channel dupes still suppressed, new-turn same-text answers pass. Monitor → ~/mon_r93.log. ASCII sends, R93x prefixes.

## Priority (R92 failure re-test)
1. **Same-text re-ask** — send `R93D: reply with exactly: repro ok` twice (wait for A1, send identical).
   PASS: two user bubbles + TWO "repro ok" answer bubbles on PWA; wire shows AGENT_MESSAGE or full stream for BOTH turns.
   Then **Cmd+Shift+R hard refresh** → PASS iff BOTH answers still render (bridge replay must not swallow 2nd).
2. **Dual-channel suppression control** — watch wire/feed during all turns: same-turn content arriving twice (stream + AGENT_MESSAGE) must render ONE bubble, no double text.
   PASS: no visible duplicate answer text per turn.

## Regular regression
3. Rapid-fire R93B/R93C → strict U→A→U→A, queue flush after result-DONE.
4. Cross-session residue → send `R93A`, switch to empty New Chat, feed must be empty; switch back → turn intact.
5. Tool turn `R93T: create file r93test.txt containing r93-ok` → card running→done, file on disk.
6. Stray watch: no wrong-window TOOL_CALL, no dup-variant AGENT_MESSAGE surface, replay single per select, 0 CLOSED.

Forensics: grep mon log dup AGENT_MESSAGE per ut / replay bursts / CLOSED; sessiondb tail for R93 turns.
