/**
 * Copilot Chat session JSONL projector.
 * Handles modern Copilot which often rewrites kind=0 full snapshots,
 * plus kind=1 finalize markers and kind=2 response mutations.
 */

export type PhoneEvent =
  | { type: 'SYSTEM_MESSAGE'; text: string; visibility?: string; internal?: boolean }
  | { type: 'USER_MESSAGE'; text: string; requestId?: string }
  | { type: 'COPILOT_TYPING'; requestId?: string }
  | { type: 'AGENT_STREAM_START'; streamId: string; requestIndex?: number }
  | { type: 'AGENT_STREAM_SET'; streamId: string; text: string; requestIndex?: number }
  | { type: 'AGENT_STREAM_CHUNK'; streamId: string; text: string; requestIndex?: number }
  | { type: 'AGENT_STREAM_END'; streamId: string; requestIndex?: number }
  | { type: 'AGENT_MESSAGE'; streamId?: string; text: string; requestIndex?: number }
  | {
      type: 'TOOL_CALL';
      text: string;
      toolId?: string | null;
      isComplete?: boolean;
      input?: unknown;
      requestIndex?: number;
      isConfirmed?: unknown;
    }
  | {
      type: 'PROGRESS_STEP';
      title: string;
      detail?: string;
      requestIndex?: number;
      stepId?: string;
      doneCount?: number;
    }
  | {
      type: 'THINKING_STEP';
      text: string;
      requestIndex?: number;
      stepId?: string;
    }
  | { type: 'AGENT_CONFIRM'; title: string; message: string; buttons: string[]; requestIndex?: number }
  | { type: 'COPILOT_DONE'; requestIndex?: number; reason?: string; v?: unknown }
  | { type: string; [k: string]: unknown };

/** Chrome we never surface as chat text */
const IGNORE = new Set([
  // Match paid Remote: never surface these chrome kinds to phone
  'thinking',
  'progressTaskSerialized',
  'progressTask',
  'progressMessage',
  'mcpServersStarting',
  'undoStop',
  'prepareToolInvocation',
  'inlineReference',
  'textEditGroup',
  'codeblockUri',
  'codeCitation',
]);

const DONE_DEBOUNCE_MS = 450;

export class JsonlProjector {
  private seenRequestIds = new Set<string>();
  private respParts = new Map<string, any[]>();
  private lastEmittedText = new Map<string, string>();
  private activeStreams = new Map<string, number | undefined>();
  private lastToolKey = new Map<string, string>();
  private lastProgressKey = new Map<string, string>();
  private lastThinkingKey = new Map<string, string>();
  private doneTimers = new Map<number, NodeJS.Timeout>();
  private doneSink: ((ev: PhoneEvent) => void) | undefined;
  /** last kind0 request count to detect growth */
  private lastKind0ReqCount = 0;
  /**
   * 已知的会话请求总数，用作 kind=2 append 时推导**真实**请求下标的基准。
   *
   * kind=2 的 `k=["requests"]` 变异每次只追加一条请求，载荷内部下标恒为 0。
   * 若直接拿它当请求序号，所有轮次都会塌到 `requests/0/...`：
   *   1) streamId 碰撞 → 手机端把多轮回复折叠进同一行；
   *   2) 收尾标记（kind=1 的 result/elapsedMs）带的是真实下标，
   *      与注册在 0 上的流对不上 → 流永不收尾（AGENT_MESSAGE / STREAM_END 缺失）。
   */
  private reqCount = 0;

  setDoneSink(fn: (ev: PhoneEvent) => void) {
    this.doneSink = fn;
  }

  dispose() {
    for (const t of this.doneTimers.values()) clearTimeout(t);
    this.doneTimers.clear();
  }

  reset() {
    this.seenRequestIds.clear();
    this.respParts.clear();
    this.lastEmittedText.clear();
    this.activeStreams.clear();
    this.lastToolKey.clear();
    this.lastProgressKey.clear();
    this.lastThinkingKey.clear();
    for (const t of this.doneTimers.values()) clearTimeout(t);
    this.doneTimers.clear();
    this.lastKind0ReqCount = 0;
    this.reqCount = 0;
  }

