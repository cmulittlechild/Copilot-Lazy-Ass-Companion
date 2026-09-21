# Copilot Remote 0.4.1 — Static Reverse Report

> Target: `atulhritik.copilot-remote-0.4.1.vsix`  
> Analysis dir: `/Users/xin/Desktop/sidecar_remote/analysis/copilot-remote-0.4.1`  
> Method: static unpack + webpack bundle reconstruction (no install >100MB)  
> Date: 2026-08-04

## 0. Package inventory

| Path | Size | Role |
|------|------|------|
| `extension/dist/extension.js` | 319 KB | Main extension (webpack bundle) |
| `extension/dist/pwa/assets/index-*.js` | 308 KB | Phone PWA |
| `extension/dist/public.pem` | 451 B | License RSA public key |
| `extension/package.json` | 3 KB | Manifest |
| cloudflared binary in VSIX | **absent** | Downloaded on first run to `~/.copilot-remote/` |

No source maps. No TypeScript sources. Dependencies bundled: `ws`, `jsonwebtoken`, `qrcode`, `uuid`, `web-push`, `node-machine-id`.

## 1. Architecture

```text
activate()
  ├─ LicenseManager (globalState JWT + machine bind)
  ├─ QrPanel webview (sidebar)
  └─ if activated → runtime:
        ├─ WsServer(port=3000..3020)  HTTP static PWA + WebSocket
        ├─ PushManager (VAPID web-push)
        ├─ CopilotHook(BaseJsonlHook)  read chatSessions JSONL, inject chat cmds
        └─ TunnelManager  cloudflared quick tunnel → trycloudflare.com
```

### Modules recovered
- `LicenseManager`
- `QrPanel`
- `WsServer`
- `PushManager`
- `BaseJsonlHook`
- `CopilotHook` (extends BaseJsonlHook)
- `TunnelManager`

## 2. Activation / License

Storage keys (VS Code `globalState`):
- `copilot-remote.licenseKey`
- `copilot-remote.boundMachine`

Flow:
1. Load `dist/public.pem`
2. `jsonwebtoken.verify(token, publicKey, {algorithms:["RS256"]})`
3. Require claim `product === "copilot-remote"`
4. Bind to `machineIdSync()` from `node-machine-id`
5. If machine id changes → deactivated

Also settings key `copilot-remote.licenseKey` exists in package.json (UI/config), but runtime activation uses **globalState**.

## 3. Session mirror (read path)

### File discovery `findLatestSessionFile()`
Priority:
1. `extensionContext.storageUri` nearby:
   - `dirname(storageUri)/chatSessions`
   - `storageUri/chatSessions`
2. Fallback **Windows-oriented**:
   - `%APPDATA%/Code/User/workspaceStorage/*/chatSessions`
3. Pick newest `*.jsonl` by mtime

**Important macOS gap:** fallback uses only `process.env.APPDATA`. On macOS APPDATA is usually empty, so discovery depends heavily on `storageUri` being present/valid. If that fails, session watch may not start.

Rescan interval: **2000 ms**  
Directory watch on chatSessions dir when found.

### Tail engine `BaseJsonlHook`
- `fs.watch` + **8ms poll**
- byte-offset tail (`lastByteOffset`)
- parse complete lines only
- each line: `JSON.parse` → `processChatEntry`

### JSONL semantics (VS Code chat session log)
Entries look like JSON-patch style objects with:
- `kind` (observed: `2` for mutations)
- `k` path array, e.g.:
  - `["requests"]` full request list replace
  - `["requests", idx, "response"]` response parts
  - `["requests", idx, "elapsedMs"|"result"|"isCanceled"]` finalize signals
- `v` value
- `i` optional splice index

`processChatEntry` logic:
- if `k[0]=="requests"`:
  - finalize markers (`elapsedMs|result|isCanceled`) → `scheduleFinalize(idx)`
  - `kind==2`:
    - `k==["requests"]` & array `v` → each `handleUserRequest`
    - `k==["requests", n, "response"]` → `applyResponseMutation(path, n, v, i)`

`applyResponseMutation`:
- if `i` not number: replace parts array
- else: `parts.splice(i, 0, ...v)`  (**SPLICE incremental**)
- then `emitBlocks` + maybe schedule finalize

`handleUserRequest`:
- dedupe by `requestId`
- extract text from multiple fields (`message.text|value|prompt|content...`)
- skip if `isInjectedEcho` (30s window, last 20 injects)
- send `USER_MESSAGE` + `COPILOT_TYPING`

