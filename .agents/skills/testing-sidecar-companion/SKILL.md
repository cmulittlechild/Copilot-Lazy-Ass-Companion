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
- 队列修复验证口径：trailing DONE 常滞后答案 30-50s，U2 应等到 result-DONE 后才广播才算守住；wire 时间戳差 (U2-U1)>(A1-U1)=未逃逸。
- 停止测试必须 arm 后 <3s 内二击（窗口一过重 arm 不算确认）；停止键恢复延迟 ~3-5s 是 deferMs 宽限预期。
- 跟随压制测试分清两种触发源：「窗内被压跟随的延后重评」与「窗外新 follow」；后者只有绑定会话经手机点选且 <90s 活跃才被压（boundViaExplicitSelect），桌面主动切换不受压制。
- 吞包排查新规律：重绑/跟随后首发必死查 SESSION_SELECTED 对 outboundQueue/pendingSendQueue 的清零点（已修为捞回输入框）；三空（无泡无广播无落盘）还可能是输入为空时 doSend 静默 return——发送前先截图确认 input.value。
- 中文快速输入的「的→一/整句丢字」是电脑控制打字驱动在 IME 输入框丢字符所致（wire _ut 与变形文本一致=发送前已变形），非应用层 bug；报告时先区分驱动伪影。
- 注入回执 DONE（inject_soft_unverified 等 reason）在发送后 ~1.8s 到达，rr 释放判定要看 DONE 与最年轻待答条目的时距（<8s 不释放）。
- 勿在桌面 composer 粘贴命令字样文本——会被 agent 当指令执行并写脏会话。

## R55 (v1.0.6 仲裁器)
- 仲裁器副作用验证口径：USER→DONE 之间若零 AGENT=答案被吞（对磁盘 jsonl 确认答案确实生成——区分"没生成"与"没广播")；DONE 连发突发(×6)=仲裁器积压释放；AGENT 行尾的 sess=/ut= 是归属戳；TOOL_CALL 不在 dedup 范围会双投。
- 输入变形新特征：变形字符=最近输入过的字符(写→锂、有哪→锂锂)——更像输入层 per-char buffer 复用/替换，而非随机丢字。
- 停止测试现实约束：快模型(v4-flash ~2s)轮太短打不中；想测停止先切慢模型或发长文+0.5s 内连点两次。
- macOS "iPhone Mirroring" app 会反复抢前台+弹 iCloud 登录——osascript quit "iPhone Mirroring"(不是 Simulator)。

## R68 取证心得：回放层验证

- monitor 把 HISTORY_REPLAY 折叠成 `n=?`——要看回放内容需写探针：PHONE_CONNECT → PHONE_SESSION_SELECT(file=…jsonl) → dump e.messages 逐条（/tmp/replay_probe.mjs 有模板，~15行）。
- 手工造孤儿轮：往 chatSessions/<sid>.jsonl 尾追加 `{"kind":2,"k":["requests"],"v":[{…request…}]}`，克隆现有 request 行、换 requestId/timestamp/message.text；`response:[]`=纯孤儿，`response:[{"value":"",…}]`=空流壳（等价失败轮）。注意：尾部（最末）孤儿按设计不加占位——要测占位须再跟一个 request。
- 副作用：文件监视器会把新追加的 request 当**活轮**再广播一遍 live USER_MESSAGE（wire 上会突然出现非客户端发送的 U）。
- 客户端同文闸签名：feed 里同一答文第二次不渲（agentTextRendered 闸，无 replaying 豁免）——占位符/重复答案只渲首个。判别：wire 探针里有但 feed 里没有 = 客户端丢弃。

## R69 取证心得补充

- Chrome devtools Offline **只拦新连接/HTTP**，不杀已建 WS——掐活 socket 要配合 chrome://net-internals/#sockets "Flush socket pools"，但 app 重连 ~2s 内完成，手速追不上；可靠方案是 Offline 保持开→flush→重连握手被拦→死窗期可拉长。
- 造"迟到确认"场景的另一条路：开**第二个 PWA tab**发同文——其 USER_MESSAGE 回声会以 live 事件广播到第一 tab，等价迟到送达确认。
- sessionStorage `sidecar.pendingSend`（{text,key,at}）可直接种"未送达待发"，刷新即触发「发送可能未送达…已回填」路径——不用真断网。
- 控制台 JS 错误要警惕：`feed.addEventListener('scroll')` 里 ReferenceError 只污染滚动钩子不阻断其它功能，肉眼难觉——每轮值得瞄一眼 Console。

