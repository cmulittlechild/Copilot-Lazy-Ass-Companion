# bug_fix.md — companion-open 缺陷与修复记录

> 范围：`projects/companion-open`（当前 **0.4.1**）  
> 依据：VSIX 产物、源码、`GAP_CLOSED.md` / `WIRE_NOTES.md`、  
> `analysis/copilot-remote-0.4.1/REPORT*.md`、  
> `work/copilot-remote-phone-ui/findings/PHONE_DISPLAY.md`  
> 说明：无独立 CHANGELOG；版本时间线由 VSIX mtime + 代码 diff 反推。

---

## 1. 概述

**Copilot Sidecar Companion** 是对 `atulhritik.copilot-remote 0.4.1` 静态逆向后做成的 **非替换型** 自用伴侣：

- 不替换 `GitHub.copilot-chat`
- tail `chatSessions/*.jsonl`（0.4.1 起主源切换为 `GitHub.copilot-chat/transcripts/*.jsonl` 实时事件流）
- 本机 HTTP/WS + 手机 PWA
- 手机消息回注 workbench chat
- 可选 cloudflared 隧道；**无 license**

| 维度 | 0.4.1 状态 |
|------|------------|
| 协议 | `PHONE_*` / `AGENT_STREAM_*` / `TOOL_CALL` / `HISTORY_REPLAY` / `TUNNEL_URL` / Push / SESSION / TERMINAL / INSTANCE_STATUS |
| 会话 | transcripts 实时流（毫秒级）+ chatSessions 标题/发现 + live-only + replay 切会话 |
| 手机 UI | --vscode-* 官方视觉（chat-row/头像/codicon/thinking 折叠）+ marked/hljs |
| 验证 | `npm run test:e2e` + TranscriptWatcher 单测 + 浏览器实测 |

---

## 2. 版本时间线（0.1.0 → 0.4.1）

| 版本 | 关键交付 / 修复 |
|------|------------------|
| **0.1.0** | 最小原型：bridge + jsonl projector + sessionWatcher + inject；无 PWA |
| **0.1.1** | **liveOnly@EOF**；macOS Application Support 会话根；host-free e2e |
| **0.2.0** | **PWA** + 侧栏 QR + **Tunnel**；`publicUrl` / `TUNNEL_URL`；inject echo 抑制 |
| **0.2.1** | `tunnelTimeoutMs`；端口 **auto-scan**；**COPILOT_DONE 450ms debounce** |
| **0.3.0** | **PushManager**；`sendToPhone` / offlineQueue；完整 **STREAM_***；`fs.watch`；channel.json；隧道 mint token；`GAP_CLOSED.md` |
| **0.3.1** | `copyToken`；token 空态中文提示 |
| **0.3.2** | **手机噪音治理**：internal SYSTEM、Watching session 不进 feed；phone echo；quiet push |
| **0.3.3** | **kind0 快照投影** + **bootstrapLastRequests**；曾尝试步骤组 UI |
| **0.3.4** | 与 0.3.3 同内容重打（**app.js 仍损坏**） |
| **0.3.5** | **修复 app.js `Illegal break`（connecting 卡死）**；SW **v3 network-first** |
| **0.3.6** | **Display parity**：忽略 thinking/progress；独立 tool details；typing bubble；SW **v4** |
| **0.4.0** | **PWA 升级**：marked/hljs、流式状态机、thinking 折叠、会话抽屉、终端面板；`terminal.ts` / `instances.ts` / `onRequest` |
| **0.4.1** | **实时同步**：`transcriptWatcher`（transcripts 毫秒级事件流 + SET→CHUNK 打字机）；**会话标题**（state.vscdb `ChatSessionStore.index` + customTitle 兜底）；**官方视觉**（`--vscode-*` / codicon / chat-row）；**实例切换 UI**（`PHONE_INSTANCE_LIST`）；消息 footer 复制；e2e 覆盖 push/instance/typewriter/sessionIndex/可选 tunnel |
| **0.4.2** | **双源兜底**：transcripts 漏写 assistant 回复时从 chatSessions 补全（见 § 0.4.2） |
| **0.5.0** | **工作区归属**：`workspaceIndex`（`workspace.json` 反向索引 + 两级名），会话列表按工作区分组；**`extensionKind: ["ui"]`**（SSH 场景钉在本机）；**模型/审批选择器**（`chatControl`：`changeModel` 命令 + slash 切审批级别）；跳工作区切会话（`transcriptActive` 降级） || **0.5.1** | **真机测试暴露的两个严重 bug**（见 § 0.5.1）：端口冲突崩溃、`listSessions` 同步阻塞 1.4s；新增 105 项单元测试（含 vscode stub 首次真正执行 `chatControl`） |
| **0.5.2/0.5.3** | **会话切换三连修复**（见 § 0.5.2）：历史回放为 0、切走切不回、`streamId` 碰撞致回复折叠；修复流收尾、重复渲染、`requestCount` 恒 0、CSS 粘连 |
| **0.5.4** | **会话闪回修复**：`TranscriptWatcher` 无 pin，2s rescan 按 mtime 把手机端从手动选择的会话抢回「项目学习与理解」；新增 `pinFile()` 并在 `PHONE_SESSION_SELECT` 后 pin |
| **0.5.6** | **消息注入目标会话 + 标题解析 + 滚动闸门加固**（见 § 0.5.6） |
| **0.5.5** | **切换会话自动滑动修复**：回放期间逐条 `scrollFeed()` 导致手机从第一条滚到最后一条；回放期间禁用滚动、末尾一次定位；「已切换到会话」系统消息并入回放列表末尾 |
---

