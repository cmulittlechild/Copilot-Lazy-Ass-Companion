# Finding: copilot-remote 0.4.1 手机浏览器显示链路

- case: copilot-remote-phone-ui
- target: local VSIX `atulhritik.copilot-remote-0.4.1`
- auth: granted / offline_local_only
- confidence: high（静态还原 + 既有 analysis/pseudo 交叉验证）

## 一句话结论

手机端不是简单 HTML 模板，而是 **React + Tailwind PWA**：
WebSocket 事件 → 内存 `messages[]` 状态机 → 按 `role` 分发到不同气泡组件；
助手正文走 **react-markdown（remark-gfm）**，工具调用是 **可折叠 `<details>`**，不是 Copilot 桌面那种“已完成 N 个步骤”总折叠条。

## 架构

```text
VS Code extension (dist/extension.js)
  CopilotHook / BaseJsonlHook
    chatSessions/*.jsonl
      processChatEntry / applyResponseMutation / renderBlocks
        → WsServer.sendToPhone(event)
          HTTP static: dist/pwa/*
          WS events to phone

Phone browser PWA (dist/pwa)
  index.html → assets/index-*.js (React app)
    hy() hook: messages + handleWsMessage(switch type)
    uS(msg): switch role → aS/sS/fS/pS/hS/dS
    gS(): composer Agent/Ask/Edit + send PHONE_MESSAGE
```

## 扩展侧：决定“发什么给手机”

`renderBlocks(parts)`（extension bundle）把 JSONL response parts 投影为块：

| JSONL part kind | 手机事件 |
|---|---|
| plain `{value: string}` | text → `AGENT_STREAM_*` / 最终 `AGENT_MESSAGE` |
| `toolInvocation` / `toolInvocationSerialized` | `TOOL_CALL`（text/toolId/input/isComplete） |
| `confirmation` | `AGENT_CONFIRM` |
| ignored set | **不发** |

忽略集合（手机永远看不到这些 chrome）：
`thinking`, `progressTaskSerialized`, `progressMessage`, `mcpServersStarting`, `undoStop`, `prepareToolInvocation`

含义：
- 桌面 Copilot 的 thinking / progressTask「步骤条」**被故意丢掉**
- 手机只看得到：**用户话、流式正文、工具卡片、确认框、系统条**

流式协议（与 companion 同源）：
`AGENT_STREAM_START|SET|CHUNK|END` + `COPILOT_TYPING` + `COPILOT_DONE`
finalize debounce ~450ms。

## 手机侧：状态机（handleWsMessage）

伪代码还原自 `dist/pwa/assets/index-uGnOBk9B.js`：

```js
// hy() → { messages, handleWsMessage }
switch (e.type) {
  case 'COPILOT_TYPING':
    // 追加 role=typing；180s 后自动清掉
  case 'COPILOT_DONE':
    // 去掉 typing
  case 'AGENT_STREAM_START/SET':
    // 按 streamId upsert role=agent, streaming=true
  case 'AGENT_STREAM_CHUNK':
    // 找到 streaming&&streamId 的 agent，text += delta
  case 'AGENT_STREAM_END':
    // streaming=false
  case 'AGENT_MESSAGE':
    // 若末条 agent 文本相同则跳过，否则 append agent
  case 'USER_MESSAGE':
    // append user
  case 'TOOL_CALL':
    // 按 toolId upsert tool（text/isComplete/input/result）
  case 'AGENT_CONFIRM':
    // append confirm + buttons
  case 'AGENT_CONFIRM_RESOLVED':
    // 同 toolId 的 confirm 去按钮，文案 "Resolved in VS Code ✓"
  case 'SYSTEM_MESSAGE':
    // append system pill
  case 'HISTORY_REPLAY':
    // messages[] 映射 role，按 timestamp merge 排序
}
```

辅助：
- `yt()` id 生成 `m1,m2...`
- `sn(list,msg)` 按 timestamp 有序插入
- `Li(list,pred)` 从后往前找 index
- `Sd(type)` / `my(ev)`：HISTORY_REPLAY 事件 → UI message

**没有** `PROGRESS_STEP` / `THINKING_STEP` 事件类型（PWA EVENTISH 列表已枚举）。

## 手机侧：显示组件（role → UI）

路由 `uS({msg,onConfirm})`：

| role | 组件 | 视觉 |
|---|---|---|
| user | `aS` | 右对齐蓝泡 `bg-blue-600`，纯文本 `whitespace-pre-wrap`（**不 markdown**） |
| agent | `sS` | 左对齐；绿点 + “Copilot” + streaming 时 “typing…”；正文 `cS` markdown；空文本显示 *thinking…*；streaming 时 `cursor-blink` |
| tool | `fS` | **`<details>` 折叠卡**：⚙ + 标题 + done/running badge；展开 Input JSON / Result |
| confirm | `pS` | indigo 卡片 + 按钮；cancel/no 灰色，其它主色；resolved 后灰卡 |
| system | `hS` | 居中小 pill |
| typing | `dS` | 三点 bounce 动画 “thinking…” |

### Markdown（agent only）`cS`
- `react-markdown` + `remark-gfm`（变量 `Kk` + `oS`）
- 自定义 components：p/h1-h3/code/pre/ul/ol/li/strong/em/blockquote/hr/a/table...
- fenced code：语言标签条 + `bg-slate-950` + emerald mono
- inline code：`bg-slate-700 text-emerald-300`

### 工具卡为什么像“可折叠步骤”
不是 N 步汇总，而是 **每个 TOOL_CALL 一张独立 details**。
running → amber pulse badge；done → emerald badge。

## Composer
`gS`：
- 模式 chips：Agent / Ask / Edit → `PHONE_MESSAGE.mode`
- 多 agent 时 Auto + list
- textarea + 圆形发送键
- 未连接 disabled

## PWA 壳
- `display: standalone`，dark slate-950
- JetBrains Mono 字体
- firebase-messaging-sw.js + sw.js（推送）
- viewport 禁缩放

## 与 companion-open 对照（可落地）

| 点 | Remote 0.4.1 | companion 现状 | 建议 |
|---|---|---|---|
| 技术栈 | React+TW+react-markdown | 原生 DOM + 轻量 md | 可继续原生，对齐视觉 class 即可 |
| thinking/progress | 扩展侧丢弃 | 我们曾投影 PROGRESS/THINKING | 若要“像官方插件”，可保留；若要“像 Remote”，应忽略 |
| 工具 UI | 每 tool 一张 `<details>` | 步骤组“已完成 N 个” | **对齐 Remote：独立可折叠 tool 卡 + done/running** |
| 用户泡 | 纯文本 | 纯文本 | 已接近 |
| 助手泡 | markdown + streaming cursor | markdown stream | 加 streaming 绿点/typing…/cursor-blink |
| typing | 独立 role + 180s 超时 | status 文案 | 可加三点泡 |
| confirm | indigo 卡 + PHONE_CONFIRM | 有 | 视觉可抄 |
| HISTORY | merge by role\|text + ts sort | clearFeed replace | Remote 更偏 merge |

## 证据路径
- PWA bundle: `atulhritik.copilot-remote-0.4.1/dist/pwa/assets/index-uGnOBk9B.js`
- 还原: `work/copilot-remote-phone-ui/pseudo/comp_*.js`, `pwa_ws_switch.pretty.js`
- 扩展 renderBlocks / ignore: `analysis/copilot-remote-0.4.1/pseudo/fn_renderBlocks.js`, `sections/ignored_kinds.js`
- 总报告: `analysis/copilot-remote-0.4.1/REPORT.md`