## R71 取证心得补充

- **WS 监控必须带 token**：QR 面板开隧道会铸 sessionToken 并把裸连客户端踢下广播通道（无 token 的 WS 只剩 PING 心跳、广播静默——极易误判成"服务无广播"）。监控端 PHONE_CONNECT 务必带 `token` 字段，或升级后直接从 QR URL 抠。
- 裸 DONE（无 _ut/closedUt）在「TOOL→DONE→+10s 正文」形态下会早于答案到达——live 占位误判即源于此；判别这类 DONE 是否误报看轮内是否有工具活动在飞。
- reqerr 轮特征：chatSessions request 的 `result.errorDetails.message`="Sorry, no response was returned."，response 只剩 mcpServersStarting；transcript 只有 turn_start 无 assistant.message/turn_end；sessiondb assistant_response 为空。

## R90 取证心得补充（第12轮马拉松，HEAD 4aa92be 含 endedStreams）

- **token 监控脚本已固化**：`ws_monitor_tok.mjs`（读 channel.json 的 port+token 发 PHONE_CONNECT）。token 启用期间旧 `ws_monitor.mjs` 裸连只剩 PING——一律用 _tok 版。
- **发送后按钮保焦坑**：点「发送」后按钮翻成「停止」且保留键盘焦点——此时键入文本里的 Space 会激活按钮（空格=点击），连按两次=phone_stop 0.3s 内杀掉新轮。自动化务必先点输入框再打字；桌面浏览器真实用户同样可中招（键盘焦点陷阱）。
- **发送端按钮滞留判据**：同会话被动 tab 已回「发送」而发送 tab 仍「停止」>10s = 发送端本地 rr 死链（跨 tab 对照是最快判据）；单击一次可释放。风险：滞留期打字再点=进队而非发送，队头无 DONE 可等→形似吞包。
- **瞬时乱序会自愈**：新发送的 user 泡可能短暂插到旧轮次上方（含 DONE 后），~2min 内无广播自行归位——先复查再报，别在窗口内截图当铁证。
- **stray 再投影识别**：wire 上 AGENT_STREAM_SET/MESSAGE 携带**上一轮答案原文**且 _ut 盖着新一轮——对照桌面 chat 该轮无此文即可定性（非模型真输出）。
- **回放风暴**：空闲期 monitor 可见 ×5 同内容 HISTORY_REPLAY（<0.2s 连发）——录制/计数时注意去重。
- TOOL_CALL 不受 dedup 约束会漏进下一轮窗口（已知）；`requests/0/response#text#0` 式 jsonl-id 空 STREAM_END 尾随 DONE ~36s 属正常骨架合成。

## R91 取证心得补充

- **跨会话残泡（cross-session residue）判据**：切到空会话后 feed 出现上会话泡 → 立刻核对目标 session 的 jsonl (`grep -c <text> chatSessions/<file>.jsonl`) 与 sessiondb (`select ... where session_id like '<prefix>%'`)。jsonl/db 均无 → 实锤残泡（重放/清屏后「已发未答」补画或未清 DOM），非该会话真实内容。
- **stale-TOOL 门可被 fresh-ts 绕过**：parked turn（如 confirmation 暂停的 run_in_terminal）在其后续轮窗口内重投影时携带**新 ts**，`ts >10s vs latestUserLiveTs` 检查失效。排查迟到 TOOL_CALL 时对照该 tool 首次出现时间 vs 重投时间。
- **变体文本 duplicate 滑过 same-text dedupe**：同一 ut 的 AGENT_MESSAGE 可二次到达但 markdown 被改写（如 `[file](file)`→`file`，链接 target 丢失）→ 文本不同 dedupe 不拦；客户端按 ut 合并只渲一泡，wire 上可见。查 dup 时按 ut 聚合计数而非文本。
- **停止路径时序**：send→(arm 一次点击)→confirm → DONE[phone_stop] ~2s → 按钮 ≤5s 回「发送」+ 孤儿占位「该轮无回复」。R91S2 实测干净。注意若轮撞上 confirmation 边界会先释放（停止点击落在已释放键上无效）——测 stop 选不受 confirmation 影响的短轮。
- **result-DONE 滞后 ~30-45s**：answer-DONE 与 [result] DONE 间距约 30s+；连发队列憋到 [result] 才 flush（实测 enqueue→wire 44s，触发后 3s）。判「吞包/卡队列」前先等 [result] DONE。
- **MODEL_LIST 三连发**：select/重连时同 ms 内 ×3 广播（多 subscriber），杂讯类，非风暴。
- **杂散 frame 家族（均已被吸收、无可见重渲）**：`AGENT_STREAM_END len=0 id=requests/0/response#text#N`（END 后 ~30s 迟壳）、`id=sessiondb/<sess>/<idx>` 标记、parked-turn USER/AGENT 整批重投（own ut，客户端 dedupe）。