### 0.4.2：手机端收不到 Copilot 回复（transcripts 漏写 → chatSessions 兜底）

**症状**：手机端发送「你好」，电脑 VS Code 正常接收并回复，但手机端只显示自己发的消息，**始终等不到回复**。

**排查过程**（证据链）：

```bash
# 对比两个数据源的 mtime / size
find workspaceStorage -path '*transcripts/*.jsonl' -exec stat -f '%m %z %N' {} \; | sort -rn
find workspaceStorage -path '*chatSessions/*.jsonl' -exec stat -f '%m %z %N' {} \; | sort -rn
```

会话 `8304329e-b101-4948-8099-5892a7f9fe93` 的两源状态严重不一致：

| 源 | 大小 | mtime | 内容 |
|----|------|-------|------|
| `transcripts/` | **12 KB** | 02:03:20 | 停在 `user.message 你好` → `assistant.turn_start`，**之后无任何事件** |
| `chatSessions/` | **238 KB** | 06:33:23 | `requests[3].response` 含完整回复「你好！👋 我在呢…」 |

**根因**：**VS Code 的 transcripts 事件流会漏写 `assistant.message`**（尤其简短问候类回复），回复只落到 chatSessions。0.4.1 把 transcripts 当作唯一实时源，因此这类回复对手机端完全不可见。

**修复**（`src/transcriptWatcher.ts` 双源融合）：

- 新增 `chatSessionsDir` / `fallbackPollMs` 选项与 `findChatSessionsDir()` 辅助
- transcripts 仍为主源（毫秒级、顺序好）
- 检测到 **transcripts 停滞而同名 chatSessions 有新写入** 时，用 `JsonlProjector` 从 chatSessions 补全 assistant 回复
- `extension.ts` 接线传入 `csdir`，`qrPanel` 记录 `chatSessions 兜底源: …`

**验证**：绑定真实会话 `8304329e` 后补出 4 条 `AGENT_STREAM_SET`，含「你好！👋 我在呢…」；`tsc` 零错误、`test:e2e:fast` 全绿。

---

## 0.5.1 — 真机测试暴露的两个严重 bug

**背景**：此前所有验证都基于 mock bridge 与 e2e，两者都**绕过了真实 VS Code 扩展宿主**，
因此 `chatControl.ts`（488 行，依赖 `vscode` 模块）从未被执行过。改用
`--extensionDevelopmentPath` 起独立 dev host 后，立刻暴露两个长期存在的严重缺陷。

