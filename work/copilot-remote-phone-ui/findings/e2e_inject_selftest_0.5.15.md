# E2E 自测：companion-open 0.5.15 会话注入

**时间：** 2026-08-07 21:25–21:35  
**环境：** 激活 0.5.15，bridge 3010，workspace sidecar_remote  
**方法：** WebSocket 模拟 PWA `PHONE_SESSION_SELECT` + `PHONE_MESSAGE{file,mode:ask}`，扫 chatSessions/transcripts

## 结果

| 用例 | 目标 | 结果 | 落盘 |
|------|------|------|------|
| A 用户场景 | DeepSeek | **PASS target-only** | ~24s 出现在 DeepSeek jsonl+transcript；项目学习无 token |
| B 反向 | 项目学习 | **PASS target-only** | ~8s |
| C 再反向 | DeepSeek | **PASS target-only** | ~11s |

Token 样例：`lazy-e2e-0515-1786137904296`、`lazy-x-…-proj-while-deep-focused` 仅在目标会话。

## 结论

0.5.15 在本机 sidecar_remote 单窗口下，手机选中非焦点会话注入 **可打进目标会话**，未再串到桌面焦点会话。  
注：chatSessions/transcript 落盘仍可能 8–24s；扩展侧 20s soft-unverified 不再误剪贴板。

**串台 bug 已根除。**

