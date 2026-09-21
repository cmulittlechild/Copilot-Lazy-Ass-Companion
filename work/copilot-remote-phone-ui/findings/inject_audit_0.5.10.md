# Inject Session Targeting Audit — companion-open 0.5.10

**Date:** 2026-08-07  
**Scope:** phone → VS Code message injection landing in wrong chat session  
**Code under audit:** `/Users/xin/Desktop/sidecar_remote/projects/companion-open`  
**Installed extension:** `~/.vscode/extensions/local-dev.copilot-sidecar-companion-0.5.10`  
**Host VS Code:** 1.131.0 (`e4c7e7b1…`, arm64)  
**Compared to:** paid `atulhritik.copilot-remote-0.4.1`, analysis REPORT, references/copilot workbench sources

---

## Verdict

| Item | Result |
|------|--------|
| **PASS/FAIL** | **FAIL** — still vulnerable to wrong-session inject |
| **Confidence** | **High (~88%)** |
| **0.5.10 claimed fix present in source?** | Yes |
| **0.5.10 claimed fix present in installed dist?** | Yes (bit-identical intent) |
| **Fix effective on VS Code 1.131?** | **No** — primary targeting API ignores `sessionResource` |
| **User repro still plausible?** | **Yes** (phone DeepSeek selected, desktop focus on「项目学习与理解」→ `hi` lands on focused) |

**One-line root cause of residual bug:**  
0.5.10 *calls* `workbench.action.chat.open({ query, sessionResource })`, but VS Code 1.131’s Open Chat action binds the **last focused chat widget** and **never reads `opts.sessionResource`**. Command resolve does not throw on unknown fields, so companion logs a **false-success** path (`chat.open+sessionResource`) while still accepting input on the focused session.

---

## Evidence matrix

### 1) Paid copilot-remote (baseline limitation)

`analysis/copilot-remote-0.4.1/pseudo/PRETTY_injectMessage.js` / REPORT §4:

1. mode best-effort (`openAgentMode` / `openEditSession` / `openAskMode`)
2. **`workbench.action.chat.open({ query })` only** — no session id / URI
3. clipboard fallback

→ Known: always hits **desktop focused** chat. No multi-session targeting.

### 2) companion-open 0.5.10 claimed fix (source)

`src/inject.ts` priority:

1. `activeSessionFile` → `sid` → `localChatSessionUri(sid)`  
2. best-effort `activateSessionForInject(sid)`  
3. mode commands (agent/edit/ask)  
4. **Path A:** `chat.open({ query, isPartialQuery:false, sessionResource[, location|target] })`  
5. **Path B:** focused `chat.open({ query })` if Path A “fails”  
6. clipboard

`src/extension.ts`:

- `PHONE_MESSAGE`: if `msg.file` → `setActiveSessionFile` + best-effort `watcher.selectSession`
- logs `inject via=${injectPath} sid=… activated=…`
- `PHONE_SESSION_SELECT`: `setActiveSessionFile(file)` only when `selectSession` returns ok

`media/pwa/app.js`:

- `doSend` → `PHONE_MESSAGE { text, mode, file: currentSessionMeta.file || undefined }`
- session click → `setSessionTitle` + `PHONE_SESSION_SELECT`

### 3) Installed dist parity (0.5.10)

Checked under `~/.vscode/extensions/local-dev.copilot-sidecar-companion-0.5.10`:

| Marker | Present |
|--------|---------|
| `sessionResource` / `chat.open+sessionResource` | yes (`dist/inject.js`) |
| `focused-fallback-after-target-fail` | yes |
| `setActiveSessionFile(msg.file)` on `PHONE_MESSAGE` | yes (`dist/extension.js`) |
| PWA `file: currentSessionMeta.file` | yes (`media/pwa/app.js`) |
| SW `sidecar-pwa-v17` | yes |
| package version | `0.5.10` |

→ Packaging/install is **not** the gap. Runtime API semantics are.