## R13 取证心得补充（f6d19c8 复验轮）
- **装包双验证**：`code --install-extension vsix --force` 后，装目录 `~/.vscode/extensions/local-dev.copilot-sidecar-companion-*/` 的 dist/media 与仓库对哈希确认一致；但**必须再 Reload Window**（Cmd+Shift+P）才激活——extensionHost pid 不变说明没生效。同理 PWA 硬刷 Cmd+Shift+R 加载新 app.js（旧页面跑的是旧 JS，replay 时的表象会骗人）。
- **脚本化边界点击**：手动打 ~1s 收尾窗口打不中。可靠做法：预先在输入框打好第二条消息保持聚焦，`tail -n0 -f mon.log | grep --line-buffered -m1 'AGENT_STREAM_END len=0' && osascript -e 'tell app "System Events" to key code 36'`——Enter 即发送（输入框聚焦时 Enter=发送已验证）。tee 写盘有 ~1.5s 缓冲延迟，若追求同秒命中可再压。
- **requestRunning 长尾**：DONE[result] 后 requests/N 重投影通道还会拖 ~35-55s 才收 `AGENT_STREAM_END len=0` 骨架；此窗口内发送会走已排队路径（泡+提示可见），骨架 END 或 10s watchdog 到来时排空送达。判别吞包 vs 排队：泡/hint 是否出现 + 计数 wire 上 `<<< USER_MESSAGE` 与实际点击数。
- **变体重投影残留泡特征**：variant AGENT_MESSAGE（同 ut、内容被剥壳）+35s 左右到；修后原卡片格式保住，但被剥掉真实内容（如文件名整条被吃）时归一化判等失败 → 额外渲染一条无 Copilot 标签的 orphan 泡（agent-continued）。wire 上两条广播 ut 相同是识别特征。
- **伪装弹窗/权限**：osascript 弹"允许控制"会阻塞脚本——screenshot 先确认无弹窗再跑长命令；窗口管理用 osascript visible/activate（macOS，勿用 wmctrl）。
- browser_console 工具在此环境拒连（报 Chrome not foreground）；DOM 取证改用截图 zoom + 代码比对。

## R14 取证心得补充（651328b 复验轮）
- **静默丢答识别特征（新 P1 类缺陷）**：wire 上该轮只见 `AGENT_STREAM_END len=0 id=sessiondb/<file>/<row>` + `requests/N` END len=0 + DONE[result]，无 AGENT_MESSAGE、无 SET/CHUNK——sessiondb 行明明有答案却没广播。PWA 表现 = 光秃 user 泡或「该轮无回复」占位。恢复途径只有切会话回放（回放条目本身可能是 transcript 剥壳变体，如文件名 inlineReference 掉光）。本轮 2/7 轮全丢 + 1 轮 +28s 迟到（迟到件搭 requests/N 重投影通道到）。
- **变体来源实锤**：chatSessions jsonl `response[]` 里文件名是 `inlineReference` 节点（`Created ` + ref + ` - **done**`），剥壳序列化即得 "Created  - **done**" 双空格变体；sessiondb turns 表存的是完整文本。两源不一致=所有"变体重投影"类 bug 的总根因。
- **排队泡 dequeue 重挂**：连发泡 flush 时可能 re-append 到底部——若其上方刚生成了空占位卡，DOM 顺序会变成 占位→user泡（看着像占位串位）。判归属别看位置，看它夹在哪两条 turn 边界之间。
- 触发变体的可靠配方：让回答引用**已存在**的工作区文件（echo 复读「Found `file.txt` - **ok**」最稳；纯 create+reply 不稳）。

