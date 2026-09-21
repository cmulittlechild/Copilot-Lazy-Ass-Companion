# Copilot Remote — Iteration 2 (no phone / no license)

## Goal
Continue reverse engineering without license activation or mobile pairing.

## What we did
1. Deep-parsed real local `chatSessions/*.jsonl` (408 sessions found on machine).
2. Reimplemented Remote's JSONL→phone event pipeline as `sim/jsonl_replay.mjs`.
3. Built protocol mock bridge + fake phone client (`sim/mock_bridge.mjs`, `sim/fake_phone_client.mjs`).
4. Validated end-to-end **protocol shape** on localhost without official runtime.

## JSONL format (validated)

Object keys almost always: `kind`, `k`, `v`, optional `i`.

| kind | meaning ( empirically ) | Remote handling |
|------|-------------------------|-----------------|
| 0 | session init snapshot (`version`, `creationDate`, ...) | ignored by hook |
| 1 | field assign / scalar updates (`inputState`, tokens, `elapsedMs`, `result`...) | only finalize markers used |
| 2 | structural mutations | **main path** |

### kind=2 important paths
- `k: ["requests"]`, `v: Request[]` → new/updated requests list → `USER_MESSAGE`
- `k: ["requests", idx, "response"]`, `v: Part[]`, optional `i` → response parts replace/splice
- finalize via kind=1: `k: ["requests", idx, "elapsedMs"|"result"|"isCanceled"]` → `COPILOT_DONE`

### Response part kinds seen
- `thinking` (ignored by Remote)
- `toolInvocationSerialized` (mapped to `TOOL_CALL`)
- plain `{value: string}` (mapped to stream text)
- `inlineReference`, `progressTaskSerialized` (mostly ignored / not primary)

### Request object fields seen
`requestId`, `timestamp`, `agent`, `modelId`, `message`, `response`, `variableData`, token fields, `modeInfo`, ...

## Critical finding vs earlier static read
Remote **only applies body mutations when `kind === 2`**.  
Most metadata updates are `kind === 1` and only finalize keys matter.

Also: many stream updates are full **response array replace** (`i` absent), not only splice. Splice happens too (`i` present) for incremental tool rows.

## Replay results (no phone needed)
- small session `aaded402...`: events include USER_MESSAGE / TOOL_CALL / STREAM / DONE
- current session `eab05fee...`: multi-turn reconstruction works at scale

## Protocol simulation
Fake phone against mock bridge succeeded:
- send `PHONE_CONNECT`
- send `PHONE_MESSAGE`
- receive `AGENT_LIST`, `USER_MESSAGE`, `AGENT_STREAM_SET`, `COPILOT_DONE`

This proves we can develop/test companion logic **without** paying license or using a phone.

## QR / pairing note (static)
Official QR is essentially tunnel URL; PWA reads `?tunnel=`.
No strong pairing token found in static strings. Auth gate is license UI + whatever WS accepts.

## Artifacts
- `jsonl/*.summary.json`, `jsonl/*.events.jsonl`
- `sim/jsonl_replay.mjs`
- `sim/fake_phone_client.mjs`
- `sim/mock_bridge.mjs`
- `sim/protocol.md`

## Next implementation-ready conclusions
A non-replacing companion should implement:
1. macOS path: `~/Library/Application Support/Code/User/workspaceStorage/*/chatSessions`
2. JSONL kind0/1/2 semantics above
3. ignore set: thinking/progressTaskSerialized/progressMessage/mcpServersStarting/undoStop/prepareToolInvocation
4. phone protocol messages listed in `sim/protocol.md`
5. inject via `workbench.action.chat.open({query})` + confirmation commands
6. optional tunnel later; local ws first