  projectLine(obj: any): PhoneEvent[] {
    if (!obj || typeof obj !== 'object') return [];
    const out: PhoneEvent[] = [];

    // kind 0: full session snapshot (modern Copilot often rewrites whole file)
    if (obj.kind === 0) {
      out.push(...this.handleKind0Snapshot(obj.v));
      return out;
    }

    const k = obj.k;
    if (!Array.isArray(k) || k.length === 0) return out;

    // finalize markers (usually kind=1)
    if (
      k.length === 3 &&
      typeof k[1] === 'number' &&
      (k[2] === 'elapsedMs' || k[2] === 'result' || k[2] === 'isCanceled')
    ) {
      const reqIndex = k[1] as number;
      const endEvs = this.endActiveStreamsForRequest(reqIndex);
      const doneEv: PhoneEvent = {
        type: 'COPILOT_DONE',
        requestIndex: reqIndex,
        reason: k[2],
        v: obj.v,
      };
      if (this.doneSink) {
        out.push(...endEvs);
        this.scheduleDone(reqIndex, doneEv);
        return out;
      }
      out.push(...endEvs, doneEv);
      return out;
    }

    // structural mutations kind===2
    if (obj.kind !== 2) return out;

    if (k.length === 1 && k[0] === 'requests') {
      const v = obj.v;
      if (!Array.isArray(v)) return out;
      // 真实请求下标：优先用变异自带的 splice 位置 obj.i（权威），
      // 缺失时回退到累计计数器。切勿使用载荷内部下标（恒为 0）。
      const base = typeof obj.i === 'number' && obj.i >= 0 ? obj.i : this.reqCount;
      for (let n = 0; n < v.length; n++) {
        const gi = base + n;
        out.push(...this.handleUserRequest(v[n], gi));
        // if request already has response parts in this mutation, project them
        if (Array.isArray(v[n]?.response) && v[n].response.length) {
          out.push(
            ...this.applyResponseMutation(`requests/${gi}/response`, gi, v[n].response, undefined),
          );
        }
        // 新版 Copilot 把整个**已完成**请求一条 append 落盘（elapsedMs/result/
        // modelState.completedAt 随请求对象同来），不再写独立的
        // ["requests",N,"elapsedMs"] 收尾标记 → 必须就地补 COPILOT_DONE，
        // 否则手机端 typing/停止按钮要等 transcript 兜底超时（~120s）才清。
        const reason = requestDoneReason(v[n]);
        if (reason) {
          out.push(...this.endActiveStreamsForRequest(gi));
          const doneEv: PhoneEvent = { type: 'COPILOT_DONE', requestIndex: gi, reason };
          if (this.doneSink) this.scheduleDone(gi, doneEv);
          else out.push(doneEv);
        }
      }
      this.reqCount = Math.max(this.reqCount, base + v.length);
      return out;
    }

    if (k.length === 3 && typeof k[1] === 'number' && k[2] === 'response') {
      const pathKey = `requests/${k[1]}/response`;
      out.push(...this.applyResponseMutation(pathKey, k[1], obj.v, obj.i));
    }
    return out;
  }

  private handleKind0Snapshot(v: any): PhoneEvent[] {
    if (!v || typeof v !== 'object') return [];
    const reqs = v.requests;
    if (!Array.isArray(reqs)) return [];
    const out: PhoneEvent[] = [];

    // Only emit for newly appeared requests, and always refresh the latest request's response
    // so live UI can catch up after a full rewrite.
    const start = Math.max(0, reqs.length - 3); // last 3 requests max to avoid flood
    for (let i = start; i < reqs.length; i++) {
      const req = reqs[i];
      out.push(...this.handleUserRequest(req, i));
      const resp = req?.response;
      if (Array.isArray(resp) && resp.length) {
        out.push(...this.applyResponseMutation(`requests/${i}/response`, i, resp, undefined));
      }
      // if request looks finished, end streams + DONE（快照路径同因嵌带完成标记）
      if (req?.response) {
        const reason = requestDoneReason(req);
        if (reason) {
          out.push(...this.endActiveStreamsForRequest(i));
          const doneEv: PhoneEvent = { type: 'COPILOT_DONE', requestIndex: i, reason };
          if (this.doneSink) this.scheduleDone(i, doneEv);
          else out.push(doneEv);
        }
      }
    }
    this.lastKind0ReqCount = reqs.length;
    // 快照重写后同步计数器，使后续 kind=2 append 能接在正确下标上
    this.reqCount = Math.max(this.reqCount, reqs.length);
    return out;
  }

