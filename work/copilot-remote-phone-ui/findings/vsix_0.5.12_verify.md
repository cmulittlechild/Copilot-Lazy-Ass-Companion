# 0.5.12 VSIX 完整性核对表 + 安装状态 + 强制安装建议

> 验证时间：2026-08-07 · 机器：macOS（xin@xindeMacBook-Air）
> 验证方式：`unzip` 解压 `/Users/xin/Desktop/sidecar_remote/projects/companion-open/copilot-sidecar-companion-0.5.12.vsix` 到 `/tmp/vsix_verify_0512/`，grep/read 核对关键实现；对比 `~/.vscode/extensions/` 已装版本。
> 背景：VS Code 本地聊天会话注入串台 bug（手机选 DeepSeek 8304329e，桌面焦点「项目学习」42c7881d → hi 打进 42c7881d）。修复路径 = `vscode.open(vscode-chat-session://local/<base64url(sid)>)` → delay → `openInSidebar` → delay → `chat.open({query})`（不带 sessionResource）。

## 1. 0.5.12 VSIX 完整性核对表

### 1.1 package.json 版本

| 项 | 结果 | 证据 |
|---|---|---|
| version = 0.5.12 | **PASS** | `extension/package.json`: `name: copilot-sidecar-companion, publisher: local-dev, version: 0.5.12, engines: {'vscode': '^1.85.0'}` |
| vsix 时间 | PASS | `Aug 7 02:14:23 2026`, 725,590 字节（0.5.10 为 724,020，增量 ~1.5KB 合理） |

### 1.2 dist/inject.js 关键实现（15,940 字节）

| 检查项 | 结果 | 证据行 |
|---|---|---|
| a) `vscode.open(uri)` 第一步绑定会话 | **PASS** | L109 `await vscode.commands.executeCommand("vscode.open", uri)`（L125-127 备选 `workbench.action.chat.openSessionInEditorGroup`） |
| b) `workbench.action.chat.openInSidebar`（含无参调用） | **PASS** | L115 注释、L146 `await vscode.commands.executeCommand("workbench.action.chat.openInSidebar")`（无参，L151 有 catch 降级） |
| c) `chat.open({query...})` 提交且**不带** sessionResource | **PASS** | L228-232 `submitFocusedQuery`: `executeCommand("workbench.action.chat.open", { query: text, isPartialQuery: false })`——**无 sessionResource 字段**；L118 注释明确禁止「把 sessionResource 传给 chat.open（假成功）」；grep 全文件 sessionResource 仅出现在注释（L108/111/118/260） |
| d) defineSessionOpenPolicy / injectSessionOpen 配置 | **PASS（部分）** | 配置读取 L273: `getConfiguration("copilotSidecar").get("injectSessionOpen", "editor")`；package.json L116 定义 `copilotSidecar.injectSessionOpen -> ["editor", "focused-only"]`（default=editor）。**注意：代码中无名为 `defineSessionOpenPolicy` 的函数**（可能源码名或已改版），但「injectSessionOpen 配置 + 策略分支（preferBind / focused-only）」完整存在，功能等价 |
| e) `waitForInjectInSessionFile` 验证函数 | **PASS** | L167 定义（timeoutMs=2500, pollMs=120），L321/323 调用（2000ms/100ms），实现含 transcripts 优先 + chatSessions 降级、delta 追加检测 + 全量包含检测 |

**injectMessage 完整流程（L294-360）**：
- 有 sid + preferBind：`activateSessionForInject(sid)` → 失败则**剪贴板**（绝不 silent focused-fallback）→ `tryModeCommands(mode)`（mode 在绑定之后，避免切走 widget）→ `focusInput` → `submitFocusedQuery(text)` → `waitForInjectInSessionFile` soft verify（只记日志，不二次提交防双发）
- 返回结构含 `via: "chat.open" / "clipboard"`、`openVia: opened.via`、`verified`、`injectPath: "bind+chat.open" / "bind+chat.open+unverified" / "clipboard-bind-failed" / "clipboard-submit-failed"`
- `localChatSessionUri`: L94-101 `Buffer.from(sessionId).toString("base64url")` → `vscode-chat-session://local/<encoded>`，与 workbench `LocalChatSessionUri.forSession` 一致

