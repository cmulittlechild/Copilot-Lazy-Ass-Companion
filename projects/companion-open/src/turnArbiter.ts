/**
 * 统一事件裁决器：三个数据源（chatSessions / transcripts / session-store.db）
 * 写盘时机各不相同，同一轮次的内容会经多通道重复、乱序到达。此前客户端
 * （PWA）要各自猜测归属/去重/定序，竞态层出不穷。
 *
 * 这里在广播出口做单一裁决点：
 *  - 每条内容事件打规范归属：_sess（会话 basename）、_ut（所属用户文本）、
 *    _seq（单调序）、reqIdx（可推导时）；
 *  - 跨通道去重：同会话+同轮次+同内容前缀的事件在窗口内只放行第一条；
 *  - DONE 仲裁：过期 DONE（早于最近 live USER）打 stale 标记；
 *    注入回执 DONE（发送后 ~2s、无归属）打 ack 标记；停止类 DONE 打
 *    closedUt 让客户端精确清待答条目。
 * 客户端仍保留原有防线作兜底，但权威判断从此在服务端。
 */

const CONTENT_DEDUPE_MS = 120_000;
const STALE_DONE_SKEW_MS = 2_000;
const INJECT_ACK_WINDOW_MS = 8_000;
const MAX_TRACKED_TURNS = 64;

interface TrackedTurn {
  utKey: string;
  ts: number;
  reqIdx: number | null;
  answered: boolean;
}

