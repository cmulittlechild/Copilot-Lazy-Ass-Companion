---
name: testing-sidecar-companion
description: 实机测试 copilot-sidecar-companion 扩展（PWA ↔ VS Code bridge）的方法：健康检查、WS 旁路计时监控、session-store.db 验证、UI 元素路径
---

# Testing copilot-sidecar-companion (Copilot Lazy Ass)

PWA ↔ VS Code bridge。仓库 `~/repos/sidecar_remote/projects/companion-open`。

## 环境确认（开始前）
- `curl -s http://127.0.0.1:3010/health` → ok/pwaOk/clients/tokenPresent。端口冲突时会扫到 3011+，以 `~/.copilot-sidecar-companion/channel.json` 的 `port` 为准。
- `channel.json` 还给出：当前绑定 session 文件名、workspaceName、extensionVersion。
- 已装扩展版本：`ls ~/.vscode/extensions | grep sidecar`；新装 VSIX 后必须 Reload Window 才生效。
- Chrome 打开 `http://127.0.0.1:<port>` 即 PWA（"Copilot Lazy Ass"）。

## WS 旁路监控（测延迟/双气泡的最可靠手段）
被动 client 连 `ws://127.0.0.1:<port>` 发 `{"type":"PHONE_CONNECT"}`（无 token 时直接连），即可收全部**广播**：
- `>>>` USER_MESSAGE = 手机发送时刻 t0（bridge.acceptPhoneUserMessage 广播，所有 client 可见）
- `<<<` AGENT_STREAM_START/SET/CHUNK/END 与 AGENT_MESSAGE = 回复到达时刻 → 延迟 = t_reply−t0
- HISTORY_REPLAY n=N = 切会话回放条数；SYSTEM_MESSAGE = "已切换到会话: <file>"
- 注意：`MODEL_SELECTED`/`SESSION_SELECTED`/`MODEL_LIST` 是 request→reply 单播，旁路监控看不到，只看 PWA UI。
- ws 模块在 `projects/companion-open/node_modules/ws`；脚本放 /tmp，Terminal.app 开一个窗口跑它并排录屏，时间戳直接进画面。

## session-store.db（快速通道验证）
`~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db`
`sqlite3` 表 `turns(id,session_id,turn_index,user_message,assistant_response,timestamp)`：Copilot 回复完成后秒级落行（远早于 chatSessions JSONL ~45s）。查询最近行可独立验证真实答案内容与落库时间；`session_id` = chatSessions jsonl 文件名去扩展名。

## PWA UI 元素（app.js / index.html）
- 会话抽屉：顶部 ☰（#btnSessions）→ #sessionList 行点击切换；发消息前确认选中会话（注入打 activeSessionFile）
- 模型：composer 左下 pill（#btnModel）→ bottom sheet（#modelSheet）行点击；ok:false 时 #modelError 红条，成功 pill 文本立即变模型名
- 发送：#input + #send；回放在 #feed
- 已知幻影bug排查点：发新消息后 ~2s 内若出现"上一轮答案"气泡 = chatSessions/seed 重投影（ut 去重窗口 120s，过期即复发）

## 判定参考
- 回复延迟 ≤25s 正常；~40s+ 说明 sessiondb 快速通道未生效（回退到 chatSessions 轮询）
- 每轮发送后观察到 t_send+60s：同文本第二个 AGENT_MESSAGE = 迟到重复投影回归
- 桌面一致性：VS Code 右侧 Copilot chat 面板应出现同一会话同一问答（桌面无幻影）

## Devin Secrets Needed
无（本机 bridge 无 token；Copilot 需用户事先登录 VS Code）

## 实测经验（第七轮后补充）
- 发送按钮呈"停止"态 = 死流残留：先点一次发 phone_stop 清桥端流态，再重新发送。
- 幻影验证必须两连发以上——单发可能因写盘时机碰巧干净，漏判回归。
- USER 消息延迟基准要含 Copilot chatSessions 落盘延迟（~30-55s 属正常数据源延迟，非扩展慢）。
- 外会话切换 dump：kind0 快照整段重放，无 timestamp 请求只有数组尾部一条才可能新发。
- 扩展更新后 PWA 需 Cmd+Shift+R 硬刷加载新 app.js，否则客户端修复全部假阴性。
- 验证幻影区分"在途轮"（跟随期间正在生成的轮次，易漏）与"落地轮"；单发不足覆盖，必须连发。
- 桌面 Try Again/重试点击会以 USER_MESSAGE 泄漏到镜像端，勿当真实发送。
- 验证跟随修复须等 newest 稳定后观察 ≥1 个 poll 周期——SESSION_FOLLOW 重发风暴只在持续 newest 下显现。
- F5 在 DevTools 聚焦时不刷新页面，须用浏览器刷新按钮；吞包存证查控制台 sidecar.pendingSend。
- sessiondb 快通道把"答案到达"(~2s)与"轮次收尾"解耦；死流压制判据=监控全文 grep STREAM_START=0。
- 吞包两种成因区分：死流残留"停止"态误吞 vs socket 间隔 ~3min 退化静默吞（按钮正常仍丢）。
- 延迟测量须用带墙钟的监控列对齐发送时刻（发送 exec date 同步记录）。