### 4) VS Code 1.131 workbench — `chat.open` ignores `sessionResource`

From `workbench.desktop.main.js` (`Zk="workbench.action.chat.open"`, class `WGt`):

```text
async run(e, t) {
  t = typeof t == "string" ? { query: t } : t;
  … b = n.lastFocusedWidget;
  if ((!this.mode || !b || !fs(b.domNode)) && (b = await n.revealWidget()), !b) return;
  // uses: t.mode, modelSelector, tools*, previousRequests, attach*, query, isPartialQuery, preserveInput, blockOnResponse, toolIds
  // NO read of t.sessionResource / t.location / t.target for session switch
  if (t?.query) {
    if (t.isPartialQuery) { b.setInput(t.query); }
    else { … b.setInput(t.query); I = b.acceptInput(); }
  }
  b.focusInput();
}
```

Implications:

- Path A’s first attempt **almost always succeeds** (command exists; extra props ignored).
- `injectPath` becomes `chat.open+sessionResource` even when message went to **focused** session.
- Path B (`focused-fallback-after-target-fail`) is **rarely reached** when `sid` is set — diagnostics hide the bug.
- QR log “success” is **not** proof of correct session.

### 5) `activateSessionForInject` does not reliably retarget

Attempts:

| via | Actual VS Code 1.131 meaning | Targets phone session? |
|-----|------------------------------|-------------------------|
| `workbench.action.chat.openInSidebar` + `{sessionResource}` | **“Move Chat into Side Bar”** (`Mqn`) — moves *current* editor chat to sidebar; **does not take sessionResource to load another session** | No |
| `chat.open` + `{sessionResource, location/target/position}` | Open Chat on **focused/revealed** widget; extra fields ignored | No |

Any non-throwing attempt returns `activated=true` after first try → another **false positive** (`sessionActivated: true` in logs).

URI encoding itself looks **correct** vs workbench:

```text
LocalChatSessionUri.forSession(id):
  encodeBase64(utf8(id), padded=false, urlSafe=true)
  → vscode-chat-session://<authority=local session type>/<base64url>
```

companion `localChatSessionUri` uses `base64url` + `authority: "local"` — matches.  
**URI is fine; the open path never applies it for query accept.**

### 6) Mode commands

companion still calls:

- `workbench.action.chat.openAgentMode`
- `workbench.action.chat.openEditSession`
- `workbench.action.chat.openAskMode`

In VS Code **1.131** these string ids are **absent** (0 hits).  
Modern open path supports **`chat.open({ mode: "agent"|"ask"|…, query })`** via `WGt` + `handleSwitchToMode`.

Side note: `handleSwitchToMode` may set `needToClearSession` and run **New Chat** — if companion later relies on `mode` inside `chat.open`, mode switch can **wipe/retarget** the focused widget. Not the current primary bug (commands no-op), but a footgun.

### 7) Phone / extension state gaps (secondary)

| Gap | Effect |
|-----|--------|
| `activeSessionFile` is **module RAM only** | Lost on extension host reload / window reload until next `PHONE_MESSAGE.file` or select |
| Mitigated by PWA attaching `file` on send | Works **only if** `currentSessionMeta.file` is set |
| `currentSessionMeta.file` set on click / `SESSION_SELECTED` | Not set from `HISTORY_REPLAY.file` (bridge sends `file`, PWA handler **ignores** it) |
| Reconnect with empty title meta | Can send `PHONE_MESSAGE` **without** `file` → `focused-only` |
| `PHONE_SESSION_SELECT` sets active file only if `selectSession(file)` ok | Missing/unreadable path → no active file |
| Multi-window / multi-instance | Bridge is per-extension-host; inject always uses **that** window’s focused chat widget — no cross-window session lock |
| No unit/e2e test asserts *desktop session id* of accepted input | Regressions only caught by manual repro |

### 8) Historical oscillation (why 0.5.10 looked like a fix)

