/**
 * 实例发现（轻量版）—— 探测端口范围内运行的其他 Companion bridge 实例。
 * 只做「发现 + 状态查询」，不做跨进程 proxy 转发；
 * 手机端拿到目标实例信息后自行重连到对应端口。
 * 实现思路参考 himeneko copilot-remote 的 instance-discovery.ts / server.ts。
 */
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { createConnection } from 'net';
import { WebSocket } from 'ws';

export interface InstanceInfo {
  instanceId: string;
  workspaceName: string;
  host: string;
  port: number;
  isPrimary: boolean;
  pid: number;
}

export interface InstanceDiscoveryOptions {
  /** 当前 bridge 的端口（探测起点） */
  basePort: number;
  /** PHONE_CONNECT 认证 token；bridge 未启用认证时可省略 */
  authToken?: string;
  /** 探测范围 basePort..basePort+range，默认 20 */
  range?: number;
  log?: (line: string) => void;
}

/** 单端口探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 1_500;
/** isAvailable 快速连通性探测超时（毫秒） */
const AVAILABLE_TIMEOUT_MS = 800;
/** 并发探测上限，避免端口风暴 */
const SCAN_CONCURRENCY = 4;
const SCAN_HOST = '127.0.0.1';

/** bridge 返回的 INSTANCE_STATUS 消息（字段值尚未做类型验证） */
interface StatusMessage {
  type: string;
  instanceId?: unknown;
  workspaceName?: unknown;
  host?: unknown;
  port?: unknown;
  isPrimary?: unknown;
  pid?: unknown;
}

export class InstanceDiscovery {
  constructor(private readonly opts: InstanceDiscoveryOptions) {}

  /** 扫描端口范围，返回发现的实例（含当前端口上的实例） */
  async scan(): Promise<InstanceInfo[]> {
    const range = this.opts.range ?? 20;
    const ports: number[] = [];
    for (let offset = 0; offset <= range; offset++) {
      ports.push(this.opts.basePort + offset);
    }

    this.log(`[instances] scan ${SCAN_HOST}:${this.opts.basePort}..${this.opts.basePort + range}`);
    const found: InstanceInfo[] = [];
    await runPool(ports, SCAN_CONCURRENCY, async (port) => {
      const info = await this.probePort(port);
      if (info) found.push(info);
    });
    found.sort((a, b) => a.port - b.port);
    this.log(`[instances] scan 完成，发现 ${found.length} 个实例`);
    return found;
  }

  /**
   * 快速检查 basePort 是否已被本机服务占用（即当前 bridge 是否在跑）。
   * 简化为 TCP 连通性探测，不做完整握手。
   */
  isAvailable(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: SCAN_HOST, port: this.opts.basePort });
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      socket.setTimeout(AVAILABLE_TIMEOUT_MS);
      socket.on('connect', () => finish(true));
      socket.on('error', () => finish(false));
      socket.on('timeout', () => finish(false));
    });
  }

  /**
   * 探测单个端口：
   * PHONE_CONNECT 握手 → 收到 CONNECTED_ACK → 发送 PHONE_INSTANCE_STATUS →
   * 收到 INSTANCE_STATUS 即视为发现一个实例。
   */
  private async probePort(port: number): Promise<InstanceInfo | undefined> {
    return new Promise<InstanceInfo | undefined>((resolve) => {
      let settled = false;
      let ws: WebSocket | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        safeClose(ws);
        resolve(undefined);
      }, PROBE_TIMEOUT_MS);

      const finish = (info?: InstanceInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        safeClose(ws);
        resolve(info);
      };

      try {
        ws = new WebSocket(`ws://${SCAN_HOST}:${port}`);
      } catch {
        finish(undefined);
        return;
      }

      ws.on('open', () => {
        ws?.send(JSON.stringify({ type: 'PHONE_CONNECT', token: this.opts.authToken }));
      });

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const msg = parseMessage(data);
        if (!msg) {
          finish(undefined);
          return;
        }
        if (msg.type === 'CONNECTED_ACK') {
          // 握手成功：请求该实例的自身状态
          ws?.send(JSON.stringify({ type: 'PHONE_INSTANCE_STATUS' }));
          return;
        }
        if (msg.type === 'INSTANCE_STATUS') {
          finish(normalizeStatus(msg, port));
          return;
        }
        // 握手后 bridge 会顺推 HISTORY_REPLAY / AGENT_STREAM_SET 等广播帧——
        // 这些不是探测协议的一部分，继续等 INSTANCE_STATUS；曾经按
        // 「非预期类型即终止」把每条探测都在 HISTORY_REPLAY 上掐死，
        // 发现列表恒为空。只有 AUTH_FAILED（认证错误=不值得重试）
        // 才真正终止；foreign WS 交由 PROBE_TIMEOUT 兜底。
        if (msg.type === 'AUTH_FAILED') {
          finish(undefined);
          return;
        }
        // 其余带 type 的 JSON 一律忽略继续等（含 AGENT_LIST/HISTORY_REPLAY 等）
      });

      ws.on('error', () => finish(undefined));
      ws.on('close', () => finish(undefined));
    });
  }

  private log(line: string): void {
    try {
      this.opts.log?.(line);
    } catch {
      // 忽略日志回调异常
    }
  }
}

/** 生成当前 VS Code 窗口的实例 id：vscode-<pid>-<workspaceName md5 前 8 位> */
export function makeInstanceId(): string {
  const workspaceName = vscode.workspace.name || 'untitled';
  const hash = createHash('md5').update(workspaceName).digest('hex').slice(0, 8);
  return `vscode-${process.pid}-${hash}`;
}

/** 校验并规范化 INSTANCE_STATUS 消息为 InstanceInfo */
function normalizeStatus(msg: StatusMessage, probedPort: number): InstanceInfo | undefined {
  if (typeof msg.instanceId !== 'string' || msg.instanceId.length === 0) return undefined;
  if (typeof msg.workspaceName !== 'string') return undefined;
  const pid = Number(msg.pid);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const reportedPort = Number(msg.port);
  const port = Number.isInteger(reportedPort) && reportedPort > 0 ? reportedPort : probedPort;
  const host = typeof msg.host === 'string' && msg.host.length > 0 ? msg.host : SCAN_HOST;
  return {
    instanceId: msg.instanceId,
    workspaceName: msg.workspaceName,
    host,
    port,
    isPrimary: msg.isPrimary === true,
    pid,
  };
}

/** 解析 ws 消息为 StatusMessage；无法解析时返回 undefined */
function parseMessage(data: Buffer | ArrayBuffer | Buffer[]): StatusMessage | undefined {
  let text: string;
  if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else if (Array.isArray(data)) {
    text = Buffer.concat(data).toString('utf8');
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf8');
  } else {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as StatusMessage;
  } catch {
    return undefined;
  }
}

function safeClose(ws: WebSocket | undefined): void {
  try {
    ws?.close();
    ws?.terminate();
  } catch {
    // 忽略关闭异常
  }
}

/** 以固定并发度执行一批任务（防止端口风暴） */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
      }
    }),
  );
}
