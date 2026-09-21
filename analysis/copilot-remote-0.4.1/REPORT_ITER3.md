# Iteration 3 — Companion prototype

## Done
1. Confirmed real tool parts use `toolInvocationSerialized` with:
   - `isConfirmed: { type: 1, reason? }`
   - `isComplete: boolean`
   - `invocationMessage` string or `{value}`
2. No dedicated `kind:"confirmation"` parts in sampled local history (auto-approve common). Remote still has `AGENT_CONFIRM` path for when they appear.
3. Built **non-replacing** extension prototype:
   - `/Users/xin/Desktop/sidecar_remote/companion-open`
4. Compiled + packaged VSIX.
5. Unit-tested JSONL projector on real sessions.

## Prototype modules
- `src/jsonl.ts` — Remote-like projector (kind0/1/2)
- `src/sessionWatcher.ts` — macOS/Linux/Windows session roots + tail
- `src/inject.ts` — chat.open({query}) + confirmation commands
- `src/bridge.ts` — local WS bridge with optional auth token
- `src/extension.ts` — activation/commands/status

## Improvements vs paid Remote
- Does not replace GitHub Copilot Chat
- No license gate
- macOS Application Support path supported
- Optional auth token on PHONE_CONNECT
- Gentler default poll (50ms vs 8ms)
- Stream text de-dupe

## Install prototype
```bash
code --install-extension /Users/xin/Desktop/sidecar_remote/companion-open/copilot-sidecar-companion-0.1.0.vsix --force
```
Then Command Palette: `Copilot Sidecar: Start Bridge` (or autoStart).
Test:
```bash
node /Users/xin/Desktop/sidecar_remote/analysis/copilot-remote-0.4.1/sim/fake_phone_client.mjs \
  --url ws://127.0.0.1:3010 --send "hello" --mode agent --timeout 3000
```

## Still TODO
- Webview QR panel / PWA
- cloudflared/devtunnel optional transport
- Better live-only mode (start tail at EOF, not full replay)
- Richer tool confirmation UX when `isConfirmed` pending states appear
- Multi-window workspace binding
