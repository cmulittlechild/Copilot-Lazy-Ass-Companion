# Copilot Remote Control

**Control and monitor your GitHub Copilot agent from your phone — in real time, with zero servers and zero subscriptions.**

Walk away from your desk while your agent runs. Your phone mirrors the entire chat session. When the agent needs a decision, your pocket buzzes. Tap, reply, done — agent keeps going.

---

## Features

- **Live chat mirror** — every agent message streams to your phone in real time via a secure Cloudflare tunnel
- **Push notifications** — instant buzz when the agent stops and needs your input
- **Reply from phone** — type a response or tap a confirmation button; it injects directly into VS Code as if you typed it
- **File upload** — attach a screenshot or PDF from your phone camera roll; the extension saves it to your workspace and tells the agent
- **Works offline for the agent** — messages are queued while your phone is briefly disconnected and replayed when it reconnects
- **No middleman server** — your phone talks directly to your PC through Cloudflare's free tunnel. You own the pipe, nothing passes through our systems
- **One-time purchase** — pay once, use forever, on one machine

---

## How It Works

```
Your PC (VS Code)  ──cloudflared tunnel──  Cloudflare  ──WebSocket──  Your Phone (PWA)
```

1. The extension starts a local WebSocket server on your PC
2. The bundled `cloudflared` binary creates a free Cloudflare tunnel pointing at it
3. A QR code appears in the VS Code sidebar — scan it with your phone
4. Your phone opens a Progressive Web App that connects through the tunnel
5. Everything the Copilot agent does streams live to your phone
6. Messages you send from the phone inject back into VS Code Copilot chat

No cloud account. No subscription. No data leaves your machines except through the tunnel you control.

---

## Setup

### 1. Install & Activate

1. Install this extension from the VS Code marketplace
2. Open the **Copilot Remote** panel in the activity bar (phone icon)
3. Run **`Copilot Remote: Activate License`** from the Command Palette
4. Paste your license key from the purchase email

### 2. Connect Your Phone

1. The QR code appears automatically in the sidebar once the tunnel starts (takes ~5 seconds)
2. Open your phone camera and scan the QR code
3. The PWA opens in your phone browser — tap **Add to Home Screen** to install it
4. The sidebar turns green: **Phone connected**

### 3. Enable Push Notifications (optional but recommended)

1. When the PWA opens, allow notification permissions
2. In VS Code settings, set `copilot-remote.fcmServerKey` to your Firebase Cloud Messaging server key
   - This is free: create a Firebase project → Project Settings → Cloud Messaging → Server Key
3. Now you get a push notification whenever the agent pauses and needs your input

---

## Requirements

| Requirement | Details |
|---|---|
| VS Code | 1.85 or newer |
| GitHub Copilot Chat | Must be installed and signed in |
| Internet | For the Cloudflare tunnel only |
| License key | One-time purchase at [agent-handle.vercel.app](https://agent-handle.vercel.app) |

---

## Commands

| Command | What it does |
|---|---|
| `Copilot Remote: Activate License` | Enter or re-enter your license key |
| `Copilot Remote: Show QR Code` | Focus the sidebar QR panel |
| `Copilot Remote: Restart Tunnel` | Kill and restart the Cloudflare tunnel |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `copilot-remote.fcmServerKey` | *(empty)* | Firebase Cloud Messaging server key for push notifications |

---

## FAQ

**Does this work if my PC goes to sleep?**
No — the tunnel requires your PC to stay awake. Use your OS power settings to prevent sleep while running long agent tasks.

**Can I use it from multiple phones?**
Yes — multiple browsers/devices can scan the same QR code and connect simultaneously. All receive the same live stream.

**Is my code sent to any server?**
No. The tunnel carries the chat text displayed in VS Code. Your source code never leaves your PC; it is never uploaded anywhere by this extension.

**What if the tunnel URL changes?**
The QR code updates automatically. Just re-scan if prompted. The tunnel URL changes each time VS Code restarts.

**Does the license work offline?**
Yes — license verification is pure RSA math against a public key bundled in the extension. No server call is made at any point.

**My phone says "Connection lost" — what do I do?**
Run **`Copilot Remote: Restart Tunnel`** from the Command Palette. The QR code will refresh.

---

## Privacy

- **No telemetry.** Zero analytics, zero crash reporting, zero usage data sent anywhere.
- **No cloud account required.** The Cloudflare tunnel is anonymous and ephemeral — a new random URL every session.
- **License verification is offline.** Your key is verified locally using RSA cryptography; no activation server exists.

---

## License & Pricing

One-time purchase. Lifetime license. Bound to one machine.

[**Buy at agent-handle.vercel.app →**](https://agent-handle.vercel.app)