  private scheduleDone(reqIndex: number, ev: PhoneEvent) {
    const prev = this.doneTimers.get(reqIndex);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.doneTimers.delete(reqIndex);
      this.doneSink?.(ev);
    }, DONE_DEBOUNCE_MS);
    this.doneTimers.set(reqIndex, t);
  }

  private handleUserRequest(t: any, reqIndex?: number): PhoneEvent[] {
    const rid = t?.requestId ?? '';
    if (!rid || this.seenRequestIds.has(rid)) return [];
    this.seenRequestIds.add(rid);
    const text = textOfUserReq(t);
    if (!text) return [];
    return [
      {
        type: 'USER_MESSAGE',
        text,
        requestId: rid,
        requestIndex: reqIndex,
        timestamp: typeof t?.timestamp === 'number' ? t.timestamp : undefined,
      } as PhoneEvent,
      { type: 'COPILOT_TYPING', requestId: rid, requestIndex: reqIndex },
    ];
  }

  private applyResponseMutation(pathKey: string, reqIndex: number, v: any, i: any): PhoneEvent[] {
    let cur = this.respParts.get(pathKey) ?? [];
    if (typeof i !== 'number') {
      cur = Array.isArray(v) ? v.slice() : [];
    } else {
      if (!Array.isArray(cur)) cur = [];
      const add = Array.isArray(v) ? v : [v];
      cur.splice(i, 0, ...add);
    }
    this.respParts.set(pathKey, cur);

    const blocks = renderBlocks(cur);
    const out: PhoneEvent[] = [];
    let textBlockIdx = 0;
    let stepIdx = 0;
    let thinkIdx = 0;
    for (let n = 0; n < blocks.length; n++) {
      const b = blocks[n];
      if (b.type === 'text') {
        // stable stream id by text-slot index among text blocks only
        out.push(...this.emitTextStream(`${pathKey}#text#${textBlockIdx}`, b.text, reqIndex));
        textBlockIdx++;
      } else if (b.type === 'thinking') {
        // 0.5.23：内部规划 → THINKING_STEP（不进 AGENT 正文流）
        const thinkKey = `${pathKey}#think#${thinkIdx}`;
        const t = String(b.text || '').trim();
        if (t && this.lastThinkingKey.get(thinkKey) !== t) {
          this.lastThinkingKey.set(thinkKey, t);
          out.push({
            type: 'THINKING_STEP',
            text: t,
            requestIndex: reqIndex,
            stepId: thinkKey,
          });
        }
        thinkIdx++;
        stepIdx++;
      } else if (b.type === 'tool') {
        const toolKey = `${b.toolId ?? ''}|${b.text}|${b.isComplete ? 1 : 0}`;
        const mapKey = `${pathKey}#tool#${b.toolId ?? n}`;
        if (this.lastToolKey.get(mapKey) === toolKey) continue;
        this.lastToolKey.set(mapKey, toolKey);
        out.push({
          type: 'TOOL_CALL',
          text: b.text,
          toolId: b.toolId,
          isComplete: b.isComplete,
          input: b.input,
          isConfirmed: b.isConfirmed,
          requestIndex: reqIndex,
        });
        stepIdx++;
      } else if (b.type === 'confirm') {
        out.push({
          type: 'AGENT_CONFIRM',
          title: b.title,
          message: b.message,
          buttons: b.buttons,
          requestIndex: reqIndex,
        });
      }
    }
    return out;
  }

  private emitTextStream(streamId: string, text: string, reqIndex: number): PhoneEvent[] {
    const prev = this.lastEmittedText.get(streamId);
    if (prev === text) return [];

    const out: PhoneEvent[] = [];
    if (prev === undefined) {
      out.push({ type: 'AGENT_STREAM_START', streamId, requestIndex: reqIndex });
      out.push({ type: 'AGENT_STREAM_SET', streamId, text, requestIndex: reqIndex });
      this.activeStreams.set(streamId, reqIndex);
    } else if (text.startsWith(prev)) {
      const delta = text.slice(prev.length);
      if (!delta) return [];
      out.push({ type: 'AGENT_STREAM_CHUNK', streamId, text: delta, requestIndex: reqIndex });
      this.activeStreams.set(streamId, reqIndex);
    } else {
      out.push({ type: 'AGENT_STREAM_SET', streamId, text, requestIndex: reqIndex });
      this.activeStreams.set(streamId, reqIndex);
    }
    this.lastEmittedText.set(streamId, text);
    return out;
  }

  /**
   * 收尾**全部**残留的活跃流。
   *
   * 仅用于历史回放这类「读取静态完整文件」的场景：真实会话里并非每个请求
   * 都写了 `result`/`elapsedMs` 收尾标记（实测某会话 6 轮只有 2 个标记，
   * 且其中一个还早于对应 response 落盘），导致多数回复没有 AGENT_MESSAGE /
   * AGENT_STREAM_END —— 手机端表现为光标常亮、没有复制按钮。
   *
   * 实时 tail 路径**不要**调用它，那里的流确实可能仍在进行中。
   */
  finalizeAllStreams(): PhoneEvent[] {
    const out: PhoneEvent[] = [];
    for (const [streamId, idx] of [...this.activeStreams.entries()]) {
      const finalText = this.lastEmittedText.get(streamId);
      if (typeof finalText === 'string' && finalText.length) {
        out.push({ type: 'AGENT_MESSAGE', streamId, text: finalText, requestIndex: idx });
      }
      out.push({ type: 'AGENT_STREAM_END', streamId, requestIndex: idx });
      this.activeStreams.delete(streamId);
    }
    return out;
  }

  private endActiveStreamsForRequest(reqIndex: number): PhoneEvent[] {
    const out: PhoneEvent[] = [];
    for (const [streamId, idx] of [...this.activeStreams.entries()]) {
      if (idx !== reqIndex) continue;
      const finalText = this.lastEmittedText.get(streamId);
      if (typeof finalText === 'string' && finalText.length) {
        out.push({ type: 'AGENT_MESSAGE', streamId, text: finalText, requestIndex: reqIndex });
      }
      out.push({ type: 'AGENT_STREAM_END', streamId, requestIndex: reqIndex });
      this.activeStreams.delete(streamId);
    }
    return out;
  }
}

