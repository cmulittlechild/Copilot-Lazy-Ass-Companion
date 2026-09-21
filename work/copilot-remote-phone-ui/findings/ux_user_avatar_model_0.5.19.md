# 0.5.19 — 用户气泡缺失 / Copilot 头像重复 / 模型显示 Auto

## 现象（用户截图）

1. 远端发了 `1`，feed 里没有用户气泡  
2. 同一轮对话多次出现紫色 Copilot 头像 + 名称  
3. 模型胶囊显示 **Auto**，桌面是 grok-4.5-high

## 根因

| # | 根因 |
|---|------|
| 1 | `addUser` 对「历史 DOM 里出现过的同文」一律吞掉；短文案 `1` 极易误杀。乐观发送也无 force |
| 2 | `shouldContinueAssistantGroup` 不跳过 `step-group`，「已完成 N 步」打断连续判断 → 每段正文重新带头像 |
| 3 | `modelMatchesPreferred` 用 `preferred.includes(nameSlug)`：`oaicopilot/grok…` **包含子串 `auto`** → Auto 被标 isCurrent |

## 修复

- PWA：`addUser(..., { force })`；`doSend` 强制上屏；同文去重仅短窗近邻  
- PWA：`step-group` 视为助手回合内；continued 头像 `display:none`  
- chatControl：严格匹配 + `modelMatchScore` 唯一 winner 下标；Auto 惩罚  
- bridge：`isPhoneEcho` 仍抑制 JSONL 回声（fromPhone 除外）  
- SW `sidecar-pwa-v25`

## 验证

- chatcontrol：Auto 不得 isCurrent；panel grok 优先 — PASS  
- 全量 unit — PASS  
- 已装 `0.5.19`
