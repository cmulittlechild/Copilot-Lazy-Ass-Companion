# Issue 2/3/4 — Phone PWA UI/Sync（companion-open）

- date: 2026-08-06
- target: `/Users/xin/Desktop/sidecar_remote/projects/companion-open`
- status: root-caused + fixed in source

## Summary

| # | Symptom | Root cause | Fix |
|---|---------|------------|-----|
| 2 | Copilot avatar keeps pulsing `...` after reply done; send not locked | Typing label only partially cleared; no request-running composer state; tool-only turns skipped `AGENT_STREAM_END` | Full visual finish on `COPILOT_DONE`; send↔stop state; always `STREAM_END` on turn_end |
| 3 | Every intermediate assistant fragment shows its own Copilot badge | Each `streamId`/`turnSeq` created a full header row | Collapse consecutive assistant rows in same user turn (`agent-continued`) |
| 4 | Phone-sent user question missing from feed (only Copilot replies) | Echo suppression dropped JSONL `USER_MESSAGE` **and** never put phone text into bridge history | `acceptPhoneUserMessage` → history+broadcast before echo remember; PWA short-window dedupe |

---

## PROBLEM 2 — Typing dots stuck + send/stop state

### Root cause (evidence)

1. **Independent typing row vs per-turn meta dots**
   - `showTyping()` creates `.typing-row` with avatar + `...`.
   - `startAssistantTurn()` also puts `.typing-label` with `...` on **every** assistant row.
   - `COPILOT_DONE` only did `clearTyping()` + removed `.streaming` class — **did not hide `.typing-label`** on completed rows.
   - `completeAssistantTurn()` hid label for **one** `streamId` only. Multi-turn agent loops leave earlier turns’ dots visible.

2. **Transcript turn_end skipped STREAM_END when no text**
   - `handleTurnEnd()` previously:
     ```ts
     if (this.streamAccum) { AGENT_MESSAGE; AGENT_STREAM_END }
     COPILOT_DONE
     ```
   - Tool-only / empty-content turns never emitted `AGENT_STREAM_END` → row stayed `streaming` with meta dots.

3. **No composer request state**
   - `setStatus()` always set `sendBtn.disabled = !ok` (connection only).
   - No stop affordance while Copilot running (VS Code swaps send→stop).

### Fix

**PWA (`media/pwa/app.js`)**
- `finishAllAssistantVisuals()`: clear typing-row + all `.typing-label` + all streaming classes/icons.
- `COPILOT_DONE` / `HISTORY_REPLAY finally` / stop path call it.
- `requestRunning` + `paintSendButton()`: idle「发送」/ running「停止」(`#send.is-stop`).
- `setRequestRunning(false)` debounced ~600ms so multi-turn `COPILOT_DONE` between tool loops doesn’t flicker.
- `PHONE_STOP` → extension `cancelChatRequest()` (`workbench.action.chat.cancel` …).

**Transcript (`src/transcriptWatcher.ts`)**
- `handleTurnEnd` / `endActiveStream`: if turn was opened, **always** emit `AGENT_STREAM_END`, then `COPILOT_DONE`.

### Edge cases
| Scenario | Behavior |
|----------|----------|
| Live stream | STREAM_* sets running; DONE finishes all visuals |
| Multi-turn tools | Intermediate DONE debounced; next START cancels off |
| History replay | finally forces running=false, no leftover dots |
| Phone stop | optimistic finish + server DONE |
| chatSessions fallback | still emits COPILOT_DONE via JsonlProjector debounce |

---

## PROBLEM 3 — One Copilot badge per reply group

### Root cause (evidence)

- Transcript assigns `streamId = 't' + turnSeq` per `assistant.turn_start`.
- chatSessions `emitTextStream` uses per-text-block stream ids (`requests/N/response#text#K`).
- PWA `startAssistantTurn` / `addAgentFinal` always rendered full avatar +「Copilot」name.
- One user request → many assistant fragments → many badges.

### Fix

- `shouldContinueAssistantGroup()`: walk feed upward; skip `typing-row` / `tool-card`; if previous visible is `agent` → continue group; if `user`/`sys`/`confirm` → new group.
- Continued rows: class `agent-continued` — hide avatar (visibility) + name; keep optional streaming dots until complete.
- CSS in `styles.css` for `.agent-continued` / `.typing-label.is-done`.