### Bug A：端口冲突直接崩溃（多窗口时只有第一个窗口能起 bridge）

**症状**：4 个 VS Code 窗口只有 1 个 bridge 在监听。dev host 的 `exthost.log`：

```
[error] Error: listen EADDRINUSE: address already in use 127.0.0.1:3010
```

**根因**：`BridgeServer.start()` 的端口扫描逻辑本身是对的（`EADDRINUSE → continue`），
但 `listenOn()` **只给 `server` 挂了 `error` 监听，没给 `wss` 挂**。
`ws` 库会把 http server 的 `error` 事件**转发到 `WebSocketServer` 实例**上，
于是端口占用时 `wss` 的 error 无人处理 → Node 抛 unhandled error 直接崩溃，
**端口扫描永远走不到第二次迭代**。

**修复**：`listenOn()` 同时给 `wss` 挂 error 监听并纳入 `cleanupPartial()`。
**验证**：`scripts/test_portscan.mjs`（7 项）+ 真机 dev host 确认 `:3010 :3011` 并存。

### Bug B：`listSessions` 同步阻塞 1374ms，拖死整个扩展宿主

**症状**：真机上手机端**所有**请求（含 0.4.x 就有的 `PHONE_SESSION_LIST`）零响应，
但 `/health` 正常、`requestHandlers=1`（处理器确实注册了）。延长超时到 15s 后全部通过。

**根因**：`collectSessionsFromDir()` 对**每个**会话文件都调用
`resolveSessionTitle`（读 1MB）+ `countRequestsQuick`（读 256KB），
**然后才**排序取前 40。本机实测：

```
会话文件总数: 432   总大小: 3036MB   最大单个: 324.8MB
listSessions(12): 1374ms  ❌ 同步阻塞事件循环
```

1.4 秒同步阻塞会卡住扩展宿主事件循环，后续请求全部排队超时。

**修复**：新增 `enrichSessions()`，把昂贵字段延迟到**排序截断之后**，
只对真正返回的 N 条读文件头。

```
修复后: listSessions(12) 51ms (27×)  listSessions(40) 131ms
```

**验证**：`scripts/test_sessionperf.mjs`（15 项，构造 400 文件/527MB，
断言耗时随 `limit` 缩放而非随文件总数）+ 真机 3s 超时下 11/11 通过。

### 诊断手段（保留为长期资产）

- `/health` 新增 `messageHandlers` / `requestHandlers` 计数 —— 用事实排除「处理器未注册」猜测
- `scripts/test_dispatch_isolated.mjs` —— 隔离实验：同结构 handler 配 `dist/bridge.js` 跑通，
  证明 bug 在 `extension.ts` 侧而非 bridge dispatch
- `scripts/probe_live.mjs`（`npm run probe`）—— 连真实运行实例做协议探测

### 教训

**mock 与 e2e 都不覆盖真实扩展宿主。** 依赖 `vscode` 模块的代码必须用
vscode stub（`scripts/test_chatcontrol.mjs`）或 dev host 验证，
性能问题必须在**真实数据规模**下测（3GB / 432 文件才暴露出来）。

---

## 0.5.2 / 0.5.3 — 会话切换三连修复（用户实测反馈）

**症状**（用户浏览器截图 + 实测）：
1. 选择会话后看不到该会话的历史记录
2. 在「测试 DeepSeek V4 Flash」对话后切到别的会话，再切回来**选不回来**
3. 会话列表显示 `0 次请求`（实际有 28 次）、组名与计数粘连

### Bug：历史回放为 0（选会话后空白）

**根因**：`PHONE_SESSION_SELECT` 处理里 `bridge.replaySession([])` **传的是空数组** ——
清空 feed 后广播了一个空的 `HISTORY_REPLAY`，会话历史从未被发送。
修复：改为调用 `watcher.projectHistory(file)` 生成真实历史再广播。

### Bug：切走切不回（选不回来）

