# Copilot Lazy Ass Companion

一个 VS Code 扩展：把你桌面上的 **GitHub Copilot Chat** 实时镜像到手机（或任意浏览器）上——在手机上看回复、发指令、批工具调用、切会话、换模型，人不在电脑前也能继续干活。

> 非替换式伴侣：不修改、不替换 `GitHub.copilot-chat`，只读它落盘的会话文件，自己开一座本地桥。

English intro below / 中文见「快速上手」。

---

## What it does

Copilot Lazy Ass Companion turns your phone into a remote control + live monitor for Copilot Chat in VS Code:

- **Live mirror** — assistant answers stream to your phone as Copilot generates them: markdown, thinking steps, tool-call cards, everything.
- **Send from phone** — type a prompt on the phone, it lands in the real Copilot Chat composer and runs like you typed it.
- **Approve tool calls** — Copilot's permission cards (terminal commands, file writes) can be confirmed from the phone.
- **Queue & stop** — fire messages while a turn is running; they queue and auto-send FIFO. Double-tap Stop aborts the in-flight turn.
- **Session drawer** — browse all chat sessions (grouped by workspace, titled, searchable), replay full history, switch context.
- **Model switcher** — change the active model (Claude / GPT / third-party providers) from the phone.
- **Push notifications** — get pinged on the phone when Copilot finishes a turn.

## How it works (architecture)

```
Copilot Chat ──(writes)──> chatSessions/*.jsonl + transcripts + session-store.db
                                   │
                          extension tails 3 sources
                                   │
                       TurnArbiter (dedup/order/stamp)
                                   │
                   local bridge  :3010  (HTTP + WebSocket)
                                   │
                    phone / any browser  →  PWA
```

The extension watches the three async sources Copilot writes to disk, arbitrates them into one ordered event stream, and relays it to a PWA client. Phone-originated messages are injected back into the chat via VS Code workbench chat commands. Everything runs locally — no third-party server sees your data.

## Install (from GitHub Release)

1. Download `copilot-sidecar-companion-*.vsix` from [**Releases**](https://github.com/cmulittlechild/Copilot-Lazy-Ass-Companion/releases/latest).
2. In VS Code: `Cmd/Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file — or CLI: `code --install-extension copilot-sidecar-companion-1.0.7.vsix`.
3. **Developer: Reload Window**. Status bar shows `Sidecar :3010`; the sidebar gets a **Copilot Lazy Ass → QR / 连接** panel.

**Requirements**: VS Code 1.93+ (1.99+ recommended — its Node ≥22.5 enables the faster SQLite session index), **GitHub Copilot Chat** installed & signed in. Works on macOS and Windows.

## 快速上手

1. 扩展装好后桥接自动启动（状态栏 `Sidecar :3010`）。
2. 命令面板跑 **Copilot Lazy Ass: Show QR Panel**，或点侧栏 QR / 连接。
3. 手机扫码（同一 Wi-Fi）打开 PWA，可加主屏当 App 用。
4. 手机上正常聊天即可——发送排队、停止（双击）、切会话、换模型、批工具卡都在页面里。

如果手机连不上：把 `copilotSidecar.host` 设为 `0.0.0.0`，并确认手机和电脑同一局域网、防火墙放行该端口。要在外面用就开 **Start Tunnel**（Cloudflare 快速隧道，自动带一次性 token 到二维码里）。

## Commands

| Command | 作用 |
|---------|------|
| `Copilot Lazy Ass: Start Bridge` / `Stop Bridge` | 启停本地桥 |
| `Copilot Lazy Ass: Show QR Panel` | 打开二维码连接面板 |
| `Copilot Lazy Ass: Show Status` | 诊断状态（端口/索引/日志） |
| `Copilot Lazy Ass: Copy PWA URL` / `Copy Auth Token` | 复制连接地址 / 令牌 |
| `Copilot Lazy Ass: Start Tunnel` / `Stop Tunnel` / `Restart Tunnel` | 公网隧道开关 |

## Settings (`copilotSidecar.*`)

| Key | Default | 说明 |
|-----|---------|------|
| `port` | `3010` | 桥接端口（被占自动 +20 探测） |
| `host` | `127.0.0.1` | 绑定地址；局域网用 `0.0.0.0` |
| `autoStart` | `true` | 启动 VS Code 即开桥 |
| `authToken` | `""` | 共享令牌；开 LAN/隧道务必设置 |
| `defaultMode` | `agent` | 手机消息注入的 chat mode |
| `injectSessionOpen` | `editor` | 注入时目标会话打开方式 |
| `pollMs` | `50` | JSONL tail 轮询间隔 |
| `sessionRescanMs` | `2000` | 最新会话文件重扫周期 |
| `liveOnly` | `true` | `false` = 连接即回放全历史 |
| `preferTranscript` | `true` | 以 realtime transcripts 为主源 |
| `enableTunnel` | `false` | 桥启动即自动开隧道 |
| `downloadCloudflared` | `true` | 缺 cloudflared 时自动下载到 `~/.copilot-sidecar-companion/` |
| `tunnelTimeoutMs` | `35000` | 等 trycloudflare URL 的超时 |

## Security & privacy

- 默认只绑 `127.0.0.1`，数据不出本机；`0.0.0.0` / 隧道 = 暴露到局域网/公网，**务必设 `authToken`**（隧道会自动发一次性 token 嵌进二维码）。
- 手机端可执行终端命令（走 Copilot 审批流）——token 当密码对待。
- 无遥测、无第三方服务器；会话内容只在本机 ⇄ 你的浏览器之间流动。隧道模式下 TLS 由 Cloudflare 边缘到手机这一段提供。

## Troubleshooting

- **手机连不上** → `host=0.0.0.0`、同一 Wi-Fi、防火墙放端口。
- **PWA 装上后行为像旧版** → 硬刷一次（`Cmd/Ctrl+Shift+R`）；1.0.x 起带版本戳，正常会自动更新。
- **注入落错会话** → `injectSessionOpen: "editor"` + 命令面板 **Show Status** 看目标。
- **没内容/延迟大** → remote workspace 无 transcripts 目录，自动降级到 chatSessions（最多 ~60s 滞后）。
- **日志** → **Show Status** + VS Code 开发者控制台。

## Repo layout

- `projects/companion-open/` — **发布物**：扩展源码（`src/` TypeScript，`media/pwa/` PWA 前端，`dist/` 编译产物）
- `references/` `analysis/` `work/` `bug_fix.md` `testplan_r*_*.md` — 研究资料与双平台实测记录（非发布物）

Dev: `cd projects/companion-open && npm install && npm run compile && npm run package`（产出 vsix）。

## Disclaimer / License

Unofficial community tool — **not affiliated with GitHub or Microsoft**. Reads Copilot Chat's local session files on your own machine; use at your own risk within the GitHub Copilot ToS and your org's policies. [MIT](LICENSE).