/**
 * 请求对象自带的完成标记。新版 Copilot（0.67+）把整轮请求以单条
 * `k=["requests"]` append 落盘，完成态直接写在请求对象上
 * （elapsedMs/result/modelState.completedAt/isCanceled），
 * 不再有独立的 [N,"elapsedMs"] 行。
 */
function requestDoneReason(req: any): string | undefined {
  if (!req || typeof req !== 'object') return undefined;
  if (req.isCanceled === true || req.isCanceled === 1) return 'isCanceled';
  if (req.result != null) return 'result';
  if (req.elapsedMs != null) return 'elapsedMs';
  const ms = req.modelState;
  if (ms && typeof ms === 'object' && ms.completedAt != null) return 'modelState.completedAt';
  return undefined;
}

export function textOfUserReq(t: any): string {
  if (!t || typeof t !== 'object') return '';
  const msg = t.message;
  if (msg && typeof msg === 'object') {
    if (typeof msg.text === 'string') return msg.text;
    if (typeof msg.value === 'string') return msg.value;
    if (Array.isArray(msg.parts)) {
      return msg.parts
        .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p?.value === 'string' ? p.value : ''))
        .filter(Boolean)
        .join(' ');
    }
  }
  for (const key of ['text', 'prompt', 'content', 'value']) {
    if (typeof t[key] === 'string' && t[key]) return t[key];
  }
  return '';
}

function contentValue(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'object') {
    if (typeof c.value === 'string') return c.value;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.content === 'string') return c.content;
  }
  return '';
}