### Edge cases
| Scenario | Behavior |
|----------|----------|
| user → agent → tool → agent | one badge (tools belong to assistant turn) |
| user → agent → user → agent | two badges |
| History replay | same grouping rules |
| Multi-stream same request | collapsed if no user between |

---

## PROBLEM 4 — Phone user bubble missing

### Root cause (evidence)

Paid Remote PWA (`index-uGnOBk9B.js`):
```js
onSend: send PHONE_MESSAGE + p({type:"USER_MESSAGE", text})  // optimistic
```
Extension only sends `COPILOT_TYPING` on phone message; JSONL `handleUserRequest` does:
```js
r && !this.isInjectedEcho(r) && send USER_MESSAGE
```
Echo is **consume-once** so desktop-originated users still appear; phone optimistic already showed the bubble.

companion-open before fix:
1. PWA `doSend` did optimistic `addUser(phone:text:Date.now())` — unique key every time.
2. `bridge.rememberPhoneText` on `PHONE_MESSAGE`.
3. `extension` + `bridge.sendToPhone` **drop** JSONL `USER_MESSAGE` via `isInjectedEcho` / `isPhoneEcho` (30s, keep-not-consume on bridge).
4. **Never** wrote phone text into `bridge.history`.
5. After `HISTORY_REPLAY` / session switch / reconnect: feed rebuild from history → **user question gone**, only assistant remains.
6. Even live: if optimistic path failed or feed cleared, no server-side user event remained.

### Fix

**Bridge (`src/bridge.ts`)**
```ts
// on PHONE_MESSAGE:
acceptPhoneUserMessage(text) {
  pushHistory({ type:'USER_MESSAGE', text, fromPhone:true });
  broadcastRaw(...);      // before remember
  rememberPhoneText(text); // then suppress JSONL echo
}
```

**PWA**
- Optimistic `addUser` with stable `userTextDedupeKey(text)`.
- 15s short-window map `recentPhoneUserAt` so bridge echo / transcript echo don’t double-bubble, but same text can be sent again later.
- `requestId` keys still permanent.

**Extension**
- Still broadcasts `COPILOT_TYPING` after inject; does **not** need to emit USER_MESSAGE (bridge already did).

### Edge cases
| Scenario | Behavior |
|----------|----------|
| Phone send live | optimistic bubble + bridge history/broadcast; JSONL echo dropped |
| Desktop-typed user | no phone remember → USER_MESSAGE reaches phone |
| Reconnect / HISTORY_REPLAY | user lines present from history |
| Same text re-send after 15s | allowed (short window expired) |
| Double sources (transcript + chatSessions) | echo + textKey still single bubble |

---

## Files changed

1. `projects/companion-open/media/pwa/app.js` — requestRunning/send-stop, finishAllAssistantVisuals, badge collapse, user short-window dedupe, PHONE_STOP, HISTORY_REPLAY safety
2. `projects/companion-open/media/pwa/styles.css` — `.agent-continued`, `#send.is-stop`, `.typing-label.is-done`
3. `projects/companion-open/media/pwa/sw.js` — cache `v12` → `v13`
4. `projects/companion-open/src/bridge.ts` — `acceptPhoneUserMessage`
5. `projects/companion-open/src/extension.ts` — `PHONE_STOP` → `cancelChatRequest`
6. `projects/companion-open/src/inject.ts` — `cancelChatRequest()`
7. `projects/companion-open/src/transcriptWatcher.ts` — always `AGENT_STREAM_END` on turn end

## Constraints preserved

- `HISTORY_REPLAY` still uses `try/finally`, no ghost vars (`activeStreamId` etc.) — empty-feed fix intact
- `setSessionTitle` / `DEFAULT_BRAND = 'Copilot Lazy Ass'` untouched
- Typing clears on `AGENT_MESSAGE` / `AGENT_STREAM_END` / `COPILOT_DONE` / stop
- User appears immediately on send **and** survives transcript/history without bad permanent dedupe

## Verification

- `node --check media/pwa/app.js` OK
- `npx tsc` OK
- Bridge smoke: `acceptPhoneUserMessage` → history+broadcast; `sendToPhone` same text dropped
- Badge grouping unit: 6/6 cases
- Source invariants: `hadStream` → `AGENT_STREAM_END` → `COPILOT_DONE`

## Manual check (phone)

1. Send from phone → see **You** bubble immediately; after reply, question still there on reconnect.
2. While generating, button = **停止**; after DONE = **发送**, no `...` on any Copilot header.
3. Agent+tools multi-fragment reply → **one** Copilot name/avatar for the group.
