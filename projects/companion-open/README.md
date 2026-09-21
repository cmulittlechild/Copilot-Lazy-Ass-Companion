# Copilot Lazy Ass Companion

Remote companion for **GitHub Copilot Chat** in VS Code: mirror your active chat session to a phone-friendly **PWA** over the local network, send prompts back to Copilot from your phone, run terminal commands, and switch models / sessions / approval levels — all without touching your desktop.

> 非替换型伴侣扩展：不修改、不替换 `GitHub.copilot-chat`，只读取其本地会话文件并提供一个本地 WebSocket/PWA 桥接。

![screenshot](docs/screenshot-qr-panel.png)
![screenshot](docs/screenshot-phone-chat.png)

*(screenshots placeholder — replace `docs/screenshot-*.png` before publishing)*

## Features

- **Real-time chat mirror** — tails `GitHub.copilot-chat` transcript / `chatSessions` JSONL files with millisecond latency; streaming assistant output, thinking steps, and tool-call cards all rendered.
- **Send from your phone** — inject prompts into the active VS Code chat session (agent / ask / edit modes) via workbench chat commands, with echo suppression.
- **QR pairing** — sidebar panel shows a QR code (local URL, or public tunnel URL when enabled); scan and you're connected.
- **Session & workspace browser** — phone-side drawer lists sessions with LLM-generated titles, grouped by workspace (local + SSH remote), with search.
- **Model & approval switcher** — enumerate `vscode.lm` models, switch via `workbench.action.chat.changeModel`; 4-step approval levels (default / assisted / autoApprove / autopilot).
- **Terminal panel** — run shell commands from the phone via Shell Integration (clipboard read-back fallback for WSL / custom prompts).
- **Web Push notifications** — VAPID push when Copilot finishes, phone PWA subscribe.
- **Optional Cloudflare quick tunnel** — off by default; when started, a random session token is auto-minted and embedded in the QR / URL.
- **Multi-instance discovery** — multiple VS Code windows on different ports are auto-discovered by the PWA.

## Requirements

- VS Code **1.93+** with **GitHub Copilot Chat** extension installed and signed in.
- Node 22-based VS Code (1.99+) enables the SQLite session index (faster permission-level reads); on older hosts it degrades gracefully.

## Install

**From VSIX (local):**

```bash
npm install && npm run compile && npm run package
# macOS app bundle CLI if `code` is not on PATH:
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension ./copilot-sidecar-companion-0.5.38.vsix --force
```

Reload the window. The status bar shows `Sidecar :3010` and the sidebar gets a **Copilot Lazy Ass → QR / 连接** panel.

## Usage

1. The bridge auto-starts on launch (or run **Copilot Lazy Ass: Start Bridge**).
2. Open the sidebar panel **QR / 连接** and scan the QR code with your phone.
3. On the phone, open the PWA (e.g. `http://192.168.x.x:3010/`) and optionally "Add to Home Screen".
4. Set `copilotSidecar.host` to `0.0.0.0` if your phone can't reach the default `127.0.0.1` binding.
5. Optional remote access: command **Copilot Lazy Ass: Start Tunnel** (Cloudflare quick tunnel, public URL appears in the QR panel).

If `copilotSidecar.authToken` is set, append `?token=YOUR_TOKEN` to the URL (the QR code includes it automatically). If the token is empty when a tunnel starts, a random per-session token is generated in memory and embedded in the QR / `?token=` URL — it is never written to settings.

## Settings

| key | default | note |
|-----|---------|------|
| `copilotSidecar.port` | `3010` | HTTP + WebSocket port (auto-scans +20 if busy) |
| `copilotSidecar.host` | `127.0.0.1` | `0.0.0.0` for LAN access |
| `copilotSidecar.autoStart` | `true` | start bridge on startup |
| `copilotSidecar.authToken` | `""` | optional shared token for all clients |
| `copilotSidecar.defaultMode` | `agent` | default chat mode for phone messages |
| `copilotSidecar.injectSessionOpen` | `editor` | how target session is opened for injection |
| `copilotSidecar.liveOnly` | `true` | tail at EOF; `false` replays session history |
| `copilotSidecar.preferTranscript` | `true` | use realtime transcripts as primary source |
| `copilotSidecar.enableTunnel` | `false` | auto-start Cloudflare quick tunnel |
| `copilotSidecar.downloadCloudflared` | `true` | cache cloudflared under `~/.copilot-sidecar-companion/` |
| `copilotSidecar.tunnelTimeoutMs` | `35000` | wait for trycloudflare URL |

## Security

- By default the bridge binds to **127.0.0.1 only** — nothing leaves your machine. Binding `0.0.0.0` exposes it to your LAN: **always set an `authToken`** in that case.
- The tunnel feature exposes your local bridge through a **public Cloudflare quick tunnel** (`*.trycloudflare.com`). It is unauthenticated infrastructure: anyone who obtains the URL can reach the bridge, so always use it with the auto-minted session token, prefer short-lived sessions, and stop the tunnel when you're done.
- Terminal execution from the phone runs with your local user privileges — treat the token like a password.
- Everything is plaintext HTTP/WS (no TLS on LAN); the tunnel provides TLS only between phone and Cloudflare edge.

## Privacy

**All data stays on your machine.** The extension reads local Copilot Chat session files (`chatSessions` / `transcripts` JSONL) and relays them over your local network (or your own Cloudflare quick tunnel) directly to your phone. No third-party servers, no telemetry, no analytics, no data collection. Push notifications go through the browser push service you configured (VAPID keys are generated locally).

## Troubleshooting

- **Phone can't connect** — check `copilotSidecar.host` (`0.0.0.0` for LAN), same Wi-Fi, and firewall rules for the port shown in the status bar.
- **QR shows `127.0.0.1`** — that's the local URL; use the tunnel URL after starting a tunnel, or open the LAN IP manually.
- **Injection lands in the wrong session** — try `copilotSidecar.injectSessionOpen: "editor"` (default) and check the target session is the active chat editor; see command **Show Status**.
- **No content after switching sessions on remote workspaces** — expected fallback: remote workspaces have no transcripts dir; the bridge falls back to chatSessions (up to ~60s lag).
- **Terminal commands fail** — Shell Integration requires a supported shell; the clipboard read-back fallback covers WSL/custom prompts.
- **Logs** — run **Copilot Lazy Ass: Show Status**; bridge errors surface in the VS Code developer console.

## Disclaimer

This is an **unofficial, community tool**. It is **not affiliated with, endorsed by, or supported by GitHub or Microsoft**. It reads local VS Code Copilot Chat session files on your own machine; usage is at your own risk and must comply with the **GitHub Copilot Terms of Service** and your organization's policies.

## License

[MIT](LICENSE) — copyright (c) 2026 the project authors.
