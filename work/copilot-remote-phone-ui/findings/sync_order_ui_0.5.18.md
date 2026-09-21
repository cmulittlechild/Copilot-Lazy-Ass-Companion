# 0.5.18 — 重复回复 / 穿插顺序 / 步骤折叠 / 模型同步

## 用户现象

1. 远程先发 `1` 再发 `2`，Copilot 又重复渲染了 `1` 的回复  
2. 桌面是「正文 ⇄ 工具」穿插；远程把多段正文和多个命令堆在一起  
3. 已完成工具卡默认不折叠  
4. 希望类似桌面「已完成 N 个步骤」  
5. 桌面模型是 `grok-4.5-high`，远程显示 `deepseek-v4-flash`

## 根因

| # | 根因 |
|---|------|
| 1/2 重复 | phone live 时 transcript 已是权威源，但 `chatSessions` fallback 仍在 EOF 后投影助手侧；会话落盘时整轮 response 再投一遍 → 重复 1 的回复 + 堆积 |
| 2 顺序 | 同一 turn 内 tool 前后共用/`SET` 同一 stream；PWA 工具卡 `appendChild` 到 feed 末尾，未在 tool 边界切开 stream |
| 3/4 UI | `upsertTool` 完成时未强制 `details.open=false`；无「已完成 N 步」分组；`COPILOT_DONE` 不 force 工具 done |
| 5 模型 | `listModels` 用 `settings.chat.defaultModel`（常为过期 deepseek）；真实面板模型在 globalStorage `chat.currentLanguageModel.panel` = `oaicopilot/grok-4.5-high` |

## 修复（0.5.18）

### transcriptWatcher

- `suppressFallbackAgent`：`bindFile({replay:false})` 时 mute chatSessions 助手投影  
- tool start 前 `endActiveStream`（保留 turnSeq），tool 后正文新 `streamId`  
- `execution_complete` / `turn_end.completeOpenTools` → `isComplete:true`  
- 新 turn 收尾上一流；不预发空 `STREAM_START`

### PWA

- done 工具默认折叠；`collapseCompletedToolSteps` →「已完成 N 个步骤」  
- `markAllToolsDone` on `COPILOT_DONE` / `STREAM_END` / `HISTORY_REPLAY`  
- 单调 done：已 done 不被 incomplete 打回 running  
- SW cache `sidecar-pwa-v24`

### chatControl

- `readCurrentPanelModelId()` 读 globalStorage state.vscdb  
- 优先级：selectModel 记忆 > panel current > settings defaultModel  
- `modelMatchesPreferred` 处理 `oaicopilot/grok-4.5-high` 等前缀

## 测试

- `scripts/test_transcript_order.mjs`：穿插顺序 + complete + fallback 静默 — **9/9 PASS**  
- 全量 `npm run test:unit` — **PASS**（含 chatcontrol / pin / sessionselect / bighistory 等）

## 安装

```bash
code --install-extension copilot-sidecar-companion-0.5.18.vsix --force
# Reload Window
# 远程 PWA 硬刷新（SW v24）
```

## 验证清单

1. 远程连 **sidecar_remote 对应 bridge**（注意 3010=omniprox / 3011=sidecar）  
2. 选「项目学习」会话，发短消息 A 再发 B，不应再出现 A 的整轮重复  
3. 带工具的一轮：正文 → 工具卡 → 正文 穿插；完成后折叠为「已完成 N 个步骤」  
4. 模型胶囊显示 grok-4.5-high（或面板当前模型），不是过期 defaultModel  
