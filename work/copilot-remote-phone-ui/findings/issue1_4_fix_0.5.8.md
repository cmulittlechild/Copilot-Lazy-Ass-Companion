# 0.5.8 root-cause fixes

## 1 Dual panel reopen
- Cause: `activateSessionForInject` called `vscode.open(vscode-chat-session://…)` and `openInEditor`, which resolve to ChatSessionEditorInput (editor group).
- Then `chat.open({query, sessionResource})` reinforced editor open.
- Fix: never vscode.open/openInEditor; try sidebar commands; primary inject `chat.open({query})` only (paid Remote style).

## 2 Typing dots / send=stop
- Cause: empty STREAM_START rows left `.typing-label`; COPILOT_DONE only partially cleared; send button not bound to requestRunning.
- Fix: requestRunning + PHONE_STOP; finishAllAssistantVisuals; STREAM_END clears residual labels; empty shells removed.

## 3 Multiple Copilot badges
- Cause: each turnSeq/stream start created full avatar+name row.
- Fix: agent-continued collapse; defer DOM on STREAM_START; remove empty complete turns.

## 4 Missing own user message on phone
- Cause: doSend called notePhoneUserText before addUser → seenKeys occupied → addUser returned null; plus echo suppress without prior history broadcast (already fixed acceptPhoneUserMessage).
- Fix: only addUser (notes inside); DOM-first dedupe; bridge acceptPhoneUserMessage push+broadcast before remember.

Installed: local-dev.copilot-sidecar-companion@0.5.8, SW v14.
