# Real inject API — open specific local chat session + submit query (VS Code 1.131)

**Date:** 2026-08-07  
**Host:** VS Code **1.131.0** (`e4c7e7b1d6d0…`)  
**Workbench:** `/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`  
**Sources (same commit):** `microsoft/vscode@e4c7e7b1d6d060162f4aa7f8225271b67ce1df75`  
**Consumer:** `projects/companion-open` phone → desktop inject  
**Constraint:** extension host only — **public commands / `vscode.*` APIs**. No product code patch, no private services.

---

## 0. Executive answer

| Goal | Extension-accessible way on 1.131 |
|------|-----------------------------------|
| Build local session URI | `vscode-chat-session://local/<base64url(sessionId)>` (= `LocalChatSessionUri.forSession`) |
| Load **that** session into a focused chat widget | **`vscode.open(uri)` / `vscode.commands.executeCommand('vscode.open', uri)`** via chat **editor resolver** → `ChatEditorInput` **or** force editor with `workbench.action.chat.openSessionInEditorGroup` **only if** you can pass a live agent-session object (fragile) |
| Prefer existing surface (sidebar if already showing session) | **No reliable pure-command “load into sidebar only”** for arbitrary id. Native click path uses **internal** `IChatWidgetService.openSession(uri, ChatViewPaneTarget, { revealIfOpened: true })` — **not** exported to extensions. Closest public approximation: open URI with **reveal**, then submit. |
| Submit query into **whatever widget is now focused** | `workbench.action.chat.open({ query, isPartialQuery: false, mode? })` — uses **`lastFocusedWidget` / `revealWidget()`**, **ignores `sessionResource`** |
| Combined “open session X + send Q” single command | **None** for existing local sessions |

**Working inject strategy (ranked):**

1. **Primary (correct session > dual panel):** open session URI in editor (`vscode.open` / `openSessionInEditorGroup` family), wait until that widget is focused, then `chat.open({ query })`.  
2. **Anti dual-panel best-effort:** if you can detect the session is already the sidebar widget’s active session, **skip open** and only `chat.open({ query })`. Detection from extension host is **limited** (see §6).  
3. **Do not** rely on `chat.open({ query, sessionResource })` — false success on 1.131.  
4. **Do not** use `workbench.action.chat.openInSidebar` / `openInEditor` as session loaders — they are **Move Chat** actions.

---

## 1. URI contract (correct — keep)

Workbench `LocalChatSessionUri` (`chatUri.ts`):

```ts
// scheme = Schemas.vscodeLocalChatSession = "vscode-chat-session"
// authority = localChatSessionType = "local"
// path = "/" + base64url(utf8(sessionId))   // encodeBase64(..., padded=false, urlSafe=true)
LocalChatSessionUri.forSession(sessionId)
```

companion already matches:

```ts
vscode.Uri.from({
  scheme: "vscode-chat-session",
  authority: "local",
  path: "/" + Buffer.from(sessionId, "utf8").toString("base64url"),
});
```

`sessionId` for local Copilot/chatSessions jsonl is typically the **file basename without `.jsonl`** (UUID / id string stored in chat service), **not** the absolute filesystem path.

---

## 2. Command matrix (1.131 facts)

### 2.1 `workbench.action.chat.open` — submit only, not session switch

Minified `WGt` / source `OpenChatGlobalAction` + `IChatViewOpenOptions`:

**Reads:** `query`, `isPartialQuery`, `mode`, `modelSelector`, `toolsInclude`/`toolsExclude`, `toolIds`, `previousRequests`, `attach*`, `preserveInput`, `blockOnResponse`.

**Does not read:** `sessionResource`, `location`, `target`, `position`.

**Widget selection:**

```text
widget = lastFocusedWidget
if (!mode-locked path or widget missing/not visible) widget = await revealWidget()
// revealWidget → last focused if revealable, else open ChatViewId panel widget
setInput(query); acceptInput(); focusInput()
```

