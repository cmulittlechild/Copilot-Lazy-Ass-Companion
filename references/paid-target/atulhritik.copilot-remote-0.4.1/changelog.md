# Changelog

## [0.4.1] - 2026-07-10

### Changed
- Activation screen: "Buy a license" is now a full-width secondary button (larger, easier to tap) beneath the primary Activate button.

## [0.4.0] - 2026-07-10

### Fixed
- Responses now always match VS Code Copilot exactly. Removed a parallel `vscode.lm` code path that generated separate, tool-less answers (e.g. it couldn't run commands), which appeared on the phone instead of the real agent output.
- "Stuck on thinking": the final answer is delivered by a JSONL splice entry that the parser was dropping. The response state is now fully reconstructed (snapshot + splice) so tool calls and the final text always reach the phone, in order.

### Added
- Live "Copilot is working…" indicator on the phone from the moment a message is sent until the real response arrives.

### Changed
- Redesigned the sidebar panel: a focused activation hero (large Activate License button) when unlicensed, and a polished status/QR/tunnel dashboard once activated.
- cloudflared is no longer bundled — the correct binary is downloaded on first run. VSIX size reduced from ~95 MB to ~230 KB.

## [0.2.2] - 2026-04-16

### Fixed
- Critical bug: Copilot responses delayed ~10 minutes and arriving incomplete on phone
- Root cause: VS Code JSONL writes use two modes (REPLACE and SPLICE via `i` field); the extension only handled REPLACE, silently dropping SPLICE entries
- Response streaming now correctly reconstructs the full response state before diffing new parts

## [0.2.1] - 2026-04-15

### Fixed
- README URLs changed from copilot-remote.vercel.app to agent-handle.vercel.app

## [0.2.0] - 2026-04-15

### Changed
- Published to VS Code Marketplace under publisher `atulhritik`
- Added repository URL and marketplace metadata

## [0.1.0] - 2026-04-08

### Added
- Initial release
- Remote phone control via Cloudflare tunnel + PWA
- QR code in VS Code sidebar for instant phone pairing
- Real-time Copilot chat mirroring on phone
- Push notifications (Firebase FCM) when agent needs input
- File upload from phone to agent workspace
- Offline license verification (RSA-signed JWT, no server call)
- Machine-bound license key (one license per PC)
- Auto-restart tunnel on disconnect
- Supports Windows, macOS (Intel + Apple Silicon), Linux