## R15 取证心得补充（cda409c+8d87f01 复验轮）
- **两枚修复都在服务端**（transcriptWatcher.ts pendingGap/asked-unanswered 豁免 + jsonl.ts inlineReference→`文件名`）——**必须 Reload Window**，仅硬刷 PWA 不够（app.js 本轮 hash 未变 691f9714）。
- **丢答恢复的 wire 签名**：sessiondb END len=0 后 ~40-50s 出现 `AGENT_STREAM_SET`（id=requests/N/response#text#0）= 重投影通道投递正文（走 SET 而非 AGENT_MESSAGE）——判修好的标志就是 SET 到、文本含 `文件名`，而不是"什么也不来"。
- sessiondb END len=0 本身仍在（快通道竞态没根治），差别只在后续重投影是否补投——复验时别把 len=0 单独当失败证据，要看整轮是否有 SET/AGENT_MESSAGE 收尾。

## R18 取证心得补充（马拉松复跑，installed dist==repo dist@6f0a194）
- **连接回放是单播**：monitor 只见 select/follow 触发的广播回放；PWA 硬刷后的 feed 重建来自单播回放（wire 不可见）——判"冷连回放有没有发"别盯 monitor，开一次性探针 client（PHONE_CONNECT→PHONE_SESSION_SELECT→dump e.messages）自测，回放数+内容一把梭。
- **monitor 打点对齐**：`echo "#### <tag> $(date +%T)" >> ~/mon_m18.log` 在 tee 同一文件里写发送时刻，wire 行自带墙钟，事后逐轮算延迟零误差。
- **会话行↔文件映射**：drawer 不显示 file id，用探针 `PHONE_SESSION_LIST` 拉 file/title/requestCount/mtime 对照后再点行，别凭标题猜。
- **点选→桌面切换延迟 ~20-24s**（soft-unverified inject 路径）：点选后 ~20-23s 会冒**反向 SESSION_FOLLOW**（watcher 抓到切换前 newest=桌面旧会话）把 feed 拽走——正好是 EXPLICIT_SELECT_GUARD_MS=20s 窗沿外。判「切会话中发送」归属看三点：wire 上 SESSION_SELECTED+REPLAY 对 = follow 签名（select 只广播 REPLAY）；sessiondb turns 行 session_id 是落盘归属铁证；jsonl grep 防漏。
- **静默丢答新场景**：切会话竞态里在途轮的 live 帧可整段缺席（无 AGENT_MESSAGE/STREAM/DONE/sessiondb 行），答案只经下一次回放的 db 回填到达——对照 sessiondb timestamp（答案生成时刻）与 wire（零帧）可实锤「生成但没广播」。
- **VS Code 1.139 Chat "Sessions" 视图**：行点击/悬停图标/"Open as Editor"都不保证真的切换活动会话（实测零 SESSION_FOLLOW）；可靠触发桌面会话变更=在桌面 composer 真发一条消息（新会话落盘即 newest→跟随）。桌面发送前把文字打在 PWA 输入框里，跟随落地后可直接 Enter 复用。
- **sessiondb 行即铁证**：`turns` 表 (session_id,turn_index,user_message,assistant_response,timestamp) 三列对账——归属、答案、生成时刻一次看清；`id=sessiondb/<file>/<row>` 的 STREAM_END 行还给出 db 行号。
- 桌面"Update"徽标 staged 时勿 Reload/Update VS Code（桥会死）；本次全程无碍。