**Implication:** any `chat.open({ query, sessionResource })` **succeeds** (extra fields ignored) and still hits **focused** session → companion 0.5.10 false-positive `injectPath=chat.open+sessionResource`.

`IChatViewOpenOptions` in 1.131 **has no `sessionResource` field**.

### 2.2 Move commands (not loaders)

| Command | Title (1.131) | Behavior |
|---------|---------------|----------|
| `workbench.action.chat.openInEditor` | Move Chat into Editor Area | Moves **current** panel chat → editor (`g$o`); optional marshalled `{ sessionResource, $mid:19 }` only as **context of current widget**, not “open id X” |
| `workbench.action.chat.openInSidebar` | Move Chat into Side Bar | `Mqn`: if active editor is chat, close it and `ChatViewPane.loadSession(that.sessionResource)`; else just open chat view |
| `workbench.action.chat.openInNewWindow` | Move / open in window | Same family as move, not arbitrary id load |

companion’s `activateSessionForInject` calling `openInSidebar({ sessionResource })` is a **no-op loader** (args unused) → another false `activated=true`.

### 2.3 How UI click opens a session (internal — gold path)

`agentSessionsControl.openAgentSession` → `agentSessionsOpener.openSession` → for **local**:

```ts
await chatWidgetService.openSession(session.resource, ChatViewPaneTarget, {
  revealIfOpened: true,
  // title preferred only for non-local
});
```

`ChatWidgetService.openSession` (1.131):

1. If `target === undefined` **or** `options.revealIfOpened`:  
   `revealSessionIfAlreadyOpen(uri)`  
   - if **sidebar** widget already has that `sessionResource` → focus view, return widget (**no dual panel**)  
   - else if **editor** already has that session → focus that editor tab  
   - else quick-chat match  
2. If still not open and target is **view / undefined**:  
   `viewsService.openView(ChatViewId)` + **`ChatViewPane.loadSession(uri)`** + `focusInput`  
3. Else: `editorService.openEditor({ resource: uri, revealIfOpened })` → `ChatEditorInput`

**This service is not on the extension API.** Extensions cannot call `loadSession` / `openSession` directly.

### 2.4 Public path that **does** bind a session id: editor resolver + `vscode.open`

Workbench contribution `workbench.contrib.chatResolver`:

```text
editorResolverService.registerEditor(
  `${scheme}:**/**`,  // includes vscode-chat-session
  { id: ChatEditorInput.EditorID, priority: "builtin" },
  { singlePerResource: true, canSupportResource: t => t.scheme === scheme },
  { createEditorInput: ({ resource, options }) =>
      ({ editor: createInstance(ChatEditorInput, resource, options), options }) }
)
```

`ChatEditorInput` constructor: if `resource.scheme === vscodeLocalChatSession` and `LocalChatSessionUri.parseLocalSessionId` ok → `_sessionResource = resource`, then resolve/load that model.

Therefore from extension host:

```ts
await vscode.commands.executeCommand("vscode.open", localChatSessionUri(sid));
// or
await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
// showTextDocument may be awkward for non-text editors; prefer vscode.open
```

**Effects:**

- Opens / reveals **chat editor tab** for that session (`singlePerResource: true` → same URI reuses tab).  
- If session was only in **sidebar**, this typically **adds an editor surface** (dual panel risk) — same root cause as 0.5.6.  
- After open, that editor chat widget becomes focused (if `preserveFocus` not set) → subsequent `chat.open({ query })` lands on **correct** session.

### 2.5 `workbench.action.chat.openSessionIn*` family

| Command | Target | Needs |
|---------|--------|-------|
| `openSessionInEditorGroup` | active editor group | selected / arg sessions |
| `openSessionInNewEditorGroup` | side group | same |
| `openSessionInNewWindow` | aux window | same |
| `openSessionInAgentsWindow` | Agents window | optional URI / `{ sessionResource }` **or** last focused |

Base `AgentSessionAction` (`SK`):

```text
args e:
  if marshalled context ($mid===25 with .session): resolve e.sessions??[e.session] via agentSessionsService.getSession(resource)
  else if e truthy: n = [e]   // treats e as IAgentSession-like (needs .resource)
  else: focused sessions in agent sessions viewer
→ openSession(session.resource, targetGroup, { pinned: true, ... })
```

**Extension practicality:**

- Passing only a bare `Uri` is **not** enough for `openSessionInEditorGroup` (expects session object with `.resource` or viewer focus).  
- Passing `{ resource: uri }` **might** work if code path uses `e.resource` without full `IAgentSession` methods — **unverified / fragile** (markRead etc. not required on open path of `Vgt`, only `.resource`). Worth runtime probe:

```ts
await vscode.commands.executeCommand(
  "workbench.action.chat.openSessionInEditorGroup",
  { resource: localChatSessionUri(sid) },
);
```

- `openSessionInAgentsWindow` **does** accept `Uri` or `{ sessionResource: Uri }` explicitly — but opens **Agents window**, not normal sidebar chat (usually wrong for companion inject).

### 2.6 Other commands

| Command | Use for inject? |
|---------|-----------------|
| `workbench.action.chat.history` / `pickAgentSession` | Interactive picker only |
| `workbench.action.chat.submit` | Sends **current input** of focused widget; does not set text from args |
| `workbench.action.chat.focusInput` | `lastFocusedWidget.focusInput()` only |
| `workbench.action.chat.newChat` / `openChat` (“New Chat Editor”) | **New** session — wrong |
| `workbench.action.chat.openNewSessionSidebar.*` / `openNewChatSession*` | **New** session |
| `workbench.action.chat.openAgentMode` / `openEditSession` / `openAskMode` | **Absent** on 1.131 (0 hits). Use `chat.open({ mode: "agent"\|"ask"\|…, query })` instead |
| Mode switch inside `chat.open` | `handleSwitchToMode` may set `needToClearSession` → runs **`workbench.action.chat.newChat`** — can **wipe** session after you carefully opened one. Prefer: open session first, then `chat.open({ query })` **without** mode, or switch mode carefully only when empty/safe |

### 2.7 Extension `vscode.chat` API

Shipped `vscode.d.ts` chat surface = **participant / language model** APIs only. **No** `openSession`, **no** session list, **no** send-to-session-id. Proposed chat session APIs are not a stable companion dependency here.

---

## 3. Recommended inject algorithm (extension host)

### 3.1 Inputs

- `text: string` — user message  
- `sessionId: string` — from phone selection (`basename(jsonl)` without extension)  
- optional `mode: "agent" | "ask" | "edit"` — best-effort  

### 3.2 Pseudocode (correctness-first)

```ts
async function injectIntoLocalSession(sessionId: string, text: string, mode?: string) {
  const uri = localChatSessionUri(sessionId); // vscode-chat-session://local/<b64url>

  // ----- Phase A: make THAT session's widget the focused chat widget -----
  // A0. (optional) If you have a strong signal that sidebar/editor already shows
  //     this session AND it is focused, skip open to avoid dual panel.
  //     On stock APIs this signal is weak — see §6.

  // A1. Primary public binder: editor resolver
  try {
    await vscode.commands.executeCommand("vscode.open", uri);
    // alternate:
    // await vscode.commands.executeCommand("vscode.open", uri, {
    //   // EditorOpenOptions depend on command bridge; keep minimal
    // });
  } catch (e) {
    // A2. Probe session-object open (may no-op or throw)
    try {
      await vscode.commands.executeCommand(
        "workbench.action.chat.openSessionInEditorGroup",
        { resource: uri },
      );
    } catch {
      /* continue */
    }
  }

  // Let editor/input resolve + focus settle (loadSession is async in workbench)
  await delay(150); // tune 100–300ms; prefer event if you add verification §5

  // ----- Phase B: submit into focused widget -----
  // Do NOT pass sessionResource (ignored; false success).
  // Avoid mode switch if it might clear session; set mode only when necessary.
  const openArgs: Record<string, unknown> = {
    query: text,
    isPartialQuery: false,
  };
  // Optional: openArgs.mode = mode;  // WARNING: may trigger newChat — test first

  await vscode.commands.executeCommand("workbench.action.chat.open", openArgs);

  // Optional verification: watch chatSessions/<sessionId>.jsonl for user line
  // matching text within N ms; if missing, retry open+submit once or clipboard.
}
```

### 3.3 Dual-panel policy (product requirement)

> Prefer not opening duplicate editor panels if session already open in sidebar;  
> but **CORRECT session > no dual panel**.

| Situation | Action |
|-----------|--------|
| Unknown whether session visible | **`vscode.open(uri)` + `chat.open({query})`** — may create editor tab; message is correct |
| Known already focused on that session | **Only** `chat.open({query})` |
| Must avoid editor at all costs | **No complete public solution** on 1.131 for arbitrary id → wrong-session risk returns (paid Remote behavior) |

There is **no** extension command equivalent to:

```ts
chatWidgetService.openSession(uri, ChatViewPaneTarget, { revealIfOpened: true })
```

which is the only first-party “sidebar-preferring + reveal existing” API.

### 3.4 What to delete from companion 0.5.10 path

1. Stop treating `chat.open({ sessionResource })` as targeted success.  
2. Stop `activateSessionForInject` via `openInSidebar` / `chat.open` location hacks — they do not load ids.  
3. Restore **URI open** as the real binder (accepted dual-panel tradeoff), **or** accept focused-only.  
4. Replace missing `openAgentMode` commands with optional `mode` on `chat.open`, gated by tests for `needToClearSession`.  
5. Log `injectPath` only after **jsonl verification** (or at least distinguish `openedUri` vs `submittedQuery`).

---

## 4. Concrete companion-oriented sequence (phone message)

```text
PHONE_MESSAGE { text, mode, file }
  → sid = basename(file).replace(/\.jsonl$/i,'')
  → setActiveSessionFile(file)  // for echo suppression / UI
  → noteInjectedText(text)

