# Issue: 桌面端（VS Code Copilot Chat）发送的用户消息不同步到手机 PWA feed

**日期**: 2026-08-06
**方向**: Desktop → Phone（反向方向）
**严重度**: 高（核心同步链路失效）
**状态**: 根因已确认（多因素叠加，单点根因在 `extension.ts` 的 `transcriptActive` 全局 gate）

---

## 1. 结论摘要（TL;DR）

桌面用户在 VS Code Copilot Chat 发送的用户消息**不会**到达手机 PWA feed，根因是**三因素叠加**：

1. **主根因（单点 gate）** — `extension.ts:381` 的 `if (transcriptActive) return;`
   只要 transcripts 实时源处于激活态（`transcriptActive === true`，启动即有 transcripts 目录时**无条件置 true**，见 `extension.ts:417`），
   chatSessions 投影器（`SessionWatcher`）产生的 `USER_MESSAGE` 事件被**整体抑制**。
   而 chatSessions 源（`jsonl.ts` 的 `JsonlProjector`）是唯一能从**任何会话文件**投影 `USER_MESSAGE` 的路径。
   这个 gate 的本意是「避免双源重复」，但它把「桌面会话 ≠ 手机当前绑定 transcript 文件」时的所有用户消息全部丢掉。

2. **TranscriptWatcher 单文件绑定** — `transcriptWatcher.ts` 同一时刻只 tail **一个** transcript 文件
   （启动时 = 目录 mtime 最新的文件；手机 `PHONE_SESSION_SELECT` 后 = 手机选中的那个文件，`bindFile` + `pinFile`）。
   桌面端若在**另一个会话**（或另一个工作区）里发消息，watcher 不会读取那个文件 → 该会话的 `user.message` 永远不会被投影。
   实测证据：桌面“你好”发生在 `8304329e…`（sidecar_remote 工作区），而最新会话/默认绑定是 `42c7881d…`（本任务会话）。

3. **`PHONE_SESSION_SELECT` 的 `replay:false`** — `extension.ts:206` 在 `bindFile(tfile, { replay: false })` 后
   起始偏移 = **EOF**。若手机选中的会话**之前已经发过消息**（文件非空），此时桌面再在该会话发消息，新行**会**被 tail 读到 → 能同步；
   但如果桌面发的会话不是手机选中的会话，则完全不读。

**结论**：这是一个**全局 gate 掩盖了「多会话/多文件」同步缺口**的设计缺陷。手机→桌面方向之所以工作，是因为
`injectMessage` 先把手机消息注入了**手机选中的会话**，watcher 恰好 tail 那个文件 → 一切正常。
桌面→手机方向没有「注入到被监控文件」的机制，一旦桌面用户切到别的会话，消息就消失在 gate 后面。

---

## 2. 关键证据（代码行号 + 真实文件样本）

### 2.1 `extension.ts:381` — 全局 gate（主根因）

```ts
// extension.ts L374-385 (SessionWatcher onEvent)
onEvent: (ev) => {
  ...
  // 实时源优先：仅当当前会话确实由 transcripts 供稿时才抑制 chatSessions，
  // 避免切到无 transcripts 的（远程）工作区后两边都不出内容。
  if (transcriptActive) return;      // ← L381：transcripts 激活 → chatSessions 事件全丢
  if (bridge?.sendToPhone) bridge.sendToPhone(ev);
  else bridge?.broadcast(ev);
},
```

`transcriptActive` 置位点：

```ts
// extension.ts L405-417
if (tdir) {
  ...
  transcriptWatcher.start();
  // 启动时监控当前窗口最新的 transcript，此时由实时源供稿
  transcriptActive = true;           // ← L417：只要有 transcripts 目录就置 true
  ...
}
```

以及 `PHONE_SESSION_SELECT` 里：

```ts
// extension.ts L200-213
if (ok && transcriptWatcher && file) {
  ...
  transcriptActive = bound;          // ← 绑定成功 → true；无 transcripts → false（降级）
}
```

**问题本质**：
- `transcriptActive` 是**全局布尔**，但它实际只描述「手机当前选中的那个文件」是否有 transcript 源。
- 当 `true` 时，`SessionWatcher`（chatSessions 投影，**能覆盖任何会话**）的 `USER_MESSAGE` 被全部丢弃。
- TranscriptWatcher 只监控**一个**文件 → 桌面在别的会话发消息 → 没有任何源会投出这条 `USER_MESSAGE`。

### 2.2 `transcriptWatcher.ts` — 单文件 tail + pin

```ts
// transcriptWatcher.ts L133-146
/**
 * 手动选择会话后 pin 住目标文件：
 * 周期 rescan（scanNewestBoth）在 pin 期间不再按 mtime 自动切换，
 * 否则手机端切到别的会话后会被「项目学习与理解」的最新 mtime 抢回来。
 */
pinFile(file: string | null): void {
  this.pinnedFile = file ? path.normalize(file) : null;
}
```