| Ver | Behavior |
|-----|----------|
| 0.5.6 | Tried `vscode.open(session uri)` + `chat.open({query, sessionResource})` — better chance to load session, but dual panel / editor force |
| 0.5.8 | Removed `vscode.open` / `openInEditor` to kill dual panel; primary inject became **focused-only** (paid parity) |
| 0.5.10 | Re-added `sessionResource` on `chat.open` without restoring a **real** session-load step that VS Code honors for acceptInput |

Net: 0.5.10 fixed the *intent* and logging, not the *binding* to the correct widget/model.

---

## Remaining risks (ranked)

### R1 — CRITICAL: `chat.open` never session-targets (false success)

- **Trigger:** Phone has DeepSeek selected (`file` set); desktop focus on「项目学习与理解」/ another agent session.  
- **Behavior:** Message accepted on focused session; DeepSeek jsonl lacks user line; phone may still show optimistic bubble.  
- **Why fix fails:** See §4.  
- **Detectability:** QR may show `inject via=chat.open+sessionResource` — **misleading**. Must verify target **chatSessions/\<sid\>.jsonl** / transcripts, not injectPath alone.

### R2 — HIGH: Pre-activate path is cosmetic

- `activateSessionForInject` success ≠ session switch.  
- 80ms delay after “activation” does not change widget identity.

### R3 — HIGH: Silent focused fallback semantics inverted

- Design assumed Path A throw → Path B.  
- Reality: Path A never throws for unknown `sessionResource` → focused inject labeled as targeted.

### R4 — MEDIUM: Missing / stale `file` on phone send

- No session select, failed select, or reconnect without restoring `currentSessionMeta.file` → no `sid` → intentional focused inject.  
- `HISTORY_REPLAY` carries `file` but PWA does not call `setSessionTitle(..., msg.file)`.

### R5 — MEDIUM: Multi-window / multi-folder

- Extension is `extensionKind: ["ui"]` (good for remote chatSessions), but inject is still **per-window focused chat**.  
- Phone list can show sessions from other workspaces; inject cannot move another window’s focus.

### R6 — LOW–MED: Mode API drift

- Dead mode command ids on 1.131; mode effectively desktop-default.  
- Future `mode` on `chat.open` may clear session (`needToClearSession`).

### R7 — LOW: Confirmation / stop still global focused

- `handleConfirmation` / `cancelChatRequest` have no sessionResource either (same class of issue; out of primary repro).

---

## Concrete code gaps

### G1 — No post-condition that the **widget session** matches `sid`

After inject, companion never checks e.g. whether the written jsonl / transcript for `sid` received the user message. Returns `ok: true` solely because `executeCommand` resolved.

### G2 — Wrong primitive for session open

Needed pattern (conceptual; must be validated per build):

1. **Load/show** target session widget (`loadSession(localUri)` / open session editor-or-sidebar **by resource**, not merely “move current to sidebar”).  
2. Wait until that widget is focused / `viewModel.sessionResource` matches.  
3. **Then** `acceptInput` / `chat.open({ query })` **without relying on ignored sessionResource**.

Candidate workbench surfaces observed (not yet wired safely in companion):

- Chat view `loadSession(sessionResource)`
- `getWidgetBySessionResource`
- `openSessionInEditorGroup` / related (context often agent-sessions viewer; may force editor → dual-panel tradeoff returns)
- **Avoid** treating `openInSidebar` as “open this session in sidebar”

### G3 — `executeCommand` success treated as semantic success

Unknown option keys do not reject. Need either:

- build-specific option allowlist verified against workbench, or  
- observation-based confirmation (jsonl/transcript), or  
- proposed API if Microsoft exposes one.

### G4 — PWA `HISTORY_REPLAY` ignores `file`

```js
// bridge.replaySession → HISTORY_REPLAY { messages, file }
// app.js case 'HISTORY_REPLAY': clearFeed + replay only — does not set currentSessionMeta.file
```