function normText(t: unknown): string {
  return String(t ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function sessBaseOf(ev: any): string {
  const f = String(ev?._sess || ev?.file || ev?.sessionFile || "");
  if (!f) return "";
  const base = f.split(/[\\/]/).pop() || "";
  return base.replace(/\.jsonl$/i, "");
}

export class TurnArbiter {
  private seq = 0;
  private latestUserLiveTs = 0;
  private latestReqIdx = -1;
  private openTurns: TrackedTurn[] = [];
  private emitted = new Map<string, number>();

  /** 会话切换/绑定变更时调用：清本轮状态，避免跨会话误杀。 */
  resetForSession(sessBase?: string) {
    this.openTurns = [];
    this.latestUserLiveTs = 0;
    this.latestReqIdx = -1;
    if (sessBase) this.pruneEmitted(0);
  }

  private pruneEmitted(now: number) {
    for (const [k, ts] of this.emitted) {
      if (now - ts > CONTENT_DEDUPE_MS) this.emitted.delete(k);
    }
  }

  /** 内容指纹：类型族 + 会话 + 轮次 + 内容前缀。窗口内重复 → 跨通道重投，丢弃。 */
  private contentKey(ev: any, sessBase: string, utKey: string): string | null {
    switch (ev.type) {
      case "USER_MESSAGE": {
        const t = normText(ev.text);
        if (!t) return null;
        return `u|${sessBase}|${t}`;
      }
      case "AGENT_MESSAGE": {
        const t = normText(ev.text);
        if (!t) return null;
        const sid = String(ev.streamId || "");
        const req =
          typeof ev.requestIndex === "number" ? `r${ev.requestIndex}` : "";
        // streamId 相同 = 同一条流终帧在多个通道各发一遍（sendStreamEnd /
        // transcripts 收尾 / sessiondb 投影）；reqIdx 区分同题重问。
        return sid
          ? `a|${sessBase}|${sid}`
          : `a|${sessBase}|${req}|${utKey}|${t.slice(0, 80)}`;
      }
      default:
        return null;
    }
  }

  private newestOpenTurn(sessBase: string): TrackedTurn | undefined {
    for (let i = this.openTurns.length - 1; i >= 0; i--) {
      const t = this.openTurns[i];
      if (t.answered) continue;
      if (sessBase && (t as any).sess && (t as any).sess !== sessBase) continue;
      return t;
    }
    return undefined;
  }

  private markAnswered(sessBase: string, utKey?: string) {
    for (const t of this.openTurns) {
      if (t.answered) continue;
      if (sessBase && (t as any).sess && (t as any).sess !== sessBase) continue;
      if (utKey && t.utKey !== utKey) continue;
      t.answered = true;
      if (!utKey) break;
    }
    while (this.openTurns.length > MAX_TRACKED_TURNS) this.openTurns.shift();
  }

  /**
   * 裁决一条待广播事件。返回打戳后的事件；返回 null = 丢弃（跨通道重复）。
   * 非内容类事件（MODEL_LIST/SYSTEM_MESSAGE 等）原样放行，仅打 _seq。
   */
  accept(ev: any): any | null {
    if (!ev || typeof ev !== "object") return ev;
    const now = Date.now();
    this.pruneEmitted(now);

    const sessBase = sessBaseOf(ev);
    const type = String(ev.type || "");

    // 轮次归属键：服务端下发的 _ut 优先；否则归到最新未答轮
    let utKey = typeof ev._ut === "string" ? normText(ev._ut) : "";

    switch (type) {
      case "USER_MESSAGE": {
        const t = normText(ev.text);
        const reqIdx =
          typeof ev.requestIndex === "number" ? ev.requestIndex : null;
        if (reqIdx != null && reqIdx > this.latestReqIdx) this.latestReqIdx = reqIdx;
        if (!ev.replayed && !ev.history) this.latestUserLiveTs = Math.max(this.latestUserLiveTs, now);
        const turn: TrackedTurn = { utKey: t, ts: now, reqIdx, answered: false };
        (turn as any).sess = sessBase;
        this.openTurns.push(turn);
        if (this.openTurns.length > MAX_TRACKED_TURNS) this.openTurns.shift();
        utKey = t;
        break;
      }
      case "AGENT_STREAM_START":
      case "AGENT_STREAM_SET":
      case "AGENT_STREAM_CHUNK":
      case "AGENT_STREAM_END":
      case "AGENT_TOOL_CALL":
      case "AGENT_TOOL_RESULT":
      case "AGENT_THINKING":
      case "THINKING_START":
      case "THINKING_END":
      case "COPILOT_TYPING": {
        if (!utKey) {
          const t = this.newestOpenTurn(sessBase);
          if (t) utKey = t.utKey;
        }
        break;
      }
      case "AGENT_MESSAGE": {
        if (!utKey) {
          const t = this.newestOpenTurn(sessBase);
          if (t) utKey = t.utKey;
        }
        break;
      }
      case "COPILOT_DONE": {
        const reqIdx =
          typeof ev.requestIndex === "number" ? ev.requestIndex : null;
        const doneTs =
          typeof ev.ts === "number" ? ev.ts : typeof ev.timestamp === "number" ? ev.timestamp : now;
        const immediate =
          ev.reason === "phone_stop" || ev.reason === "isCanceled";

        // 过期 DONE：归属旧轮次，不得释放当前在途状态
        const staleByIdx = reqIdx != null && this.latestReqIdx > reqIdx;
        const staleByTs =
          reqIdx == null &&
          !immediate &&
          Number.isFinite(doneTs) &&
          doneTs + STALE_DONE_SKEW_MS < this.latestUserLiveTs;
        if (staleByIdx || staleByTs) ev.stale = true;

        // 注入回执 DONE：发送后 ~2s 必到、无 _ut/requestIndex——不是轮终
        const newest = this.newestOpenTurn(sessBase);
        if (!immediate && !utKey && newest && now - newest.ts < INJECT_ACK_WINDOW_MS) {
          ev.ack = true;
        }

        // 停止类 DONE：终止最新未答轮，记 closedUt 让客户端精确清条目
        if (immediate && !utKey && newest) {
          ev.closedUt = newest.utKey;
          this.markAnswered(sessBase, newest.utKey);
        } else if (utKey) {
          this.markAnswered(sessBase, utKey);
        } else if (!immediate && !staleByIdx && !staleByTs && newest) {
          this.markAnswered(sessBase, newest.utKey);
        }
        break;
      }
      default:
        break;
    }

    // 跨通道去重（USER/AGENT_MESSAGE 两类；USER 另有文本窗去重在前置层）
    if (type === "AGENT_MESSAGE") {
      const key = this.contentKey(ev, sessBase, utKey);
      if (key) {
        const seen = this.emitted.get(key);
        if (seen != null && now - seen <= CONTENT_DEDUPE_MS) return null;
        this.emitted.set(key, now);
      }
      this.markAnswered(sessBase, utKey);
    }

    const out = { ...ev, _seq: ++this.seq };
    if (sessBase && !out._sess) out._sess = sessBase;
    if (utKey && !out._ut) out._ut = utKey;
    return out;
  }
}