```ts
// transcriptWatcher.ts scanNewestBoth L311-345
private scanNewestBoth() {
  if (this.disposed) return;
  if (this.pinnedFile) {             // pin 期间绝不自动切换
    if (this.current !== this.pinnedFile && fs.existsSync(this.pinnedFile)) {
      this.bindFile(this.pinnedFile);
    }
    return;
  }
  const t = this.newestInDir(this.opts.dir);       // 只看一个目录的 mtime 最新
  ...
}
```

- `newestInDir` 只取**一个目录**里 mtime 最新的 `.jsonl`。
- 若手机选中的会话在 `8304329e…`，而桌面活跃会话 `42c7881d…` 更新（mtime 更大），
  watcher 若未被 pin 就会自动切到 `42c7881d`；若被 pin 则永远停在 `8304329e`，
  **两者都不会同时读两个文件** → 桌面在其他会话的消息完全不可见。

### 2.3 真实数据证据（live 系统）

**桌面“你好”落在哪个文件：**

```
$ find workspaceStorage -path '*transcripts/*.jsonl' -exec grep -l '"你好"' {} \;
.../6ea7fd91d95d0ee7b8771238283ff09b/GitHub.copilot-chat/transcripts/8304329e-b101-4948-8099-5892a7f9fe93.jsonl
```

`8304329e` 中“你好”原始行（LINE 31）：

```json
{"type":"user.message","data":{"content":"你好","attachments":[]},
 "id":"e09b40c1-53be-47f8-96a0-1d8240ed2d9c",
 "timestamp":"2026-08-06T00:03:20.646Z","parentId":"af90672e-..."}
```

**而 mtime 最新（启动时绑定）的文件是 `42c7881d`：**

```
-rw-r--r--  ... 9668831 Aug 6 20:32  42c7881d-500f-4b23-a39e-f01d9441bd90.jsonl
-rw-r--r--  ...   92413 Aug 6 17:55  8304329e-b101-4948-8099-5892a7f9fe93.jsonl
```

→ TranscriptWatcher 启动绑定 `42c7881d`，`transcriptActive = true`，
→ 桌面在 `8304329e` 发“你好” → `8304329e.jsonl` 新增 1 行，watcher 不读；
→ chatSessions 投影本可覆盖（`SessionWatcher` 监控 chatSessions 目录），但被 `transcriptActive` gate 拦死。

**user.message 结构验证（无 turn 前置依赖，tail 可正常解析）：**

```
你好 at line 31
prev line: {"type":"assistant.turn_end",...}
cur line : {"type":"user.message","data":{"content":"你好","attachments":[]},"id":"e09b40c1-..."}
next line: {"type":"assistant.turn_start",...}
```

→ `user.message` 是独立 JSON 行，`handleUserMessage` 不依赖 turn 结构，只要文件被 tail 就能投出。

**chatSessions 兜底源有同会话数据：**
`8304329e…` 的 chatSessions 文件存在（`6ea7fd91.../chatSessions/8304329e-b101-4948-8099-5892a7f9fe93.jsonl`），
`JsonlProjector.handleUserRequest` 会投 `USER_MESSAGE`（`jsonl.ts:211-218`），但同样被 gate 拦截。

### 2.4 为什么手机→桌面正常（对照）

- 手机发消息 → `bridge.ts:306` `acceptPhoneUserMessage` → `pushHistory + broadcastRaw`（**不经过 watcher**）→ 手机 PWA 立即渲染；
- 同时 `injectMessage` 把文本注入**手机当前选中的会话**（`inject.ts`），TranscriptWatcher tail 的正是该文件 →
  transcript 回读的 `user.message` 被 `isInjectedEcho`（`inject.ts`）/ `isPhoneEcho`（`bridge.ts:660`）抑制，不重复。
- 也就是说：**双向对称依赖「手机选中会话 == 被监控文件」这个隐式前提**，而桌面用户不遵守这个前提。

---

## 3. 边界场景分析