### G5 — Dead mode command ids on current host

Replace with `chat.open({ mode, query, … })` **only after** session widget is correct; watch `needToClearSession`.

### G6 — No automated regression for “wrong session”

Existing tests cover select/replay/pin/history ordering; **none** stub workbench to assert acceptInput session id.

---

## Comparison summary

| Layer | Paid 0.4.1 | companion 0.5.8 | companion 0.5.10 (claimed) | companion 0.5.10 (actual on 1.131) |
|-------|------------|-----------------|---------------------------|-----------------------------------|
| Phone session select | weak / latest file | yes | yes | yes (mirror only) |
| `PHONE_MESSAGE.file` | no | no | yes | yes |
| `activeSessionFile` | no | partial (0.5.6 era) | yes | yes (RAM) |
| Inject command | `chat.open({query})` | `chat.open({query})` focused | `chat.open({query, sessionResource})` | **same as focused** (resource ignored) |
| Dual panel risk | low | fixed by dropping open/editor | avoided | still avoided |
| Wrong-session risk | high | high | claimed fixed | **still high** |

---

## What would count as PASS later

Minimum acceptance for a real fix:

1. With desktop focused on session A and phone selected session B, phone send appears in **B’s** `chatSessions/<B>.jsonl` (and UI), **not** A.  
2. QR/log path must not claim targeted success unless (1) holds — prefer logging `focused-widget` vs `session-loaded` from observed widget resource.  
3. Sidebar-only users must not get a forced second editor panel (preserve 0.5.8 dual-panel fix).  
4. Reconnect + send without re-tapping session still targets last phone session (`HISTORY_REPLAY.file` → `currentSessionMeta`).  
5. Installed dist markers match, and a host-version note documents which VS Code builds were verified.

---

## Suggested next fix directions (audit only — not implemented)

1. **Prove** current failure: one send while logging focused widget resource vs `sid` (or diff two jsonl mtimes). Expect mismatch even when `injectPath=chat.open+sessionResource`.  
2. Reverse a **session-load-then-accept** sequence that stays in sidebar when the session already lives there (use `loadSession` / sessions viewer open APIs carefully).  
3. Until then: if target session ≠ focused, **refuse auto-send** or clipboard-with-explicit “desktop is on another session” (honest failure > silent wrong chat).  
4. Fix PWA `HISTORY_REPLAY` to restore `currentSessionMeta.file`.  
5. Treat `activateSessionForInject` return value as non-authoritative; don’t surface as success.  
6. Add host capability probe: if `chat.open` options documented/observed lack `sessionResource`, mark targeting unsupported.

---

## Files reviewed

- `projects/companion-open/src/inject.ts` (full)
- `projects/companion-open/src/extension.ts` (`PHONE_MESSAGE`, `PHONE_SESSION_SELECT`)
- `projects/companion-open/media/pwa/app.js` (`doSend`, session meta, replay)
- `projects/companion-open/src/bridge.ts` (`replaySession` file passthrough)
- `projects/companion-open/src/sessionWatcher.ts` (`selectSession`)
- Installed `…/0.5.10/dist/{inject,extension}.js`, `media/pwa/app.js`, `sw.js`
- `analysis/copilot-remote-0.4.1/pseudo/PRETTY_injectMessage.js`, `REPORT.md`
- `references/paid-target/…` inject pattern
- VS Code 1.131 `workbench.desktop.main.js` (`WGt` / `LocalChatSessionUri` / `openInSidebar`)
- `bug_fix.md` 0.5.6–0.5.10 notes
- `work/…/findings/issue1_4_fix_0.5.8.md`

---

## Final scorecard

| Question | Answer |
|----------|--------|
| Is phone→VS Code injection **still** vulnerable to wrong session? | **YES** |
| Did 0.5.10 ship the code it claims? | **YES** (source + installed) |
| Does that code fix the bug on current VS Code? | **NO** |
| Overall | **FAIL** (high confidence) |