**根因**：`SessionWatcher.scan()` 每 2 秒 `findNewestSessionFile()` 强制回绑最新会话，
**覆盖了手动选择**；且 `selectSession()` 在 `file === current` 时直接 `return true` 什么都不做。
修复：引入 `pinnedFile`，手动选择后 pin 住，`scan()` 在 pin 期间不自动切换。

### Bug：streamId 碰撞（回复折叠成一行 + 流不收尾）

**根因**：`k=["requests"]` 的 append 分支用 **mutation 载荷内的局部下标 `i`**，
而 kind=2 每次只 append 一个请求，所以 `i` 恒为 0 → `requestIndex` 恒 0、
`pathKey` 恒 `requests/0/response` → 多轮回复**共用同一 streamId**，
PWA 把它们折叠进同一行（6 条回复只有 1 条可见），且 `elapsedMs/result` 收尾标记
带真实索引（3、5）匹配不到注册成 0 的流 → **流永远不收尾**。
修复：用 mutation 的权威 splice 索引 `obj.i`，缺失时回退到累计计数器。

### Bug：历史回放流不收尾（缺复制按钮 + 光标闪烁）

**根因**：真实数据只有部分请求有 `result/elapsedMs` 收尾标记，
历史回放读静态完整文件后残留流未收尾。且此前 `finalizeAllStreams` 源码有但 **dist 未重建**。
修复：`projectHistory` 末尾调用 `proj.finalizeAllStreams()`（源码已加，0.5.3 真正编译进 dist）。

### Bug：重复渲染（同一条回复出现两次）

**根因**：`addAgentFinal` 去重只检查**最后一个** agent 消息，而回放与 live 数据源
把同一条回复**交错投出**（中间隔着 user/tool），最后一个不是它 → 漏掉。
修复：改为**全 feed 扫描** `body.dataset.raw === text` 去重。

### Bug：`0 次请求` + 组名粘连

- `countRequestsQuick` 只读 kind=0 快照的 `requests.length`（该会话为 0），
  真实的请求都在 kind=2 增量里 → 修复为遍历读取首个 `k=["requests"]` 增量的长度
- `ws-group` CSS 规则数为 0（截图组名与计数粘连）→ 补齐 flex/间距/徽标样式

### 验证（真机浏览器实测「测试 DeepSeek V4 Flash」会话）

```
回放 41 条历史 | 6 用户 + 7 回复 + 7 工具卡 | dupCount=0 | streaming=0
切走(9条) → 切回(41条) 完整恢复 | 注入新消息成功
```

---

## 0.5.4 — 会话闪回修复（用户实测反馈）

**症状**：当前在「项目学习与理解」会话，点击会话列表选择别的会话时，
**第一秒别的会话闪了一下，然后自动切回本会话**。

**根因**：双 watcher 的 pin 不一致——
- `SessionWatcher`（chatSessions 源）有 `pinnedFile` 机制，手动选择后不被 2s rescan 抢回 ✅
- `TranscriptWatcher`（实时源）**没有 pin**，`scanNewestBoth()` 每 2 秒按 mtime 选最新 transcripts，
  而「项目学习与理解」是当前活跃会话（mtime 最新）→ 切到别的会话 1 秒后被抢回，
  并触发广播把手机端拉回 ❌

**修复**（`src/transcriptWatcher.ts` + `src/extension.ts`）：
- 新增 `pinFile(file: string | null)`：pin 期间 `scanNewestBoth()` 不再按 mtime 自动切换
- `bindFile()` 会自动解除旧 pin（用户重新选择即恢复自动跟随）
- `PHONE_SESSION_SELECT` 成功后 `pinFile(tfile)` 锁住目标会话

**验证**：
- `scripts/test_pin.mjs`（5 项）：启动绑最新 → 手动选旧会话 → pin 6 秒不被抢回 → 解除后恢复自动跟随
- 真机浏览器：选「测试 DeepSeek V4 Flash」→ 回放 41 条历史 → 等 6 秒仍是该会话，未被抢回

---

## 0.5.5 — 切换会话自动滑动修复（用户实测反馈）

**症状**：切换会话后，手机画面从**整个会话最开始**一路自动滑动到最后，
用户希望**直接显示最新消息**，需要时自行上滑查看历史。