| 场景 | 现状 | 影响 |
|---|---|---|
| 桌面在当前被监控会话发消息 | 能同步（tail 到增量行） | ✅ 正常 |
| 桌面在**另一个**会话发消息 | transcriptWatcher 不读该文件；chatSessions gate 拦截 | ❌ 丢失（本 bug） |
| 桌面在**另一个工作区**（含 SSH remote）发消息 | transcripts 只绑定当前工作区目录；remote 无 transcripts → 即便降级，`transcriptActive=false` 时 chatSessions 才放行 | ⚠️ 仅降级时可用 |
| 手机端切到旧会话后，桌面在**旧会话**发消息 | `bindFile(tfile,{replay:false})` 偏移=EOF → 新行能 tail 到 | ✅ 正常（若用户没再切走） |
| 桌面发消息后立刻被 `scanNewestBoth` 抢回最新文件 | 若未 pin，`rescan` 每 2s 检查 mtime，会切回最新文件，丢失旧会话 | ⚠️ 时序竞态 |
| 重试（desktop 重发） | 无影响（同文件则 tail 到） | — |
| 首条消息 | 同（文件为空时 EOF=0，仍能 tail） | — |
| 多窗口 | 每个窗口独立 bridge + watcher；手机连的是**一个**窗口 → 只有该窗口的会话可同步 | ⚠️ 结构限制 |
| 远程工作区 | `transcriptsDir` 为 null → `bound=false` → `transcriptActive=false` → chatSessions 投影可用 | ✅ 降级路径可工作 |

---

## 4. 工业级修复方案

### 核心思路
**解除「全局 gate」对 chatSessions USER_MESSAGE 的抑制，让 desktop 用户消息永远可达；同时保留对注入回声（phone→desktop→transcript 回读）的抑制，避免手机消息双出现。**

具体分三层：

---

### 4.1 `extension.ts` — 拆开 gate：只拦「assistant 侧」的 chatSessions 重复，不拦 USER_MESSAGE

在 `SessionWatcher.onEvent`（`extension.ts:374`）中：

```ts
onEvent: (ev) => {
  if (
    ev.type === "USER_MESSAGE" &&
    typeof (ev as any).text === "string" &&
    isInjectedEcho((ev as any).text)
  ) {
    return; // 手机注入回声（phone→desktop→transcript/chatSessions 回读）仍抑制
  }
  if (
    ev.type === "SYSTEM_MESSAGE" &&
    (String((ev as any).text || "").startsWith("Watching session:") ||
      (ev as any).visibility === "internal" ||
      (ev as any).internal === true)
  ) {
    writeChannelArtifact();
    return;
  }
  // 关键改动：transcriptActive 只抑制「助手侧」事件（避免双源重复渲染）；
  // USER_MESSAGE 永远放行 —— transcript 源只监控一个文件，桌面在别的会话发消息时，
  // 只有 chatSessions 投影能覆盖到，必须放行。
  if (transcriptActive && ev.type !== "USER_MESSAGE") return;
  if (bridge?.sendToPhone) bridge.sendToPhone(ev);
  else bridge?.broadcast(ev);
},
```

**为什么不会双出现（手机注入消息）**：
- 手机发消息 → `acceptPhoneUserMessage`（bridge 侧）直接广播 → PWA 渲染；
- transcript 回读该 `user.message` → `extension.ts onEvent` 先过 `isInjectedEcho` → **拦截**（30s 窗口）；
- chatSessions 投影该 request → 同样先过 `isInjectedEcho` → 拦截；
- 所以 USER_MESSAGE 放行**不会**造成手机消息双出现 —— echo 抑制在 gate 之前，且按文本匹配。

**为什么不会双出现（assistant 回复）**：
- transcripts 与 chatSessions 都会投影 `AGENT_STREAM_*` / `AGENT_MESSAGE`；
- `transcriptActive && ev.type !== "USER_MESSAGE"` 仍拦截 chatSessions 的 assistant 侧事件 → 不重复。

---

### 4.2 `transcriptWatcher.ts` — 多文件感知：桌面活跃会话切换时自动跟随

在 `transcriptWatcher.ts` 增加“跟随桌面活跃会话”的能力（不改单文件 tail 主路径，避免回归）：

```ts
/** 与 phone 选中会话无关的「桌面活跃会话」文件；存在时优先于 mtime 自动跟随 */
private desktopActiveFile: string | undefined;

/**
 * 让 watcher 感知桌面活跃会话：桌面用户在 VS Code Chat 里切会话时，
 * workbench 会更新 chatSessions 目录的 mtime；此处把「最新 chatSessions 文件」
 * 作为桌面活跃会话信号（若该文件也是 transcripts 目录里的同名文件则跟随）。
 */
setDesktopActive(file: string | undefined): void {
  this.desktopActiveFile = file ? path.normalize(file) : undefined;
}

private scanNewestBoth() {
  if (this.disposed) return;
  if (this.pinnedFile) {
    // pin 期间不自动切换（手机选中优先），但允许记录桌面活跃信号
    if (this.current !== this.pinnedFile && fs.existsSync(this.pinnedFile)) {
      this.bindFile(this.pinnedFile);
    }
    return;
  }
  // 桌面活跃会话信号优先：仅当该文件确实存在于 transcripts 目录（即同名）才跟随
  const t = this.newestInDir(this.opts.dir);
  const cs = this.opts.chatSessionsDir ? this.newestInDir(this.opts.chatSessionsDir) : undefined;
  let base: string | undefined;
  let bestMtime = -1;
  if (t && t.mtimeMs > bestMtime) { base = t.name; bestMtime = t.mtimeMs; }
  if (cs && cs.mtimeMs > bestMtime) { base = cs.name; bestMtime = cs.mtimeMs; }
  if (this.desktopActiveFile) {
    const dBase = path.basename(this.desktopActiveFile);
    const dTfile = path.join(this.opts.dir, dBase);
    if (fs.existsSync(dTfile)) {
      base = dBase; // 桌面活跃会话优先于 mtime 猜测
    }
  }
  if (!base) return;
  const tfile = path.join(this.opts.dir, base);
  if (tfile === this.current) return;
  if (!fs.existsSync(tfile)) return;
  this.bindFile(tfile);
}
```

