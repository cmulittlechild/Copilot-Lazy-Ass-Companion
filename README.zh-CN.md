<p align="center">
  <img src="icon.png" width="128" alt="Copilot Lazy Ass Companion 图标">
</p>

<h1 align="center">Copilot Lazy Ass Companion</h1>

<p align="center"><a href="README.md">English README → README.md</a></p>

一个 VS Code 扩展：把你桌面上的 **GitHub Copilot Chat** 实时镜像到手机（或任意浏览器）上——在手机上看回复、发指令、批工具调用、切会话、换模型，人不在电脑前也能继续干活。

> 非替换式伴侣：不修改、不替换 `GitHub.copilot-chat`，只读它落盘的会话文件，自己开一座本地桥。

## 它能干什么

- **实时镜像**——Copilot 的回答边生成边推到手机：markdown 正文、思考步骤、工具调用卡片全部呈现
- **手机发消息**——在手机上敲 prompt，落到真正的 Copilot Chat 输入框里执行，跟坐在电脑前一样
- **审批工具卡**——Copilot 弹出的权限确认（跑终端命令、写文件）手机上就能点
- **连发排队 + 停止**——回复进行中也能继续发，自动 FIFO 排队依次送；双击「停止」掐断在途回复
- **会话抽屉**——全部会话按 workspace 分组列出、带标题、可搜索，点选即完整回放历史
- **模型切换**——手机上换当前模型
- **终端面板**——手机上跑 shell 命令（Shell Integration，含剪贴板回读兜底）
- **推送通知**——Copilot 跑完一轮手机收到通知（本地生成 VAPID，无第三方）
- **多窗口发现**——多个 VS Code 窗口各自开桥，PWA 自动发现可切换

## 无需公网 IP 也能远程使用

**内置临时公网隧道。** 一条命令（**Start Tunnel**）拉起 Cloudflare 快速隧道（`*.trycloudflare.com`），PWA 在任何网络下都能访问——手机流量、别的 Wi-Fi、任何地方都行。不需要公网 IP、端口转发或自己的服务器。每次开隧道自动铸一次性会话 token 嵌进二维码/URL。默认关闭，用完记得停掉。

## 工作原理

```
Copilot Chat ──(落盘)──> chatSessions/*.jsonl + transcripts + session-store.db
                                  │
                      扩展实时 tail 三个异步数据源
                                  │
                    TurnArbiter 统一裁决（去重/定序/归属）
                                  │
                  本地桥 :3010  (HTTP + WebSocket)
                   ┌──────────────┴──────────────┐
                局域网 / 隧道                   PWA
              （手机或任意浏览器）
```

Copilot 没有对外的事件 API，本扩展旁听它写盘的三个数据源，裁决成一条有序事件流推给 PWA；手机端的消息通过 VS Code workbench chat 命令注回会话。**全程本地，不经任何第三方服务器。**

## 截图

扩展侧边栏面板 —— 手机配对二维码、隧道控制：

![Copilot Lazy Ass 侧边栏](docs/screenshots/qr-panel.png)

## 安装

