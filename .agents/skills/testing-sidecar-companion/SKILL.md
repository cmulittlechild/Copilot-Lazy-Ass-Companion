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
- ws 模块在 `projects/companion-open/node_modules/ws`；监控脚本已固化在本 skill 目录 `ws_monitor.mjs`（Node 24+ 原生 WebSocket 零依赖），直接 `node .agents/skills/testing-sidecar-companion/ws_monitor.mjs` 即可（/tmp 会被系统周期清理，勿再放那里）。Terminal.app 开窗口跑它并排录屏，时间戳直接进画面。
- 监控须打印 PING 帧（8s 一跳的应用层心跳）：区分"链路活着但没业务流量"与"真断链"；~3min 空闲吞包修复后，前台空闲应见 PING 持续、CLOSED 零次。

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
- 验证"已投去重"类修复双测：目标 stray 不再冒 + 回放/跟随不受影响；点选后看 feed 空不空是最快判据（注意：手机点选 n=1 仅提示是设计行为，勿误判回归）。
- 工具轮验证用"建文件+验证"提示可一次覆盖 THINKING/TOOL_CALL/步骤组/文件实证。
- 边界重投影有 sessiondb 变体：回放过的答案可能在下轮发信后经 db 行再投。
- 前缀比对类压制的对抗验证必含同题重问——确认 seq 放行（重问抬 userSeq 后 isUtAnswered=false）。
- 重投影压制须分通道验证：sessiondb 行去重≠t 流投影；stray 判据=发信后 +2s 内冒上轮答案泡+监控 STREAM_START id=t1m*。
- 清单生命周期修复须穷尽所有移除路径逐一验证（本例三杀手：DONE 清/USER 回声 splice/SESSION_SELECTED 清，分三轮补齐）；「回声≠状态存活」是通用判据。
- 验证"补画/压制"修复须双通道对照：sessiondb 快路径无 STREAM_START；回放态与 live-emit 态是两套"已投"记忆。
- 马拉松式找 bug 要测"用户真会做的误操作"：连发/边切边发/边打草稿边收推送。
- 回放有两条不同来源须分别验证：连接回放=原样服务 `this.history`（活积+点选残留），点选回放=`replaySession(projectHistory+db回填)`——点选修好 history 后连接回放才含 USER；宿主重启后未点选即连会暴露"零用户泡"缺陷（fallback 通道按设计吞 USER_MESSAGE 只记 rid→ut）。
- 快速连发场景坑：在途时发送键是「停止」——点进 composer 打字**必须先截图确认文本进框再点**，否则空值点击=phone_stop 杀在途轮且文本丢失（自动化 type 偶发不落框已复现 2 次）。
- 答案渲染成 "text|Copy" 灰框 = marked.min.js CDN 没加载（md-fallback-pre 降级）；curl CDN 可达≠页面加载成功，Cmd+Shift+R 硬刷可恢复——是 PWA 对局域网手机场景的健壮性弱点。
- Copilot 0.67+ 无增量流事件：全程 AGENT_STREAM_START=0 属正常，答案以单条 AGENT_MESSAGE 到达；DONE 由 requestDoneReason（elapsedMs 内联）触发，typing 正常清。
- 上游模型 503/空响应时桌面显示 "Sorry..." 但 PWA 零错误泡——对账时注意"有问无答"可能是上游失败而非投递缺陷，区分靠看桌面同会话。
- 回放排序验证用探针 dump 序列最快：UA 过滤后必须严格 `UAUA…` 交错且 `U{2,}|A{2,}` clump 检测零命中；同 streamId 重复 AGENT_MESSAGE 抓双投。
- 同请求双投排查：会话 jsonl 同一请求可能带「append 内嵌 response」（projectLine 会顺带投影，jsonl.js:121）与「requests[i].response 追加 mut」双形态——守卫需覆盖 step1（append）与 step3（显式内嵌）两条路径。
- release 链检查看「最后一个 DONE 后按钮是否及时回发送」：滞留超 10s 即疑死链（`anyStreamingNow() return` 不重挂定时器曾是死路）。
- 孤儿轮（停止/失败/无回复）回放应渲染斜体「该轮无回复」占位恢复交错——live 区不应出现占位（在途轮豁免）。