配合 `extension.ts` 在**桌面会话切换事件**里调用（best-effort，命令可能不存在）：

```ts
// extension.ts activate 内，注册桌面会话切换监听
try {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveChatSession?.((s) => {
      // s.session 的 id → 反查 chatSessions/transcripts 文件路径
      const sid = String((s as any)?.session?.id ?? "");
      if (!sid) return;
      const rec = workspaceIndex?.resolveBySessionId?.(sid);
      const f = rec?.chatSessionsDir
        ? path.join(rec.chatSessionsDir, sid + ".jsonl")
        : undefined;
      transcriptWatcher?.setDesktopActive(f);
    }) ?? { dispose() {} },
  );
} catch { /* API 不可用则忽略（自动 mtime 跟随仍兜底） */ }
```

> 注：`onDidChangeActiveChatSession` 为 VS Code 1.10x+ API，旧版本缺失时 catch 忽略即可 ——
> 即使没有事件，`scanNewestBoth` 的双源 mtime 对比（`transcriptWatcher.ts:328-339`）已能跟随「活跃会话」，
> 因为桌面活跃会话的 chatSessions 文件 mtime 必然最新（60s 落盘 + 实时写）。

---

### 4.3 `bridge.ts` — 兜底：即使 transcript 源漏了，USER_MESSAGE 也能进 history（重连不丢）

现状 `bridge.sendToPhone`（`bridge.ts:428-476`）已经处理 `USER_MESSAGE` 的 history/offline/broadcast；
配合 4.1 后 chatSessions USER_MESSAGE 会走 `sendToPhone` → `pushHistory` + `broadcastRaw`，
重连 `HISTORY_REPLAY` 也能恢复。无需改动。
（可选加固：`eventDedupeKey` 对 USER_MESSAGE 已含 `requestId|text`，天然防重。）

---

### 4.4 PWA 侧确认（`app.js`）— 无需改动

`addUser`（`app.js:470-525`）的短窗去重只影响「手机自己刚发的消息」（`recentPhoneUserAt`/`seenKeys`），
桌面消息带独立 `requestId`（transcript `user.message.id` / chatSessions `requestId`）→ key 不冲突，正常渲染。
`handle USER_MESSAGE`（`app.js:1039-1045`）key 构造：`msg.requestId ? user:${msg.requestId} : textKey` — OK。

---

## 5. 回归测试建议

1. **桌面消息 → 手机**：手机选中会话 A，桌面在 A 发消息 → 手机 feed 应出现；在 B 发 → 手机 feed 应出现（经 chatSessions 放行）。
2. **手机消息不双出现**：手机发“你好” → PWA 一次；transcript/chatSessions 回读的“你好”被 `isInjectedEcho` 拦截。
3. **切会话回放**：`PHONE_SESSION_SELECT` → `HISTORY_REPLAY` 仍只走 `replaySession`（单通道），不叠加 transcript 回放。
4. **重连**：断开重连 → `HISTORY_REPLAY` 包含桌面消息（USER_MESSAGE 已进 history）。
5. **远程工作区**：无 transcripts → `transcriptActive=false` → chatSessions 全量放行（含 USER_MESSAGE）。

---

## 6. 附带发现（非本 bug 但相关）

- `transcriptWatcher.ts` `bindFile(file, {replay:false})` 后 `pinFile` 重置逻辑：`bindFile` 内部第一行
  `this.pinnedFile = null`（L170），随后 `extension.ts:208` 再 `pinFile(tfile)` —— 顺序 OK，但**任何其他路径
  （如 `scanNewestBoth` 内部无 pin 时）调用 `bindFile` 会清掉 pin**，这是 0.5.x 已知的“选不回来”竞态来源之一。
- 双源重复的**安全方向**：放行 USER_MESSAGE 后，若将来有人把 `isInjectedEcho` 窗口改短（<30s），
  手机消息可能在 transcript 回读时再次出现 —— 建议把 echo 窗口与 bridge `PHONE_ECHO_WINDOW_MS` 对齐。