1. 从 [Releases](https://github.com/cmulittlechild/Copilot-Lazy-Ass-Companion/releases/latest) 下载 `copilot-sidecar-companion-*.vsix`
2. VS Code 命令面板（`Cmd/Ctrl+Shift+P`）→ **Extensions: Install from VSIX…** 选择文件；或命令行 `code --install-extension copilot-sidecar-companion-1.0.0.vsix`
3. **Developer: Reload Window**——状态栏出现 `Sidecar :3010`，侧栏出现 **Copilot Lazy Ass → QR / 连接** 面板

**要求**：VS Code 1.93+（推荐 1.99+，其 Node ≥22.5 可走更快的 SQLite 会话索引，低版本自动降级），已安装并登录 **GitHub Copilot Chat**。macOS / Windows 均实测可用。

## 快速上手

1. 扩展装好后桥接自动启动（状态栏 `Sidecar :3010`）
2. 命令面板跑 **Copilot Lazy Ass: Show QR Panel**，或点侧栏 QR / 连接
3. 手机扫码（同一 Wi-Fi）打开 PWA，可「添加到主屏幕」当 App 用
4. 手机上正常聊天即可——发送、排队、停止、切会话、换模型、批工具卡都在页面里

**手机连不上**：`copilotSidecar.host` 设为 `0.0.0.0`，确认同一局域网且防火墙放行端口。
**外网使用**：跑 **Copilot Lazy Ass: Start Tunnel**——不需要公网 IP，二维码自动带上含 token 的公网地址。用完记得 **Stop Tunnel**。

## 语言

扩展界面、二维码面板、通知以及手机端 PWA 同时提供**英文和中文**：扩展一侧跟随
VS Code 显示语言（内置 `en`/`zh-cn` 语言包），PWA 跟随浏览器语言；会话抽屉里的
`中/EN` 按钮可以手动切换（存在 localStorage）。

## 命令

| 命令 | 作用 |
|------|------|
| `Copilot Lazy Ass: Start Bridge` / `Stop Bridge` | 启停本地桥 |
| `Copilot Lazy Ass: Show QR Panel` | 二维码连接面板 |
| `Copilot Lazy Ass: Show Status` | 诊断状态（端口/会话索引/日志） |
| `Copilot Lazy Ass: Copy PWA URL` / `Copy Auth Token` | 复制连接地址 / 令牌 |
| `Copilot Lazy Ass: Start Tunnel` / `Stop Tunnel` / `Restart Tunnel` | 公网隧道开关 |

## 设置（`copilotSidecar.*`）

| 键 | 默认 | 说明 |
|-----|------|------|
| `port` | `3010` | 桥接端口（被占自动 +20 探测） |
| `host` | `127.0.0.1` | 绑定地址；局域网用 `0.0.0.0` |
| `autoStart` | `true` | VS Code 启动即开桥 |
| `authToken` | `""` | 共享令牌；开 LAN/隧道务必设置 |
| `defaultMode` | `agent` | 手机消息注入的 chat mode |
| `injectSessionOpen` | `editor` | 注入时目标会话打开方式 |
| `pollMs` | `50` | JSONL tail 轮询间隔（ms） |
| `sessionRescanMs` | `2000` | 最新会话文件重扫周期 |
| `liveOnly` | `true` | `false` = 连接即回放全历史 |
| `preferTranscript` | `true` | 以 realtime transcripts 为主源 |
| `enableTunnel` | `false` | 桥启动即自动开隧道 |
| `downloadCloudflared` | `true` | 缺 cloudflared 自动下载到 `~/.copilot-sidecar-companion/` |
| `tunnelTimeoutMs` | `35000` | 等 trycloudflare URL 超时 |

## 安全与隐私

- 默认只绑 `127.0.0.1`，数据不出本机；绑 `0.0.0.0` 或开隧道即暴露到局域网/公网——**务必设 `authToken`**（隧道会为每个会话自动铸一次性 token 嵌进二维码，不写进设置）
- 手机端可执行终端命令（走你本机权限），token 当密码对待
- 无遥测、无第三方服务器；会话内容只在本机 ⇄ 你的浏览器之间流动。隧道模式下 TLS 只覆盖手机到 Cloudflare 边缘一段

## 常见问题

- **手机连不上** → `host=0.0.0.0`、同一 Wi-Fi、防火墙放端口
- **PWA 像旧版** → 硬刷一次（`Cmd/Ctrl+Shift+R`）；带版本戳正常会自动更新
- **消息注错会话** → `injectSessionOpen: "editor"` + **Show Status** 看目标
- **remote workspace 延迟大** → 远端无 transcripts 目录，自动降级 chatSessions（最多 ~60s 滞后）
- **看日志** → **Show Status** + VS Code 开发者控制台

## 开发

```bash
npm install && npm run compile && npm run package   # 产出 vsix
```

## 免责 / License

非官方社区工具，**与 GitHub / Microsoft 无关**。只读本机 Copilot Chat 会话文件；使用请遵守 GitHub Copilot 服务条款与你所在组织的政策。[MIT](LICENSE)。
