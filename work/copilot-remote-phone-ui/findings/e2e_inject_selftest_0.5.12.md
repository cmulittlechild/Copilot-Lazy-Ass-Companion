# E2E 自测：companion-open 0.5.12 会话注入是否修好

**时间：** 2026-08-07 ~05:32–05:36（本机）  
**方法：** WebSocket 直连真实 Extension Host bridge，模拟 PWA `PHONE_SESSION_SELECT` + `PHONE_MESSAGE{file}`，再扫 chatSessions/transcripts 落盘。  
**结论：未修好。会话定向注入 FAIL。**

---

## 环境

| 项 | 值 |
|----|-----|
| extensions.json 激活 | **0.5.12** |
| 多 bridge | 3010=omniprox, **3011=Desktop**, 3012=隧道/异常 |
| 测端口 | **3011**（唯一能列出 DeepSeek `8304329e` + 项目学习 `42c7881d` 的窗口） |
| Desktop 焦点会话 | `f33c74b8`（ArenaHero / 9928cc…） |
| DeepSeek 文件 | `…/6ea7fd91…/chatSessions/8304329e-….jsonl`（跨 storage，但在 3011 SESSION_LIST 可见） |

---

## 用例 A — 手机选 DeepSeek 发消息（复现用户场景）

- token: `lazy-e2e-1786073558393-ds`
- 步骤: `PHONE_SESSION_SELECT(DeepSeek file ok=true)` → `PHONE_MESSAGE{text:token, mode:ask, file:DeepSeek}`
- **DeepSeek jsonl：无 token，mtime 仍停在 08-06 23:53**
- **实际落点：**
  - `9928cc…/chatSessions/f33c74b8-….jsonl`（Desktop **焦点**会话）
  - 同 id transcript
- **VERDICT: FAIL** — 选中 DeepSeek，消息进焦点会话

---

## 用例 B — 对照：注入「当前焦点」会话

- token: `lazy-samews-1786073677373-control-current`
- target = current = `f33c74b8`
- ~10s 内目标 jsonl 出现 token
- **VERDICT: PASS** — 说明 bridge→`chat.open({query})` 链路本身可用，只是**不会换会话**

---

## 用例 C — 同窗口换另一个会话（`67e32c2a` glm 测试）

- token: `lazy-samews-1786073691021-target-other`
- `PHONE_SESSION_SELECT(67e32c2a)` + `PHONE_MESSAGE{file:67e32c2a}`
- **目标 `67e32c2a`：始终无 token**（chatSessions + transcript 未动）
- **最终在焦点 `f33c74b8` 出现 token**
- **VERDICT: FAIL** — 同工作区非焦点会话也绑不住

---

## 根因（运行时，不是“没装上”）

1. **0.5.12 已在跑**（channel 曾报 `extensionVersion: 0.5.12`；激活元数据亦为 0.5.12）。  
2. 代码路径 `vscode.open(uri) → openInSidebar → chat.open({query})` **未能**让 `lastFocusedWidget` 变成目标会话。  
3. `chat.open` 仍打 **焦点 widget** → 与 0.5.10 用户可见症状相同（只是不再靠假 `sessionResource` 日志）。  
4. 可能机制（与 workbench `Mqn` 一致）：
   - `vscode.open(跨 storage / 非本窗 session)` 未成为 active ChatEditor，或  
   - `openInSidebar` 在 editor 未就绪时只 `openView` 不 `loadSession`，或  
   - 提交时 lastFocused 仍是旧侧边栏 widget。  
5. **多窗口 P0 仍在**：手机若连错 port，会在错误 Host 上注入；本次即使连对 3011 仍串台。

---

## 总判定

| 问题 | 结果 |
|------|------|
| 0.5.12 安装/激活 | 是 |
| focused 注入 | 可用 |
| 非焦点 / 指定 session 注入 | **不可用（实锤 FAIL）** |
| 能否对用户说「串台已修好」 | **不能** |

**一句话：改了安装与代码意图，运行时会话绑定仍失败；bug 还在。**
