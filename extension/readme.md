# Copilot Lazy Ass Companion (local / self-use)

Open-source **non-replacing** companion inspired by static reverse of `atulhritik.copilot-remote`.

**No license / activation.** Self-use only.

## Goals
- Do **not** replace `GitHub.copilot-chat`
- Mirror active Copilot Chat session by tailing `chatSessions/*.jsonl`
- Serve a simple phone **PWA** over the same local HTTP port
- Accept remote prompts over WebSocket
- Inject back with `workbench.action.chat.open({ query })`
- Optional Cloudflare quick tunnel (`cloudflared`) — off by default

## Status
Prototype derived from:
- `../../analysis/copilot-remote-0.4.1`

Current:
- live-only tail at EOF (`copilotSidecar.liveOnly`)
- port auto-scan preferred..+20 when busy
- session discovery prefers `context.storageUri` nearby `chatSessions`
- optional auth token (`?token=` on PWA URL or `PHONE_CONNECT.token`)
- public tunnel auto-mints in-memory token if settings empty
- `~/.copilot-sidecar-companion/channel.json` channel artifact
- sidebar QR panel (port / token / public URL)
- tunnel start awaits URL (`TunnelManager.start` → Promise<string>)
- inject echo suppression + success SYSTEM_MESSAGE
- COPILOT_DONE 450ms debounce + TOOL_CALL dedupe
- host-free local E2E (`npm run test:e2e`)
- Web Push (VAPID) + PWA subscribe + stream projector (START/CHUNK/SET/END)
- `fs.watch` on session file + chatSessions dir (poll backup)

## 0.4.0 (借鉴 davidobot sidecar / himeneko copilot-remote)

PWA 前端（`media/pwa/`）:
- **Markdown 升级**: `marked.js` (GFM) + `highlight.js` (代码高亮，cdnjs 加载失败自动降级纯文本)
- **流式状态机**: 按 streamId 聚合 turn（START/SET/CHUNK/END），防乱序防丢块
- **thinking 折叠块**: `THINKING_STEP` → `<details class="assistant-thinking-block">` 流式追加
- **代码块增强**: 语言徽章 + 一键 Copy 按钮（幂等 decorateCodeBlocks）
- **会话抽屉**: `PHONE_SESSION_LIST` 列表 + 点击 `PHONE_SESSION_SELECT` 切换
- **终端面板**: `PHONE_TERMINAL_LIST` / `PHONE_TERMINAL_EXEC` / `TERMINAL_OUTPUT`
- **工具卡片状态**: running / ✓ done / ✓ 已确认

## 0.5.0 (工作区归属 + 模型/审批选择器)

**解决「不知道哪个会话属于哪个工作区」**:
- `src/workspaceIndex.ts` — 扫 `workspaceStorage/*/workspace.json` 建反向索引（**不算 hash**，
  因为 hash = `md5(fsPath + Math.round(birthtimeMs))` 含 birthtime 盐不可反推）
- 两级名：远程 `GC_trr:fuse_seg`、本地 `sidecar_remote`；SSH authority 支持 hex-JSON
  (`{"hostName":"GC_trr"}`) 与明文别名两种编码
- 借鉴 paseo 建模纪律：`workspaceId` 不透明（`wks_<hash12>`）**禁止当路径用**，路径只在 `cwd`
- PWA 会话抽屉按工作区分组：当前工作区置顶带「当前」徽标、远程组带主机徽标、可折叠、支持搜索

**`extensionKind: ["ui"]`**（关键）:
- SSH remote 时扩展钉在本机 → `storageUri` 与 bridge 都在 Mac，手机能连
- 实测依据：`chatSessions` 由本机 workbench 写（41 个远程工作区**全都有**），
  而 `transcripts` 由远程侧 copilot-chat 扩展写（远程工作区中 **0 个**有）

**模型 / 审批模式选择器**（`src/chatControl.ts`）:
- 模型：`vscode.lm.selectChatModels()` 列举 + `workbench.action.chat.changeModel` 切换
  （`{id, vendor, family}` 三字段必填，否则内部 assert 失败）；订阅 `onDidChangeChatModels` 推送
- 审批级别 4 档 `default` / `assisted` / `autoApprove` / `autopilot`，靠 slash 命令
  `/exitAutopilot` `/yolo` `/autopilot` 切换（silent，不留气泡）；`assisted` 退回桌面 picker
- 与 `mode`(agent/ask/edit) 是**两个独立维度**
- PWA 底部 sheet 选择器（借鉴 paseo `CompactModelSheet`）：搜索过滤、当前项 ✓、不可用项置灰带原因

**跨工作区切会话**:
- `PHONE_SESSION_SELECT` 用工作区索引反查目标会话所属的 transcripts 目录，
  而非固定用当前窗口目录 → 修掉「列表看得见、点进去切不过去」
- 目标工作区无 transcripts（远程恒如此）时 `transcriptActive=false` 降级 chatSessions，
  避免两个源都不出内容导致手机空白

扩展侧（`src/`）:
- `src/terminal.ts` — `TerminalManager`: Shell Integration 流式执行 + exitCode，无集成时剪贴板回读兜底
- `src/instances.ts` — `InstanceDiscovery`: 多窗口/多工作区发现（扫描 basePort..+range，PHONE_INSTANCE_STATUS 握手）
- `src/sessionWatcher.ts` — `listSessions()` / `selectSession()` 会话列表与切换
- `src/bridge.ts` — `onRequest()` 请求-响应协议；`AGENT_CONFIRM` 移出 HISTORY_REPLAY 防重复
- `src/extension.ts` — 接线新协议（SESSION/TERMINAL/INSTANCE_STATUS）

