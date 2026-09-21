"use strict";
/**
 * Copilot Chat session JSONL projector.
 * Handles modern Copilot which often rewrites kind=0 full snapshots,
 * plus kind=1 finalize markers and kind=2 response mutations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonlProjector = void 0;
exports.textOfUserReq = textOfUserReq;
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
class JsonlProjector {
    seenRequestIds = new Set();
    respParts = new Map();
    lastEmittedText = new Map();
    activeStreams = new Map();
    lastToolKey = new Map();
    lastProgressKey = new Map();
    lastThinkingKey = new Map();
    doneTimers = new Map();
    doneSink;
    /** last kind0 request count to detect growth */
    lastKind0ReqCount = 0;
    /**
     * 已知的会话请求总数，用作 kind=2 append 时推导**真实**请求下标的基准。
     *
     * kind=2 的 `k=["requests"]` 变异每次只追加一条请求，载荷内部下标恒为 0。
     * 若直接拿它当请求序号，所有轮次都会塌到 `requests/0/...`：
     *   1) streamId 碰撞 → 手机端把多轮回复折叠进同一行；
     *   2) 收尾标记（kind=1 的 result/elapsedMs）带的是真实下标，
     *      与注册在 0 上的流对不上 → 流永不收尾（AGENT_MESSAGE / STREAM_END 缺失）。
     */
    reqCount = 0;
    setDoneSink(fn) {
        this.doneSink = fn;
    }
    dispose() {
        for (const t of this.doneTimers.values())
            clearTimeout(t);
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
        for (const t of this.doneTimers.values())
            clearTimeout(t);
        this.doneTimers.clear();
        this.lastKind0ReqCount = 0;
        this.reqCount = 0;
    }
    projectLine(obj) {
        if (!obj || typeof obj !== 'object')
            return [];
        const out = [];
        // kind 0: full session snapshot (modern Copilot often rewrites whole file)
        if (obj.kind === 0) {
            out.push(...this.handleKind0Snapshot(obj.v));
            return out;
        }
        const k = obj.k;
        if (!Array.isArray(k) || k.length === 0)
            return out;
        // finalize markers (usually kind=1)
        if (k.length === 3 &&
            typeof k[1] === 'number' &&
            (k[2] === 'elapsedMs' || k[2] === 'result' || k[2] === 'isCanceled')) {
            const reqIndex = k[1];
            const endEvs = this.endActiveStreamsForRequest(reqIndex);
            const doneEv = {
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
        if (obj.kind !== 2)
            return out;
        if (k.length === 1 && k[0] === 'requests') {
            const v = obj.v;
            if (!Array.isArray(v))
                return out;
            // 真实请求下标：优先用变异自带的 splice 位置 obj.i（权威），
            // 缺失时回退到累计计数器。切勿使用载荷内部下标（恒为 0）。
            const base = typeof obj.i === 'number' && obj.i >= 0 ? obj.i : this.reqCount;
            for (let n = 0; n < v.length; n++) {
                const gi = base + n;
                out.push(...this.handleUserRequest(v[n], gi));
                // if request already has response parts in this mutation, project them
                if (Array.isArray(v[n]?.response) && v[n].response.length) {
                    out.push(...this.applyResponseMutation(`requests/${gi}/response`, gi, v[n].response, undefined));
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
    handleKind0Snapshot(v) {
        if (!v || typeof v !== 'object')
            return [];
        const reqs = v.requests;
        if (!Array.isArray(reqs))
            return [];
        const out = [];
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
            // if request looks finished, end streams
            if (req?.response && (req.result || req.elapsedMs != null)) {
                out.push(...this.endActiveStreamsForRequest(i));
            }
        }
        this.lastKind0ReqCount = reqs.length;
        // 快照重写后同步计数器，使后续 kind=2 append 能接在正确下标上
        this.reqCount = Math.max(this.reqCount, reqs.length);
        return out;
    }
    scheduleDone(reqIndex, ev) {
        const prev = this.doneTimers.get(reqIndex);
        if (prev)
            clearTimeout(prev);
        const t = setTimeout(() => {
            this.doneTimers.delete(reqIndex);
            this.doneSink?.(ev);
        }, DONE_DEBOUNCE_MS);
        this.doneTimers.set(reqIndex, t);
    }
    handleUserRequest(t, reqIndex) {
        const rid = t?.requestId ?? '';
        if (!rid || this.seenRequestIds.has(rid))
            return [];
        this.seenRequestIds.add(rid);
        const text = textOfUserReq(t);
        if (!text)
            return [];
        return [
            { type: 'USER_MESSAGE', text, requestId: rid, requestIndex: reqIndex },
            { type: 'COPILOT_TYPING', requestId: rid, requestIndex: reqIndex },
        ];
    }
    applyResponseMutation(pathKey, reqIndex, v, i) {
        let cur = this.respParts.get(pathKey) ?? [];
        if (typeof i !== 'number') {
            cur = Array.isArray(v) ? v.slice() : [];
        }
        else {
            if (!Array.isArray(cur))
                cur = [];
            const add = Array.isArray(v) ? v : [v];
            cur.splice(i, 0, ...add);
        }
        this.respParts.set(pathKey, cur);
        const blocks = renderBlocks(cur);
        const out = [];
        let textBlockIdx = 0;
        let stepIdx = 0;
        for (let n = 0; n < blocks.length; n++) {
            const b = blocks[n];
            if (b.type === 'text') {
                // stable stream id by text-slot index among text blocks only
                out.push(...this.emitTextStream(`${pathKey}#text#${textBlockIdx}`, b.text, reqIndex));
                textBlockIdx++;
            }
            else if (b.type === 'tool') {
                const toolKey = `${b.toolId ?? ''}|${b.text}|${b.isComplete ? 1 : 0}`;
                const mapKey = `${pathKey}#tool#${b.toolId ?? n}`;
                if (this.lastToolKey.get(mapKey) === toolKey)
                    continue;
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
            }
            else if (b.type === 'confirm') {
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
    emitTextStream(streamId, text, reqIndex) {
        const prev = this.lastEmittedText.get(streamId);
        if (prev === text)
            return [];
        const out = [];
        if (prev === undefined) {
            out.push({ type: 'AGENT_STREAM_START', streamId, requestIndex: reqIndex });
            out.push({ type: 'AGENT_STREAM_SET', streamId, text, requestIndex: reqIndex });
            this.activeStreams.set(streamId, reqIndex);
        }
        else if (text.startsWith(prev)) {
            const delta = text.slice(prev.length);
            if (!delta)
                return [];
            out.push({ type: 'AGENT_STREAM_CHUNK', streamId, text: delta, requestIndex: reqIndex });
            this.activeStreams.set(streamId, reqIndex);
        }
        else {
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
    finalizeAllStreams() {
        const out = [];
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
    endActiveStreamsForRequest(reqIndex) {
        const out = [];
        for (const [streamId, idx] of [...this.activeStreams.entries()]) {
            if (idx !== reqIndex)
                continue;
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
exports.JsonlProjector = JsonlProjector;
function textOfUserReq(t) {
    if (!t || typeof t !== 'object')
        return '';
    const msg = t.message;
    if (msg && typeof msg === 'object') {
        if (typeof msg.text === 'string')
            return msg.text;
        if (typeof msg.value === 'string')
            return msg.value;
        if (Array.isArray(msg.parts)) {
            return msg.parts
                .map((p) => (typeof p?.text === 'string' ? p.text : typeof p?.value === 'string' ? p.value : ''))
                .filter(Boolean)
                .join('');
        }
    }
    for (const key of ['text', 'prompt', 'content', 'value']) {
        if (typeof t[key] === 'string' && t[key])
            return t[key];
    }
    return '';
}
function contentValue(c) {
    if (c == null)
        return '';
    if (typeof c === 'string')
        return c;
    if (typeof c === 'object') {
        if (typeof c.value === 'string')
            return c.value;
        if (typeof c.text === 'string')
            return c.text;
        if (typeof c.content === 'string')
            return c.content;
    }
    return '';
}
function renderBlocks(parts) {
    const blocks = [];
    let textAcc = '';
    const flushText = () => {
        if (!textAcc)
            return;
        blocks.push({ type: 'text', text: textAcc });
        textAcc = '';
    };
    let stepCount = 0;
    for (const p of parts || []) {
        if (!p || typeof p !== 'object')
            continue;
        const kind = p.kind ?? '';
        if (IGNORE.has(kind))
            continue;
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
                buttons: Array.isArray(p.buttons) ? p.buttons.map((b) => (typeof b === 'string' ? b : b?.label || b?.title || 'OK')) : ['Continue', 'Cancel'],
            });
            continue;
        }
        // plain text parts: { value: "..." } or kind markdownContent
        if (!kind || kind === 'markdownContent' || kind === 'plainText') {
            const val = typeof p.value === 'string' ? p.value : contentValue(p);
            if (val)
                textAcc += val;
            continue;
        }
    }
    flushText();
    return blocks;
}
//# sourceMappingURL=jsonl.js.map