**根因**（两处叠加）：
1. `HISTORY_REPLAY` 里 `for (const m of list) handle(m)` **逐条渲染**，
   每条消息（USER/AGENT/TOOL）都调 `scrollFeed()` 滚动一次 →
   手机端看到从第一条滚到最后的整个滑动过程（且 CSS smooth 带动画）
2. 「已切换到会话」系统消息在 `HISTORY_REPLAY` **之后**单独广播 →
   把内容推高但没有重新定位，回放结束时的定位被它破坏

**修复**：
- `scrollFeed()` 在 `replaying` 期间**直接 return**（回放逐条渲染时不滚动），
  回放结束时统一一次性定位到底部
- 「已切换到会话」系统消息**并入 `replaySession` 的事件列表末尾**，
  `replaySession` 明确保留传入的 `SYSTEM_MESSAGE`（其余 SKIP 类型照旧过滤），
  让回放结束的定位包含它

**验证**（真机浏览器，DeepSeek 会话 41 条历史）：
```
采样期间 scrollTop 稳定在 4354（无逐条滚动过程）
最终 atBottom=true，最后一条是「已切换到会话」系统消息
```

---


---

## 0.5.6 — 切换会话后消息打错会话 / 标题变「新建聊天」 / 仍会滑动

### Bug 1：手机端选了 DeepSeek 会话，发「你好」却进「项目学习与理解」
- **根因**：`injectMessage` 只调 `workbench.action.chat.open({query})`，**从不切换 VS Code 当前 chat session**。模型切换是全局 `changeModel`，所以看起来“模型跟会话变了”，消息仍进桌面当前活跃会话。
- **修复**：`setActiveSessionFile` 在 `PHONE_SESSION_SELECT` 时记录选中文件；注入前 `activateSessionForInject(sessionId)`：
  1. `vscode.open(vscode-chat-session://local/<base64url(sessionId)>)`（对应 workbench `LocalChatSessionUri.forSession`）
  2. 降级 `chat.openInEditor` / `chat.open` 带 `sessionResource`
  3. 再 `chat.open({query, sessionResource})`

### Bug 2：当前会话列表显示「新建聊天」
- **根因 A**：`resolveSessionTitle` 只读 1MB，而 kind=0 快照常是 **8MB+ 无换行单行**，JSON.parse 失败 → 回落「新建聊天」。
- **根因 B（次要）**：早期 `dirname(dirname(storageUri))` 会把 vscdb 指错；当前代码已是单次 `dirname`，但 jsonl 兜底仍坏。
- **修复**：读头扩到 12MB + 正则直接抽 `customTitle`/`initialTitle`/`title`，并解析 kind=0 快照字段。

### Bug 3：切换会话仍从头滑到尾
- **根因**：0.5.5 修了 `HISTORY_REPLAY` 内 `scrollFeed`，但 `TranscriptWatcher.bindFile({replay:true})` 仍会在切换时**再投一轮 live 事件**（非 replaying 闸门），PWA 对每条 live 消息仍 `scrollFeed()` → 平滑滚动洪水。
- **修复**：
  1. 切换会话 `bindFile(..., {replay:false})`（历史只走 `projectHistory→HISTORY_REPLAY` 单通道）
  2. PWA：`scrollFeed` 在 `replaying||replayingInstant` 直接 return；结束用 `jumpFeedToBottom`（instant + 双 rAF）
  3. SW cache → `sidecar-pwa-v9` 强制刷新

### 验证
- 标题：`42c7881d → 项目学习与理解`，`8304329e → 测试 DeepSeek V4 Flash`
- 滚动 harness：40 条回放 `scrollCalls=0, jumpCalls=1, atBottom=true`
- inject stub：先 `vscode.open(session uri)` 再 `chat.open({query, sessionResource})`，`sessionActivated: true`
- 单元 147 + e2e 全绿；已安装 `0.5.6`



## 0.5.7 — 空白 feed / 眉头会话名 / Copilot Lazy Ass

