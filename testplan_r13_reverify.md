# R13 — directed re-verification on f6d19c8 (vsix reinstalled, VS Code window reloaded, PWA hard-reloaded)

Bridge pid 4676, monitor → ~/mon_r13.log. Layout: PWA left / VS Code chat right / monitor bottom.

## Verified fixes

1. **P3a title staleness** — A→B→A: header showed 氢的元素符号 on B, 'M12A response request' back on A. Wire: 1 replay per select. PASS.
   - Note: on cold connect-reload the header shows fallback 'Copilot Lazy Ass' until first select (connect replay may not carry title). Minor.
2. **P1 boundary swallow** — 3 attempts, none lost:
   - Enter +1.7s after skeleton END → immediate broadcast+answer (B2)
   - Enter during post-DONE/pre-teardown window → queued w/ 已排队 bubble, flushed ~13s later right after skeleton END (B3)
   - Enter +0.55s after skeleton END → immediate broadcast+answer (B5)
   PASS — visible ack + delivery every time.
3. **P3b variant fidelity** — PARTIAL/NEW BUG: original card kept `m13v.txt` code + **done** bold ✓ BUT stripped variant 'Created - **done**' (filename content dropped, +35s) rendered an extra label-less bubble ABOVE the card = duplicate answer content. Root cause candidates: completeAssistantTurn normalized-equality only protects pure-format variants (this one dropped real content so equality failed → stripped text written into stream card); addAgentFinal dedupe is exact raw-equality only; agentTextRendered gate checks the variant's own text (never rendered) so late-reproj drop doesn't fire.
4. **_sess echo gate** — not directly verifiable with one client (needs cross-session same-text echo). UNTESTED.

## Regressions
- Multi-turn ×11 (V,V2,E,B1-B5,S,S2,S3): all broadcast + answered. sessiondb confirms all persisted.
- Queue path: visible half-opacity bubble + 已排队 hint, delivered after teardown.
- Stop double-click: DONE[phone_stop] on wire, partial essay kept, resend answered in 15s. No rr-hang.
- 0 CLOSED, 3 replays (1 per select), 11 USER = 11 sends.

## Observations
- requestRunning tail: sends between DONE[result] and the ~35-55s-later requests/N skeleton END get queued (B3 proved flush works). Composer shows 停止 during that window — UX delay ≤~45s for queued sends depending on skeleton/watchdog timing.
- 'b3 okb3 ok'/'b5 okb5 ok' doubled answer text = upstream (wire itself carried doubled text).
- Doubled DONE[result] pair at 01:25:09 still occurs (known minor).
- Late stop (post-DONE) arm+confirm: no phantom phone_stop fired; second DONE released running.
