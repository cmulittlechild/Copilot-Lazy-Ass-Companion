# 商业化注入 0.5.13→0.5.14

## 目标
静默串台不可接受；任意会话 100% 自动命中在 VS Code 1.131 无官方 API 下无法盖章；商业版 = **正确性门闩 + best-effort 绑定 + 可见失败**。

## 0.5.13 已落地（实测）
- 绑定：`vscode.open` ChatEditor（**默认不再 openInSidebar**）
- 硬门闩：目标 transcripts/chatSessions verify；串台 → clipboard
- **E2E（3010 / sidecar_remote / 0.5.13）**
  - token `lazy-c13-1786135899948-ds`
  - 目标 DeepSeek `8304329e` → **仅** transcript 命中（~11s）
  - 项目学习 `42c7881d` **无** token
  - **VERDICT: PASS target-only**
  - 副作用：verify 超时 8s < 落盘 11s → 误报 clipboard（手机提示复制）——已在 0.5.14 修

## 0.5.14 修复
- verify 窗口 **16s**
- submit 成功且无 leak 时 **不再 clipboard**（`soft-unverified`）
- 仅 `cross-session-leak` / bind-failed / submit-failed 走剪贴板
- SW `sidecar-pwa-v20`
- 已 `code --install-extension …0.5.14.vsix --force`，extensions.json **0.5.14**

## 使用
1. Reload Window（若 channel 仍显示 0.5.13）
2. 手机连当前 port，选 DeepSeek 发消息
3. 日志期望：`inject via=bind+chat.open+verified` 或 `soft-unverified`；**不应**再因慢落盘出现剪贴板恐吓

## 残留风险
- 多窗口多 bridge 仍可能连错 port
- 平台无 sendToSession(id)；极端竞态仍可能串台——此时应走 leak 检测
- listSessions(40) 单测偶发超时（与注入无关）