- **空白 feed**：`HISTORY_REPLAY` 去掉对未声明变量的赋值；`try/finally` + `jumpFeedToBottom`；SESSION_SELECTED 成功路径不再 clearFeed
- **眉头标题**：`#sessionTitle` 默认 `Copilot Lazy Ass`；点击会话立即 `setSessionTitle`；`SESSION_SELECTED` 再同步
- **改名**：displayName / 命令文案 / PWA title → Copilot Lazy Ass（技术 id 仍为 copilot-sidecar-companion）
- **SW**：`sidecar-pwa-v12` 强制刷新
- 安装：`local-dev.copilot-sidecar-companion@0.5.7`



## 0.5.8 — 侧边注入不弹右侧 / 停止态 / Copilot 单标 / 手机可见自己消息

1. **双面板**：`activateSessionForInject` 去掉 `vscode.open` + `openInEditor`；侧边优先；主注入 `chat.open({query})` 打 focused widget（对齐付费 Remote）
2. **发送=停止**：`requestRunning` + `PHONE_STOP`/`cancelChatRequest`；`COPILOT_DONE`/`finishAllAssistantVisuals` 清全部 •••
3. **Copilot 标**：同回合 `agent-continued` 折叠；`STREAM_START` 不建空壳；空 turn 完成时移除
4. **自己消息**：`doSend` 不再先 `notePhoneUserText` 占 seenKeys；`acceptPhoneUserMessage` 先广播再 echo 抑制
5. SW `sidecar-pwa-v14`；扩展 `@0.5.8`



## 0.5.9 — 会话内容与桌面错位（根因）

### 根因
1. **projectHistory 时间线错乱**：先投影全部 USER/TOOL，再 `finalizeAllStreams` 把 AGENT 堆到末尾 → 手机看到用户/助手分离；再被 `HISTORY_MAX=80` 截断后只剩中间某次 0.5.4 验证表。
2. **双通道叠加**：`selectSession` → `bootstrapLastRequests` live 灌一轮 + `HISTORY_REPLAY` 再灌一轮 → 重复、错序、Copilot 一直「正在输入」。
3. **跨会话污染**：`scanForeignUserMessages` 在 pin 会话时仍把其他会话桌面消息灌进当前 feed。

### 修复
- `projectHistory` 按 request 轮次投影（USER→response→finalize），与 VS Code 交错一致
- `replaySession` 按轮次裁剪（MAX_TURNS=40 / HISTORY_MAX=200），禁止半截轮次
- `selectSession` 默认 `skipBootstrap`，历史只走 HISTORY_REPLAY 单通道
- pin 时 foreign USER_MESSAGE 不再广播到手机
- 真实会话 8304329e 回归：尾部含「今天是周几→周四」「你好→有什么需要帮忙」顺序正确

### 验证
- 单测 + e2e
- 模拟 select→replay 与桌面 tail 对齐
- SW `sidecar-pwa-v16`；扩展 `@0.5.9`



## 0.5.10 — 手机发消息落到错误会话（根因）

### 现象
- 桌面在「测试 DeepSeek V4 Flash」发 hello → 手机正确显示
- 手机发 hi → 跳到「项目学习与理解」/当前 focused agent 会话，DeepSeek jsonl 无 hi

### 根因
0.5.7 为避免双面板，把 inject 主路径改成 `chat.open({query})` **不带 sessionResource**。
这会打到 VS Code **当前 focused** chat widget，而不是手机 `activeSessionFile` 选中的会话。

### 修复
1. `injectMessage`：**有 activeSessionFile 时必须** `chat.open({ query, sessionResource })` 强制定向
2. 仅无选中会话 / 定向全失败才退 focused
3. 手机 `PHONE_MESSAGE` 附带 `file: currentSessionMeta.file`；extension 注入前 `setActiveSessionFile` + 可选 re-select
4. inject 路径写入 QR 日志便于诊断

SW `sidecar-pwa-v17`；扩展 `@0.5.10`

## 3. 已修复问题（症状 → 根因 → 修复）

### 3.1 not found / PWA 资源路径

