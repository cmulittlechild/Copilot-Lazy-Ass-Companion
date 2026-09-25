import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { BridgeServer } from "./bridge";
import { SessionWatcher, sessionDiscoveryFromExtension } from "./sessionWatcher";
import { SessionIndexReader, deriveVscdbPath } from "./sessionIndex";
import { TranscriptWatcher, findTranscriptsDir, findChatSessionsDir } from "./transcriptWatcher";
import {
  injectMessage,
  handleConfirmation,
  cancelChatRequest,
  isInjectedEcho,
  setActiveSessionFile,
} from "./inject";
import { TunnelManager } from "./tunnel";
import { QrPanelProvider } from "./qrPanel";
import { PushManager } from "./push";
import { TerminalManager } from "./terminal";
import { InstanceDiscovery, makeInstanceId } from "./instances";
import { ChatControl, type PermissionLevel } from "./chatControl";
import { WorkspaceIndex } from "./workspaceIndex";

let bridge: BridgeServer | undefined;
let watcher: SessionWatcher | undefined;
let transcriptWatcher: TranscriptWatcher | undefined;

/** 正文规范化（dedupe 用）：剥 markdown 强调+压空白+截断，与 transcriptWatcher.agentTextKey 同形 */
function replayTextKey(text: string): string {
  return String(text || "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * 把 sessiondb turns 里 chatSessions 尚未写盘的回答合回回放：
 * - 已在 hist 里的回答（按规范化文本键）跳过
 * - 缺失的回答插到其 user_message 对应的 USER_MESSAGE 之后；
 *   找不到对应用户文（sessiondb-only）则 USER+AGENT 一对追加到尾部
 */
function buildReplayWithDbBackfill(
  hist: Array<Record<string, unknown> | null | undefined>,
  dbTurns:
    | Array<{ id: number; user_message: string | null; assistant_response: string | null }>
    | undefined,
  sid: string | undefined,
): Array<Record<string, unknown>> {
  const out = hist.filter(Boolean) as Array<Record<string, unknown>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!dbTurns || !dbTurns.length || !sid) return out;
  const seen = new Set(
    out
      .filter((e) => e?.type === "AGENT_MESSAGE")
      .map((e) => replayTextKey(String((e as { text?: string }).text || ""))),
  );
  const tail: Array<Record<string, unknown>> = [];
  for (const r of dbTurns) {
    const ans = String(r.assistant_response || "").trim();
    if (!ans) continue;
    if (seen.has(replayTextKey(ans))) continue;
    const ev: Record<string, unknown> = {
      type: "AGENT_MESSAGE",
      text: ans,
      streamId: `sessiondb/${sid}/${r.id}`,
      requestIndex: -1,
      timestamp: Date.now(),
      _ut: r.user_message || undefined,
    };
    // 找该回答所属的用户消息位置：最后一个与该 user_message 同文的 USER_MESSAGE
    const uKey = replayTextKey(String(r.user_message || ""));
    let inserted = false;
    if (uKey) {
      for (let i = out.length - 1; i >= 0; i--) {
        const e = out[i];
        if (
          e?.type === "USER_MESSAGE" &&
          replayTextKey(String((e as { text?: string }).text || "")) === uKey
        ) {
          out.splice(i + 1, 0, ev);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) {
      if (uKey) {
        tail.push({
          type: "USER_MESSAGE",
          text: String(r.user_message || ""),
          timestamp: Date.now(),
        });
      }
      tail.push(ev);
    }
    seen.add(replayTextKey(ans));
  }
  return out.concat(tail);
}
function rebindTranscriptForSession(file: string) {
  if (!transcriptWatcher || !file) return;
  try {
    const base = path.basename(file);
    const rec = workspaceIndex?.resolveBySessionFile(file);
    const tdirForSession = rec?.transcriptsDir ?? transcriptDir();
    if (tdirForSession) {
      const tfile = path.join(tdirForSession, base);
      if (fs.existsSync(tfile)) {
        if (transcriptWatcher.currentFile === tfile) {
          transcriptWatcher.pinFile(tfile);
          transcriptActive = true;
          return;
        }
        transcriptWatcher.bindFile(tfile, { replay: false });
        transcriptWatcher.pinFile(tfile);
        transcriptActive = true;
        return;
      }
    }
    transcriptActive = false;
    qrPanel.addLog(
      `会话 ${base} 无 transcripts（${rec?.qualifiedName ?? "未知工作区"}）→ 降级 chatSessions 源`,
    );
  } catch {
    /* transcript rebind best-effort */
  }
}

let tunnel: TunnelManager | undefined;
let terminalMgr: TerminalManager | undefined;
let discovery: InstanceDiscovery | undefined;
/** 模型 / 审批级别控制（手机端选择器） */
let chatControl: ChatControl | undefined;
/** 工作区索引：让会话列表能显示「主机:文件夹」两级归属 */
let workspaceIndex: WorkspaceIndex | undefined;
/**
 * 当前选中会话是否由 transcripts 实时源供稿。
 * 为 false 时（如切到无 transcripts 的远程工作区）必须放行 chatSessions 投影，
 * 否则两个源都不出内容，手机端会一片空白。
 */
let transcriptActive = false;
let status: vscode.StatusBarItem;
let qrPanel: QrPanelProvider;
let push: PushManager | undefined;
/** In-memory session token when settings authToken empty but public tunnel needs auth. */
let sessionToken: string | undefined;
/** package.json version of this extension instance (not getExtension — avoids stale multi-version) */
let extensionVersion: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
  extensionVersion =
    (context.extension.packageJSON as { version?: string })?.version ||
    context.extension.packageJSON?.version ||
    undefined;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(phone) Lazy Ass: off";
  status.command = "copilotSidecar.showStatus";
  status.show();
  context.subscriptions.push(status);

  qrPanel = new QrPanelProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QrPanelProvider.viewType, qrPanel),
  );

  const pwaDir = path.join(context.extensionPath, "media", "pwa");
  if (!fs.existsSync(path.join(pwaDir, "index.html"))) {
    vscode.window.showErrorMessage(
      `Lazy Ass PWA assets missing at ${pwaDir}. Reinstall the VSIX and Reload Window.`,
    );
  }

  const start = async () => {
    if (bridge) return;
    const cfg = vscode.workspace.getConfiguration("copilotSidecar");
    const preferredPort = cfg.get<number>("port", 3010);
    const host = cfg.get<string>("host", "127.0.0.1");
    const settingsToken = (cfg.get<string>("authToken", "") || "").trim();
    const enableTunnel = cfg.get<boolean>("enableTunnel", false);
    const allowDownload = cfg.get<boolean>("downloadCloudflared", true);

    const token = settingsToken || sessionToken || undefined;
    if (settingsToken) sessionToken = undefined;

    bridge = new BridgeServer({
      host,
      port: preferredPort,
      portRange: 20,
      authToken: token,
      pwaDir,
      onClientCount: (n) => {
        qrPanel.setPhoneConnected(n > 0);
        if (bridge) {
          refreshStatus(bridge, !!(enableTunnel || tunnel?.running || tunnel));
          writeChannelArtifact();
        }
      },
    });

    push = new PushManager(context.globalState);
    bridge.setPushManager?.(push);

    bridge.onPhoneMessage(async (msg) => {
      try {
        if (msg.type === "PHONE_MESSAGE" && typeof msg.text === "string") {
          const cfg = vscode.workspace.getConfiguration("companion");
          const mode = (msg.mode as any) || cfg.get("defaultMode", "agent");
          // 手机可附带 file：防止 activeSessionFile 丢失/多窗口错乱时打到错误会话
          if (typeof msg.file === "string" && msg.file.trim()) {
            const file = msg.file.trim();
            setActiveSessionFile(file);
            try {
              watcher?.selectSession(file);
            } catch {
              /* select best-effort */
            }
            // 0.5.27：发送前强制 rebind/pin 目标会话 transcript
            rebindTranscriptForSession(file);
          }
          // 0.5.28：transcript 文件可能 stale，先登记 pending，等 chatSessions gap-fill
          if (transcriptWatcher && typeof msg.text === "string") {
            transcriptWatcher.addPendingPhoneUserText(msg.text);
          }

          // noteInjectedText is called inside injectMessage; bridge also remembers
          // PHONE_MESSAGE text so sendToPhone can drop JSONL USER_MESSAGE echo.
          // USER_MESSAGE 已由 bridge.acceptPhoneUserMessage 广播；这里只推 typing 态。
          bridge?.broadcast({ type: "COPILOT_TYPING" });
          const result = await injectMessage(msg.text, mode);
          try {
            const leak = (result as any).leakFile
              ? path.basename(String((result as any).leakFile))
              : "-";
            qrPanel.addLog(
              `inject via=${result.injectPath || result.via} sid=${result.sessionId || "-"} activated=${!!result.sessionActivated} openVia=${(result as any).openVia || "-"} verified=${(result as any).verified === undefined ? "-" : (result as any).verified} leak=${leak}`,
            );
          } catch {
            /* ignore */
          }
          // soft-unverified：已 submit 且无串台证据，落盘可能延迟 — 不吓用户去粘贴双发
          if (String(result.injectPath || "").includes("soft-unverified")) {
            bridge?.broadcast({
              type: "SYSTEM_MESSAGE",
              text: "已提交到目标会话（落盘确认稍慢，若桌面未出现再重试）",
            });
            bridge?.broadcast({ type: "COPILOT_DONE", reason: "inject_soft_unverified" });
          } else if (result.injectPath === "bind+chat.open+leak-warning") {
            bridge?.broadcast({
              type: "SYSTEM_MESSAGE",
              text: "警告：目标会话已写入，但其它会话也检测到相同文本，请核对桌面 Chat",
            });
          }
          // 商业化：clipboard → 明确告诉手机；verified 成功保持安静
          if (result.via === "clipboard") {
            const reason = String(result.injectPath || "clipboard");
            bridge?.broadcast({
              type: "SYSTEM_MESSAGE",
              text:
                reason.includes("cross-session-leak")
                  ? "注入未确认目标会话（检测到可能串台），消息已复制到剪贴板，请在正确 Chat 粘贴"
                  : reason.includes("unverified")
                    ? "注入未能确认目标会话，消息已复制到剪贴板（请打开手机选中的会话后粘贴）"
                    : reason.includes("bind-failed")
                      ? "无法打开目标会话，消息已复制到剪贴板"
                      : "已复制到剪贴板（未能安全注入目标会话，请在 Chat 粘贴发送）",
            });
            // 结束手机端 typing，避免一直转圈
            bridge?.broadcast({ type: "COPILOT_DONE", reason: "inject_clipboard" });
          } else if (
            (result as any).verified === false &&
            !/soft-unverified|leak-warning/.test(String(result.injectPath || ""))
          ) {
            // soft-unverified/leak-warning 已在上方链给过提示；避免同一次注入既「已提交」又「警告」。
            bridge?.broadcast({
              type: "SYSTEM_MESSAGE",
              text: "警告：注入未通过目标会话校验，请核对桌面 Chat 是否为手机所选会话",
            });
            // 0.5.27：结束手机 typing，避免发送失败后一直显示“正在输入”
            bridge?.broadcast({ type: "COPILOT_DONE", reason: "inject_verified_false" });
          } else if ((result as any).leakFile) {
            bridge?.broadcast({
              type: "SYSTEM_MESSAGE",
              text: `警告：目标会话已写入，但另一会话也出现相同文本（${path.basename(String((result as any).leakFile))}）`,
            });
          }
        } else if (msg.type === "PHONE_STOP") {
          const result = await cancelChatRequest();
          if (!result.ok) {
            bridge?.broadcast({
              type: "SYSTEM_MESSAGE",
              text: `停止失败: ${result.error || "no cancel command"}`,
            });
          } else {
            // 本地立即收尾 typing；transcript 随后的 turn_end 还会再发 COPILOT_DONE
            bridge?.broadcast({ type: "COPILOT_DONE", reason: "phone_stop" });
          }
        } else if (msg.type === "PHONE_CONFIRM") {
          await handleConfirmation(String(msg.button || ""));
          bridge?.broadcast({
            type: "SYSTEM_MESSAGE",
            text: `确认已处理: ${msg.button || ""}`,
          });
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Lazy Ass inject failed: ${e?.message || e}`);
        bridge?.broadcast({ type: "SYSTEM_MESSAGE", text: `inject failed: ${e?.message || e}` });
      }
    });

    await bridge.start();
    qrPanel.addLog(`Lazy Ass version ${extensionVersion || "?"} port ${bridge.port}`);
    if (bridge.port !== preferredPort) {
      qrPanel.addLog(`port ${preferredPort} busy → using ${bridge.port}`);
      vscode.window.showInformationMessage(
        `Lazy Ass port ${preferredPort} busy, using ${bridge.port}`,
      );
    }

    // 终端管理 + 多实例发现（参考 copilot-remote 的 TerminalManager / InstanceDiscovery）
    terminalMgr = new TerminalManager((line) => qrPanel.addLog(line));
    discovery = new InstanceDiscovery({
      basePort: bridge.port,
      authToken: bridge.getAuthToken() || undefined,
      log: (line) => qrPanel.addLog(line),
    });

    // 工作区索引（借鉴 paseo 的 Project→Workspace→Session 分层）：
    // 扫 workspaceStorage/*/workspace.json 建立「hash → 主机:文件夹」反向映射，
    // 让手机端会话列表能按工作区分组，解决「不知道哪个会话属于哪个文件夹」。
    workspaceIndex = new WorkspaceIndex({ log: (line) => qrPanel.addLog(line) });
    try {
      const wsAll = workspaceIndex.scan();
      const withSessions = wsAll.filter((w) => w.sessionCount > 0).length;
      qrPanel.addLog(`工作区索引: ${wsAll.length} 个（含会话 ${withSessions} 个，远程 ${wsAll.filter((w) => w.isRemote).length} 个）`);
    } catch (e: any) {
      qrPanel.addLog(`工作区索引扫描失败: ${e?.message || e}`);
    }

    // 模型 / 审批级别控制：手机端可选模型与「默认审批 / 绕过审批 / autopilot」
    chatControl = new ChatControl({ log: (line) => qrPanel.addLog(line) });
    // 模型列表变化时推给手机端刷新
    try {
      context.subscriptions.push(
        chatControl.onModelsChanged(() => {
          void chatControl?.listModels().then((models) => {
            bridge?.broadcast({ type: "MODEL_LIST", models, timestamp: Date.now() });
          });
        }),
      );
    } catch {
      /* onDidChangeChatModels 不可用时忽略 */
    }

    // 桌面端切模型 → 手机同步：onDidChangeChatModels 只管模型集变更，不管选中项。
    // 轮询面板实际选中（chat.currentLanguageModel.panel，sqlite 读开销小），
    // 变化时推 MODEL_LIST（isCurrent 已按面板真实选中标记）。
    let lastPanelModelId = chatControl.peekPanelModelId();
    const panelModelPoll = setInterval(() => {
      const cur = chatControl?.peekPanelModelId();
      if (cur && cur !== lastPanelModelId) {
        lastPanelModelId = cur;
        void chatControl?.listModels().then((models) => {
          bridge?.broadcast({ type: "MODEL_LIST", models, timestamp: Date.now() });
        });
      }
    }, 2000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(panelModelPoll)));

    bridge.onRequest(async (msg, reply) => {
      switch (msg?.type) {
        case "PHONE_SESSION_LIST": {
          const sessions = watcher?.listSessions(40) ?? [];
          reply({ type: "SESSION_LIST", sessions, timestamp: Date.now() });
          break;
        }
        case "PHONE_SESSION_SELECT": {
          const file = typeof msg.file === "string" ? msg.file : "";
          const ok = watcher?.selectSession(file) ?? false;
          // 记录选中会话：后续 PHONE_MESSAGE 注入必须先切到该会话，
          // 否则 workbench.action.chat.open 只会打到 VS Code 当前活跃会话。
          if (ok && file) setActiveSessionFile(file);
          // 联动实时数据源：切到对应 transcript 文件。
          // 关键：目标会话可能属于**其他工作区**（含 SSH 远程），因此用工作区索引
          // 反查该会话所属工作区的 transcripts 目录，而不是固定用当前窗口的目录。
          //
          // 历史回放只走 projectHistory → replaySession（单通道）。
          // 这里 bindFile **禁止 replay**——否则 transcripts 再投一轮最近 user turns，
          // 与 HISTORY_REPLAY 叠加，手机端会从头滑到尾（双重洪水）。
          if (ok && file) {
            // 先播种再 rebind：seedFromHistory 会把种子记入 pendingSeed，
            // bindFile 内部 resetState/bindFallback 清空去重集合后在收尾处重放，
            // 否则清集合发生在播种之后、种子被冲掉，旧轮次会被当实时消息洪水重放。
            const hist = watcher?.projectHistory(file, 20) ?? [];
            transcriptWatcher?.seedFromHistory(hist);
            rebindTranscriptForSession(file);
          }
          reply({ type: "SESSION_SELECTED", file, ok, timestamp: Date.now() });
          if (ok) {
            // 完整同步：回放该会话历史 + sessiondb 补全 chatSessions 尚未写盘的回答
            // （HISTORY_REPLAY 瞬时渲染，不走打字机，不会有滑到尾的动画洪水）。
            const sidSel = file
              .split("/")
              .pop()
              ?.replace(/\.jsonl$/, "");
            const merged = buildReplayWithDbBackfill(
              ok && file ? (watcher?.projectHistory(file, 20) ?? []) : [],
              transcriptWatcher?.sessionDbRecentTurns(20, sidSel),
              sidSel,
            );
            transcriptWatcher?.seedFromHistory(merged.filter((e) => (e as { streamId?: string }).streamId?.startsWith("sessiondb/")) as never);
            bridge?.replaySession(
              [
                ...merged,
                {
                  type: "SYSTEM_MESSAGE",
                  text: `已切换到会话: ${file.split("/").pop()}`,
                },
              ],
              file,
            );
          }
          break;
        }
        case "PHONE_TERMINAL_LIST": {
          reply({ type: "TERMINAL_LIST", terminals: terminalMgr?.listTerminals() ?? [], timestamp: Date.now() });
          break;
        }
        case "PHONE_TERMINAL_EXEC": {
          const command = typeof msg.command === "string" ? msg.command : "";
          const terminalId = typeof msg.terminalId === "string" ? msg.terminalId : undefined;
          const result = await terminalMgr?.execute(command, terminalId);
          const termName =
            (terminalId && terminalMgr?.listTerminals().find((t) => t.id === terminalId)?.name) ||
            (terminalId ? terminalId : undefined);
          reply({
            type: "TERMINAL_OUTPUT",
            terminalId: terminalId ?? null,
            name: termName,
            content: result?.content ?? "",
            exitCode: result?.exitCode,
            ok: result?.ok ?? false,
            error: result?.error,
            timestamp: Date.now(),
          });
          break;
        }
        case "PHONE_INSTANCE_STATUS": {
          reply({
            type: "INSTANCE_STATUS",
            instanceId: makeInstanceId(),
            workspaceName: vscode.workspace.name || "untitled",
            host: bridge?.host === "0.0.0.0" ? "127.0.0.1" : bridge?.host,
            port: bridge?.port,
            isPrimary: bridge?.port === preferredPort,
            pid: process.pid,
            timestamp: Date.now(),
          });
          break;
        }
        case "PHONE_INSTANCE_LIST": {
          // 扫描端口范围发现其他窗口的 companion bridge 实例
          const list = discovery ? await discovery.scan() : [];
          reply({ type: "INSTANCE_LIST", instances: list, timestamp: Date.now() });
          break;
        }
        case "PHONE_MODEL_LIST": {
          const models = (await chatControl?.listModels()) ?? [];
          reply({ type: "MODEL_LIST", models, timestamp: Date.now() });
          break;
        }
        case "PHONE_MODEL_SELECT": {
          const id = typeof msg.id === "string" ? msg.id : "";
          const r = await chatControl?.selectModel({
            id,
            vendor: typeof msg.vendor === "string" ? msg.vendor : undefined,
            family: typeof msg.family === "string" ? msg.family : undefined,
          });
          reply({
            type: "MODEL_SELECTED",
            ok: r?.ok ?? false,
            id,
            error: r?.error ?? (chatControl ? undefined : "模型控制未就绪"),
            timestamp: Date.now(),
          });
          break;
        }
        case "PHONE_PERMISSION_LIST": {
          const levels = chatControl?.listPermissionLevels() ?? [];
          const current = chatControl?.currentPermissionLevel() ?? "default";
          reply({ type: "PERMISSION_LIST", levels, current, timestamp: Date.now() });
          break;
        }
        case "PHONE_PERMISSION_SET": {
          const level = String(msg.level || "default") as PermissionLevel;
          const r = await chatControl?.setPermissionLevel(level, {
            persist: msg.persist === true,
          });
          reply({
            type: "PERMISSION_SET",
            ok: r?.ok ?? false,
            level,
            error: r?.error ?? (chatControl ? undefined : "审批控制未就绪"),
            notice: r?.notice,
            timestamp: Date.now(),
          });
          break;
        }
        default:
          break;
      }
    });

    const sessDiscovery = sessionDiscoveryFromExtension(context.storageUri, context.globalStorageUri);
    const useTranscript = cfg.get<boolean>("preferTranscript", true);
    const tdir = useTranscript ? findTranscriptsDir(context.storageUri) : undefined;
    _transcriptDir = tdir;
    if (useTranscript && !tdir) {
      qrPanel.addLog("transcripts 目录未找到，回退 chatSessions 数据源");
    }
    // 会话标题权威源：state.vscdb ChatSessionStore.index（与官方侧栏同源）
    // storageUri 形如 workspaceStorage/<hash>/<extensionId>，
    // 因此 workspace 根 = dirname(storageUri)（一次即可；两次会跑到 workspaceStorage 根，读错库）。
    let sessionIndex: SessionIndexReader | undefined;
    let currentWorkspaceHash: string | undefined;
    try {
      if (context.storageUri?.fsPath) {
        const wsRoot = path.dirname(context.storageUri.fsPath);
        currentWorkspaceHash = path.basename(wsRoot);
        const vscdb = deriveVscdbPath(wsRoot);
        if (fs.existsSync(vscdb)) {
          sessionIndex = new SessionIndexReader({ vscdbPath: vscdb, log: (l) => qrPanel.addLog(l) });
          const n = sessionIndex.readAll().length;
          qrPanel.addLog(`会话索引: ${vscdb}（${n} 条）`);
        } else {
          qrPanel.addLog(`会话索引未找到: ${vscdb}`);
        }
      }
    } catch (e: any) {
      sessionIndex = undefined;
      qrPanel.addLog(`会话索引加载失败: ${e?.message || e}`);
    }

    watcher = new SessionWatcher({
      pollMs: cfg.get<number>("pollMs", 50),
      rescanMs: cfg.get<number>("sessionRescanMs", 2000),
      liveOnly: cfg.get<boolean>("liveOnly", true),
      preferChatSessionDirs: sessDiscovery.preferChatSessionDirs,
      roots: sessDiscovery.roots,
      sessionIndex,
      workspaceIndex,
      currentWorkspaceHash,
      onEvent: (ev) => {
        if (
          ev.type === "USER_MESSAGE" &&
          typeof (ev as any).text === "string" &&
          isInjectedEcho((ev as any).text)
        ) {
          return;
        }
        // Watching session is internal chrome — update artifact only, never phone feed.
        if (
          ev.type === "SYSTEM_MESSAGE" &&
          (String((ev as any).text || "").startsWith("Watching session:") ||
            (ev as any).visibility === "internal" ||
            (ev as any).internal === true)
        ) {
          writeChannelArtifact();
          return;
        }
        // 实时源优先：仅当当前会话确实由 transcripts 供稿时才抑制 chatSessions，
        // 避免切到无 transcripts 的（远程）工作区后两边都不出内容。
        //
        // 关键例外：USER_MESSAGE 必须放行 —— 用户可能在「别的」会话/文件里
        // 直接从 Copilot 插件发消息，而 transcripts 源只 tail 当前选中的单个文件，
        // 若 gate 住 chatSessions 的 USER_MESSAGE，桌面→手机的消息就全丢了。
        // （assistant 侧仍被 gate 拦，避免双渲染；手机注入回声由 isInjectedEcho 拦。）
        // USER_MESSAGE 双源重复由 bridge.sendToPhone 的时间窗去重处理
        // （gate 会矫枉过正：transcripts 静默时唯一来源被吞 → 零气泡）。
        if (transcriptActive && ev.type !== "USER_MESSAGE") return;
        if (bridge?.sendToPhone) bridge.sendToPhone(ev);
        else bridge?.broadcast(ev);
      },
    });
    watcher.start();

    // 毫秒级实时事件流（transcripts）：主内容源，替代 chatSessions 60s 落盘投影
    if (tdir) {
      // chatSessions 兜底源：transcripts 偶尔漏写 assistant 回复（如简短问候），从 chatSessions 补全
      const csdir = findChatSessionsDir(context.storageUri);
      // session-store.db 快速兜底：Copilot 新版 turns 行响应完成即落库，远快于 chatSessions 落盘
      const sessionStoreDb = path.join(
        path.dirname(context.globalStorageUri.fsPath),
        "github.copilot-chat",
        "session-store.db",
      );
      transcriptWatcher = new TranscriptWatcher({
        dir: tdir,
        chatSessionsDir: csdir,
        sessionStoreDb: fs.existsSync(sessionStoreDb) ? sessionStoreDb : undefined,
        pollMs: Math.max(10, cfg.get<number>("pollMs", 50)),
        onEvent: (ev) => {
          if (
            ev.type === "USER_MESSAGE" &&
            typeof (ev as any).text === "string" &&
            isInjectedEcho((ev as any).text)
          ) {
            return;
          }
          // 桌面切会话跟随：页面完整同步——feed 换目标会话历史 + 标题切换。
          // 先 SESSION_SELECTED（PWA 清 feed + 标题 + 切换态），再 HISTORY_REPLAY。
          if (ev.type === "SESSION_FOLLOW") {
            const tfile = String((ev as any).file || (ev as any).csFile || "");
            const base = tfile.split("/").pop() || "";
            // csFile 优先（transcripts 无同名文件时唯一可用源），否则按基名解析
            let csFile: string | undefined =
              typeof (ev as any).csFile === "string" && fs.existsSync((ev as any).csFile)
                ? (ev as any).csFile
                : undefined;
            if (!csFile && csdir && base) {
              const cand = path.join(csdir, base);
              if (fs.existsSync(cand)) csFile = cand;
            }
            if (csFile && fs.existsSync(csFile)) {
              setActiveSessionFile(csFile);
              watcher?.selectSession(csFile);
              const hist = watcher?.projectHistory(csFile, 20) ?? [];
              transcriptWatcher?.seedFromHistory(hist);
              const title =
                watcher
                  ?.listSessions(40)
                  .find((s) => s.file === csFile || (base && String(s.file || "").endsWith("/" + base)))
                  ?.title || undefined;
              bridge?.broadcast({
                type: "SESSION_SELECTED",
                file: csFile,
                ok: true,
                title,
                timestamp: Date.now(),
              });
              // 合并 db 补全：chatSessions 尚未写盘的回答（含中间轮次）按用户文位置插回回放
              const sidForDb = base ? base.replace(/\.jsonl$/, "") : "";
              const mergedHist = buildReplayWithDbBackfill(
                hist,
                transcriptWatcher?.sessionDbRecentTurns(20, sidForDb),
                sidForDb,
              );
              transcriptWatcher?.seedFromHistory(
                mergedHist.filter((e) =>
                  (e as { streamId?: string }).streamId?.startsWith("sessiondb/"),
                ) as never,
              );
              bridge?.replaySession(
                [
                  ...mergedHist,
                  {
                    type: "SYSTEM_MESSAGE",
                    text: `已切换到会话: ${base}`,
                  },
                ],
                csFile,
              );
            } else if (bridge?.sendToPhone) {
              // 找不到 chatSessions 对应文件：退化为提示（不替换 feed）
              bridge.sendToPhone({ type: "SYSTEM_MESSAGE", text: String((ev as any).text || "") });
            }
            return;
          }
          // 桌面在其他会话直接发消息时，transcripts 单文件 tail 可能没跟过去；
          // 用 chatSessions 的 USER_MESSAGE 兜底（bridge sendToPhone 的 isPhoneEcho
          // 会拦手机回声，不会双出现）。
          if (ev.type === "USER_MESSAGE") {
            if (bridge?.sendToPhone) bridge.sendToPhone(ev);
            else bridge?.broadcast(ev);
            return;
          }
          if (
            ev.type === "SYSTEM_MESSAGE" &&
            ((ev as any).visibility === "internal" || (ev as any).internal === true)
          ) {
            writeChannelArtifact();
            return;
          }
          if (bridge?.sendToPhone) bridge.sendToPhone(ev);
          else bridge?.broadcast(ev);
        },
      });
      transcriptWatcher.start();
      // 启动时监控当前窗口最新的 transcript，此时由实时源供稿
      transcriptActive = true;
      qrPanel.addLog(`transcript 实时源: ${tdir}`);
      if (csdir) qrPanel.addLog(`chatSessions 兜底源: ${csdir}`);
    }

    const activeToken = bridge.getAuthToken();
    const localUrl = withToken(bridge.localHttpUrl, activeToken);
    qrPanel.setBridgeUrl(localUrl);
    qrPanel.setPort(bridge.port);
    qrPanel.setTokenHint(activeToken ? maskToken(activeToken) : null);
    qrPanel.setTunnelEnabled(enableTunnel);
    qrPanel.addLog(`bridge ${bridge.localWsUrl}`);
    refreshStatus(bridge, enableTunnel);
    writeChannelArtifact();
    vscode.window.setStatusBarMessage(`Copilot Lazy Ass PWA ${localUrl}`, 5000);

    if (enableTunnel) {
      await startTunnel(bridge.port, allowDownload);
    }
  };

  const stop = async () => {
    await tunnel?.stop();
    tunnel = undefined;
    watcher?.dispose();
    watcher = undefined;
    transcriptWatcher?.dispose();
    transcriptWatcher = undefined;
    _transcriptDir = undefined;
    chatControl?.dispose();
    chatControl = undefined;
    workspaceIndex = undefined;
    transcriptActive = false;
    terminalMgr = undefined;
    discovery = undefined;
    await bridge?.stop();
    bridge = undefined;
    push = undefined;
    sessionToken = undefined;
    qrPanel.setBridgeUrl(null);
    qrPanel.setPublicUrl(null);
    qrPanel.setPort(null);
    qrPanel.setTokenHint(null);
    qrPanel.setPhoneConnected(false);
    qrPanel.setTunnelEnabled(false);
    status.text = "$(phone) Lazy Ass: off";
    writeChannelArtifact();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotSidecar.start", start),
    vscode.commands.registerCommand("copilotSidecar.stop", stop),
    vscode.commands.registerCommand("copilotSidecar.showStatus", async () => {
      if (!bridge) {
        vscode.window.showInformationMessage("Lazy Ass bridge is stopped");
        return;
      }
      const tok = bridge.getAuthToken();
      const local = withToken(bridge.localHttpUrl, tok);
      const pub = bridge.publicUrl ? withToken(ensureSlash(bridge.publicUrl), tok) : null;
      const tunState = tunnel?.running ? "running" : tunnel ? "starting/stopped" : "off";
      vscode.window.showInformationMessage(
        `Lazy Ass ${local}` +
          (pub ? ` | tunnel ${pub}` : "") +
          ` | tun=${tunState}` +
          ` | clients=${bridge.clientCount}` +
          ` | session=${watcher?.currentFile ? path.basename(watcher.currentFile) : "none"}` +
          (tok ? ` | token=${maskToken(tok)}` : ""),
      );
    }),
    vscode.commands.registerCommand("copilotSidecar.copyWsUrl", async () => {
      if (!bridge) {
        vscode.window.showWarningMessage("Bridge not running");
        return;
      }
      const tok = bridge.getAuthToken();
      const url = withToken(bridge.publicUrl ? ensureSlash(bridge.publicUrl) : bridge.localHttpUrl, tok);
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`Copied ${url}`);
    }),
    vscode.commands.registerCommand("copilotSidecar.showQr", async () => {
      await vscode.commands.executeCommand("copilotSidecar.qrPanel.focus");
    }),
    vscode.commands.registerCommand("copilotSidecar.copyToken", async () => {
      const tok = bridge?.getAuthToken() || sessionToken;
      if (!tok) {
        vscode.window.showWarningMessage(
          "当前没有 token。本地模式默认无 token；开启隧道后会自动生成，或在设置里填 copilotSidecar.authToken。",
        );
        return;
      }
      await vscode.env.clipboard.writeText(tok);
      vscode.window.showInformationMessage(`已复制 token: ${maskToken(tok)}`);
    }),
    vscode.commands.registerCommand("copilotSidecar.startTunnel", async () => {
      clearTunnelRestart();
      if (!bridge) await start();
      if (!bridge) return;
      await startTunnel(
        bridge.port,
        vscode.workspace.getConfiguration("copilotSidecar").get("downloadCloudflared", true),
      );
    }),
    vscode.commands.registerCommand("copilotSidecar.stopTunnel", async () => {
      clearTunnelRestart();
      await tunnel?.stop();
      tunnel = undefined;
      bridge?.setPublicUrl(null);
      qrPanel.setPublicUrl(null);
      qrPanel.setTunnelEnabled(false);
      if (bridge) refreshStatus(bridge, false);
      qrPanel.addLog("tunnel stopped");
      writeChannelArtifact();
    }),
    vscode.commands.registerCommand("copilotSidecar.restartTunnel", async () => {
      clearTunnelRestart();
      await tunnel?.stop();
      tunnel = undefined;
      if (!bridge) await start();
      if (!bridge) return;
      await startTunnel(
        bridge.port,
        vscode.workspace.getConfiguration("copilotSidecar").get("downloadCloudflared", true),
      );
    }),
  );

  if (vscode.workspace.getConfiguration("copilotSidecar").get("autoStart", true)) {
    start().catch((e) => {
      console.error(e);
      vscode.window.showErrorMessage(`Lazy Ass start failed: ${e?.message || e}`);
    });
  }
}

export async function deactivate() {
  clearTunnelRestart();
  await tunnel?.stop();
  watcher?.dispose();
  await bridge?.stop();
  writeChannelArtifact();
}

let tunnelRestartAttempts = 0;
let tunnelRestartTimer: NodeJS.Timeout | undefined;
let tunnelStarting = false;
const MAX_TUNNEL_RESTART_ATTEMPTS = 10;

function clearTunnelRestart() {
  if (tunnelRestartTimer) {
    clearTimeout(tunnelRestartTimer);
    tunnelRestartTimer = undefined;
  }
  tunnelRestartAttempts = 0;
}

function scheduleTunnelRestart(port: number) {
  if (tunnelRestartTimer) {
    clearTimeout(tunnelRestartTimer);
    tunnelRestartTimer = undefined;
  }
  if (!qrPanel.state.tunnelEnabled && !tunnel) {
    return;
  }
  if (tunnel?.running || tunnelStarting) {
    return;
  }
  if (tunnelRestartAttempts >= MAX_TUNNEL_RESTART_ATTEMPTS) {
    qrPanel.addLog('tunnel restart max attempts reached; open QR panel and click "开启隧道".');
    qrPanel.setTunnelEnabled(false);
    return;
  }
  const delay = Math.min(5000 + tunnelRestartAttempts * 3000, 30000);
  tunnelRestartAttempts += 1;
  qrPanel.addLog(`tunnel reconnecting in ${delay}ms (attempt ${tunnelRestartAttempts}/${MAX_TUNNEL_RESTART_ATTEMPTS})`);
  tunnelRestartTimer = setTimeout(() => {
    tunnelRestartTimer = undefined;
    if (!bridge) return;
    if (tunnel?.running || tunnelStarting) return;
    const cfg = vscode.workspace.getConfiguration("copilotSidecar");
    const allowDownload = cfg.get<boolean>("downloadCloudflared", true);
    void startTunnel(port || bridge.port, allowDownload);
  }, delay);
}

async function startTunnel(port: number, allowDownload: boolean) {
  if (tunnelStarting || tunnel?.running) {
    return;
  }
  tunnelStarting = true;
  clearTunnelRestart();
  qrPanel.setTunnelEnabled(true);
  if (!bridge) {
    tunnelStarting = false;
    return;
  }

  ensurePublicAuthToken();

  if (tunnel) {
    await tunnel.stop();
    tunnel = undefined;
  }

  const cfg = vscode.workspace.getConfiguration("copilotSidecar");
  const timeoutMs = cfg.get<number>("tunnelTimeoutMs", 35000);

  tunnel = new TunnelManager({
    allowDownload,
    timeoutMs,
    log: (line) => qrPanel.addLog(line),
    onUrl: (url) => {
      if (!url) {
        bridge?.setPublicUrl(null);
        qrPanel.setPublicUrl(null);
        if (bridge) refreshStatus(bridge, true);
        return;
      }
      applyPublicUrl(url);
    },
    onExit: (code, signal) => {
      qrPanel.addLog(`tunnel exited code=${code} signal=${signal}`);
      bridge?.setPublicUrl(null);
      qrPanel.setPublicUrl(null);
      if (bridge) refreshStatus(bridge, false);
      writeChannelArtifact();
      // 0.5.30：免费 trycloudflare 隧道会在网络抖动/长时间 idle 时被 edge 断开，
      // 自动重开以恢复服务；URL 会变，PWA 需刷新。
      scheduleTunnelRestart(bridge?.port || 0);
    },
  });

  try {
    refreshStatus(bridge, true);
    const url = await tunnel.start(port);
    applyPublicUrl(url);
    tunnelRestartAttempts = 0;
    const tok = bridge.getAuthToken();
    const full = withToken(ensureSlash(url), tok);
    vscode.window
      .showInformationMessage(`Sidecar tunnel ready: ${full}`, "Copy URL")
      .then((pick) => {
        if (pick === "Copy URL") void vscode.env.clipboard.writeText(full);
      });
    qrPanel.addLog(`tunnel ready ${url}`);
    writeChannelArtifact();
  } catch (e: any) {
    const reason = e?.message || String(e);
    qrPanel.addLog(`tunnel failed: ${reason}`);
    vscode.window.showErrorMessage(`Sidecar tunnel failed: ${reason}`);
    tunnel = undefined;
    bridge.setPublicUrl(null);
    qrPanel.setPublicUrl(null);
    qrPanel.setTunnelEnabled(false);
    refreshStatus(bridge, false);
    writeChannelArtifact();
  } finally {
    tunnelStarting = false;
  }
}

function applyPublicUrl(url: string) {
  if (!bridge) return;
  const tok = bridge.getAuthToken();
  const full = withToken(ensureSlash(url), tok);
  bridge.setPublicUrl(url);
  qrPanel.setPublicUrl(full);
  qrPanel.setPort(bridge.port);
  qrPanel.setTokenHint(tok ? maskToken(tok) : null);
  refreshStatus(bridge, true);
}

/**
 * If tunnel is used and no authToken in settings, mint an in-memory session token
 * so the public trycloudflare URL is not open.
 */
function ensurePublicAuthToken() {
  if (!bridge) return;
  const settingsToken = (
    vscode.workspace.getConfiguration("copilotSidecar").get<string>("authToken", "") || ""
  ).trim();
  if (settingsToken) {
    bridge.setAuthToken(settingsToken);
    sessionToken = undefined;
    qrPanel.setTokenHint(maskToken(settingsToken));
    qrPanel.setBridgeUrl(withToken(bridge.localHttpUrl, settingsToken));
    return;
  }
  if (bridge.getAuthToken()) {
    qrPanel.setTokenHint(maskToken(bridge.getAuthToken()!));
    return;
  }
  sessionToken = crypto.randomBytes(16).toString("hex");
  bridge.setAuthToken(sessionToken);
  qrPanel.setTokenHint(maskToken(sessionToken));
  qrPanel.setBridgeUrl(withToken(bridge.localHttpUrl, sessionToken));
  qrPanel.addLog(`session auth token generated (in-memory): ${maskToken(sessionToken)}`);
  vscode.window
    .showInformationMessage(
      `Sidecar public tunnel token: ${sessionToken} (also in QR ?token=)`,
      "Copy token",
    )
    .then((pick) => {
      if (pick === "Copy token" && sessionToken) {
        void vscode.env.clipboard.writeText(sessionToken);
      }
    });
}

function refreshStatus(b: BridgeServer, tunnelOn: boolean) {
  const t = b.publicUrl ? " tun" : tunnelOn ? " tun…" : "";
  const c = b.clientCount > 0 ? ` ·${b.clientCount}` : "";
  status.text = `$(phone) Lazy Ass: :${b.port}${t}${c}`;
}

function ensureSlash(url: string) {
  return url.endsWith("/") ? url : url + "/";
}

/** 当前工作区的 transcripts 目录（若存在） */
let _transcriptDir: string | undefined;
function transcriptDir(): string | undefined {
  return _transcriptDir;
}

function withToken(url: string, token?: string) {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }
}

function maskToken(tok: string) {
  if (tok.length <= 8) return tok;
  return `${tok.slice(0, 4)}…${tok.slice(-4)}`;
}

/** Write ~/.copilot-sidecar-companion/channel.json for external tools / self-use.
 * 多窗口时每个 bridge 写 channel-<port>.json，并更新 channel.json 为「本窗口」快照。
 * 注意：多窗口会互相覆盖 channel.json；查实例请用 channel-*.json 或 PWA 实例列表。
 */
function writeChannelArtifact() {
  try {
    const dir = path.join(os.homedir(), ".copilot-sidecar-companion");
    fs.mkdirSync(dir, { recursive: true });
    const tok = bridge?.getAuthToken();
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const payload = {
      localUrl: bridge ? withToken(bridge.localHttpUrl, tok) : null,
      publicUrl: bridge?.publicUrl ? withToken(ensureSlash(bridge.publicUrl), tok) : null,
      port: bridge?.port ?? null,
      host: bridge?.host ?? null,
      token: tok || null,
      tokenPresent: !!tok,
      session: watcher?.currentFile ? path.basename(watcher.currentFile) : null,
      workspaceName: vscode.workspace.name || null,
      workspaceFolders: folders,
      pid: process.pid,
      extensionVersion: extensionVersion ?? null,
      clients: bridge?.clientCount ?? 0,
      running: !!bridge,
      tunnelRunning: !!tunnel?.running,
      updated: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "channel.json"), JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (bridge?.port) {
      fs.writeFileSync(
        path.join(dir, `channel-${bridge.port}.json`),
        JSON.stringify(payload, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    }
  } catch {
    // ignore disk errors
  }
}
