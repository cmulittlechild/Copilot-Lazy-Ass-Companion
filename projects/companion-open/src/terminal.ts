/**
 * 终端管理器 —— 为手机端提供终端列表 / 命令执行能力。
 * 主路径使用 Shell Integration（executeCommand + read 流式读取输出），
 * 无 Shell Integration 时兜底使用 sendText + 剪贴板回读可见内容。
 * 实现思路参考 himeneko copilot-remote 的 copilot-api.ts。
 */
import * as vscode from 'vscode';

export interface TerminalInfo {
  id: string;
  name: string;
}

export interface TerminalExecResult {
  content: string;
  exitCode?: number;
  ok: boolean;
  error?: string;
}

/** 主路径执行超时（毫秒） */
const EXEC_TIMEOUT_MS = 30_000;
/** 单次执行累计输出上限，超过则只保留尾部，防止内存暴涨 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 等待 Shell Integration 就绪的最长时间 */
const SHELL_INTEGRATION_WAIT_MS = 2_500;
/** 兜底路径：sendText 后等待多久再回读剪贴板 */
const FALLBACK_CAPTURE_WAIT_MS = 700;
const NO_OUTPUT_TEXT = '(command completed with no output)';
const FALLBACK_NO_OUTPUT_TEXT = '(命令已发送；当前终端未提供 Shell Integration，已回读可见内容)';
const TIMEOUT_OUTPUT_TEXT = '(超时)';
const TIMEOUT_ERROR_TEXT = '命令执行超时（30 秒）';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TerminalManager {
  /** 终端 -> 稳定 id（WeakMap 不阻止终端被 GC） */
  private readonly terminalIds = new WeakMap<vscode.Terminal, string>();
  private nextTerminalId = 1;

  constructor(private readonly log: (line: string) => void) {}

  /** 列出当前所有终端（含稳定 id，形如 `terminal-1`） */
  listTerminals(): TerminalInfo[] {
    return vscode.window.terminals.map((terminal) => ({
      id: this.idForTerminal(terminal),
      name: terminal.name,
    }));
  }

  /**
   * 在终端中执行命令。
   * @param command 原始命令（会自动清洗换行与控制字符）
   * @param terminalId 目标终端 id；缺省用 activeTerminal，再没有则新建 'Sidecar'
   */
  async execute(command: string, terminalId?: string): Promise<TerminalExecResult> {
    // 命令清洗：统一换行、剔除控制字符（避免注入 / 终端渲染异常）
    const cleanCommand = command
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (!cleanCommand) {
      return { content: '', ok: false, error: '命令为空（去除控制字符后无内容）' };
    }
    this.log(`[terminal] execute${terminalId ? ` (${terminalId})` : ''}: ${cleanCommand.slice(0, 120)}`);

    try {
      const terminal = this.resolveTerminal(terminalId);
      if (!terminal) {
        return { content: '', ok: false, error: `终端不存在: ${terminalId}` };
      }
      terminal.show(true);

      // ── 主路径：Shell Integration ──
      // 终端可能刚创建、集成尚未就绪，最多等 2.5 秒
      const shellIntegration =
        terminal.shellIntegration ||
        (await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
          const timeout = setTimeout(() => {
            listener.dispose();
            resolve(undefined);
          }, SHELL_INTEGRATION_WAIT_MS);
          const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => {
            if (event.terminal !== terminal) return;
            clearTimeout(timeout);
            listener.dispose();
            resolve(event.shellIntegration);
          });
        }));

      if (!shellIntegration) {
        // ── 兜底路径：sendText + 剪贴板回读（WSL / 自定义 prompt 等场景）──
        return await this.fallbackExecute(terminal, cleanCommand);
      }
      return await this.executeWithShellIntegration(terminal, shellIntegration, cleanCommand);
    } catch (e) {
      this.log(`[terminal] execute 异常: ${String(e)}`);
      return { content: '', ok: false, error: String(e) };
    }
  }

  /**
   * 剪贴板回读终端可见内容（兜底路径专用）。
   * 会先保存并最终恢复剪贴板，避免污染用户的剪贴板。
   */
  async captureTerminal(terminal: vscode.Terminal): Promise<string> {
    const previousClipboard = await vscode.env.clipboard.readText();
    terminal.show(true);
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      const content = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
      return content;
    } finally {
      await vscode.env.clipboard.writeText(previousClipboard);
    }
  }

  /** 无 Shell Integration 的兜底执行：sendText + 短暂等待 + 剪贴板回读 */
  private async fallbackExecute(terminal: vscode.Terminal, cleanCommand: string): Promise<TerminalExecResult> {
    terminal.sendText(cleanCommand, true);
    await sleep(FALLBACK_CAPTURE_WAIT_MS);
    let content = '';
    try {
      content = await this.captureTerminal(terminal);
    } catch (e) {
      this.log(`[terminal] 剪贴板回读失败: ${String(e)}`);
    }
    return {
      content: content || FALLBACK_NO_OUTPUT_TEXT,
      exitCode: undefined,
      ok: true,
    };
  }

  /** 主路径执行：executeCommand + 流式读取输出，外层 30 秒超时 */
  private async executeWithShellIntegration(
    terminal: vscode.Terminal,
    shellIntegration: vscode.TerminalShellIntegration,
    cleanCommand: string,
  ): Promise<TerminalExecResult> {
    // 超时标志：超时后让 for await 读取循环尽快退出
    let timedOut = false;

    const run = async (): Promise<{ output: string; exitCode?: number }> => {
      let execution: vscode.TerminalShellExecution;
      let endListener: vscode.Disposable | undefined;
      const ended = new Promise<number | undefined>((resolve) => {
        endListener = vscode.window.onDidEndTerminalShellExecution((event) => {
          if (event.terminal !== terminal || event.execution !== execution) return;
          endListener?.dispose();
          resolve(event.exitCode);
        });
      });
      execution = shellIntegration.executeCommand(cleanCommand);
      let output = '';
      for await (const chunk of execution.read()) {
        if (timedOut) break; // 超时：尽快脱离读取流，避免悬挂
        output += chunk;
        if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
      }
      const exitCode = await ended;
      endListener?.dispose();
      return { output: output || NO_OUTPUT_TEXT, exitCode };
    };

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolveTimeout({ kind: 'timeout' });
      }, EXEC_TIMEOUT_MS);
    });

    const runPromise = run().then(
      (result) => ({ kind: 'done' as const, output: result.output, exitCode: result.exitCode }),
      (error) => {
        this.log(`[terminal] shell integration 执行异常: ${String(error)}`);
        return { kind: 'error' as const, error: String(error) };
      },
    );

    // 30 秒超时与执行结果竞争：超时即返回，不让调用方一直等待
    const winner = await Promise.race([runPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    if (winner.kind === 'done') {
      return { content: winner.output, exitCode: winner.exitCode, ok: true };
    }
    if (winner.kind === 'timeout') {
      this.log('[terminal] 命令执行超时（30 秒）');
      // 超时后不能只 return：run() 内部靠 timedOut 标志退出读取循环；
      // 若底层终端执行仍在跑，其结束事件最终会触发并自行释放监听器（尽力清理）。
      return { content: TIMEOUT_OUTPUT_TEXT, exitCode: undefined, ok: false, error: TIMEOUT_ERROR_TEXT };
    }
    return { content: '', ok: false, error: winner.error };
  }

  /**
   * 解析目标终端：
   * - 指定 terminalId：按 id 查找，找不到返回 undefined（由调用方报错，不静默新建）
   * - 未指定：优先 activeTerminal，再没有则新建 'Sidecar'
   */
  private resolveTerminal(terminalId?: string): vscode.Terminal | undefined {
    if (terminalId) {
      const found = this.findTerminalById(terminalId);
      if (found) return found;
      return undefined;
    }
    if (vscode.window.activeTerminal) return vscode.window.activeTerminal;
    return vscode.window.createTerminal('Sidecar');
  }

  private findTerminalById(terminalId: string): vscode.Terminal | undefined {
    for (const terminal of vscode.window.terminals) {
      if (this.terminalIds.get(terminal) === terminalId) return terminal;
    }
    return undefined;
  }

  private idForTerminal(terminal: vscode.Terminal): string {
    const existing = this.terminalIds.get(terminal);
    if (existing) return existing;
    const id = `terminal-${this.nextTerminalId++}`;
    this.terminalIds.set(terminal, id);
    return id;
  }
}