| 项 | 内容 |
|----|------|
| **症状** | 打开本机或隧道 URL 得到纯文本 `not found`；PWA 空白 |
| **根因** | 更新 VSIX 后未 Reload，`pwaDir` 仍指向已删旧扩展目录；或静态路径无 `index.html` fallback |
| **修复** | `resolvePwaRoot` 自愈 + SPA fallback；`/health` 暴露 `pwaOk`/`pwaDir`；端口占用时 `port..+20` 扫描（约 0.2.1+）；安装后要求 Reload |
| **版本** | 0.2.0–0.3.3 持续加强 |

### 3.2 connecting… 卡死（app.js 语法错误）

| 项 | 内容 |
|----|------|
| **症状** | 手机左上角长期 `connecting…`，WS 逻辑不跑 |
| **根因** | **0.3.3 / 0.3.4** 打包时 `media/pwa/app.js` 被错误拼接：`showConfirm` 中混入 `TOOL_CALL` 的 `case/break`，触发 **`SyntaxError: Illegal break statement`** |
| **验证** | `node --check`：0.3.3/0.3.4 失败；0.3.2 / 0.3.5 / 0.3.6 通过 |
| **修复** | **0.3.5** 重写可用 app.js；脚本可解析后 `connect()` 才执行 |
| **版本** | **0.3.5** |

### 3.3 助手回复不同步（kind0 / 现代 JSONL）

| 项 | 内容 |
|----|------|
| **症状** | 桌面 Copilot 有完整步骤与答案，手机只见用户消息 + typing |
| **根因** | 早期 projector 只处理 `kind===2`；现代 Copilot 常 **整文件 rewrite 为巨大 kind=0 快照**；live-only 只 tail 新行会漏正文；`progressTask`/`thinking` 曾被忽略或错误投影 |
| **修复** | **0.3.3+** `handleKind0Snapshot`；`bootstrapLastRequests` 捕获 mid-turn；text 前缀增长发 `AGENT_STREAM_CHUNK`；rewrite/mtime 检测重投影 |
| **0.3.6** | 对齐 Remote：thinking/progress **扩展侧 IGNORE**，手机只收 user/stream/tool/confirm |
| **版本** | 0.3.3–0.3.6 |

### 3.4 Tunnel / publicUrl

| 项 | 内容 |
|----|------|
| **症状** | 隧道已开但 QR 显示「—」；重连刷 `TUNNEL_URL`；公网无 token |
| **根因** | URL 未 await / 重复 broadcast 进 history；settings 无 token 时公网裸奔；cloudflared 超时 |
| **修复** | tunnel start → Promise + timeout；`setPublicUrl` 去重；`TUNNEL_URL` 不进 HISTORY；隧道时 mint session token；`/health.publicUrl`；channel.json / tunnel.url |
| **版本** | 0.2.0–0.3.0+ |

### 3.5 手机信息流刷屏

| 项 | 内容 |
|----|------|
| **症状** | Watching session、connected、tunnel、push 成功失败刷屏 |
| **根因** | 内部 chrome 当 SYSTEM 广播；HISTORY 含 ephemeral 事件 |
| **修复** | `visibility/internal`；extension 拦截 Watching session；`HISTORY_SKIP`；PWA `shouldSkipSys` 4s 去重；push quiet；HISTORY_REPLAY 先 clearFeed |
| **版本** | **0.3.2** 集中治理 |

### 3.6 PWA Service Worker 缓存旧脚本

| 项 | 内容 |
|----|------|
| **症状** | 升级 VSIX 后手机仍跑坏的/旧的 `app.js` |
| **根因** | SW cache-first 钉死 app shell |
| **修复** | cache `v1→v2→v3(0.3.5)→v4(0.3.6)`；对 `/app.js` `/styles.css` `/sw.js` **network-first** |
| **版本** | **0.3.5 / 0.3.6** |

### 3.7 历史 / 离线队列洪水