### 1.3 dist/extension.js 关键逻辑（36,568 字节）

| 检查项 | 结果 | 证据行 |
|---|---|---|
| PHONE_MESSAGE 处理 | **PASS** | L118 `msg.type === "PHONE_MESSAGE"` → L123 `setActiveSessionFile(file)` → L125 `watcher?.selectSession(file)` |
| transcriptWatcher.bindFile/pinFile rebind | **PASS** | L141-142（PHONE_SESSION_SELECT 分支）`bindFile(tfile, {replay:false})` + `pinFile(tfile)`；L264-265（PHONE_MESSAGE 分支，0.5.11 注释）同样 rebind，`transcriptActive = bound`，不 bound 时降级 chatSessions 源 |
| inject 日志含 openVia/verified | **PASS** | L159: `inject via=${result.injectPath||result.via} sid=${...} activated=${!!result.sessionActivated} openVia=${result.openVia||"-"} verified=${result.verified===undefined?"-":result.verified}` |

### 1.4 media/pwa/sw.js 缓存名

| 检查项 | 结果 | 证据 |
|---|---|---|
| 缓存名 sidecar-pwa-v18（或更新） | **PASS（v19）** | `extension/media/pwa/sw.js` 唯一标记 `sidecar-pwa-v19`（比要求的 v18 更新，符合「变更后必须升 SW 版本」纪律） |

## 2. 当前安装状态结论

### 2.1 已安装版本（~/.vscode/extensions/）

| 目录 | version | 安装时间 | 状态 |
|---|---|---|---|
| `local-dev.copilot-sidecar-companion-0.5.10` | 0.5.10 | Aug 7 00:02:14 | **当前激活**（extensions.json 唯一 entry，source=vsix, pinned=true） |
| `local-dev.copilot-sidecar-companion-0.5.9` | 0.5.9 | Aug 6 23:38:44 | obsolete（`.obsolete` 标记 `-> true`） |
| `local-dev.copilot-sidecar-companion-0.5.8` | 0.5.8 | Aug 6 22:22:26 | obsolete（`.obsolete` 标记 `-> true`） |

### 2.2 vsix 产物 vs 安装状态

- vsix 目录有 `0.5.10`（Aug 7 00:02）与 `0.5.12`（Aug 7 02:14）——**0.5.11 不存在**（无 vsix、无目录、.obsolete 无记录；PHONE_MESSAGE rebind 注释「0.5.11」可能是开发中途版本号，最终打包为 0.5.12）
- **0.5.12 vsix 已存在但未安装** ✅ 关键结论确认：用户机器仍在跑 0.5.10

### 2.3 0.5.10（旧） vs 0.5.12（新）差异证据

```
0.5.10 inject.js (12,471 B): openInSidebar ×3, vscode.open ×3 — 无 waitForInjectInSessionFile / injectSessionOpen / openVia / verified
0.5.12 inject.js (15,940 B): 上述全部实现完整
0.5.10 extension.js: openVia 出现 0 次（无 inject 日志增强）
```

→ 0.5.10 是「sessionResource 假成功路径」或裸 openInSidebar 路径，0.5.12 是完整修复版，**必须强制安装 0.5.12**。

### 2.4 扩展元数据（extensions.json 唯一 entry，index 32）

```json
{
  "identifier": {"id": "local-dev.copilot-sidecar-companion"},
  "version": "0.5.10",
  "location": {"fsPath": ".../local-dev.copilot-sidecar-companion-0.5.10"},
  "metadata": {"pinned": true, "source": "vsix", "installedTimestamp": 1786053734162}
}
```

- **无 `latestVersion` 字段** —— 本地 vsix 安装不写 marketplace 元数据，auto-update 机制无法感知本地 vsix 更新，**这就是「打包了新版本但 VS Code 不更新」的根因形态**。`pinned: true` 进一步阻止任何自动更新。
- 因此更新只能靠**手动强制安装**。

### 2.5 channel / tunnel 现状（~/.copilot-sidecar-companion/）