## R19 取证心得补充（a27de87 复验轮：全局 sessiondb 轮询 + _sess 过滤）
- **`_sess` 错标签名**：live AGENT_MESSAGE 的 `sess=` 与 sessiondb 行 session_id 不一致时，以 **sessiondb 行为准**——本次见到答案 `sess=83b72c09` 但行/jsonl 都证明轮跑在 9c6e9dd0：是 transcript/arbiter 通道按 boundSessionBase 打标，而点选后 rebind 要等 inject 驱动桌面切换落地（本次 ~52s，被在途轮排队拖慢）。客户端 _sess 过滤会**正确丢弃错标事件**→feed 卡 typing ~19s 直至下一次回放回填。取证：wire 错标 + sqlite `turns` 行 session_id + chatSessions jsonl grep 三方对账。
- **点选≠立即换绑**：PHONE_SESSION_SELECT 只立刻广播 replay；watcher 换绑要等桌面切换完成（含被在途轮排队的情形）——期间 transcript 通道事件全按旧会话打 _sess。判「跟随还是点选」依旧看 wire 有没有 `SESSION_SELECTED`（select 只播 REPLAY；follow 播 SESSION_SELECTED+REPLAY 对）。
- **全局轮询后 wire 噪音预期**：monitor 会见到 `sess=` 非当前会话的 U/A 帧——是设计行为（客户端 app.js:2040 过滤）；断言在 feed（渲染层）不在 wire（广播层）。
- **vsce 打包会 bundle app.js**：vsix 内 `media/pwa/app.js` 是 IIFE 打包产物（md5 ≠ 仓库源文件）；比对装好的包时解 vsix 内部件比，别拿源文件 hash 对。dist/*.js 的「装包 vs 仓库」diff 若只含 HTML 模板串换行差异属无害。
- **`Reload Window` 只重载窗口**：徽标上的 VS Code update 不会被它应用；重载后桥新 pid（channel.json 更新），monitor 需重连。
- 判上游倍字（如 "b19 okb19 ok"）：直接查 sessiondb `assistant_response`——本桥只读该表，库里是倍字即上游写的，wire 忠实投递不算 bug。

## R20 取证心得补充（2072b63 复验轮：_sess 权威标签 + 幻影答案）
- **幻影重投影签名**：`AGENT_STREAM_START id=t1m...` + `AGENT_STREAM_SET "旧答案"` + `<<< AGENT_MESSAGE "旧答案" ut="新开轮的 ut"` ——transcript 变体重投影把**上一轮**的答案盖在新开轮的 `_ut` 上（本轮 "s2 ok" 幻影进 M20E）。识别：同 ut 出现 2 条 AGENT_MESSAGE 且第一条是上一轮答案文本、+1.8s 就到（作文不可能 2s 答完）；sessiondb 行只有真答案 → 幻影是 live-only，回放自愈。dup-per-ut 普查里 ut×2 即此签名。
- **判幻影 vs 真答**：幻影答案 == 上一轮的 answer text 逐字相同；真答在时间窗内是慢的（作文 ~8-20s）。
- **2072b63 后 `_sess` 可信**：emit() 只在无 `_sess` 时补 boundSessionBase——sessiondb 行 `r.session_id` 不再被盖；见到 `sess=X` 基本可信（仍用 sessiondb 对账兜底）。
- **drawer 列表按近度重排**：会话行顺序随最近活动变，每次开抽屉先截图再点行，别背坐标。
- **作文流 ~20s**：「在途轮排队切换」窗口稍纵即逝——要点选的动作备好再发文，或发更长文（≥250 词）保证切换落在在途窗内。
- **select 的 replay 也会被在途轮排队**：本轮 4b0f0160 select 的 REPLAY 晚了 ~13s（正常 ~2s）——select 点击到 replay 间隔大不等于没选上，看 wire。

## R21 取证心得补充
- BUG-4（幻影重投影盖新轮 ut）**不可稳定复现**：变体重投影是 sporadic 上游事件，本轮 3 个触发窗（纯文本答案 ~89s、单引号文件引用 ~115s、标准 backtick+bold 文件引用 ~95s）全部零重投影——连「同文 re-emission 带旧 ut」都没出现，无法动态验证 owner-ut 重指派生效。结论只能写「未复现 + 无幻影」而不是「已修复」。若后续要验证，需要在变体确实发射的轮次上碰运气；统计上每轮能等 ~90s 窗都算一次尝试。
- 全量判据有用：`grep "<<< AGENT_MESSAGE" mon.log | grep -v "sess="` —— 裸（无 sess）AGENT_MESSAGE 即 transcript 投影通道事件，幻影特征。本轮全量=0 行，说明 transcript 投影管线整体静默，所有答案全走 sessiondb 快通道（_sess=行.session_id）。
- 跟随机制澄清（回应 R20 遗留问题）：SESSION_FOLLOW 对**有内容**会话正常——点选 4b0f0160 后 +8s 同向 SESSION_SELECTED（inject 驱动桌面切换落地），桌面作曲框发 M21D → +10s SESSION_SELECTED→34adae78 + REPLAY n=6 + 19s 直播答案。R20 的 SESSION_SELECTED=0 是 pending-content 设计（新会话无内容不跟随），非回归。
- 桌面作曲框坐标：右侧 Chat 面板的输入框在 "Describe what to..." 占位符行，y≈300（不是 335——335 会点到附件胶囊/图标行或 Outline 折叠钮）。直接点击后 `type` 文本比跨 app Cmd+V 可靠。
- 同文重问判定仍过：M21DUP ×2 得两条 dup21 ok（sessiondb 行 494/495），新 emittedA2 owner-check 未误伤同 ut 重问。排队 ~13s 才 flush 因为首轮 result-DONE 未到（queue 行为正常）。
- 撞名 grep 陷阱：`grep -l "M21D"` 会误中 "M21DUP"——jsonl 归因验证要用全 token 正则 `M21D[A-Z]*` 并统计实际 token，不能靠子串 grep -l。

## R22 取证心得补充
- **BUG-2 残余场景确认**：在途轮中点选 + 被弃会话的在途轮仍产生活动 → boundHot(~24s) 过期后 follow 以「最新活动」重校验放行 → 手机被拽回旧会话（本轮 +57s SESSION_SELECTED→旧会话）。处决条件：essay 流式跨越守卫窗 + 点选 inject soft_unverified（桌面面板停在 Sessions 列表视图时 inject 无法驱动）。用户症状=R18 BUG-2，语义上属 newest-activity 设计与显式点选冲突——报告为决策项而非硬 bug。
- **中途停止的 wire 形态**：双点击 停止（先武装再确认）在途轮中产生 `AGENT_STREAM_START/SET(过渡文)+TOOL_CALL+STREAM_END len=0+COPILOT_DONE` 同刻批次，然后 30s+ 静默；**无 phone_stop 标记帧**（monitor 不显示该类型或本构建不带 reason 标签）。行为判据=轮冻结+无续帧+composer 恢复。
- **被弃会话的在途轮**：preamble 经 sessiondb 快通道直播（sess=旧会话正确），但流式正文不上 wire——watcher 只盯 bound 文件的 transcript；正文最终经下一次回放整段回填（sessiondb 行存全文 len=1311）。判读要点：sessiondb 行长度证明轮已写完，feed 空缺只是直播盲区非丢答。
- 第二次 DUP 同文重发答案走了 **transcript 通道**（t7m id）而非 sessiondb——两条投递通道都活。hadOwnUt 门端到端验证：同文 ×2 → 两条答案（sessiondb 行 509/510）。
- 工具轮 create-file 若文件已存在，模型先 read_file 再覆盖——TOOL_CALL 事件照走但用户提示「create」结果是「replace」；sessiondb 存最终答复。
- 三击「再次点击停止」武装提示每条 arm 留一条残影（R18 已记，本构建仍在）。

## R23 取证心得补充（第十二轮马拉松，HEAD 00736c0 含 endedStreams+stale-ts+排队泡）
- **装包与激活**：`code --install-extension <vsix> --force` 后必须 Reload Window——channel.json `pid` 变化即激活证据（本轮 1201→2092）。装目录 dist/media 与 vsix zip 内文件 md5 逐一对哈希即可判是否最新构建。
- **抽屉行坐标**：会话行 pitch≈32px、首行 title y≈175（不是 229——229 落在次行 氪/硒 边界会误选上一行）。点错行的信号=回放 file/title 与目标不符，**先看 wire file= 再判定**，别按行名猜。
- **打字落空风险**：composer 未聚焦时 `type` 的按键会喂给文档层——本轮疑触发会话行 typeahead/激活，造成同会话重选+REPLAY n=9 且 feed 清空后 ~75s 不重渲（ANOM-1 空 feed，手动重选恢复；input 文本被清）。自动化每发前先截图确认 focus ring 再 type。
- **停止轮迟答**：DONE[phone_stop] 后被停轮的真实答案 +30s 经 requests/N jsonl 重投通道整段补到（sessiondb 该行 assistant_response 为空——两源对停止轮分叉）。feed 出现「答案正文+该轮无回复占位」**自相矛盾对**（ANOM-2）；归属 _ut 仍是本论（stale-ts 没盖错）、单渲无双渲。判读：矛盾点在占位未撤，非重投影本身。
- **排队泡口径（e780955 复验通过）**：requestRunning 时带文点发送→泡即渲（opacity.6+italic .queued）+「已排队」hint；turn 尾 DONE→U2 广播 Δ≈3.0s；同一 DOM 元素去 .queued 不画第二泡；feed 序 U1A1U2A2。终判据=泡出现时刻+Δ(U2,DONE1)+单泡。
- **桌面发信→手机不拽**：显式点选后桌面在他会话实发一轮，wire 广播其 USER/AGENT（sess=他会话）但手机 feed 不跟随也不渲（>106s 零 SESSION_FOLLOW）——userActivity 门按码应放行（activity>select 时刻），实际未发=要么上游压制要么「显式绑定粘性」设计。报告为语义确认项，非铁证 bug。
- **停止点击窗**：flash 系模型 ~10-13s 整文单泡到——截图+点击链路 ~4-6s 吃窗，双击停要「发送→等~3s→点→点（<1.5s）」无截图连击才打得中（本轮前两次失败均因确认点落在 DONE 后/rr 释放后空文 no-op）。已停轮 arm hint 残影永久留 feed（sys 消息不撤）。
- **requests/N 骨架**:len=0 END 随每轮 +15~45s 尾随，属正常收尾骨架；endedStreams 修复后未见同 sid 的 SET/START 迟帧复投。

## R24 取证心得补充（第十三轮，5567505 同会话跟随跳过+孤儿占位双向扫）
- **孤儿占位有两种元素**：live DONE 路径画的是 `data-orphan-ph` 标记元素（rescindOrphanPlaceholders 的扫描对象）；**回放渲染的孤儿占位是普通 .msg.agent 无标记**（带复制键的斜体文案）——DOM 取证查占位必须按 data-orphan-ph 区分，querySelector('.msg.agent') 会把两者混为一谈。
- **回放孤儿判定需后随 user 轮**：文件尾部的孤儿 request 不画占位（视作在途豁免）；要造占位须在其后再跟一条 request 把它界住。
- **jsonl 尾注入的 wire 规律**：新 requestId 行 → 只播 USER_MESSAGE（即便带完整 response 也不播 AGENT——迟答广播只发给桥**亲自派发过**的 requestId）；同 requestId 再追加同容/异容行 → 第二次起全量静默（已见过）；薄克隆（缺 result/responseId）会重复播 USER。结论：**「停止轮迟答」无法用文件注入伪造**，只能靠真停止轮碰运气。
- **快停可造真迟答**：发送后 ~1-1.5s 内完成 arm+confirm 双连击 → phone_stop 打在生成完成前 → 真答案 +10.6s 经迟投通道 AGENT_MESSAGE 到达（本轮 R24X 首次稳定复现 R23 M23S3 机制；此前 ~5s/8.5s 两档均只得到答案先到）。真迟答到达时 live 占位要么没画（延迟复核窗口内答案先到）要么画在**其它孤儿轮**上（本轮落在先前注入的孤儿泡下——bareDone 归属取「最末无答用户泡」，hint/sys 行不计答案会扰归属）。
- **占位撤销 in-vivo 验证配方**：DOM 注入假答案兄节点（`.msg.agent>.body[data-raw≠'']`）插到真 `data-orphan-ph` 元素**上方**，再发一条真消息——其 addAgentFinal 触发全 feed 扫描→占位被撤（双向扫的反向半支即此验证）。
- **jsonl 整文件重写副作用**：truncate+write 会让 watcher 从 tail offset 重读——把偏移附近的真行再播一遍（本轮 R24X USER 回声）；客户端 dedupe 吸收，但监控会记一条"幽灵"USER。
- **drawer 排序随活动重排**：任何文件/会话活动后行序即变（本轮 M23A 从第2行升第1行）——开抽屉必须先截图再点，背坐标必误点。
- **browser_console 前景检测失灵**：Chrome 窗已在最前仍报 "not in the foreground"——改用 Cmd+Alt+J DevTools 控制台 + GUI 键入执行 JS（录屏也更透明）。
- **草稿存活性**：composer 未发送草稿经受**跨会话**跟随回放+同会话重选回放均未丢——R23「草稿被清」疑似绑定在 ANOM-1 的空 feed 路径，本轮无自发回放无法复验该特定清空路径。

## R26 取证心得补充（深层检查轮，vsix 8f1ab3f endedStreams）
- **发送打点别再 `echo >> mon.log`**：tee 用自有文件偏移写盘（非 O_APPEND），后续写入会覆盖你追加的 `####` 行——marker 写独立文件 `~/mon_rXX.marks`，靠 wire 行自带墙钟对齐。
- **macOS Sonoma+「点击桌面壁纸显示桌面」**：computer click 落到 wallpaper 会瞬间隐藏全部窗口，且 type 会落到 Finder（type-select，无害但废动作）。恢复=Dock 图标点回各 app。窗口并排布局用 `osascript -e 'tell process "Google Chrome" to set position of window 1 to {0,25}' -e '…set size of window 1 to {755,743}'`（勿全屏——会盖住监控终端；PWA 是窄移动 UI，左 75% 足够）。
- **确定性断线 flap**：`kill -STOP <ext host pid>`（channel.json 的 pid）冻结服务端 ≥ SOCKET_STALE_MS(30s) → PWA linkWatchdog 判半死 → `forceReconnect` 升级请求挂起 → `kill -CONT` 后握手完成自动恢复（wire 出现广播 REPLAY=reannounce 证据）。比 DevTools Offline 可靠（Offline 不杀已建 WS）。
- **模型真生效判据**：chatSessions jsonl 每个 request 存 `modelId`(选中 id) 与 `result.resolvedModel`——grep 最新 request 即铁证，无需靠答风猜。
- **queue-escape 判据公式**：排队 U2 的 wire USER 时刻 tU2 与前轮答案 tA1——tU2<tA1 即逃逸（本例 interim TOOL_CALL DONE 提前释放队列；上游 Copilot 串行化兜底所以答案仍对，但机制已破）。
- **TOOL 双投核查**：wire `TOOL_CALL` 同 ts ×N 配对 jsonl `response[]` 里 `kind==toolInvocationSerialized` 计数——1 实调 N 广播=双投；DOM 表现为同调用双 step-group（一张卡常滞留「正在运行」）。
- **endedStreams 盲区**：8f1ab3f 只挡「其 streamId 已 END 后到达」的帧——无 START 记录的孤儿 `AGENT_STREAM_CHUNK`（jsonl 投影通道 `requests/N/response#text#K`）仍能进来，~55s 迟帧可复活一张 .streaming 幽灵卡；DOM 取证 `#feed .streaming` 计数。
- **DOM 取证通道**：read_dom/browser_console 会误报「Chrome not foreground」——DevTools Cmd+Alt+J 控制台跑 JS dump `#feed > *` 的 className+text 前缀最稳（自证 .streaming/queued/data-orphan-ph/移位块）。
- **模型切换副作用**：model select 触发会话 jsonl rewrite → watcher tail 重读把最近 USER 当 foreign 重播 → feed 冒同会话内容的「【其他会话】」sys 行（P2 误标，非泄漏）。
- **模型轮 result-DONE 可缺席**：本轮 deepseek-v4.1-flash 轮答案 DONE 后 >70s 无 [result] DONE，rr 由 ~75s STREAM_STALE 看门狗释放——该窗口内排队消息会滞留 ~75s，判「队列卡死」前先等看门狗。
- **停止轮自查表**：sessiondb 该 turn 行 assistant_response 为空 + jsonl modelState value=2 = 真停；feed 回放应渲「(该轮无回复—已停止或请求失败)」占位。live 区的假阳性靠「答案+占位共存>5s」判。