## 0.4.1 (实时同步 + 标题 + 官方视觉)

**同步延迟/顺序修复（核心）**:
- **`src/transcriptWatcher.ts`**（新）: 改用 `GitHub.copilot-chat/transcripts/*.jsonl` 实时事件流
  作为主内容源（毫秒级，替代 chatSessions 约 60s 周期落盘）：
  - 事件流 → PhoneEvent：user.message → USER_MESSAGE、assistant.message → AGENT_STREAM_SET
    （完整快照整段覆盖）+ THINKING_STEP、tool.execution_* → TOOL_CALL、turn_end → COPILOT_DONE
  - 时间戳单调有序 → 天然解决乱序；行序=重放序
  - 内部子代理消息过滤（[Terminal/[Session/[Task 前缀 + notification:），±3s 批量去重
  - replay 模式（切会话）：从尾部最近 10 轮用户消息开始回放历史
  - `copilotSidecar.preferTranscript` 设置（默认 true），目录缺失自动回退 chatSessions
- SessionWatcher 保留为会话发现/标题源（transcripts 可用时不重复投影内容）

**会话标题**:
- `listSessions()` 现在解析 `kind=1 k=['customTitle']`（LLM 生成，与官方侧栏一致），
  缺失时用首条用户消息截断 200 字符，空会话显示"新建聊天"
- 手机端会话抽屉显示标题而非 UUID（真实样例："项目学习与理解"、"Mihomo IP 轮换策略修改"）

**PWA 视觉对齐 VS Code 官方 Copilot Chat**:
- `--vscode-*` CSS 变量体系（dark+：#1e1e1e 背景），消息行 chat-row 结构（24px 头像 +
  "Copilot" 紫色名 + 无气泡内容渲染，与官方一致）
- codicon 图标字体（本地化 `/codicon.css` + `.ttf`，离线可用）
- thinking 折叠块 codicon（circle-filled/check）、工具卡 done 徽章、用户消息透明背景
- 会话抽屉显示 title（fallback UUID）

## Dev
```bash
cd .
npm install
npm run compile
npm run test:e2e
npm run package

# Install (macOS app bundle CLI if `code` not on PATH):
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension ./copilot-sidecar-companion-0.3.0.vsix --force
```

Reload window. Status bar shows `Sidecar :3010`. Sidebar **Copilot Lazy Ass → QR / 连接**.

## Phone / PWA
1. Bridge auto-starts (or command **Copilot Lazy Ass: Start Bridge**)
2. Open local PWA: `http://127.0.0.1:3010/`
3. Or enable tunnel:
   - setting `copilotSidecar.enableTunnel: true`, or
   - command **Copilot Lazy Ass: Start Tunnel**
4. Scan QR in sidebar (public URL preferred, else local)

If `authToken` is set, open `http://127.0.0.1:3010/?token=YOUR_TOKEN`.

When **Start Tunnel** runs and `authToken` is empty, a random session token is generated in-memory, embedded in the QR/`?token=` URL, and written to `channel.json` (not persisted to settings).

## Settings
| key | default | note |
|-----|---------|------|
| `copilotSidecar.port` | `3010` | HTTP+WS |
| `copilotSidecar.host` | `127.0.0.1` | use `0.0.0.0` for LAN |
| `copilotSidecar.authToken` | `""` | optional |
| `copilotSidecar.liveOnly` | `true` | EOF tail |
| `copilotSidecar.enableTunnel` | `false` | cloudflared quick tunnel (manual Start Tunnel is solid) |
| `copilotSidecar.tunnelTimeoutMs` | `35000` | wait for trycloudflare URL |
| `copilotSidecar.downloadCloudflared` | `true` | cache under `~/.copilot-sidecar-companion/` |

## Protocol (subset)
Phone → bridge:
- `PHONE_CONNECT` `{ token?: string }`
- `PHONE_MESSAGE` `{ text: string, mode?: 'agent'|'ask'|'edit' }`
- `PHONE_CONFIRM` `{ button: string }`

Phone → bridge (extra):
- `PHONE_PUSH_SUBSCRIBE` `{ subscription }`

Bridge → phone:
- `SYSTEM_MESSAGE`, `USER_MESSAGE`, `AGENT_LIST`, `CONNECTED_ACK` (`vapidPublicKey`)
- `AGENT_STREAM_START` / `CHUNK` / `SET` / `END`, `AGENT_MESSAGE`
- `TOOL_CALL`, `AGENT_CONFIRM`, `AGENT_CONFIRM_RESOLVED`
- `COPILOT_TYPING`, `COPILOT_DONE`, `HISTORY_REPLAY`, `TUNNEL_URL`

See `WIRE_NOTES.md` for extension wiring (`PushManager`, `setPushManager`, `sendToPhone`).

## Test without phone
```bash
npm run test:e2e

# against running extension:
node ../../analysis/copilot-remote-0.4.1/sim/fake_phone_client.mjs \
  --url ws://127.0.0.1:3010 --send "hi from companion test" --mode agent
```