/**
 * 0.5.23：识别 chatSessions / transcript 里「模型内部规划」文案。
 * 这类文本常以独立 {value} 段落写入（无 kind=thinking），桌面 UI 不当正文，
 * 远程若当 AGENT_MESSAGE 会泄漏英文 monologue / 「用户只是…」自言自语。
 */
export function isInternalMonologue(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length < 12) return false;
  // 已是面向用户的 markdown 正文（标题/加粗列表）→ 不当 monologue
  if (/\n#{1,3}\s/.test(t) || /\*\*[^*\n]{2,40}\*\*/.test(t)) {
    // 仍可能是 monologue 开头夹带 **；仅当整体像规划句且较短时继续判断
    if (t.length > 400) return false;
  }
  // English planning / tool-prep monologue
  // 0.5.27：识别 internal monologue，避免将正常回答如 "I will help..." / "Let me check..." 误判为 monologue
  if (/^(The user|User)\s+(is asking|wants|asked|said|has|provided|requested|just)\b/i.test(t)) return true;
  if (/^I (should|need to) (check|examine|inspect|verify|look into|see if)\b/i.test(t) && t.length < 300) return true;
  if (/^Let me (check|examine|inspect|verify|look into|see if) (the|if|whether|how|what|where)\b/i.test(t) && t.length < 300) return true;
  if (
    /\b(whether the contents are still useful|user is asking|user just said)\b/i.test(
      t,
    ) &&
    t.length < 600
  ) {
    return true;
  }
  // 中文内部规划（DeepSeek / 部分模型会落进 value）
  if (/^用户(只是|发了|问|在问|说|打了|发来|提出)/.test(t)) return true;
  if (/这是一个简单的(对话|测试)?请求/.test(t)) return true;
  if (/无需使用工具/.test(t) && t.length < 500) return true;
  if (/我应该(用中文|简短|简单|直接)/.test(t) && t.length < 600) return true;
  if (/不需要任何工具/.test(t) && t.length < 500) return true;
  return false;
}

function renderBlocks(parts: any[]) {
  const blocks: any[] = [];
  let textAcc = '';
  const flushText = () => {
    if (!textAcc) return;
    // 防御：整段累计后仍像 monologue（极少见）
    if (isInternalMonologue(textAcc) && textAcc.length < 1200) {
      blocks.push({ type: 'thinking', text: textAcc.trim() });
    } else {
      blocks.push({ type: 'text', text: textAcc });
    }
    textAcc = '';
  };

  let stepCount = 0;
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    const kind = p.kind ?? '';
    if (IGNORE.has(kind)) continue;

    // thinking / progressTask* already in IGNORE (Remote parity)

    if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
      flushText();
      const inv = p.invocationMessage ?? p.pastTenseMessage ?? {};
      const name = typeof inv === 'string' ? inv : inv?.value ?? inv?.content ?? '';
      stepCount++;
      blocks.push({
        type: 'tool',
        toolId: p.toolCallId ?? p.toolId ?? null,
        text: name || p.toolId || 'tool',
        input: p.toolSpecificData ?? p.parameters ?? p.input ?? null,
        isComplete: p.isComplete !== false && p.isComplete !== 0,
        isConfirmed: p.isConfirmed,
      });
      continue;
    }

    if (kind === 'confirmation' || kind === 'confirmationSerialized') {
      flushText();
      blocks.push({
        type: 'confirm',
        title: p.title || 'Confirmation',
        message: contentValue(p.message) || contentValue(p) || '',
        buttons: Array.isArray(p.buttons)
          ? p.buttons.map((b: any) => (typeof b === 'string' ? b : b?.label || b?.title || 'OK'))
          : ['Continue', 'Cancel'],
      });
      continue;
    }

    // plain text parts: { value: "..." } or kind markdownContent
    if (!kind || kind === 'markdownContent' || kind === 'plainText') {
      const val = typeof p.value === 'string' ? p.value : contentValue(p);
      if (!val) continue;
      // 0.5.23：独立 monologue 段 → thinking，不与后续用户可见正文拼接
      if (isInternalMonologue(val)) {
        flushText();
        blocks.push({ type: 'thinking', text: val.trim() });
        continue;
      }
      textAcc += val;
      continue;
    }
  }
  flushText();
  return blocks;
}