Response blocks `renderBlocks`:
- skip kinds in ignore set including: progress/mcp/undo/prepareToolInvocation etc.
- `toolInvocation` / `toolInvocationSerialized` → phone `tool` events
- `confirmation` → `AGENT_CONFIRM` with title/message/buttons
- plain `value` string → text stream chunks (prefix-merge)

Streaming to phone:
- `AGENT_STREAM_START|CHUNK|SET|END`
- finalize delay **450ms** then `COPILOT_DONE`

## 4. Control path (write / inject)

### Phone → extension messages
| type | action |
|------|--------|
| `PHONE_CONNECT` | mark connected; send `AGENT_LIST` |
| `PHONE_MESSAGE` | `injectMessage(text, mode)` |
| `PHONE_CONFIRM` | `handleConfirmation(button)` |
| `PHONE_PUSH_SUBSCRIBE` | store push subscription |

### `injectMessage(text, mode)`
1. `noteInjectedText(text)`
2. mode switch (best-effort):
   - `agent` → `workbench.action.chat.openAgentMode`
   - `edit` → `workbench.action.chat.openEditSession`
   - `ask` → `workbench.action.chat.openAskMode`
3. primary: `workbench.action.chat.open({ query: text })`
4. fallback: clipboard + open chat + manual paste prompt

### `handleConfirmation(button)`
- button contains `cancel` → `chat.action.rejectToolConfirmation`
- else → `chat.action.acceptToolConfirmation`

## 5. Transport

### WsServer
- default port config `copilot-remote.port` = 3000, auto-scan busy ports
- serves `dist/pwa` static files over HTTP
- WebSocket for phone
- keeps `history`, `offlineQueue`, active stream accumulator
- on connect: optional `HISTORY_REPLAY`, active `AGENT_STREAM_SET`, flush offline queue
- push subscription registration supported

### TunnelManager
- bin resolution order:
  1. bundled `dist/bin/cloudflared-<platform>-<arch>` if size ≥ 10MB
  2. cache `~/.copilot-remote/cloudflared` (or `.exe`)
  3. else download once from GitHub:
     `https://github.com/cloudflare/cloudflared/releases/download/2024.2.1/<asset>`
- launch: `cloudflared tunnel --url http://localhost:<port>`
- parse URL regex: `https://[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com`
- persist last url to `~/.copilot-remote/tunnel.url`
- restart on error after 3s
- kill old tunnels for same localhost port before start

**First-run network download of cloudflared is ~50MB+ platform binary** (not in VSIX). Analysis did not download it.

### PWA
- default remote URL setting: `https://copilot-remote-pwa.vercel.app`
- also embeddable from extension static server
- service worker + firebase messaging sw present
- understands same protocol types as extension

## 6. Protocol catalog

### Extension → Phone
- `SYSTEM_MESSAGE`
- `USER_MESSAGE`
- `AGENT_MESSAGE`
- `AGENT_LIST`
- `AGENT_STREAM_START|CHUNK|SET|END`
- `AGENT_CONFIRM` / `AGENT_CONFIRM_RESOLVED`
- `COPILOT_TYPING` / `COPILOT_DONE`
- `HISTORY_REPLAY`

### Phone → Extension
- `PHONE_CONNECT`
- `PHONE_MESSAGE` (`text`, `mode`)
- `PHONE_CONFIRM` (`button`)
- `PHONE_PUSH_SUBSCRIBE`

## 7. Timing constants

| Name | ms |
|------|----|
| session rescan | 2000 |
| jsonl poll | 8 |
| stream end delay | 450 |
| phone connected UI poll | 9000 |
| tunnel restart | 3000 |
| inject echo suppression | 30000 |

## 8. Local validation (this machine)

