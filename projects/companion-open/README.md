# Copilot Lazy Ass Companion

把你桌面上的 **GitHub Copilot Chat** 实时镜像到手机（或任意浏览器）——看回复、发指令、批工具调用、切会话、换模型，人不在电脑前也能继续干活。

> 非替换式伴侣：不修改、不替换 `GitHub.copilot-chat`，只读它落盘的会话文件，自己开一座本地桥。

## What it does

- **Live mirror** — assistant answers stream to your phone as Copilot generates them: markdown, thinking steps, tool-call cards.
- **Send from phone** — prompts land in the real Copilot Chat composer and run like you typed them.
- **Approve tool calls** — Copilot's permission cards (terminal, file writes) confirmable from the phone.
- **Queue & stop** — fire messages mid-turn; they queue FIFO and auto-send. Double-tap Stop aborts the in-flight turn.
- **Session drawer** — all chat sessions grouped by workspace, titled, searchable, full-history replay.
- **Model switcher** — change the active model from the phone.
- **Push notifications** — get pinged when Copilot finishes a turn.
- **Terminal panel** — run shell commands remotely via Shell Integration (clipboard read-back fallback).
- **Optional Cloudflare quick tunnel** — public URL with auto-minted session token, off by default.
- **Multi-instance discovery** — multiple VS Code windows auto-discovered by the PWA.

## How it works

The extension tails the three async sources Copilot writes (`chatSessions/*.jsonl`, `transcripts`, `session-store.db`), arbitrates them into one ordered, deduplicated event stream (**TurnArbiter**), and relays it over a local bridge (`:3010`, HTTP+WS) to a PWA. Phone messages are injected back via workbench chat commands. All local — no third-party server.

## Install

Download the vsix from [Releases](https://github.com/cmulittlechild/Copilot-Lazy-Ass-Companion/releases/latest), then **Extensions: Install from VSIX…** (or `code --install-extension copilot-sidecar-companion-1.0.7.vsix`), **Reload Window**.

Or build: `npm install && npm run compile && npm run package`.

**Requirements**: VS Code 1.93+ (1.99+ recommended for the SQLite session index), GitHub Copilot Chat signed in. macOS + Windows verified.

## Usage

1. Bridge auto-starts (`Sidecar :3010` in status bar).
2. **Copilot Lazy Ass: Show QR Panel** → scan with your phone (same Wi-Fi).
3. Chat on the PWA — send/queue/stop/session-switch/model-switch/tool-approval all in-page.
4. LAN access: `copilotSidecar.host` = `0.0.0.0`. Remote access: **Start Tunnel** (token auto-embedded in QR).

## Commands

`Start Bridge` · `Stop Bridge` · `Show QR Panel` · `Show Status` · `Copy PWA URL` · `Copy Auth Token` · `Start Tunnel` · `Stop Tunnel` · `Restart Tunnel`

## Settings (`copilotSidecar.*`)

| Key | Default | Note |
|-----|---------|------|
| `port` | `3010` | bridge port (+20 auto-scan if busy) |
| `host` | `127.0.0.1` | `0.0.0.0` for LAN |
| `autoStart` | `true` | start bridge on startup |
| `authToken` | `""` | shared token — **required for LAN/tunnel** |
| `defaultMode` | `agent` | chat mode for phone messages |
| `injectSessionOpen` | `editor` | how target session opens for injection |
| `pollMs` | `50` | JSONL tail poll interval |
| `sessionRescanMs` | `2000` | newest-session rescan period |
| `liveOnly` | `true` | `false` replays full history on connect |
| `preferTranscript` | `true` | transcripts as primary source |
| `enableTunnel` | `false` | auto-start Cloudflare tunnel |
| `downloadCloudflared` | `true` | cache cloudflared under `~/.copilot-sidecar-companion/` |
| `tunnelTimeoutMs` | `35000` | wait for trycloudflare URL |

## Security & privacy

Default binds `127.0.0.1` — nothing leaves the machine. LAN/tunnel exposure: always set `authToken` (tunnel auto-mints one per session). Phone-side terminal execution uses your user privileges. No telemetry, no third-party servers; tunnel TLS covers phone→Cloudflare edge only. VAPID push keys generated locally.

## Troubleshooting

- Phone can't connect → `host=0.0.0.0`, same Wi-Fi, firewall.
- Stale PWA behavior → hard-refresh (`Cmd/Ctrl+Shift+R`); version stamps auto-update since 1.0.x.
- Injection lands in wrong session → `injectSessionOpen: "editor"` + **Show Status**.
- Remote workspaces lag → no transcripts dir there; chatSessions fallback (~60s).
- Logs → **Show Status** + VS Code dev console.

## Disclaimer / License

Unofficial community tool — **not affiliated with GitHub or Microsoft**. [MIT](LICENSE).