| 项 | 内容 |
|----|------|
| **症状** | 重连或绑定会话时手机被历史淹没 |
| **根因** | liveOnly 误全量 replay；kind0 投影全部 requests；offline 与 HISTORY 双通道 |
| **修复** | 默认 liveOnly@EOF；kind0 只投影末尾少量 request；`HISTORY_MAX=80` + 文本截断；offline 只 flush 尾部；PWA replay 替换而非追加 |
| **版本** | 0.1.1 + **0.3.3** 专项 |

### 3.8 其他

| 问题 | 修复 | 约版本 |
|------|------|--------|
| 注入回声（手机看到自己的 USER） | inject 窗口 + bridge phone echo | 0.2.0–0.3.2 |
| TOOL_CALL 重复 | projector toolKey 去重 | 0.2.1+ |
| macOS 会话发现失败 | Application Support roots + storageUri 优先（相对 Remote 的 APPDATA 缺口） | 0.1.1+ |
| 仅 poll 延迟 | fs.watch + poll 备份 | 0.3.0 |
| 重连丢流/丢确认 | active stream resume + pendingConfirm + offlineQueue | 0.3.0 |

---

## 4. 显示对齐落地（0.3.6）

逆向结论见 `work/copilot-remote-phone-ui/findings/PHONE_DISPLAY.md`：

官方手机端是 **React + Tailwind PWA**，扩展侧 **丢弃** thinking / progressTask 等 chrome；工具是 **每张独立 `<details>`**，不是桌面「已完成 N 个步骤」总条。

companion **0.3.6** 落地：

| 对齐点 | 做法 |
|--------|------|
| 忽略 chrome | `jsonl` IGNORE 与 Remote 对齐 |
| 工具 UI | `upsertTool` → `<details>` running/done |
| 助手泡 | markdown + 绿点 + typing… + cursor-blink |
| Typing | 独立三点泡（约 180s 清理） |
| 用户泡 | 纯文本右对齐蓝泡 |

中间弯路：0.3.3 曾做步骤组并 **弄坏 app.js** → 0.3.5 修语法 → 0.3.6 按 Remote 重做显示。

---

## 5. 已知剩余 / 后续

0. **远程工作区同步延迟**：SSH remote 下 `transcripts/` 由运行在远程的 copilot-chat 扩展写入（本机 41 个远程工作区中 **0 个** 有 transcripts），因此远程会话只能走 `chatSessions` 周期落盘（~60s 级）。本地工作区不受影响  
1. **真实浏览器 Web Push 投递**仍依赖 Notification 权限 + FCM/APNs；host-free e2e 只覆盖 subscribe/notify 路径不抛错  
2. **多窗口跳进程 proxy 转发**未做：手机端可发现并重连目标端口，不做主实例网关转发  
2b. **当前模型无法读取**：VS Code 未提供「查当前选中模型」的 API，`isCurrent` 是 best-effort（仅反映本插件最后一次切换）；`assisted` 审批无 slash 命令，只能弹桌面端 picker  
3. **隧道冒烟**已纳入 `test:e2e`（默认尝试；`SKIP_TUNNEL_SMOKE=1` 跳过；`TUNNEL_REQUIRED=1` 失败则整套失败）  
4. PWA 为原生 DOM 对齐视觉（约 90%），复杂 GFM / Monaco 高亮边界仍不如官方  
5. 极长会话「回看更早轮次」：live 默认 EOF；切会话 replay 最近约 10 轮用户消息  
6. 目录内历史 **0.3.3/0.3.4 坏包** 勿误装；日常用 **≥0.4.1**

---

## 6. 证据索引

| 材料 | 路径 |
|------|------|
| companion 源码 | `projects/companion-open/` |
| 逆向总报告 | `analysis/copilot-remote-0.4.1/REPORT.md` |
| 迭代 2/3 | `analysis/copilot-remote-0.4.1/REPORT_ITER2.md` / `REPORT_ITER3.md` |
| 手机显示发现 | `work/copilot-remote-phone-ui/findings/PHONE_DISPLAY.md` |
| 协议闭环笔记 | `projects/companion-open/GAP_CLOSED.md` / `WIRE_NOTES.md` |
| 付费对照样本 | `references/paid-target/` |