Found recent chatSessions (top):
[
  {
    "dir": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/efb88366389d86552d61f6ab43b0dbe2/chatSessions",
    "newest": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/efb88366389d86552d61f6ab43b0dbe2/chatSessions/963c9d91-5d42-42f8-8c70-34bd7bb73a56.jsonl",
    "size": 28740805,
    "mtime": 1785850955.6295786
  },
  {
    "dir": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/4cfb0b6fc59d641b94989f31b1b09c06/chatSessions",
    "newest": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/4cfb0b6fc59d641b94989f31b1b09c06/chatSessions/eab05fee-0bc4-450d-a5da-4ec5a62783dd.jsonl",
    "size": 6934331,
    "mtime": 1785850879.4601583
  },
  {
    "dir": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/9928cc7054ada17c386a5dd2d1a000db/chatSessions",
    "newest": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/9928cc7054ada17c386a5dd2d1a000db/chatSessions/f33c74b8-ede8-4c62-8b2d-ec306857e4b8.jsonl",
    "size": 7798424,
    "mtime": 1785847684.578898
  },
  {
    "dir": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/31c13c0c390f5d1377fc9ce9b9c55cbd/chatSessions",
    "newest": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/31c13c0c390f5d1377fc9ce9b9c55cbd/chatSessions/9c9a327a-4c08-4379-aabf-e790942a895f.jsonl",
    "size": 781447,
    "mtime": 1785837169.3562493
  },
  {
    "dir": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/aba0a7ccd19bf9445f5a2e0d0a557969/chatSessions",
    "newest": "/Users/xin/Library/Application Support/Code/User/workspaceStorage/aba0a7ccd19bf9445f5a2e0d0a557969/chatSessions/37bc993b-c534-4821-ac97-613990a91f10.jsonl",
    "size": 1371,
    "mtime": 1785766837.26721
  }
]

Sample entry keys from newest jsonl (first lines):
[
  {
    "kind": 0
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "inputText"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "selections"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "inputText"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "selections"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "selections"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "inputText"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "selections"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "inputText"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "selections"
    ]
  },
  {
    "kind": 2,
    "k": [
      "requests"
    ]
  },
  {
    "kind": 1,
    "k": [
      "inputState",
      "inputText"
    ]
  }
]

## 9. Security notes (code-audit style)

1. **Tunnel is public trycloudflare URL** — anyone with URL may reach local WS unless app-level auth exists (pairing token not obvious in static strings; QR likely embeds raw tunnel URL + maybe path). Needs dynamic confirm.
2. **Reads full Copilot chat transcripts** from disk.
3. **Injects into chat** via internal commands / clipboard fallback.
4. License offline RS256 — good; machine bind via machine-id.
5. cloudflared downloaded from GitHub release pin `2024.2.1` into `~/.copilot-remote`.
6. No telemetry strings obvious; push uses web-push/VAPID.

## 10. What to reuse for a non-replacing Sidecar companion

Must copy:
- companion extension model (do not replace GitHub.copilot-chat)
- JSONL tail + request/response patch interpretation
- inject via `workbench.action.chat.open({query})` + tool confirmation commands
- echo suppression
- local WS + mobile UI + tunnel

Improve:
- macOS/Linux session path discovery (`Application Support/Code/User/workspaceStorage`)
- explicit pairing token / auth on WS
- avoid clipboard fallback when possible
- optional cloudflared bundling or devtunnel choice
- less aggressive 8ms poll (watch + smarter debounce)

## 11. Artifacts produced
- `pseudo/class_*.js` recovered class bodies
- `pseudo/fn_*.js` key functions
- `notes/raw_extract.json`, `notes/facts2.json`
- this report

## Appendix: recovered method names
### CopilotHook methods
- `findLatestSessionFile` (547 chars)
- `processChatEntry` (510 chars)
- `handleUserRequest` (319 chars)
- `applyResponseMutation` (268 chars)
- `emitBlocks` (630 chars)
- `renderBlocks` (802 chars)
- `scheduleFinalize` (240 chars)
- `injectMessage` (621 chars)
- `handleConfirmation` (180 chars)
- `dispose` (167 chars)

### WsServer methods
- `start` (1368 chars)
- `onPhoneMessage` (48 chars)
- `sendStreamStart` (143 chars)
- `sendStreamSet` (147 chars)
- `sendStreamChunk` (248 chars)
- `sendStreamEnd` (413 chars)
- `sendToPhone` (404 chars)
- `broadcast` (110 chars)

### PWA case handlers sample
AGENT_CONFIRM, AGENT_CONFIRM_RESOLVED, AGENT_MESSAGE, AGENT_STREAM_CHUNK, AGENT_STREAM_END, AGENT_STREAM_SET, AGENT_STREAM_START, COPILOT_DONE, COPILOT_TYPING, HISTORY_REPLAY, SYSTEM_MESSAGE, TOOL_CALL, USER_MESSAGE
### PWA type literals
PHONE_CONFIRM, PHONE_CONNECT, PHONE_MESSAGE, PHONE_PUSH_SUBSCRIBE, USER_MESSAGE