```json
{
  "localUrl": "http://127.0.0.1:3012/?token=e630c09130823c91aff6981ce749190f",
  "publicUrl": "https://themes-offerings-quotations-lloyd.trycloudflare.com/?token=...",
  "port": 3012, "host": "127.0.0.1", "token": "e630c09130823c91aff6981ce749190f",
  "session": "8304329e-b101-4948-8099-5892a7f9fe93.jsonl",   // 上次选中会话
  "clients": 0, "running": true, "tunnelRunning": true,
  "updated": "2026-08-07T01:14:57.812Z"
}
```

- 端口 3012（默认），token 存在，tunnel 运行中（cloudflared 已下载，tunnel.url 指向 trycloudflare 域名）。**升级后端口/token 不变，手机端无需重配**（除非 3012 被占则自动 +1，channel.json 会更新）。

## 3. 建议的强制安装命令

> 前提：VS Code 需**完全退出**（含所有窗口）后再装，否则扩展宿主占用 dist 文件。装完重启验证。

### 3.1 方案 A（推荐）：卸载旧版 → 安装 0.5.12

```bash
# 0) 完全退出 VS Code（Cmd+Q 所有窗口）
osascript -e 'quit app "Visual Studio Code"' 2>/dev/null; sleep 2

# 1) 删除旧版本目录（0.5.8/0.5.9 已被 .obsolete 标记，一并清掉）
rm -rf ~/.vscode/extensions/local-dev.copilot-sidecar-companion-0.5.8 \
       ~/.vscode/extensions/local-dev.copilot-sidecar-companion-0.5.9 \
       ~/.vscode/extensions/local-dev.copilot-sidecar-companion-0.5.10

# 2) 清理 extensions.json 中的旧记录（安全起见备份）
cp ~/.vscode/extensions/extensions.json ~/.vscode/extensions/extensions.json.bak

# 3) 用 CLI 强制安装 0.5.12（vsix 是本地安装，auto-update 不会管它；--force 覆盖同名）
code --install-extension \
  /Users/xin/Desktop/sidecar_remote/projects/companion-open/copilot-sidecar-companion-0.5.12.vsix \
  --force

# 4) 验证安装
code --list-extensions | grep companion        # 应输出 local-dev.copilot-sidecar-companion
python3 -c "import json; d=json.load(open('$HOME/.vscode/extensions/extensions.json')); e=[x for x in d if 'companion' in x['identifier']['id']][0]; print('激活版本:', e['version'])"

# 5) 重启 VS Code，观察 QR 面板日志应出现：inject via=bind+chat.open sid=... activated=true openVia=vscode.open>openInSidebar>focusInput verified=true
```

### 3.2 方案 B：不删目录，直接 --force 覆盖安装

```bash
code --install-extension .../copilot-sidecar-companion-0.5.12.vsix --force
# 旧 0.5.10 目录会被标记 obsolete，VS Code 自动选用新版本
```

（方案 B 更保守，但可能残留旧目录；方案 A 更干净。）

### 3.3 如果 code CLI 不可用（本机 `code --version` 无输出）

在 VS Code 内：`Cmd+Shift+P` → `Extensions: Install from VSIX...` → 选择
`/Users/xin/Desktop/sidecar_remote/projects/companion-open/copilot-sidecar-companion-0.5.12.vsix`。
装完重启，同样有效（会提示覆盖现有版本）。

### 3.4 升级后验证要点

1. 手机端会话选中 DeepSeek (8304329e) → 桌面 QR 日志应出现 `openVia=vscode.open>openInSidebar>focusInput`
2. 确认桌面 Chat 侧边栏实际切到 8304329e，且消息注入该会话（不再串到「项目学习」42c7881d）
3. `waitForInjectInSessionFile` 日志字段 `verified=true`（transcripts 命中）或 `verified=false`（chatSessions 60s flush 未到——属正常，非失败）
4. 若出现 `injectPath=clipboard-bind-failed` 或 `clipboard-submit-failed` → 检查 `copilotSidecar.injectSessionOpen` 配置（默认 editor）与 VS Code 版本 ≥ 1.131 铁律环境
5. 手机端无需重连：端口 3012、token 不变

## 附：临时解压目录

`/tmp/vsix_verify_0512/`（extension/ 为解压产物，可直接 diff 检查，用完可删）
