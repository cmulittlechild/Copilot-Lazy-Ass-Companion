# sidecar_remote

本目录是 **GitHub Copilot 手机伴生（companion）** 的研究与自建工程空间。

目标：

- 调研「手机远程操控 / 镜像 Copilot Chat」类方案的架构与交互
- 自建开源、**非替换式** 本地 companion：`projects/companion-open`
- 通过 tail `chatSessions/*.jsonl` 镜像会话，经本机 WebSocket / PWA 在手机上查看与回传 prompt
- 用 VS Code workbench chat 命令把手机输入注回本机 Copilot Chat

**定位：研究 + 自用原型。** 参考克隆与逆向产物仅供本地学习，不构成对第三方产品的再分发或破解授权。

---

## 目录结构

```text
sidecar_remote/
  README.md                 # 本文件
  bug_fix.md                # 问题与修复记录
  projects/
    companion-open/         # 自研 companion 扩展（当前 0.3.6）
  references/
    paid-target/            # 付费对照样本 0.4.1（解包目录 + VSIX）
    copilot/                # Copilot 远程/侧车类参考克隆（4）
    claude/                 # Claude 远程类参考克隆（5）
    terminal/               # 终端远程类参考克隆（2）
    agents/                 # Agent 相关参考克隆（1）
  analysis/
    copilot-remote-0.4.1/   # 对 paid-target 的静态分析报告与伪代码
  work/
    copilot-remote-phone-ui/# 手机 UI / 协议 case 工作区
```

| 路径 | 说明 |
|------|------|
| `projects/` | **我们自己构建的项目** |
| `references/` | **克隆的第三方参考** + 付费对照样本 |
| `analysis/` | 对 paid-target 的长期静态逆向知识库 |
| `work/` | 带 scope/timeline 的 RE case 工单 |
| `bug_fix.md` | companion 缺陷与修复时间线 |

---

## 自研：`projects/companion-open`

| 项 | 值 |
|----|----|
| 扩展名 | Copilot Sidecar Companion |
| package | `copilot-sidecar-companion` |
| 当前版本 | **0.3.6** |
| 原则 | **不替换** `GitHub.copilot-chat`；只镜像 + 回注；无 license/激活 |

### 能力摘要

- 实时 tail 活跃 Copilot Chat 的 `chatSessions/*.jsonl`（默认 live-only @ EOF）
- 本机 HTTP + WebSocket 提供手机 PWA
- 手机 prompt → `workbench.action.chat.open({ query })` 注回
- 侧栏二维码；可选 cloudflared quick tunnel（默认关）
- 可选 auth token、Web Push（VAPID）

### 安装

```bash
cd projects/companion-open

code --install-extension ./copilot-sidecar-companion-0.3.6.vsix --force
# macOS 若无 code CLI：
# "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
#   --install-extension ./copilot-sidecar-companion-0.3.6.vsix --force
```

然后 **Reload Window** → 侧栏 **Copilot Sidecar → QR / 连接**。

### 开发

```bash
cd projects/companion-open
npm install
npm run compile
npm run test:e2e
npm run package
```

常用命令：`Start Bridge` / `Stop Bridge` / `Show QR Panel` / `Start Tunnel` / `Copy Auth Token`。

详细说明见 [`projects/companion-open/README.md`](projects/companion-open/README.md)。

---

## 参考：`references/`

> **声明：** 下列均为第三方代码或样本，**仅供研究**。  
> 禁止用于破解授权、绕过付费、再分发闭源二进制或未授权商业用途。  
> 使用前请自行阅读各项目 LICENSE / 服务条款。

### paid-target

| 条目 | 说明 |
|------|------|
| `atulhritik.copilot-remote-0.4.1/` | 已解包的 0.4.1 扩展目录 |
| `atulhritik.copilot-remote-0.4.1.vsix` | 对应 VSIX 原包 |

### copilot（4）

| 目录 | 说明 |
|------|------|
| `copilot-remote` | himenekocn — VS Code + Android 远程 Copilot |
| `copilot-remote-control` | Discord bot + relay 远程控 Copilot |
| `vscode-copilot-chat-sidecar` | Davidobot — Chat sidecar |
| `vscode-github-copilot-controller` | Yuxi-Labs — 外部 API 控制 Copilot |

### claude（5）

| 目录 | 说明 |
|------|------|
| `247-claude-code-remote` | 浏览器/手机远程 Claude Code |
| `ClaudeRelay-Win` | Windows 托盘 + 手机 PWA 中继 |
| `claude-remote` | 手机加密 Web UI 远程 Claude |
| `claude-remote-vscode-edition` | VS Code 形态 Claude 远程 |
| `remote-claude-code` | ttyd + 手机聊天 PWA |

### terminal（2） / agents（1）

| 目录 | 说明 |
|------|------|
| `cerberus-term` | 终端复用 / 远程会话 |
| `termote` | 手机远程控 CLI agent |
| `paseo` | 多 agent 统一控制面（含 Copilot） |

---

## 分析与工作产物

### `analysis/copilot-remote-0.4.1/`

对 paid-target 的静态逆向：

- `REPORT.md` / `REPORT_ITER2.md` / `REPORT_ITER3.md`
- `pseudo/` 关键代码片段
- `jsonl/` / `sim/` / `notes/` / `vsix_extract/`

支撑 companion 的 JSONL 投影、WS 协议、PWA 设计；**不是**授权绕过说明。

### `work/copilot-remote-phone-ui/`

手机显示链路 case：

- `scope.md` / `timeline.md`
- `findings/PHONE_DISPLAY.md` — 手机 UI 逆向结论
- `evidence/` / `pseudo/`

---

## 快速开始（仅 companion）

```bash
cd /Users/xin/Desktop/sidecar_remote/projects/companion-open
code --install-extension ./copilot-sidecar-companion-0.3.6.vsix --force
```

1. VS Code：**Reload Window**
2. **Start Bridge**（或依赖 autoStart）
3. 手机打开 `http://127.0.0.1:3010/?token=…`（同网）或 **Start Tunnel** 后扫码
4. 用完隧道请 **Stop Tunnel**

---

## 重要说明

1. 自研交付物只有 `projects/companion-open/`；`references/` / `analysis/` / `work/` 不是发布物。
2. companion 依赖本机已有 Copilot Chat；它是伴生桥，不是独立 Copilot 客户端。
3. 公网隧道会暴露本地桥：务必使用 token，用完即停。
4. 缺陷与版本修复见 [`bug_fix.md`](bug_fix.md)。

---

## 路径速查

| 需求 | 路径 |
|------|------|
| 安装/开发 companion | `projects/companion-open/` |
| companion 详细 README | `projects/companion-open/README.md` |
| 对照样本 | `references/paid-target/` |
| 0.4.1 分析报告 | `analysis/copilot-remote-0.4.1/` |
| 手机 UI 发现 | `work/copilot-remote-phone-ui/findings/PHONE_DISPLAY.md` |
| 缺陷记录 | `bug_fix.md` |
