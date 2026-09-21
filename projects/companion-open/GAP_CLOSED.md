# GAP_CLOSED — companion-open 0.3.0

Reverse gaps closed vs copilot-remote `RE_WSSERVER.js` / `RE_PUSH.js` / PWA push:

## Closed

1. **PushManager (`src/push.ts`)**
   - VAPID key generate/persist (globalState + disk fallback)
   - `addSubscription` / `notify` via `web-push`
   - Wired from `extension.ts` on bridge start: `new PushManager(context.globalState)` → `bridge.setPushManager(push)`

2. **Bridge phone path (`src/bridge.ts`)**
   - `setPushManager`
   - `PHONE_CONNECT` → `CONNECTED_ACK` (+ optional `vapidPublicKey`)
   - `HISTORY_REPLAY`, active stream resume, **offlineQueue flush**
   - `PHONE_PUSH_SUBSCRIBE` → push subscription store
   - `sendToPhone` (offline queue when no clients; skip TYPING/DONE; push on `AGENT_CONFIRM`)
   - Stream helpers: `sendStreamStart` / `Set` / `Chunk` / `End`
   - Heartbeat ping/terminate parity

3. **Extension session fan-out**
   - `onEvent` prefers `bridge.sendToPhone(ev)` over raw `broadcast`

4. **JSONL projector stream deltas**
   - prefix growth → `AGENT_STREAM_CHUNK` (covered in e2e)

5. **Packaging**
   - `.vscodeignore` un-ignores `web-push` and runtime deps (`asn1.js`, `http_ece`, `https-proxy-agent`, `jws` tree, etc.)
   - version **0.3.0** vsix

6. **E2E**
   - CONNECTED_ACK + vapidPublicKey
   - offlineQueue flush on reconnect
   - stream helper exercise
   - projector CHUNK path

## Remaining gaps (not blocking 0.3.0)

- Full PWA UI for push permission / subscribe UX may still be thinner than commercial Remote.
- No end-to-end real Web Push delivery test (needs browser Notification permission + push service).
- Heartbeat/terminate behavior not stress-tested in e2e.
- No license/activation (intentional).
- Tunnel smoke is separate (`npm run test:tunnel`); not part of default e2e.