1) uri = localChatSessionUri(sid)

2) OPEN (bind session → widget)
   try vscode.open(uri)                         // ChatEditorInput, singlePerResource
   catch try openSessionInEditorGroup({resource:uri})
   catch /* no bind */

3) wait briefly for resolve/focus

4) SUBMIT
   workbench.action.chat.open({ query: text, isPartialQuery: false })
   // focused widget should now be the editor (or previously focused if open failed)

5) VERIFY (strongly recommended)
   tail chatSessions/sid.jsonl for user message == text within timeout
   if fail → one retry of steps 2–4, then clipboard + user prompt
```

**Ordering note:** Open **before** submit. Never submit first hoping sessionResource will retarget.

**Focus note:** If user focuses another chat between open and submit, race remains — keep delay short; optional re-`vscode.open(uri)` immediately before submit (idempotent with `singlePerResource` / reveal).

---

## 5. Verification hooks available to the extension

Extensions cannot read `IChatWidget.viewModel.sessionResource` directly. Practical checks:

1. **Filesystem:** append watcher on `.../chatSessions/<sessionId>.jsonl` (companion already mirrors).  
2. **Tab titles:** `vscode.window.tabGroups` — look for chat editor tabs; URI scheme may appear on `TabInputUnknown` / custom inputs depending on API version — probe on 1.131 (chat editor might not expose full URI on `TabInputText`).  
3. **Do not trust** command resolve alone.

---

## 6. “Already open in sidebar” detection (best-effort only)

Public APIs **cannot** call `getWidgetBySessionResource` or read view pane model.

Possible weak signals:

| Signal | Quality |
|--------|---------|
| Recent phone `PHONE_SESSION_SELECT` + user hasn’t switched desktop chat | Heuristic only |
| jsonl mtime / last line activity | Does not prove UI focus |
| `vscode.window.state.focused` + guess | Insufficient |
| Ask user / always editor-open | Deterministic |

**Recommendation for companion:** implement **correctness-first** (`vscode.open` + query). Add optional setting:

- `inject.sessionOpen: "editor" | "focused-only"`  
  - `editor` = §3 algorithm  
  - `focused-only` = paid Remote parity (no dual panel, wrong session if mismatch)

A future VS Code that adds `sessionResource` to `IChatViewOpenOptions` or exports `openSession` would supersede this; **1.131 does not**.

---

## 7. Runtime probe checklist (before shipping)

Run from Extension Development Host / companion command palette:

1. With session **A** in sidebar focused, session **B** selected on phone:  
   - current 0.5.10 → message in **A** (bug)  
   - `vscode.open(uriB)` then `chat.open({query:"probe-B"})` → message in **B** jsonl (expect pass; may show editor)  
2. Session **B** already open as editor tab, sidebar shows **A**:  
   - `vscode.open(uriB)` should reveal B tab (`singlePerResource` / reveal), then query → B  
3. `chat.open({ query, sessionResource: uriB })` alone → still A (confirm ignore)  
4. `openInSidebar({ sessionResource: uriB })` → does not switch to B  
5. `chat.open({ mode: "agent", query })` on non-empty session → check whether history cleared (`needToClearSession`)  
6. `openSessionInEditorGroup({ resource: uriB })` → document yes/no on this build  

---

## 8. Evidence index

| Claim | Where |
|-------|--------|
| `chat.open` ignores `sessionResource`; uses `lastFocusedWidget` | workbench `WGt.run`; `chatActions.ts` `IChatViewOpenOptions` (no session field) |
| URI encoding | `chatUri.ts` `LocalChatSessionUri.forSession` |
| Sidebar click opens via internal `openSession(..., ChatViewPaneTarget, { revealIfOpened: true })` | `agentSessionsOpener.ts` `openSessionDefault` |
| `loadSession` on view pane | `chatViewPane.ts` `async loadSession(sessionResource)` |
| Editor resolver for `vscode-chat-session` | workbench `workbench.contrib.chatResolver` `registerEditor(\`${e}:**/**\`)` |
| `ChatEditorInput` binds local URI | `chatEditorInput.ts` constructor |
| `openInEditor` / `openInSidebar` are Move | workbench titles + `g$o` / `Mqn` |
| `openSessionInEditorGroup` uses session `.resource` | workbench `Vgt` / `SK` |
| No extension `openSession` API | shipped `vscode.d.ts` chat section |
| Mode commands missing; mode may clear session | string counts; `handleSwitchToMode` → `workbench.action.chat.newChat` |

---

## 9. One-page algorithm for implementers

```text
CORRECT SESSION (VS Code 1.131, extension-only)
═══════════════════════════════════════════════
sid  ← phone session file id
uri  ← vscode-chat-session://local/<base64url(sid)>

// BIND (public)
vscode.open(uri)     → ChatEditorInput for uri (may split UI)
// optional re-open immediately before send to win focus races

// SEND (public)
workbench.action.chat.open({ query, isPartialQuery: false })
// hits lastFocusedWidget — must already be the bound session

// VERIFY
jsonl(sid) contains user query

FORBIDDEN AS TARGETING
workbench.action.chat.open({ sessionResource: uri, query })  // ignored
workbench.action.chat.openInSidebar({ sessionResource })     // move only
workbench.action.chat.openInEditor({ sessionResource })      // move only

UNAVAILABLE TO EXTENSIONS
IChatWidgetService.openSession(uri, ChatViewPaneTarget, { revealIfOpened: true })
ChatViewPane.loadSession(uri)
```

---

## 10. Relation to prior findings

- `inject_audit_0.5.10.md` — **FAIL** diagnosis stands; this doc is the **replacement API plan**.  
- `issue1_4_fix_0.5.8.md` — dual panel from `vscode.open` is real; on 1.131 it is also the **only durable public binder** for arbitrary session id. Tradeoff is explicit: **correct session > no dual panel**.  
- Paid `copilot-remote` never solved targeting; companion must either accept editor open or stay focused-only.
