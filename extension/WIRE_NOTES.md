# Extension / Bridge wire notes (for extension agent)

This package now includes:

- `src/push.ts` — `PushManager` (VAPID + max 3 subs, dual storage)
- `src/jsonl.ts` — stream projector emits `AGENT_STREAM_START|CHUNK|SET|END` (+ `AGENT_MESSAGE` on end)
- `src/sessionWatcher.ts` — `fs.watch` on current file + parent `chatSessions` dir (poll still backup)
- `media/pwa/app.js` / `sw.js` — CONNECTED_ACK → push subscribe; stream chunk/set UI; SW push/click

## Extension (`extension.ts`) should

1. Create push manager with VS Code globalState:

```ts
import { PushManager } from './push';

const push = new PushManager(context.globalState);
// host-free / tests:
// const push = new PushManager({ storageDir: path.join(os.homedir(), '.copilot-sidecar-companion') });
```

2. Attach to bridge (bridge agent must implement these hooks):

```ts
bridge.setPushManager(push);
```

3. Prefer phone-targeted send when available:

```ts
onEvent: (ev) => {
  if (typeof bridge.sendToPhone === 'function') bridge.sendToPhone(ev);
  else bridge.broadcast(ev);
}
```

4. On `COPILOT_DONE` / stream end with no connected clients, optional:

```ts
if (bridge.clientCount === 0 && push.hasSubscribers) {
  void push.notify('Copilot finished', summaryText);
}
```

## Bridge (`bridge.ts`) should (other agent — do not rewrite here)

On `PHONE_CONNECT` success, send:

```json
{ "type": "CONNECTED_ACK", "timestamp": <ms>, "vapidPublicKey": "<public or null>" }
```

before or with `HISTORY_REPLAY`.

On `PHONE_PUSH_SUBSCRIBE`:

```ts
if (msg.type === 'PHONE_PUSH_SUBSCRIBE' && msg.subscription) {
  push?.addSubscription(msg.subscription);
  return;
}
```

Optional helpers:

- `setPushManager(push: PushManager | null)`
- `sendToPhone(ev)` — same as broadcast for now, or per-client later
- history may store `AGENT_STREAM_SET` / `AGENT_MESSAGE`; chunks are live-only

## PWA protocol additions

Phone → bridge:

- `PHONE_PUSH_SUBSCRIBE` `{ subscription: PushSubscriptionJSON }`

Bridge → phone:

- `CONNECTED_ACK` `{ vapidPublicKey?: string | null }`
- `AGENT_STREAM_START` `{ streamId }`
- `AGENT_STREAM_CHUNK` `{ streamId, text }`  // delta only
- `AGENT_STREAM_SET` `{ streamId, text }`    // full replace
- `AGENT_STREAM_END` `{ streamId }`
- `AGENT_MESSAGE` `{ streamId?, text }`      // final snapshot

## 0.4.0 request/response protocol (bridge.onRequest)

Phone → bridge (request-response; reply goes to requesting socket only):

- `PHONE_SESSION_LIST` → `SESSION_LIST` `{ sessions: [{ file, name, mtime, size, requestCount }] }`
- `PHONE_SESSION_SELECT` `{ file }` → `SESSION_SELECTED` `{ file, ok }`
- `PHONE_TERMINAL_LIST` → `TERMINAL_LIST` `{ terminals: [{ id, name }] }`
- `PHONE_TERMINAL_EXEC` `{ command, terminalId? }` → `TERMINAL_OUTPUT` `{ terminalId, name, content, exitCode?, ok, error? }`
- `PHONE_INSTANCE_STATUS` → `INSTANCE_STATUS` `{ instanceId, workspaceName, host, port, isPrimary, pid }`

## 0.5.0 additions

Session list entries (`SESSION_LIST.sessions[]`) gained workspace attribution:

- `workspaceId` — opaque id (`wks_<hash12>`), **never use as a path**
- `qualifiedName` — two-level name: `GC_trr:fuse_seg` (remote) or `sidecar_remote` (local)
- `machineName` — decoded SSH host (hex-JSON `{"hostName":"GC_trr"}` or plain alias); `null` when local
- `isRemote`, `displayName`, `isCurrent`

Model selection:

- `PHONE_MODEL_LIST` → `MODEL_LIST` `{ models: [{ id, name, vendor, family, version, maxInputTokens, isCurrent }] }`
- `PHONE_MODEL_SELECT` `{ id, vendor, family }` → `MODEL_SELECTED` `{ ok, id, error? }`
- Extension side uses `vscode.lm.selectChatModels()` + `workbench.action.chat.changeModel`
  (all three of `id`/`vendor`/`family` must be strings or the internal assert fails).
  `MODEL_LIST` is also broadcast on `onDidChangeChatModels`.

Permission level (approval mode) — independent of `mode` (agent/ask/edit):

- `PHONE_PERMISSION_LIST` → `PERMISSION_LIST` `{ levels: [{ id, label, description, available, unavailableReason? }], current }`
- `PHONE_PERMISSION_SET` `{ level, persist? }` → `PERMISSION_SET` `{ ok, level, error?, notice? }`
- Levels: `default` | `assisted` | `autoApprove` | `autopilot` (workbench internal enum)
- Switching uses slash commands (`/exitAutopilot` `/yolo` `/autopilot`, all `executeImmediately`+`silent`);
  `assisted` has no slash command → falls back to `workbench.action.chat.openPermissionPicker`
- `persist: true` also writes the `chat.permissions.default` setting

Notes:

- `AGENT_CONFIRM` is now in `HISTORY_SKIP` — pending confirm is re-sent once via `pendingConfirm` on connect (no history duplication).
- `THINKING_STEP` / `PROGRESS_STEP` remain live-only (in `HISTORY_SKIP`), matching Remote display parity.

## Storage keys / files

- globalState: `copilotSidecar.vapidKeys`, `copilotSidecar.pushSubscriptions`
- disk mirror: `~/.copilot-sidecar-companion/vapid.json`, `push-subscriptions.json`
