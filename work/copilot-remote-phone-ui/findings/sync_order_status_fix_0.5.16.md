# 消息顺序 / 同步 / 状态同步 — 0.5.16 修复

## 测试（0.5.15 真机）

| 项 | 结果 |
|----|------|
| projectHistory 交错顺序 (UA pairs) | PASS（多会话无 UUUAAA 堆叠） |
| 快速切会话 | PASS |
| 注入后 TYPING/STREAM/DONE | PASS |
| **切会话 live 洪水** | **FAIL 根因** |

实测：`PHONE_SESSION_SELECT` 后 4s 内 **567** 条 live：
`TOOL_CALL×498` + `AGENT_STREAM_*` + 最后 `HISTORY_REPLAY` + `COPILOT_DONE×11`。

## 根因

`extension.ts` 切会话：`transcriptWatcher.bindFile(tfile, { replay: false })`

但 `TranscriptWatcher.bindFile` 在 `replay !== true` 时：
1. 大文件仍 **tail 最后 1MB** 当 live 立刻投影（历史当实时）
2. **chatSessions fallback 全量 catch-up** 再灌一轮助手/TOOL

与 `projectHistory → HISTORY_REPLAY` **双通道** → 错序、重复、状态乱、发送键/正在输入异常。

## 修复（0.5.16）

1. `replay: false` / `liveOnly: true` → transcript **纯 EOF**，不 tail 1MB  
2. 同时 fallback **catchUp: false**（只跟增量）  
3. PWA `SESSION_SELECTED` 立刻清 typing/streaming/停止键  
4. `HISTORY_REPLAY.file` 同步会话元数据  
5. SW `sidecar-pwa-v22`

## 验证

- 单元：`bindFile({replay:false})` 大文件 **nonInternal events = 0** PASS  
- sessionselect/pin 单测 PASS  
- 已安装 `0.5.16`（需 **Reload Window** 后真机复测切会话 live≈0）
