(() => {
  'use strict';

  // Lightweight mobile haptic feedback helper
  const Haptics = {
    vibrate(pattern) {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(pattern);
        }
      } catch (_) {}
    },
    tap() {
      this.vibrate(8);
    },
    stop() {
      this.vibrate(25);
    },
    success() {
      this.vibrate([10, 30, 15]);
    },
  };
  const USER_AVATAR_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 13s0-4 5-4 5 4 5 4H3z"/></svg>';
  const COPILOT_AVATAR_SVG =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1L6.5 3.5H3L1 6.5L3 9.5L1 12.5L3 15H6.5L8 12.5L9.5 15H13L15 12.5L13 9.5L15 6.5L13 3.5H9.5L8 1ZM8 4L9 5.5H11L12 7L11 8.5L12 10L11 11.5H9L8 13L7 11.5H5L4 10L5 8.5L4 7L5 5.5H7L8 4Z"/></svg>';

  const feed = document.getElementById('feed');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const sessionTitleEl = document.getElementById('sessionTitle');
  const DEFAULT_BRAND = 'Copilot Lazy Ass';
  let currentSessionMeta = { file: '', title: '' };

  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const modeEl = document.getElementById('mode');
  const confirmBar = document.getElementById('confirmBar');

  // 会话抽屉
  const btnSessions = document.getElementById('btnSessions');
  const drawerOverlay = document.getElementById('drawerOverlay');
  const sessionDrawer = document.getElementById('sessionDrawer');
  const sessionList = document.getElementById('sessionList');
  const drawerClose = document.getElementById('drawerClose');
  // 实例抽屉
  const btnInstances = document.getElementById('btnInstances');
  const instanceOverlay = document.getElementById('instanceOverlay');
  const instanceDrawer = document.getElementById('instanceDrawer');
  const instanceList = document.getElementById('instanceList');
  const instanceClose = document.getElementById('instanceClose');
  // 终端面板
  const btnTerminal = document.getElementById('btnTerminal');
  const terminalPanel = document.getElementById('terminalPanel');
  const terminalInput = document.getElementById('terminalInput');
  const terminalExec = document.getElementById('terminalExec');
  const terminalSelect = document.getElementById('terminalSelect');
  const terminalOutput = document.getElementById('terminalOutput');
  const terminalClose = document.getElementById('terminalClose');
  // 会话搜索框（抽屉顶部）
  const sessionSearch = document.getElementById('sessionSearch');
  // composer 控件条：模型 / 审批模式 trigger
  const btnModel = document.getElementById('btnModel');
  const btnModelLabel = document.getElementById('btnModelLabel');
  const btnPermission = document.getElementById('btnPermission');
  const btnPermissionLabel = document.getElementById('btnPermissionLabel');
  // 底部 sheet（模型 / 审批模式共用遮罩）
  const sheetOverlay = document.getElementById('sheetOverlay');
  const modelSheet = document.getElementById('modelSheet');
  const modelSheetClose = document.getElementById('modelSheetClose');
  const modelSearch = document.getElementById('modelSearch');
  const modelList = document.getElementById('modelList');
  const modelError = document.getElementById('modelError');
  const permissionSheet = document.getElementById('permissionSheet');
  const permissionSheetClose = document.getElementById('permissionSheetClose');
  const permissionList = document.getElementById('permissionList');
  const permissionError = document.getElementById('permissionError');

  /** streamId -> { element, bubble, bodyEl, statusHost, markdown, thinkingItem, statusKeys } 流式回合状态机 */
  const streamingTurns = new Map();
  /** toolId -> details element（工具调用卡片，全局去重） */
  const tools = new Map();
  /** 持久行的去重 key */
  const seenKeys = new Set();
  /** requestIndex -> streamId 映射，THINKING_STEP / PROGRESS_STEP 按 requestIndex 归位 */
  const reqToStream = new Map();
  /** 最近一次活跃的 streamId（无 streamId 事件回退用） */
  let lastActiveStreamId = null;
  /** 当前选中的终端 id */
  let currentTerminalId = null;

  /** 最近一次 SESSION_LIST 原始数据（搜索框过滤时复用，无需重新请求） */
  let lastSessions = [];
  /** 手动折叠/展开覆盖：workspaceId -> bool（true=展开）；未记录则按默认规则 */
  const wsGroupOpen = new Map();
  /** 抽屉打开期间冻结的会话排序（file→index）：新广播更新行数据但不再挤掉行位，防误点 */
  let sessionRowFreeze = null;
  /** 最近一次 MODEL_LIST；null = 尚未加载 */
  let modelsCache = null;
  /** 当前选中模型 id */
  let currentModelId = null;
  /** 最近一次 PERMISSION_LIST.levels；null = 尚未加载 */
  let permissionLevelsCache = null;
  /** 当前审批级别 id */
  let currentPermissionLevel = null;

  /** 会话切换超时回退定时器（防止 HISTORY_REPLAY 延迟或丢失时永久卡在「切换会话…」） */
  let sessionSwitchFallbackTimer = null;

  let ws;
  let reconnectTimer;
  let intentionalClose = false;
  let lastTunnelUrl = null;
  let reconnectAttempt = 0;
  /** 是否已经成功连上过一次（区分首次连接与断线重连） */
  let hasConnectedOnce = false;
  // 链路活性：服务端 8s 一次 PING 消息作应用层心跳；前台空闲时半死 socket
  // readyState 仍 OPEN，send() 成功返回但消息被吞——用最近入站时间判活性。
  let lastInboundAt = 0;
  const SOCKET_STALE_MS = 30000; // 3 个心跳周期未入站即判死
  let linkWatchdog = null;
  /** 用户选择的目标实例 ws 地址（localStorage 持久化）；null = 默认连接当前页面 host */
  let instanceUrlOverride = readStoredInstanceUrl();
  /** INSTANCE_LIST 响应超时兜底 timer（服务端未接线时显示空态） */
  let instanceListTimer = null;
  let vapidPublicKey = null;
  let pushSubscribed = false;
  let lastSysText = '';
  let lastSysAt = 0;
  let replaying = false;
  let typingEl = null;
  let typingTimer = null;
  /** 会话切换 / 历史回放期间：禁用 smooth 滚动，直接跳到底部（避免整段滑动动画） */
  let replayingInstant = false;
  /** 最近一次 HISTORY_REPLAY 覆盖到的最大事件 ts：ts 不晚于它的 live 事件
   *  是迟到重投影（激活 catch-up / sessiondb 轮询 / rewrite 重放），
   *  按内容查重丢弃；回放里没有的新内容仍照常渲染。 */
  let replayFloorTs = 0;
  /**
   * 当前是否有进行中的 Copilot 请求（对齐 VS Code 发送键 → Stop）。
   * true：按钮变「停止」；false：恢复「发送」。
   * 由 COPILOT_TYPING / STREAM_* 置位，COPILOT_DONE 清除。
   */
  let requestRunning = false;
  /** 停止需双击确认：空输入点击发送键先武装 3s，再点才真正停（防误触/打字未落框杀掉在途回复） */
  let stopArmUntil = 0;
  /** 本会话见过的最大 requestIndex（仅 live）：用于识别旧请求迟到的 DONE，
      防止把当前在途轮的发送键/队列提前释放 */
  let latestLiveReqIdx = -1;
  /** 最近 live USER 事件 ts：判 DONE 陈旧用（不带 requestIndex 的兜底通道 DONE） */
  let latestUserLiveTs = 0;
  /** COPILOT_DONE 防抖：agent 多 turn（tool 循环）中间 turn_end 也会 DONE，短延迟避免发送键闪烁 */
  let requestDoneTimer = null;
  /** 乐观用户消息短窗：textKey → at（与 bridge 回声去重，不永久禁同文） */
  const recentPhoneUserAt = new Map();
  const USER_TEXT_DEDUP_MS = 15000;
  const REQUEST_DONE_GRACE_MS = 600;
  /** 回放里刚画过的用户泡 → 迟到 live 回声去重窗口（chatSessions 写盘滞后可达 ~60s+） */
  const REPLAY_ECHO_DEDUP_MS = 120000;
  /** 待答条目阻塞发送队列的时限：超时视为死轮放行（真无回复不能永远卡队列） */
  // 待答条目挡队列的窗口：只挡「刚发出还没等到答案」的段（15s）。
  // 更长没有意义——发送核验 9s 会清未送达条目；真在途轮由 requestRunning 挡；
  // 120s 旧窗曾把孤儿条目挡足两分钟 → 跟随/回放后排队消息滞留 40-55s。
  const AWAIT_REPLY_FLUSH_BLOCK_MS = 15000;
  /**
   * 死流容忍窗口：最后一次 STREAM_* / COPILOT_TYPING 活动距现在超过该值，
   * 视为僵尸流——requests/N 开流后 END 被服务器端抑制时按钮会永远卡在「停止」。
   */
  const STREAM_STALE_MS = 75 * 1000;
  /** 待答条目仍计"活轮"的时限：须 > 上游实际 TTFT/超时（观测 ~90s+） */
  const STREAM_STALE_AWAIT_MS = 150 * 1000;
  /** 最后一次流活动（STREAM_* / COPILOT_TYPING / AGENT_MESSAGE）时间戳 */
  let lastStreamActivityAt = 0;
  /**
   * 发送后置核验：半死 socket 上 ws.send() 不抛异常但从未送达——
   * 送出后在 N 秒内等服务器 USER_MESSAGE 回声，超时判丢失并回填文本。
   */
  const SEND_VERIFY_MS = 9000;
  let pendingSendCheck = null;
  /** 核验计时器误报时间戳：送达确认若晚于误报到达，补一条「已送达」修正提示 */
  let sendVerifyMissedAt = 0;
  /** 误报后回填进输入框的文本：送达确认到达时若原样未动则自动清，勿留残渣 */
  let sendVerifyRestoredText = null;
  /** 送达确认后清回填残渣：仅当输入框内容仍与回填文本原样一致（用户没动过） */
  function clearRestoredIfConfirmed(confirmedText) {
    if (!sendVerifyRestoredText) return;
    if (confirmedText != null &&
        userTextDedupeKey(String(confirmedText)) !== userTextDedupeKey(sendVerifyRestoredText)) return;
    if ((input.value || '') === sendVerifyRestoredText) input.value = '';
    sendVerifyRestoredText = null;
  }
  /** 待发核验持久化 key：页面被半死 socket 刷新杀死内存计时器时，刷新后从这里回填 */
  const PENDING_SEND_KEY = 'sidecar.pendingSend';
  function persistPendingSend(text, key) {
    try { sessionStorage.setItem(PENDING_SEND_KEY, JSON.stringify({ text, key: key || '', at: Date.now(), sess: currentSessionMeta.file || '' })); } catch {}
  }
  /** pendingSend 属于发送时的会话：切到别会话后补画会造成跨会话残泡（R91）。 */
  function pendingSendSessOk(p) {
    if (!p || !p.sess) return true; // 旧记录无 sess 无法判定，按本会话处理
    const pBase = baseNameAny(p.sess).replace(/\.jsonl$/i, '');
    const boundBase = baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '');
    return !pBase || !boundBase || pBase === boundBase;
  }
  /** 已发出但未收到回答的用户消息（清屏/重放后重画用）；回声到达或回答完成即移除 */
  const sentAwaitingReply = [];
  /** 待答清单持久化：页面刷新把内存清单连同「发后落盘窗口」上下文一起蒸发——
      transcript 请求行只在轮次完成时写盘，发送后 ~1s 刷新的回放里该轮 USER 缺席，
      补画与未送达校验都无凭据 → 答案裸挂上一轮。快照进 sessionStorage，回放末段按
      「5min 内 + 本会话 + 回放 USER 缺席」恢复（已在回放里的说明轮已落盘无需跟踪）。 */
  const SENT_AWAITING_KEY = 'sidecar.sentAwaiting';
  function persistSentAwaiting() {
    try {
      const arr = sentAwaitingReply
        .filter((e) => e && typeof e.text === 'string' && e.text.trim())
        .map((e) => ({ text: e.text, key: e.key || '', sess: e.sess || '', at: e.at || Date.now() }));
      if (arr.length) sessionStorage.setItem(SENT_AWAITING_KEY, JSON.stringify(arr.slice(-8)));
      else sessionStorage.removeItem(SENT_AWAITING_KEY);
    } catch (_) {}
  }
  /** 回放渲染过的用户文 textKey→ts：跟随/重连回放后迟到的同文 live USER 回声据此吞掉 */
  const recentReplayedUserText = new Map();
  function clearPendingSend() {
    try { sessionStorage.removeItem(PENDING_SEND_KEY); } catch {}
    if (pendingSendCheck) { clearTimeout(pendingSendCheck.timer); pendingSendCheck = null; }
  }
  /**
   * 启动时检查：刷新前有未确认送达的消息 → 回填输入框。
   * 不消费 key——重连风暴可能连续多次 reload，读到即删会让二次刷新丢回填；
   * key 只在 USER 回声确认或下次发送覆写时清除。
   */
  function restorePendingSend() {
    try {
      const raw = sessionStorage.getItem(PENDING_SEND_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p.text !== 'string' || !p.text.trim()) {
        sessionStorage.removeItem(PENDING_SEND_KEY);
        return;
      }
      if (Date.now() - (p.at || 0) > 5 * 60 * 1000) {
        sessionStorage.removeItem(PENDING_SEND_KEY);
        return;
      }
      if (!(input.value || '').trim()) { input.value = p.text; sendVerifyRestoredText = p.text; }
      addSys('发送可能未送达（连接中断），文本已回填，请重新发送');
    } catch {}
  }
  const MAX_OUTBOUND_QUEUE = 20;
  const outboundQueue = [];
  /** 离线入队消息允许的最大滞留毫秒数——超过即丢弃，防止半死 socket 恢复后数分钟前的消息幽灵补发撞车 */
  const OUTBOUND_QUEUE_TTL_MS = 90000;
  /** 请求进行中用户再次输入的消息队列：排队而非停轮（发送键=有文本就排队，空文本才停止） */
  const pendingSendQueue = [];
  /** 排队消息持久化：页面刷新会把内存里的 pendingSendQueue 连同泡一起蒸发，
      回放后用 sessionStorage 副本把文本回填输入框（与切会话回填同语义，不自动重发）。 */
  const QUEUED_SENDS_KEY = 'sidecar.queuedSends';
  function persistQueuedSends() {
    try {
      const arr = [];
      for (const q of pendingSendQueue) {
        if (q && typeof q.text === 'string' && q.text.trim()) {
          arr.push({ text: q.text, at: q.at || Date.now(), sess: q.sess || currentSessionMeta.file || '' });
        }
      }
      if (arr.length) sessionStorage.setItem(QUEUED_SENDS_KEY, JSON.stringify(arr.slice(0, 8)));
      else sessionStorage.removeItem(QUEUED_SENDS_KEY);
    } catch (_) {}
  }
  /** 「已排队」提示元素：出队发走后移除，不再残留（R59 P3）。 */
  let queuedHintEl = null;
  /** 硬释放看门狗：DONE 触发的宽限释放链会被 setRequestRunning(true) 取消
      （迟到流事件重置 rr → 悬挂 ~100s 到僵尸看门狗）。DONE 判 release 时
      独立布一个 15s 检查：rr 仍在且流静默 ≥5s → 强制释放+出队。 */
  let releaseHardTimer = null;
  /** 看门狗体：rr 仍在且流静默 ≥5s → 强制释放；流还有活动则 15s 后再查
      （一次性失效会让「挡后新待答入列」的轮次永久卡停止态）。 */
  function hardReleaseCheck() {
    releaseHardTimer = null;
    if (!requestRunning) return;
    if (Date.now() - lastStreamActivityAt >= 5000) {
      markAllToolsDone();
      finishAllAssistantVisuals();
      requestRunning = false;
      paintSendButton();
      if (statusText && !replaying && !replayingInstant) {
        statusText.textContent = connectedLabel();
      }
      flushPendingSendQueue();
    } else {
      releaseHardTimer = setTimeout(hardReleaseCheck, 15000);
    }
  }

  /**
   * 鉴权 token：URL ?token= 优先，其次 localStorage（tunnel 开了 auth 时必须带）。
   * 0.5.20：无 token 连 3011 会 auth failed → close → 一直 connecting 的根因。
   */
  function pageToken() {
    try {
      const q = new URL(location.href).searchParams.get('token');
      if (q && String(q).trim()) {
        const t = String(q).trim();
        let persisted = false;
        try {
          localStorage.setItem('sidecar.authToken', t);
          persisted = localStorage.getItem('sidecar.authToken') === t;
        } catch {
          /* ignore */
        }
        if (persisted) {
          try {
            const clean = new URL(location.href);
            clean.searchParams.delete('token');
            history.replaceState(null, document.title, clean.pathname + clean.search + clean.hash);
          } catch {
            /* ignore */
          }
        }
        return t;
      }
    } catch {
      /* ignore */
    }
    try {
      const s = localStorage.getItem('sidecar.authToken');
      if (s && String(s).trim()) return String(s).trim();
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /** 读取持久化的目标实例地址（隐私模式等场景可能抛异常，静默降级） */
  function readStoredInstanceUrl() {
    try {
      return localStorage.getItem('sidecar.instanceUrl') || null;
    } catch {
      return null;
    }
  }

  /** 鉴权失败：停止死循环重连，给出可操作提示 */
  function onAuthFailed(detail) {
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    const tip =
      '鉴权失败：当前 bridge 需要 token。请用扩展面板二维码/链接打开（URL 带 ?token=），或在 channel.json 的 localUrl/publicUrl 复制完整地址。' +
      (detail ? ' (' + detail + ')' : '');
    setStatus(false, '鉴权失败');
    try {
      addSys(tip);
    } catch {
      /* ignore */
    }
    try {
      if (ws) ws.close();
    } catch {
      /* ignore */
    }
  }

  function isLoopbackHost(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }

  /** 当前连接地址：优先用户选中的实例（sidecar.instanceUrl），否则页面 host */
  function wsUrl() {
    const q = pageToken();
    let base = instanceUrlOverride;
    if (!base) {
      const u = new URL(location.href);
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      base = `${proto}//${u.host}`;
    }
    return q ? `${base}/?token=${encodeURIComponent(q)}` : base;
  }

  /** 顶部状态文字：tunnel 优先；其次显示选中实例端口（已连接 :3210） */
  function connectedLabel() {
    if (lastTunnelUrl) return '已连接 (tunnel)';
    if (instanceUrlOverride) {
      try {
        const p = new URL(instanceUrlOverride).port;
        if (p) return `已连接 :${p}`;
      } catch {
        /* 忽略非法地址 */
      }
    }
    return '已连接';
  }

  function setStatus(ok, text) {
    statusDot.className = 'dot ' + (ok ? 'ok' : 'bad');
    statusText.textContent = text;
    // 连接态与请求态解耦：断线才强制禁用；在线时由 requestRunning 决定发送/停止
    if (!ok) {
      sendBtn.disabled = true;
      sendBtn.textContent = '发送';
      sendBtn.classList.remove('is-stop');
      sendBtn.setAttribute('aria-label', '发送');
      return;
    }
    paintSendButton();
  }

  /** 同步发送键：空闲=发送 / 请求中=停止（对齐 VS Code composer） */
  function paintSendButton() {
    if (!sendBtn) return;
    if (requestRunning) {
      sendBtn.disabled = false;
      sendBtn.textContent = '停止';
      sendBtn.classList.add('is-stop');
      sendBtn.setAttribute('aria-label', '停止生成');
      sendBtn.title = '停止当前 Copilot 请求';
    } else {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
      sendBtn.classList.remove('is-stop');
      sendBtn.setAttribute('aria-label', '发送');
      sendBtn.title = '发送到 VS Code Copilot';
    }
  }

  function setRequestRunning(on, statusLabel, opts) {
    const force = !!(opts && opts.force);
    if (on) {
      if (requestDoneTimer) {
        clearTimeout(requestDoneTimer);
        requestDoneTimer = null;
      }
      requestRunning = true;
      // 新请求开始本身就是活动：否则首个流事件到达前的空窗里，
      // lastStreamActivityAt 还是上一轮的旧值，doSend/flush 的僵尸检查
      // （>STREAM_STALE_MS 判死）会把刚发起的活轮当死轮收尸 → 连发绕过
      // 排队直接插队广播（U1U2A1A2 回归形态）。
      lastStreamActivityAt = Date.now();
      paintSendButton();
      if (statusText) statusText.textContent = statusLabel || 'Copilot 正在输入…';
      return;
    }
    // off：先做一次「还有没有真在流」检查
    const anyStreamingNow = () => {
      for (const entry of streamingTurns.values()) {
        if (entry.element && entry.element.isConnected && entry.element.classList.contains('streaming')) {
          return true;
        }
      }
      return false;
    };
    if (requestDoneTimer) clearTimeout(requestDoneTimer);
    // force：立即结束（切会话 / stop / 取消），不给残影宽限
    if (force) {
      requestDoneTimer = null;
      for (const entry of streamingTurns.values()) {
        if (entry.element) entry.element.classList.remove('streaming');
        if (entry.bubble) entry.bubble.classList.remove('streaming');
      }
      requestRunning = false;
      paintSendButton();
      if (statusText && !replaying && !replayingInstant) {
        statusText.textContent = connectedLabel();
      }
      return;
    }
    // deferMs：DONE 可能提前于真实轮次结束（tool 循环/长 thinking 间隙、迟到
    // 的旧请求 DONE）——宽限内任何新流活动（setRequestRunning(true)）会取消
    // 本定时器；期满仍无活动才释放发送键。否则中途 DONE 会让按钮变回「发送」，
    // 长轮几乎无法从 PWA 停止。
    const deferMs = opts && typeof opts.deferMs === 'number' ? opts.deferMs : null;
    // 统一的延迟释放检查：残留 .streaming 元素 + 最近 5s 有流活动 → 中途 DONE，
    // 续查；残留但无活动 → 死流，清尾后释放。此前「仍有流就直接 return」是
    // 死路——残留元素不消失时按钮滞留 ~60s 直到下一个 DONE。
    const graceRelease = () => {
      requestDoneTimer = null;
      // 续查条件：最近 5s 有任何流活动（含发送打点/THINKING），不限于残留
      // .streaming 元素——中途 DONE/回执 DONE 后流仍在走，此时释放会让排队
      // 消息赶在 A1 前插队（U1U2A1A2 残余逃逸）。真轮终后必经历 5s 静默。
      if (Date.now() - lastStreamActivityAt < 5000) {
        requestDoneTimer = setTimeout(graceRelease, 1500);
        return;
      }
      // rr 在此刻真实落锁 = 客户端已判定本论终结——残余 running 工具卡
      // 一律收 done：END 的 !any 门跳过、DONE 全被 ack/stale 压制的轮
      // （实测 Autopilot 工具轮）走到这里才释放，缺这步徽章要干等到
      // transcript 尾帧 DONE 或下一轮顺带清扫（最差永久挂 running）。
      markAllToolsDone();
      finishAllAssistantVisuals();
      requestRunning = false;
      paintSendButton();
      if (statusText && !replaying && !replayingInstant) {
        statusText.textContent = connectedLabel();
      }
      flushPendingSendQueue();
    };
    if (deferMs != null) {
      requestDoneTimer = setTimeout(graceRelease, deferMs);
      return;
    }
    if (!anyStreamingNow()) {
      requestDoneTimer = null;
      requestRunning = false;
      paintSendButton();
      if (statusText && !replaying && !replayingInstant) {
        statusText.textContent = connectedLabel();
      }
      return;
    }
    // 仍有 streaming：短宽限等下一 turn
    requestDoneTimer = setTimeout(graceRelease, REQUEST_DONE_GRACE_MS);
  }

  function setSessionTitle(title, file) {
    if (file) currentSessionMeta.file = file;
    if (title != null) currentSessionMeta.title = String(title || '').trim();
    const label = currentSessionMeta.title || DEFAULT_BRAND;
    if (sessionTitleEl) {
      sessionTitleEl.textContent = label;
      sessionTitleEl.title = currentSessionMeta.file || label;
    }
  }

  function baseNameAny(p) {
    const parts = String(p || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  function titleFromSessionFile(file) {
    if (!file) return '';
    // prefer cache from last SESSION_LIST render
    try {
      if (window.__sessionTitleCache && window.__sessionTitleCache[file]) {
        return window.__sessionTitleCache[file];
      }
    } catch (_) {}
    const base = baseNameAny(file);
    return base.replace(/\.jsonl$/i, '').slice(0, 8) || '';
  }


  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** marked 配置：gfm + highlight 回调（hljs 精确匹配，highlightAuto 兜底） */
  function configureMarkdown() {
    try {
      if (window.marked && typeof window.marked.setOptions === 'function') {
        // 注意：marked v5+ 移除了 highlight 选项（不生效），代码高亮在
        // decorateCodeBlocks 中通过 hljs.highlightElement 手动完成。
        window.marked.setOptions({
          gfm: true,
          // 与官方 Copilot Chat 一致：breaks: true（单换行 → <br>）
          breaks: true,
          headerIds: false,
          mangle: false,
        });
      }
    } catch (e) {
      /* CDN 不可用或 marked 版本差异，静默降级 */
    }
  }

  /** marked + hljs 渲染；清理危险 HTML/JS 载荷防范 XSS，CDN 不可用时降级为 <pre> 包裹 */
  function sanitizeMarkdownHtml(html) {
    if (!html) return '';
    if (typeof DOMParser === 'undefined') {
      return String(html)
        .replace(/<\s*(script|style|iframe|object|embed|form|meta|link|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^>\s]+)/gi, '')
        .replace(/\s(?:href|src)\s*=\s*(['"]?)\s*(?:javascript|vbscript|data:\s*text\/html):/gi, ' href=$1about:blank#blocked-');
    }
    const allowed = new Set([
      'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'EM', 'H1', 'H2', 'H3', 'H4',
      'HR', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'SUMMARY', 'TABLE', 'TBODY', 'TD',
      'TH', 'THEAD', 'TR', 'UL', 'U',
    ]);
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    for (const node of Array.from(doc.body.querySelectorAll('*'))) {
      if (!allowed.has(node.tagName)) {
        if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|FORM|META|LINK|BASE|SVG|MATH|VIDEO|AUDIO|SOURCE)$/.test(node.tagName)) {
          node.remove();
        } else {
          const parent = node.parentNode;
          if (parent) {
            while (node.firstChild) parent.insertBefore(node.firstChild, node);
            node.remove();
          }
        }
        continue;
      }
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on') || name === 'style' || name === 'srcset' || name === 'id') {
          node.removeAttribute(attr.name);
          continue;
        }
        if (name === 'class') {
          const safeClasses = value.split(/\s+/).filter((c) => /^(language-[a-z0-9_+-]+|hljs)$/.test(c));
          if (safeClasses.length) node.setAttribute('class', safeClasses.join(' '));
          else node.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' && node.tagName === 'A') {
          try {
            const u = new URL(value, location.href);
            if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error('unsafe link');
            node.setAttribute('href', u.toString());
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          } catch {
            node.removeAttribute(attr.name);
          }
          continue;
        }
        if (name === 'src' && node.tagName === 'IMG') {
          try {
            const u = new URL(value, location.href);
            const sameOrigin = u.origin === location.origin && ['http:', 'https:'].includes(u.protocol);
            const dataImage = /^data:image\/(?:gif|jpe?g|png|webp);/i.test(value);
            if (!sameOrigin && !dataImage) throw new Error('unsafe image');
            node.setAttribute('src', sameOrigin ? u.toString() : value);
          } catch {
            node.removeAttribute(attr.name);
          }
          continue;
        }
        if (!['alt', 'title'].includes(name)) node.removeAttribute(attr.name);
      }
    }
    return doc.body.innerHTML;
  }

  function renderMarkdown(src) {
    const text = String(src || '').replace(/\r\n/g, '\n');
    if (!text) return '';
    try {
      if (window.marked && typeof window.marked.parse === 'function') {
        let html = window.marked.parse(text);
        if (html) {
          return sanitizeMarkdownHtml(html);
        }
      }
    } catch (e) {
      /* 降级到纯文本 */
    }
    return `<pre class="md-fallback-pre"><code>${escapeHtml(text)}</code></pre>`;
  }

  /** 给每个代码块加语言徽章 + Copy 按钮（幂等，davidobot decorateCodeBlocks） */
  function decorateCodeBlocks(container) {
    if (!container) return;
    const blocks = container.querySelectorAll('pre');
    for (const block of blocks) {
      if (block.querySelector('.code-header')) continue; // 幂等：已装饰过
      const code = block.querySelector('code');
      if (!code) continue;
      // 从 language- 类解析语言
      let language = '';
      for (const cls of code.classList) {
        if (cls.startsWith('language-')) {
          language = cls.replace('language-', '');
          break;
        }
      }
      // marked v5+ 不调用 highlight 回调 → 手动高亮（hljs.highlightElement）
      if (window.hljs && typeof window.hljs.highlightElement === 'function') {
        try {
          if (language && window.hljs.getLanguage(language)) {
            code.classList.add(`language-${language}`);
            window.hljs.highlightElement(code);
          } else if (!code.classList.contains('hljs')) {
            // 未知语言 → 自动检测兜底
            window.hljs.highlightElement(code);
          }
        } catch (e) {
          /* 高亮失败不阻塞 */
        }
      }
      const header = document.createElement('div');
      header.className = 'code-header';
      const langLabel = document.createElement('span');
      langLabel.className = 'code-language';
      langLabel.textContent = language || 'text';
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'copy-code';
      copyButton.textContent = 'Copy';
      copyButton.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.textContent || '');
          copyButton.textContent = 'Copied!';
          setTimeout(() => {
            copyButton.textContent = 'Copy';
          }, 1200);
        } catch (e) {
          /* 剪贴板不可用 */
        }
      });
      header.append(langLabel, copyButton);
      block.insertBefore(header, block.firstChild);
    }
  }

  let scrollRafId = null;
  /** 用户主动上滚持锁：只在真实滚轮/触摸向上时置位，滚回底部解除。
      此前用「距底 >96px」判定——大块流内容一次插入把 scrollHeight 拉高即
      误判为上滚，之后整轮长答不再跟底（R66 P3）。 */
  let userScrollHold = false;
  function feedIsAtBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 8;
  }
  function bindScrollHold() {
    if (!feed) return;
    const isAtBottom = feedIsAtBottom;
    feed.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) userScrollHold = true;
      else if (isAtBottom()) userScrollHold = false;
    }, { passive: true });
    let touchY = null;
    feed.addEventListener('touchstart', (e) => {
      touchY = e.touches && e.touches.length ? e.touches[0].clientY : null;
    }, { passive: true });
    feed.addEventListener('touchmove', (e) => {
      if (touchY == null || !(e.touches && e.touches.length)) return;
      const dy = e.touches[0].clientY - touchY;
      touchY = e.touches[0].clientY;
      // 手指下滑 = 内容上滚查看历史；上滑到底解除
      if (dy > 4) userScrollHold = true;
      else if (dy < -4 && isAtBottom()) userScrollHold = false;
    }, { passive: true });
    feed.addEventListener('scroll', () => {
      if (isAtBottom()) userScrollHold = false;
    }, { passive: true });
  }

  function scrollFeed(force) {
    // 回放期间完全禁止滚动——逐条渲染若每次 scroll，手机会从第一条一路滑到尾。
    if (replaying || replayingInstant) return;
    // 非强制且用户手动向上滑动翻阅历史时，不打断用户
    if (!force && userScrollHold) return;
    if (scrollRafId) cancelAnimationFrame(scrollRafId);
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      try { feed.style.scrollBehavior = 'auto'; } catch (_) {}
      feed.scrollTop = feed.scrollHeight;
    });
  }

  /** 回放结束一次 instant 定位到底部（双 rAF 等高度稳定） */
  function jumpFeedToBottom() {
    try { feed.style.scrollBehavior = 'auto'; } catch (_) {}
    requestAnimationFrame(function () {
      feed.scrollTop = feed.scrollHeight;
      requestAnimationFrame(function () {
        feed.scrollTop = feed.scrollHeight;
      });
    });
  }


  function clearTyping() {
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
    if (typingEl && typingEl.isConnected) typingEl.remove();
    typingEl = null;
  }

  function hideTypingLabel(root) {
    if (!root) return;
    const label = root.querySelector && root.querySelector('.typing-label');
    if (label) {
      label.style.display = 'none';
      label.classList.add('is-done');
    }
  }

  /**
   * 请求彻底结束时的视觉收尾：
   * - 去掉独立 typing-row
   * - 去掉所有助手行 streaming 类 / 光标
   * - 隐藏所有 typing-label（否则只 complete 单个 stream 时其它 turn 的 ••• 仍在跳）
   */
  function finishAllAssistantVisuals() {
    clearTyping();
    for (const entry of streamingTurns.values()) {
      if (entry.element) {
        entry.element.classList.remove('streaming');
        hideTypingLabel(entry.element);
      }
      if (entry.bubble) entry.bubble.classList.remove('streaming');
      const thinkingIcon = entry.element && entry.element.querySelector('.thinking-icon');
      if (thinkingIcon) {
        thinkingIcon.classList.remove('codicon-circle-filled');
        thinkingIcon.classList.add('codicon-check');
      }
      // 收尾补 markdown 渲染：流式期 bodyEl 是纯 textContent（**加粗**等原样裸露），
      // 无 STREAM_END 的流（回放 SET、DONE 收尾）到这一步仍是生文，补 marked 解析。
      if (entry.markdown && entry.bodyEl) renderEntryBody(entry);
    }
    feed.querySelectorAll('.msg.agent .typing-label').forEach((n) => {
      n.style.display = 'none';
      n.classList.add('is-done');
    });
    feed.querySelectorAll('.msg.agent.streaming').forEach((n) => n.classList.remove('streaming'));
    feed.querySelectorAll('.msg.agent .bubble.streaming').forEach((n) => n.classList.remove('streaming'));
  }

  function showTyping() {
    // 已有进行中的助手流时，只靠该行 meta 的 •••，不再叠独立 typing-row（避免双头像）
    let hasLiveStream = false;
    for (const entry of streamingTurns.values()) {
      if (entry.element && entry.element.isConnected && entry.element.classList.contains('streaming')) {
        hasLiveStream = true;
        break;
      }
    }
    if (hasLiveStream) {
      clearTyping();
      setRequestRunning(true, 'Copilot 正在输入…');
      return;
    }
    clearTyping();
    const el = document.createElement('div');
    el.className = 'msg agent typing-row';
    el.innerHTML =
      '<div class="chat-row">' +
      '<div class="chat-avatar copilot-avatar">' + COPILOT_AVATAR_SVG + '</div>' +
      '<div class="chat-content">' +
      '<div class="agent-meta"><span class="meta-name copilot-name">Copilot</span></div>' +
      '<div class="bubble agent-bubble typing-bubble">' +
      '<span class="typing-ellipsis"><i></i><i></i><i></i></span>' +
      '</div>' +
      '</div>' +
      '</div>';
    feed.appendChild(el);
    typingEl = el;
    setRequestRunning(true, 'Copilot 正在输入…');
    scrollFeed();
    typingTimer = setTimeout(clearTyping, 180000);
  }

  function userTextDedupeKey(text) {
    return 'user:' + String(text || '').trim().slice(0, 160);
  }

  function notePhoneUserText(text) {
    const k = userTextDedupeKey(text);
    recentPhoneUserAt.set(k, Date.now());
    seenKeys.add(k);
    setTimeout(() => {
      const at = recentPhoneUserAt.get(k);
      if (at && Date.now() - at >= USER_TEXT_DEDUP_MS - 50) {
        recentPhoneUserAt.delete(k);
        seenKeys.delete(k);
      }
    }, USER_TEXT_DEDUP_MS);
  }

  function isRecentPhoneUserText(text) {
    const k = userTextDedupeKey(text);
    const at = recentPhoneUserAt.get(k);
    if (at == null) return false;
    if (Date.now() - at > USER_TEXT_DEDUP_MS) {
      recentPhoneUserAt.delete(k);
      seenKeys.delete(k);
      return false;
    }
    return true;
  }

  function eventTsNum(o) {
    const t = Number(o && (o.ts != null ? o.ts : o.timestamp));
    return Number.isFinite(t) ? t : NaN;
  }

  function isStaleReplayEvent(ts) {
    return !replaying && !replayingInstant && replayFloorTs > 0 && Number.isFinite(ts) && ts <= replayFloorTs;
  }

  function userTextRendered(t) {
    const k = userTextDedupeKey(t);
    const nodes = feed.querySelectorAll('.msg.user');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].dataset.textKey === k) return true;
    return false;
  }

  function agentTextRendered(t) {
    const nodes = feed.querySelectorAll('.msg.agent .body');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].dataset.raw === t) return true;
    return false;
  }

  /** 归属 user 泡（与 appendFeedChronological 的 owner 判定一致）：
      ut 文本键优先（最后一条同文 user），否则最后一个 ts ≤ t 的 user，
      均无则取末尾 user。 */
  function ownerUserFor(ut, ts) {
    const users = feed.querySelectorAll('.msg.user');
    if (ut) {
      const want = userTextDedupeKey(String(ut));
      for (let i = users.length - 1; i >= 0; i--) {
        if (users[i].dataset.textKey === want) return users[i];
      }
    }
    const t = Number(ts);
    if (Number.isFinite(t) && t > 0) {
      for (let i = users.length - 1; i >= 0; i--) {
        const uts = Number(users[i].dataset.ts);
        if (Number.isFinite(uts) && uts <= t) return users[i];
      }
    }
    return users.length ? users[users.length - 1] : null;
  }

  /** 归属 user 泡下是否已有真答案——排除 selfSid 自身在产的卡（自产答案的
      流不应被判尾帧）。thinking/孤儿占位/utCopy 补画不算。 */
  function turnHasOtherAnswer(userEl, selfSid) {
    if (!userEl) return false;
    for (let n = userEl.nextElementSibling; n && !n.classList.contains('user'); n = n.nextElementSibling) {
      if (!n.classList.contains('agent') || n.classList.contains('typing-row')) continue;
      if (n.dataset.orphanPh || n.dataset.utCopy) continue;
      const b = n.querySelector('.body');
      if (b && String(b.dataset.raw || '').trim() && n.dataset.streamId !== selfSid) return true;
      const sid = n.dataset && n.dataset.streamId;
      const st = sid && sid !== selfSid ? streamingTurns.get(sid) : null;
      if (st && String(st.markdown || '').trim()) return true;
    }
    return false;
  }

  /** 指定 user 泡之下是否已有同文答案（含未收尾的流式卡；thinking/孤儿占位不算） */
  function answerUnderUser(userEl, text) {
    if (!userEl) return false;
    const want = String(text || '').trim();
    if (!want) return false;
    for (let n = userEl.nextElementSibling; n && !n.classList.contains('user'); n = n.nextElementSibling) {
      if (!n.classList.contains('agent') || n.classList.contains('typing-row')) continue;
      if (n.dataset.orphanPh || n.dataset.utCopy) continue;
      const b = n.querySelector('.body');
      if (b && String(b.dataset.raw || '').trim() === want) return true;
      const sid = n.dataset && n.dataset.streamId;
      const st = sid ? streamingTurns.get(sid) : null;
      if (st && String(st.markdown || '').trim() === want) return true;
    }
    return false;
  }


  /** User message — 官方 chat-row：avatar + "You" + 气泡 */
  function addUser(text, key, opts) {
    const t = String(text || '');
    const textKey = userTextDedupeKey(t);
    const force = !!(opts && opts.force);
    // 回放模式：跳过所有去重（同文「你好」在历史里多次出现是正常的）
    const isReplay = replaying || replayingInstant;
    // 权威 requestId key 已见过 → 丢（除非 force 乐观发送）
    if (!isReplay && !force && key && key.startsWith('user:') && key !== textKey && seenKeys.has(key)) {
      return null;
    }
    // 0.5.19：同文去重只吞「短窗内刚画过的手机回声」，不再扫历史 12 条。
    // 否则会话里曾经有过「1」，用户再发「1」会被静默丢掉（截图：远端无用户气泡）。
    if (!isReplay && !force && isRecentPhoneUserText(t)) {
      // 全量扫：迟到的重投影/回放副本可能把真泡顶出尾部窗口，按 DOM 位置限扫会漏
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= 0; i--) {
        const body = nodes[i].querySelector('.user-bubble');
        if (body && body.textContent === t) {
          // 吞掉回声后即消耗该记录：用户同文重问（>回声到达）不该被二次吞掉变裸文本
          recentPhoneUserAt.delete(textKey);
          seenKeys.delete(textKey);
          if (key) seenKeys.add(key);
          return null;
        }
      }
    }
    // 非 force 时：同 requestId / 同 textKey 已登记且非乐观损坏态 → 丢
    if (!isReplay && !force && key && seenKeys.has(key) && !isRecentPhoneUserText(t)) {
      return null;
    }
    // 回放刚含该条、迟到 live 同文回声（跟随/重连后文件二次写盘）→ 吞掉并消耗，
    // 用户真重发同文时第二次放行
    if (!isReplay && !force) {
      const rat = recentReplayedUserText.get(textKey);
      if (rat != null && Date.now() - rat <= REPLAY_ECHO_DEDUP_MS) {
        const nodes = feed.querySelectorAll('.msg.user');
        for (let i = nodes.length - 1; i >= 0; i--) {
          const body = nodes[i].querySelector('.user-bubble');
          if (body && body.textContent === t) {
            recentReplayedUserText.delete(textKey);
            if (key) seenKeys.add(key);
            return null;
          }
        }
      }
    }
    if (key) seenKeys.add(key);
    if (isReplay) recentReplayedUserText.set(textKey, Date.now());
    if (!isReplay && force) notePhoneUserText(t);
    clearTyping();
    const el = document.createElement('div');
    el.className = 'msg user';
    if (key) el.dataset.key = key;
    el.dataset.textKey = textKey;
    const row = document.createElement('div');
    row.className = 'chat-row';
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.innerHTML = USER_AVATAR_SVG;
    const content = document.createElement('div');
    content.className = 'chat-content';
    const name = document.createElement('span');
    name.className = 'sender-name';
    name.textContent = 'You';
    const bubble = document.createElement('div');
    bubble.className = 'bubble user-bubble';
    bubble.textContent = t;
    content.append(name, bubble);
    row.append(avatar, content);
    el.appendChild(row);
    const ts = opts && opts.ts != null ? opts.ts : (opts && opts.timestamp);
    appendFeedChronological(el, ts);
    scrollFeed();
    return el;
  }

  /** System pill (Remote hS) */
  function addSys(text) {
    const el = document.createElement('div');
    el.className = 'msg sys';
    const pill = document.createElement('span');
    pill.className = 'sys-pill';
    pill.textContent = text || '';
    el.appendChild(pill);
    feed.appendChild(el);
    scrollFeed();
    return el;
  }

  /**
   * 0.5.22：按事件 timestamp 插入 DOM，修复 chatSessions 迟到补全被 append 到末尾
   * 造成「用户气泡出现在旧助手回复上面/下面错乱」；无 timestamp 则 append。
   * 0.5.22b：回放（HISTORY_REPLAY）期间跳过按序插入——projectHistory 已按轮次
   * 交错排好，按 timestamp 重排反而把 user/agent 拆成两堆。只有 live 事件才需要。
   * R93：agent/tool 元素可携带 _ut（归属用户文）——同题重问时 ts 会归属错轮
   * （事件源 ts 与客户端泡 ts 不同时钟），按 ut 文本键锁到最后一条同名用户泡。
   */
  function appendFeedChronological(el, ts, ut) {
    if (!el || !feed) return;
    const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Number(ts);
    // ts 戳与插入顺序无关——回放元素也打：全 feed 无 ts 节点时，后续 live 事件
    // 的按序插入把它们全当「尾端」跳过，迟到件贴尾不归位（实测回放后
    // sessiondb 迟到对永久挂底）。
    if (Number.isFinite(t) && t > 0) el.dataset.ts = String(t);
    // 回放期间：projectHistory 已排好顺序，直接 append
    if (replaying || replayingInstant) {
      feed.appendChild(el);
      return;
    }
    const isAgent = el.classList && (el.classList.contains('agent') || el.classList.contains('tool-card'));
    if (isAgent) {
      const users = feed.querySelectorAll('.msg.user');
      let owner = null;
      if (ut) {
        const want = userTextDedupeKey(String(ut));
        for (let i = users.length - 1; i >= 0; i--) {
          if (users[i].dataset.textKey === want) { owner = users[i]; break; }
        }
      }
      if (!owner && Number.isFinite(t) && t > 0) {
        for (let i = users.length - 1; i >= 0; i--) {
          const ut = Number(users[i].dataset.ts);
          if (Number.isFinite(ut) && ut <= t) { owner = users[i]; break; }
        }
      }
      if (!owner) owner = users[users.length - 1] || null;
      if (owner) {
        let at = owner;
        let n = owner.nextSibling;
        while (n) {
          if (n.classList && n.classList.contains('user')) break;
          const nt = Number(n.dataset && n.dataset.ts);
          if (Number.isFinite(t) && Number.isFinite(nt) && nt > t) break;
          at = n;
          n = n.nextSibling;
        }
        if (at.nextSibling) feed.insertBefore(el, at.nextSibling);
        else feed.appendChild(el);
        return;
      }
    }
    if (!Number.isFinite(t) || t <= 0) {
      feed.appendChild(el);
      return;
    }
    const kids = feed.children;
    // 从尾部找第一个 ts > t 的节点，插到它前面
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = kids[i];
      if (!n || !n.dataset) continue;
      const nt = Number(n.dataset.ts);
      if (!Number.isFinite(nt)) continue;
      if (nt > t) {
        // 继续向前，找到第一个 <= t 的后面
        continue;
      }
      // n.ts <= t → 插到 n 后面
      if (n.nextSibling) feed.insertBefore(el, n.nextSibling);
      else feed.appendChild(el);
      return;
    }
    // 全部比 t 新，或没有带 ts 的节点：若有更新的，插到最前带 ts 的前面
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      const nt = n && n.dataset ? Number(n.dataset.ts) : NaN;
      if (Number.isFinite(nt) && nt > t) {
        feed.insertBefore(el, n);
        return;
      }
    }
    feed.appendChild(el);
  }

  /**
   * 同一用户回合内，连续助手片段是否应折叠「Copilot」头像/名：
   * - 上一可见消息是 agent（非 typing-row）→ 折叠
   * - 中间只隔 tool-card / step-group（工具是助手回合的一部分）→ 仍折叠
   * - 隔了 user / sys / confirm → 新开带头像的一组
   *
   * 0.5.19：step-group（「已完成 N 个步骤」）必须跳过，否则每个工具段后
   * 都会重新画出紫色 Copilot 头像（用户截图里重复三次的根因）。
   */
  function shouldContinueAssistantGroup() {
    const kids = feed.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = kids[i];
      if (!n || !n.classList) continue;
      if (n.classList.contains('typing-row')) continue;
      if (n.classList.contains('tool-card')) continue;
      if (n.classList.contains('step-group')) continue;
      if (n.classList.contains('agent')) return true;
      return false;
    }
    return false;
  }

  /** 开始一个助手回合（幂等）：已存在则复用 entry，否则创建 DOM 行 */
  function startAssistantTurn(streamId, opts) {
    const id = streamId || 'default';
    let entry = streamingTurns.get(id);
    if (entry && entry.element && entry.element.isConnected) return entry;

    clearTyping();
    const continued = shouldContinueAssistantGroup();
    const el = document.createElement('div');
    el.className = 'msg agent streaming' + (continued ? ' agent-continued' : '');
    el.dataset.streamId = id;
    if (continued) el.dataset.continued = '1';

    const row = document.createElement('div');
    row.className = 'chat-row';
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar copilot-avatar';
    avatar.innerHTML = COPILOT_AVATAR_SVG;
    const content = document.createElement('div');
    content.className = 'chat-content';

    const meta = document.createElement('div');
    meta.className = 'agent-meta' + (continued ? ' agent-meta-continued' : '');
    if (continued) {
      // 同组续写：不重复 Copilot 名，只保留流式 •••（完成时再藏）
      meta.innerHTML =
        '<span class="meta-sub typing-label"><span class="typing-ellipsis"><i></i><i></i><i></i></span></span>';
    } else {
      meta.innerHTML =
        '<span class="meta-name copilot-name">Copilot</span>' +
        '<span class="meta-sub typing-label"><span class="typing-ellipsis"><i></i><i></i><i></i></span></span>';
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble agent-bubble streaming';

    const statusHost = document.createElement('div');
    statusHost.className = 'assistant-status-host';

    const body = document.createElement('div');
    body.className = 'body md';

    bubble.append(statusHost, body);
    content.append(meta, bubble);
    row.append(avatar, content);
    el.appendChild(row);
    appendFeedChronological(el, opts && (opts.ts != null ? opts.ts : opts.timestamp), opts && opts.ut);

    entry = {
      id,
      element: el,
      bubble,
      bodyEl: body,
      statusHost,
      markdown: '',
      rafId: null,
      thinkingItem: null,
      statusKeys: new Set(),
      continued: !!continued,
    };
    streamingTurns.set(id, entry);
    lastActiveStreamId = id;
    // 已答轮尾帧不撑起 rr（与 frameRearms 同判据）：doneStreams 成员，或
    // _ut 归属轮已有非本流真答案的迟到流。
    const armOk =
      !doneStreams.has(id) &&
      !(opts && opts.ut &&
        turnHasOtherAnswer(
          ownerUserFor(opts.ut, opts.ts != null ? opts.ts : opts.timestamp),
          id,
        ));
    if (!replaying && armOk) setRequestRunning(true);
    scrollFeed();
    return entry;
  }

  /** 将容器内所有 <table> 包裹进 overflow-x:auto 容器（幂等） */
  function wrapTables(container) {
    if (!container) return;
    const tables = container.querySelectorAll('table');
    for (const table of tables) {
      const parent = table.parentElement;
      if (parent && parent.classList.contains('md-table-wrap')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'md-table-wrap';
      wrapper.style.overflowX = 'auto';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    }
  }

  /** 按 streamId → requestIndex → 最近活跃 → default 解析 entry（THINKING/PROGRESS 用） */
  function resolveEntryFor(msg) {
    let sid = msg.streamId;
    if (!sid && msg.requestIndex != null && reqToStream.has(msg.requestIndex)) {
      sid = reqToStream.get(msg.requestIndex);
    }
    if (!sid && lastActiveStreamId) sid = lastActiveStreamId;
    if (!sid) sid = 'default';
    const entry = streamingTurns.get(sid);
    if (entry && entry.element && entry.element.isConnected) return entry;
    // 直播期无活卡时：事件 ts 早于最新用户泡 >2s = 旧轮经慢通道迟到的
    // 思考/进度帧（归属轮已收尾，sid 常是已被复用的位置型僵尸 id）——为它
    // 新建流卡只会 appendChild 贴到 feed 底部挂进最新轮下。丢弃；活轮的
    // 早到思考帧 ts 是新鲜值不受影响。回放期豁免：历史思考帧必须照常渲染，
    // 它们靠 ts 锚定回自己那轮。
    const evTs = eventTsNum(msg);
    if (!replaying && !replayingInstant && Number.isFinite(evTs)) {
      const users = feed.querySelectorAll('.msg.user');
      const lastU = users.length ? users[users.length - 1] : null;
      const luTs = lastU ? Number(lastU.dataset.ts) : NaN;
      if (lastU && Number.isFinite(luTs) && evTs + 2000 < luTs) return null;
    }
    return startAssistantTurn(sid, { ut: msg && msg._ut, ts: evTs });
  }

  /** 慢通道流式重投压制：同文答案已在该轮（按 ts 归属的 user 泡之下）渲染时，
      不再创建流式卡——攒着文本等 END 时走 addAgentFinal 统一去重/补画。 */
  const suppressedStreams = new Map();

  /** 已答轮的残留流：DONE 放行轮次后归属流卡标记进本集合——其尾帧照常渲染/收尾，
      但不再计流活动（lastStreamActivityAt）、不再撑起 rr。否则 transcript 尾流
      把发送队列顶到 75s 收割窗才放出（实测 ~78s），目标 ~7s 出队。 */
  const doneStreams = new Set();

  /** 流帧是否应撑起 rr/计流活动。豁免两种尾帧：
      a) doneStreams 成员（DONE 已判其轮终）；
      b) 归属轮已有「非本流」真答案的迟到帧（transcript 尾流/跨通道重投影——
         内容照渲染，但不许再续命发送队列）。
      同题重问安全：_ut 归属取最新同文泡，未答新轮照常撑起。 */
  function frameRearms(msg) {
    const sid = (msg && msg.streamId) || 'default';
    if (doneStreams.has(sid)) return false;
    // 判重抑制流（transcript requests/N 通道晚于 sessiondb 答案到达被整流
    // 吞掉）——帧不渲也不该算流活动：尾部 END/碎片实测把发送键多卡 ~75s。
    if (suppressedStreams.has(sid)) return false;
    if (msg && msg._ut && turnHasOtherAnswer(ownerUserFor(msg._ut, msg.timestamp), sid)) return false;
    return true;
  }

  /** 流式增量刷新：用 textContent 显示纯文本（快速），rAF 合并同一帧多次 chunk */
  function scheduleStreamFlush(entry) {
    if (entry.rafId != null) return;
    entry.rafId = requestAnimationFrame(function () {
      entry.rafId = null;
      entry.bodyEl.textContent = entry.markdown;
      scrollFeed();
    });
  }

  /** 整段重渲染 body（marked + hljs + 代码块装饰 + 表格包裹）；取消流式 rAF */
  function renderEntryBody(entry) {
    if (entry.rafId != null) {
      cancelAnimationFrame(entry.rafId);
      entry.rafId = null;
    }
    entry.bodyEl.dataset.raw = entry.markdown;
    entry.bodyEl.innerHTML = renderMarkdown(entry.markdown);
    decorateCodeBlocks(entry.bodyEl);
    wrapTables(entry.bodyEl);
    scrollFeed();
  }

  /** AGENT_STREAM_SET：整段替换 */
  function setEntryMarkdown(streamId, text, ts, ut) {
    const sid = streamId || 'default';
    if (suppressedStreams.has(sid)) {
      suppressedStreams.set(sid, String(text || ''));
      return;
    }
    if (!streamingTurns.get(sid) && !replaying && !replayingInstant &&
        answerUnderUser(ownerUserFor(ut, ts), text)) {
      suppressedStreams.set(sid, String(text || ''));
      return;
    }
    const entry = startAssistantTurn(sid, { ts: ts, ut: ut });
    entry.markdown = String(text || '');
    if (ts != null && entry.element) entry.element.dataset.ts = String(ts);
    renderEntryBody(entry);
  }

  /** AGENT_STREAM_CHUNK：增量追加（仅纯文本追加 + rAF 合批，不调 marked.parse） */
  function appendAssistantChunk(streamId, chunk, ts, ut) {
    const sid = streamId || 'default';
    if (suppressedStreams.has(sid)) {
      suppressedStreams.set(sid, (suppressedStreams.get(sid) || '') + String(chunk || ''));
      return;
    }
    if (!streamingTurns.get(sid) && !replaying && !replayingInstant &&
        answerUnderUser(ownerUserFor(ut, ts), chunk)) {
      suppressedStreams.set(sid, String(chunk || ''));
      return;
    }
    const entry = startAssistantTurn(sid, { ts: ts, ut: ut });
    if (ts != null && entry.element && !entry.element.dataset.ts) entry.element.dataset.ts = String(ts);
    entry.markdown += String(chunk || '');
    scheduleStreamFlush(entry);
  }

  /** 助手消息完成后加 footer 操作栏（复制按钮；幂等，markdown 原文） */
  function maybeAddFooter(el, text) {
    if (!el || !text) return;
    if (el.querySelector('.msg-footer')) return; // 幂等：已有 footer
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'footer-btn copy';
    copyBtn.innerHTML =
      '<span class="codicon codicon-copy" aria-hidden="true"></span>' +
      '<span class="footer-label">复制</span>';
    copyBtn.addEventListener('click', async () => {
      const label = copyBtn.querySelector('.footer-label');
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // clipboard.writeText 在页面未聚焦/无权限时抛错——execCommand 兜底
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch {
          ok = false;
        }
      }
      if (label) {
        label.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => {
          label.textContent = '复制';
        }, 1200);
      }
    });
    footer.appendChild(copyBtn);
    el.appendChild(footer);
  }

  /** AGENT_STREAM_END / AGENT_MESSAGE：去掉 streaming 类（光标停止）；finalText 非空则覆盖 */
  function completeAssistantTurn(streamId, finalText, msg) {
    const sidKey = streamId || 'default';
    // 压制流的收尾：攒到的文本交给 addAgentFinal 统一判定（同文已渲则丢）
    if (suppressedStreams.has(sidKey)) {
      const acc = suppressedStreams.get(sidKey) || '';
      suppressedStreams.delete(sidKey);
      const ft = typeof finalText === 'string' && finalText ? finalText : acc;
      if (ft) {
        addAgentFinal(ft, 'agent:' + sidKey, {
          ts: msg ? eventTsNum(msg) : NaN,
          gapFill: !!(msg && msg.gapFill),
          streamId: sidKey,
          ut: msg && msg._ut,
        });
      }
      return;
    }
    const entry = streamingTurns.get(sidKey);
    // 同题重问第二答：上游复用首轮响应 → 慢通道把旧轮答案带「最新同文轮」的
    // _ut 重投（ts 继承首轮）。本 streamId 的卡锚在更早的同文 user 泡下时，
    // 这条投递属于新一轮——为最新轮补画一份（data-utCopy），旧卡留给自己的
    // END 收尾，不归位。
    if (entry && entry.element && entry.element.isConnected && msg && msg._ut &&
        !(replaying || replayingInstant) && typeof finalText === 'string' && finalText) {
      let anchor = entry.element;
      while (anchor && !anchor.classList.contains('user')) anchor = anchor.previousElementSibling;
      const uk = userTextDedupeKey(String(msg._ut));
      const users = feed.querySelectorAll('.msg.user');
      let lastMatch = null;
      for (let i = users.length - 1; i >= 0; i--) {
        if (users[i].dataset.textKey === uk) { lastMatch = users[i]; break; }
      }
      if (anchor && lastMatch && anchor !== lastMatch) {
        let hasAnswer = false;
        for (let n = lastMatch.nextElementSibling; n && !n.classList.contains('user'); n = n.nextElementSibling) {
          if (!n.classList.contains('agent') || n.classList.contains('typing-row')) continue;
          if (n.dataset.orphanPh) continue;
          const b = n.querySelector('.body');
          if (b && String(b.dataset.raw || '').trim()) { hasAnswer = true; break; }
          const sid2 = n.dataset && n.dataset.streamId;
          const st2 = sid2 ? streamingTurns.get(sid2) : null;
          if (st2 && String(st2.markdown || '').trim()) { hasAnswer = true; break; }
        }
        if (!hasAnswer) {
          const uts = Number(lastMatch.dataset.ts);
          const copy = addAgentFinal(finalText, null, {
            ts: Number.isFinite(uts) ? uts + 1 : eventTsNum(msg),
            gapFill: !!msg.gapFill,
            ut: msg._ut,
          });
          if (copy) copy.dataset.utCopy = '1';
          return;
        }
      }
    }
    if (!entry || !entry.element || !entry.element.isConnected) {
      if (typeof finalText === 'string' && finalText) {
        addAgentFinal(finalText, streamId ? 'agent:' + streamId : null, {
          ts: msg ? eventTsNum(msg) : NaN,
          gapFill: !!(msg && msg.gapFill),
          streamId: streamId,
          ut: msg && msg._ut,
        });
      }
      return;
    }
    if (typeof finalText === 'string' && finalText.length) {
      // 变体重投影：sessiondb/db 通道会发同答案的 markdown 剥壳版
      // （`file.js`→file.js、**粗体**→粗体），直接覆盖会丢格式。
      // 归一化（剥 markdown/空白）相同 = 同一份答案，保留更长的原始版。
      const existing = String(entry.markdown || '');
      if (existing && existing !== finalText) {
        const norm = (s) => String(s).replace(/[\s`*_~#>\-]+/g, '');
        if (norm(existing) === norm(finalText)) {
          if (finalText.length > existing.length) entry.markdown = finalText;
        } else {
          entry.markdown = finalText;
        }
      } else if (!existing) {
        entry.markdown = finalText;
      }
    }
    // 空壳回合（只有 Copilot 头 + •••，无正文/无 thinking/status）：直接移除，避免多枚空 Copilot 标
    const hasBody = !!(entry.markdown && String(entry.markdown).trim());
    const hasStatus = !!(entry.statusHost && entry.statusHost.childElementCount > 0);
    if (!hasBody && !hasStatus) {
      try { entry.element.remove(); } catch (_) {}
      streamingTurns.delete(streamId || 'default');
      return;
    }
    // 同文流式重投影：回放/别通道已把该轮正文画上屏，这张流式卡是迟到副本。
    // 流式路径不经 addAgentFinal 的同文去重，收尾时补查——按卡片自身锚定的
    // user 泡扫（不只末尾 user：锚在旧轮的卡收尾时最新轮已换）。
    if (entry.markdown && !replaying && !replayingInstant) {
      let anchorUser = entry.element;
      while (anchorUser && !anchorUser.classList.contains('user')) anchorUser = anchorUser.previousElementSibling;
      let dup = false;
      if (anchorUser) {
        for (let n = anchorUser.nextElementSibling; n && !n.classList.contains('user'); n = n.nextElementSibling) {
          if (n === entry.element) continue;
          if (n.dataset && (n.dataset.utCopy || n.dataset.orphanPh)) continue;
          if (!n.classList.contains('agent') || n.classList.contains('typing-row')) continue;
          const b = n.querySelector('.body');
          if (b && b.dataset.raw === entry.markdown) { dup = true; break; }
        }
      }
      if (dup) {
        try { entry.element.remove(); } catch (_) {}
        streamingTurns.delete(streamId || 'default');
        let anyLive = false;
        for (const e of streamingTurns.values()) {
          if (e.element && e.element.isConnected && e.element.classList.contains('streaming')) {
            anyLive = true;
            break;
          }
        }
        if (!anyLive) {
          clearTyping();
          feed.querySelectorAll('.msg.agent .typing-label').forEach((n) => {
            n.style.display = 'none';
            n.classList.add('is-done');
          });
          setRequestRunning(false);
        }
        return;
      }
    }
    entry.element.classList.remove('streaming');
    entry.bubble.classList.remove('streaming');
    const dot = entry.element.querySelector('.pulse-dot');
    if (dot) dot.classList.remove('streaming');
    hideTypingLabel(entry.element);
    const thinkingIcon = entry.element.querySelector('.thinking-icon');
    if (thinkingIcon) {
      thinkingIcon.classList.remove('codicon-circle-filled');
      thinkingIcon.classList.add('codicon-check');
    }
    if (entry.markdown) renderEntryBody(entry);
    else {
      if (entry.rafId != null) {
        cancelAnimationFrame(entry.rafId);
        entry.rafId = null;
      }
      entry.bodyEl.innerHTML = '';
    }
    maybeAddFooter(entry.element, entry.markdown);
    streamingTurns.delete(streamId || 'default');
    rescindOrphanPlaceholders();
    scrollFeed();
    // 该流结束后若没有其它 streaming 回合，收尾状态（防 ••• 与停止键残留）
    if (!replaying) {
      let any = false;
      for (const e of streamingTurns.values()) {
        if (e.element && e.element.isConnected && e.element.classList.contains('streaming')) {
          any = true;
          break;
        }
      }
      if (!any) {
        clearTyping();
        feed.querySelectorAll('.msg.agent .typing-label').forEach((n) => {
          n.style.display = 'none';
          n.classList.add('is-done');
        });
        // 与 END 处理同锚：流卡收尾只是「这条流」结束，不是轮终——轮中途
        // 的骨架/进度块 END 会走到这里。无条件即释会让在途态在静默窗内
        // 提前回弹（R29 实测连发仍逃逸）。统一宽限复查：≥5s 无活动才放。
        setRequestRunning(false, undefined, { deferMs: 3000 });
      }
    }
  }

  /** 独立助手消息（AGENT_MESSAGE 无 streamId 时），带去重 */
  function addAgentFinal(text, key, opts) {
    if (!text) return null;
    const isReplay = replaying || replayingInstant;
    // 回放模式：跳过 seenKeys 去重（历史里同文回复属于不同轮次，应各自显示）
    if (!isReplay && key) {
      if (seenKeys.has(key)) return null;
      seenKeys.add(key);
    }
    // 与已有 agent 消息去重：仅检查「最近一条 user 消息之后」的 agent 消息
    // （同 turn 防重复投递）；不同轮次相同回复文字（如 "123"）应各自显示。
    // 回放模式跳过此检查：同文回复在不同轮次是正常的。
    if (!isReplay) {
      const eventTs = Number(opts && (opts.ts != null ? opts.ts : opts.timestamp));
      const allMsgs = feed.children;
      let lastUserIdx = -1;
      for (let i = allMsgs.length - 1; i >= 0; i--) {
        if (allMsgs[i].classList.contains('user')) { lastUserIdx = i; break; }
      }
      const lastUser = lastUserIdx >= 0 ? allMsgs[lastUserIdx] : null;
      const lastUserTs = lastUser ? Number(lastUser.dataset.ts) : NaN;
      const lastUserIsNewerTurn =
        Number.isFinite(eventTs) && Number.isFinite(lastUserTs) && lastUserTs > eventTs;
      if (!lastUserIsNewerTurn) {
        for (let i = lastUserIdx + 1; i < allMsgs.length; i++) {
          const node = allMsgs[i];
          if (!node.classList.contains('agent') || node.classList.contains('typing-row')) continue;
          const body = node.querySelector('.body');
          if (!body) continue;
          if (body.dataset.raw === text) return null;
          // CHUNK 流式卡收尾前不写 dataset.raw：取 streamingTurns 的 markdown 比
          const sid = node.dataset && node.dataset.streamId;
          const st = sid ? streamingTurns.get(sid) : null;
          if (st && String(st.markdown || '').trim() === String(text).trim()) return null;
        }
      }
    }
    clearTyping();
    const continued = shouldContinueAssistantGroup();
    const el = document.createElement('div');
    el.className = 'msg agent' + (continued ? ' agent-continued' : '');
    if (continued) el.dataset.continued = '1';
    const row = document.createElement('div');
    row.className = 'chat-row';
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar copilot-avatar';
    avatar.innerHTML = COPILOT_AVATAR_SVG;
    const content = document.createElement('div');
    content.className = 'chat-content';
    const meta = document.createElement('div');
    meta.className = 'agent-meta' + (continued ? ' agent-meta-continued' : '');
    if (!continued) {
      meta.innerHTML = '<span class="meta-name copilot-name">Copilot</span>';
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble agent-bubble';
    const body = document.createElement('div');
    body.className = 'body md';
    body.dataset.raw = text;
    body.innerHTML = renderMarkdown(text);
    decorateCodeBlocks(body);
    wrapTables(body);
    bubble.appendChild(body);
    content.append(meta, bubble);
    row.append(avatar, content);
    el.appendChild(row);
    appendFeedChronological(el, opts && (opts.ts != null ? opts.ts : opts.timestamp), opts && opts.ut);
    // 独立助手消息完成 → 底部操作栏（复制按钮）
    maybeAddFooter(el, text);
    rescindOrphanPlaceholders();
    scrollFeed();
    return el;
  }

  /** 孤儿占位自清：误判画出的「该轮无回复」下，真答案后到就把占位撤掉。
      双向扫：迟到答案按源 ts 时序插入，可能落在占位【之前】（同一用户泡下、
      占位上方）——只向后扫会漏，形成「答案+无回复占位」同框矛盾。 */
  function rescindOrphanPlaceholders() {
    const phs = feed.querySelectorAll('.msg.agent[data-orphan-ph]');
    if (!phs.length) return;
    const hasAnswer = (sib) =>
      sib.classList &&
      sib.classList.contains('agent') &&
      !sib.classList.contains('typing-row') &&
      !sib.dataset.orphanPh &&
      (() => {
        const bd = sib.querySelector('.body');
        return bd && String(bd.dataset.raw || '').trim();
      })();
    const isUser = (sib) => sib.classList && sib.classList.contains('user');
    phs.forEach((ph) => {
      for (let n = ph.nextSibling; n; n = n.nextSibling) {
        if (isUser(n)) break;
        if (hasAnswer(n)) { ph.remove(); return; }
      }
      for (let n = ph.previousSibling; n; n = n.previousSibling) {
        if (isUser(n)) break;
        if (hasAnswer(n)) { ph.remove(); return; }
      }
    });
  }

  /** THINKING_STEP：statusHost 内折叠块，流式追加不重渲染 */
  function appendThinking(entry, text) {
    if (!entry || !text) return;
    if (!entry.thinkingItem) {
      const details = document.createElement('details');
      details.className = 'assistant-thinking-block';
      const summary = document.createElement('summary');
      summary.className = 'assistant-thinking-summary';
      // 官方 thinking 图标：streaming 时 codicon-circle-filled 旋转（CSS 控制），
      // 回合结束后由 completeAssistantTurn 换成 codicon-check
      summary.innerHTML = '<span class="thinking-icon codicon codicon-circle-filled" aria-hidden="true"></span><span>Thinking</span>';
      details.appendChild(summary);
      const pre = document.createElement('pre');
      pre.className = 'assistant-thinking-content';
      details.appendChild(pre);
      entry.statusHost.appendChild(details);
      entry.thinkingItem = pre;
    }
    entry.thinkingItem.textContent += text;
    scrollFeed();
  }

  /** PROGRESS_STEP：statusHost 内轻量进度条目（按 stepId/title 去重） */
  function appendStatus(entry, msg) {
    if (!entry) return;
    const title = String(msg.title || '').trim();
    if (!title) return;
    const key = msg.stepId != null ? `step:${msg.stepId}` : `title:${title}`;
    if (entry.statusKeys.has(key)) return;
    entry.statusKeys.add(key);
    const item = document.createElement('div');
    item.className = 'assistant-status-item';
    const kind = document.createElement('span');
    kind.className = 'assistant-status-kind';
    kind.textContent = 'progress';
    const text = document.createElement('span');
    text.className = 'assistant-status-text';
    text.textContent = msg.detail ? `${title} — ${msg.detail}` : title;
    item.append(kind, text);
    entry.statusHost.appendChild(item);
    scrollFeed();
  }

  /**
   * 把相邻已完成的 tool-card 收成「已完成 N 个步骤」（对齐桌面 Copilot）。
   * 仍在 running 的卡不收入；用户可点开 summary 展开明细。
   */
  function collapseCompletedToolSteps() {
    try {
      const kids = Array.from(feed.children || []);
      let i = 0;
      while (i < kids.length) {
        const node = kids[i];
        if (!node || !node.classList || !node.classList.contains('tool-card')) {
          i++;
          continue;
        }
        // 跳过已包进 step-group 的
        if (node.closest && node.closest('.step-group')) {
          i++;
          continue;
        }
        const run = [];
        let j = i;
        while (j < kids.length) {
          const n = kids[j];
          if (!n.classList.contains('tool-card')) break;
          if (n.closest && n.closest('.step-group')) break;
          const badge = n.querySelector('.tool-badge');
          const isRun = badge && badge.classList.contains('running');
          if (isRun) break;
          run.push(n);
          j++;
        }
        if (run.length >= 1) {
          // 单卡也包一层，统一「已完成 N 个步骤」文案（N=1 时与桌面一致）
          const group = document.createElement('div');
          group.className = 'msg step-group';
          const details = document.createElement('details');
          details.className = 'step-group-details';
          // 默认折叠
          details.open = false;
          const summary = document.createElement('summary');
          summary.className = 'step-group-summary';
          summary.innerHTML =
            '<span class="codicon codicon-check step-group-icon" aria-hidden="true"></span>' +
            `<span class="step-group-label">已完成 ${run.length} 个步骤</span>` +
            '<span class="codicon codicon-chevron-down step-group-chevron" aria-hidden="true"></span>';
          const body = document.createElement('div');
          body.className = 'step-group-body';
          details.append(summary, body);
          group.appendChild(details);
          feed.insertBefore(group, run[0]);
          for (const card of run) {
            // 组内卡片默认折叠 details
            const td = card.querySelector('details.tool-details');
            if (td) td.open = false;
            body.appendChild(card);
          }
          // 刷新 kids 引用
          kids.splice(i, run.length, group);
          i++;
          continue;
        }
        i++;
      }
    } catch (_) {
      /* DOM 异常不阻断 */
    }
  }

  /** 强制所有未完成 tool-card → done，并折叠步骤组（COPILOT_DONE / STREAM_END） */
  function markAllToolsDone() {
    try {
      for (const [, el] of tools) {
        if (!el || !el.isConnected) continue;
        const badge = el.querySelector('.tool-badge');
        if (badge && badge.classList.contains('running')) {
          badge.className = 'tool-badge done';
          badge.innerHTML =
            '<span class="codicon codicon-check" aria-hidden="true"></span>done';
          const ph = el.querySelector('.tool-pend-hint');
          if (ph) ph.remove();
          // 单调完成须落 toolDone 标记：transcript 尾帧会在 DONE 之后重投同一
          // TOOL_CALL（isComplete=false），无标记则 upsertTool 把徽章打回
          // running 且再无 DONE 翻回——卡永久停在 running（实测排队轮复现）。
          el.dataset.toolDone = '1';
        }
        const details = el.querySelector('details.tool-details');
        if (details) details.open = false;
      }
      collapseCompletedToolSteps();
    } catch (_) {}
  }

  /** Remote fS: independent collapsible tool card（toolId 去重，状态徽章增强） */
  function upsertTool(msg) {
    const toolId = msg.toolId || `tool:${String(msg.text || '').slice(0, 80)}`;
    let el = tools.get(toolId);
    // 单调完成：一旦 done，后续缺省/false 的残影不得把徽章打回 running
    const prevDone = !!(el && el.dataset && el.dataset.toolDone === '1');
    const running = prevDone ? false : msg.isComplete === false;
    const confirmed = msg.isConfirmed === true;
    let inputStr = '';
    if (msg.input != null) {
      try {
        inputStr = typeof msg.input === 'string' ? msg.input : JSON.stringify(msg.input, null, 2);
      } catch {
        inputStr = String(msg.input);
      }
    }
    const resultStr =
      msg.result != null ? (typeof msg.result === 'string' ? msg.result : String(msg.result)) : '';

    if (!el || !el.isConnected) {
      clearTyping();
      // 新 running 工具出现前，先把前面已完成的收成「已完成 N 步」
      collapseCompletedToolSteps();
      el = document.createElement('div');
      el.className = 'msg tool-card';
      el.dataset.toolId = toolId;
      el.innerHTML =
        '<details class="tool-details">' +
        '<summary class="tool-summary">' +
        '<span class="tool-gear codicon codicon-gear" aria-hidden="true"></span>' +
        '<span class="tool-title"></span>' +
        '<span class="tool-badge"></span>' +
        '</summary>' +
        '<div class="tool-body"></div>' +
        '</details>';
      appendFeedChronological(el, msg && (msg.ts != null ? msg.ts : msg.timestamp));
      tools.set(toolId, el);
    }

    const title = el.querySelector('.tool-title');
    const badge = el.querySelector('.tool-badge');
    const body = el.querySelector('.tool-body');
    // 标题：优先 tool 名；有简短 input.command 时桌面风格「已运行 cmd」
    let displayTitle = msg.text || 'tool';
    try {
      const inp = msg.input;
      if (inp && typeof inp === 'object') {
        if (typeof inp.command === 'string' && inp.command.trim()) {
          const cmd = inp.command.trim().replace(/\s+/g, ' ');
          displayTitle = (running ? '正在运行 ' : '已运行 ') + (cmd.length > 72 ? cmd.slice(0, 72) + '…' : cmd);
        } else if (typeof inp.query === 'string' && inp.query.trim()) {
          const q = inp.query.trim();
          displayTitle = (msg.text || 'search') + ': ' + (q.length > 48 ? q.slice(0, 48) + '…' : q);
        }
      }
    } catch (_) {}
    title.textContent = displayTitle;
    // 状态徽章：running（codicon-loading 旋转）/ done（codicon-check）/ confirmed（已确认）
    badge.innerHTML = confirmed
      ? '<span class="codicon codicon-check" aria-hidden="true"></span>已确认'
      : running
        ? '<span class="codicon codicon-loading" aria-hidden="true"></span>running'
        : '<span class="codicon codicon-check" aria-hidden="true"></span>done';
    badge.className = 'tool-badge ' + (confirmed ? 'confirmed' : running ? 'running' : 'done');
    if (!running) {
      el.dataset.toolDone = '1';
      const ph = el.querySelector('.tool-pend-hint');
      if (ph) ph.remove();
    }
    // 长时 running 提示：Copilot 0.67 的工具审批「待批准」态在获批前不产生
    // 任何 transcript/sessiondb 事件——客户端只能看到 run_in_terminal 等卡
    // 一直 running（实测 Get-Content 挂 ~100s 直到桌面点 Allow）。>20s 未完结
    // 就标注原因，用户才知道该去 VS Code 端批准。
    if (el.__pendTimer) { clearTimeout(el.__pendTimer); el.__pendTimer = null; }
    if (running && !confirmed) {
      el.__pendTimer = setTimeout(() => {
        el.__pendTimer = null;
        const b = el.querySelector('.tool-badge');
        if (!b || !b.classList.contains('running') || !el.isConnected) return;
        if (el.querySelector('.tool-pend-hint')) return;
        const hint = document.createElement('div');
        hint.className = 'tool-pend-hint';
        hint.textContent = '仍在运行 · 可能正等待 VS Code 端审批';
        const body = el.querySelector('.tool-body');
        if (body) body.appendChild(hint);
      }, 20000);
    }

    let html = '';
    if (inputStr && inputStr !== '{}' && inputStr !== 'null') {
      html += `<div class="tool-section"><div class="tool-label">Input:</div><pre class="tool-pre">${escapeHtml(inputStr)}</pre></div>`;
    }
    if (resultStr) {
      html += `<div class="tool-section border"><div class="tool-label">Result:</div><pre class="tool-pre">${escapeHtml(resultStr)}</pre></div>`;
    }
    // 仅 input/result 变化时重写 body，避免 complete 事件清空已有内容
    if (html) body.innerHTML = html;
    // keep open while running, collapse when done (user can re-open)
    const details = el.querySelector('details');
    if (running) {
      details.open = true;
    } else {
      details.open = false;
      // 完成时尝试把连续 done 卡收组
      collapseCompletedToolSteps();
    }
    scrollFeed();
    return el;
  }

  function showConfirm(msg) {
    // Inline feed card (Remote pS) + sticky bar for thumb reach
    const buttons = Array.isArray(msg.buttons) && msg.buttons.length ? msg.buttons : ['Continue', 'Cancel'];
    const confirmId = msg.confirmId || msg.requestId || msg.toolCallId || null;
    let resolved = false;
    const el = document.createElement('div');
    el.className = 'msg confirm-card';
    const title = document.createElement('div');
    title.className = 'confirm-title';
    title.textContent = msg.title || 'Confirm';
    const body = document.createElement('div');
    body.className = 'confirm-body';
    body.textContent = msg.message || '';
    const row = document.createElement('div');
    row.className = 'confirm-btns';
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.textContent = b;
      const low = String(b).toLowerCase();
      const isCancel = low.includes('cancel') || low.includes('no');
      btn.className = isCancel ? 'btn-cancel' : 'btn-primary';
      btn.onclick = () => {
        if (resolved) return;
        resolved = true;
        Haptics.tap();
        send({ type: 'PHONE_CONFIRM', button: b, confirmId, requestId: msg.requestId, toolCallId: msg.toolCallId });
        el.classList.add('resolved');
        row.remove();
        body.textContent = `已发送: ${b}`;
        confirmBar.classList.add('hidden');
      };
      row.appendChild(btn);
    });
    el.append(title, body, row);
    feed.appendChild(el);
    scrollFeed();

    // sticky bar
    confirmBar.classList.remove('hidden');
    confirmBar.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = msg.title || '需要确认';
    const p = document.createElement('p');
    p.textContent = msg.message || '';
    const barRow = document.createElement('div');
    barRow.className = 'btns';
    buttons.forEach((b, i) => {
      const btn = document.createElement('button');
      btn.textContent = b;
      if (i === 0) btn.className = 'primary';
      btn.onclick = () => {
        if (resolved) return;
        resolved = true;
        Haptics.tap();
        send({ type: 'PHONE_CONFIRM', button: b, confirmId, requestId: msg.requestId, toolCallId: msg.toolCallId });
        confirmBar.classList.add('hidden');
        addSys(`已发送确认: ${b}`);
      };
      barRow.appendChild(btn);
    });
    confirmBar.append(h, p, barRow);
  }

  function clearFeed() {
    feed.innerHTML = '';
    streamingTurns.clear();
    tools.clear();
    seenKeys.clear();
    reqToStream.clear();
    lastActiveStreamId = null;
    lastSysText = '';
    lastSysAt = 0;
    recentPhoneUserAt.clear();
    clearTyping();
    if (requestDoneTimer) {
      clearTimeout(requestDoneTimer);
      requestDoneTimer = null;
    }
    requestRunning = false;
    paintSendButton();
    confirmBar.classList.add('hidden');
  }

  function shouldSkipSys(text) {
    const t = String(text || '');
    if (!t) return true;
    if (t.startsWith('Watching session:')) return true;
    if (t === 'sidecar companion connected' || t.startsWith('sidecar companion connected') || t === 'lazy ass companion connected' || t.startsWith('lazy ass companion connected') || t.toLowerCase().includes('companion connected')) return true;
    if (/^回放\s+\d+\s*条历史/.test(t) && replaying) return false;
    const now = Date.now();
    if (t === lastSysText && now - lastSysAt < 4000) return true;
    lastSysText = t;
    lastSysAt = now;
    return false;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function canUsePush() {
    const host = location.hostname;
    const secure =
      location.protocol === 'https:' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]';
    return (
      secure &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  async function subscribePush(publicKey) {
    if (!publicKey || pushSubscribed || !canUsePush()) return;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        const existingKey =
          sub.options && sub.options.applicationServerKey
            ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '')
            : null;
        if (existingKey && existingKey !== publicKey) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      send({ type: 'PHONE_PUSH_SUBSCRIBE', subscription: sub.toJSON() });
      pushSubscribed = true;
    } catch (e) {
      console.warn('push subscribe failed', e);
    }
  }

  // 死流看门狗：每 10s 检查一次流活性，静默超阈值自动收尸
  setInterval(() => {
    // 尚有未超龄的待答条目 = 回声已确认、上游仍在处理——慢上游（TTFT 实测
    // ~90s+）不能按 75s 静默判死，否则活轮被提前释放，下条发送绕过排队
    // 直接插队（U1U2A1A2 回归形态）。窗口独立于 AWAIT_REPLY_FLUSH_BLOCK_MS
    // （15s 只管"刚发未答挡队"语义，此处要覆盖上游超时上限）。
    const stillAwaitingReply =
      sentAwaitingReply.length > 0 &&
      sentAwaitingReply.some((e) => Date.now() - (e.at || 0) < STREAM_STALE_AWAIT_MS);
    if (
      requestRunning &&
      !stillAwaitingReply &&
      lastStreamActivityAt &&
      Date.now() - lastStreamActivityAt > STREAM_STALE_MS
    ) {
      forceFinishDeadStream();
    }
  }, 10 * 1000);

  /** 待发消息的用户泡缺失（排队发送/回放清空/回声被吞）时补画，防「答案裸奔」。
   *  用发送时存的 localKey：与 doSend 乐观画泡同键，已画过则由 seenKeys 去重不双泡 */
  function ensurePendingUserBubble() {
    try {
      const raw = sessionStorage.getItem(PENDING_SEND_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p.text !== 'string' || !p.text.trim()) return;
      if (!pendingSendSessOk(p)) return;
      let found = false;
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= 0; i--) {
        const body = nodes[i].querySelector('.user-bubble');
        if (body && body.textContent === p.text) { found = true; break; }
      }
      if (!found) addUser(p.text, p.key || `user:pending:${Date.now()}:${userTextDedupeKey(p.text)}`, { force: true, ts: p.at || Date.now() });
    } catch (_) {}
    repaintAwaitingUserBubbles();
  }
  /** 重放/清屏后补画「已发未答」的用户泡（待发路径只覆盖 pendingSend 一条） */
  function repaintAwaitingUserBubbles() {
    const boundBase = baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '');
    for (const m of sentAwaitingReply) {
      // 只补画当前会话的条目：sess 属别会话或 sess 缺失（发送时绑定未定）
      // 的不该出现在本 feed——缺失也拦，否则在途切会话时残泡复活（R94）。
      const mBase = baseNameAny(m.sess || '').replace(/\.jsonl$/i, '');
      if (!boundBase || mBase !== boundBase) continue;
      let found = false;
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= 0; i--) {
        const body = nodes[i].querySelector('.user-bubble');
        if (body && body.textContent === m.text) { found = true; break; }
      }
      if (!found) addUser(m.text, m.key, { force: true, ts: m.at || Date.now() });
    }
  }

  function handle(msg) {
    if (!msg || !msg.type) return;
    // 同文 USER 回声无论在哪个会话到达都证明桥端已收——误报回填的原样
    // 文本在这就清（放在 _sess/foreign 过滤之前，否则别会话回声/重连
    // 窗口会把残渣留在输入框）。
    if (msg.type === 'USER_MESSAGE') clearRestoredIfConfirmed(msg.text);
    // 别会话的桌面消息：系统行提示而不是用户泡——否则 foreign 事件无 _sess 打标时
    // 穿过过滤冒充当前会话的发言，看起来像本会话的轮次（实测漏泡根因）。
    if (msg.type === 'USER_MESSAGE' && msg.foreign === true) {
      const sid = String(msg._sess || '');
      // 本会话文件被 foreign 扫描误投（模型切换重写文件触发尾部重读）：
      // live 通道已渲过同一条，静默丢——不能渲成【其他会话】系统行冒充别会话发言。
      const bound0 = currentSessionMeta.file
        ? baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '')
        : '';
      if (bound0 && sid === bound0) return;
      const want = sid + '.jsonl';
      let label = '其他会话';
      const cache = window.__sessionTitleCache || {};
      for (const k in cache) {
        if (baseNameAny(k) === want) {
          label = cache[k];
          break;
        }
      }
      addSys(`【${label}】${String(msg.text || '')}`);
      return;
    }
    // 跨会话事件过滤：服务端给 live 事件打 _sess（绑定会话 id）；与当前绑定不符的
    // 直接丢弃，防别会话 USER/AGENT 泡漏进当前 feed（回放类消息不带 _sess 不拦）。
    if (msg._sess && currentSessionMeta.file) {
      const bound = baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '');
      if (bound && String(msg._sess) !== bound) return;
    }
    // 跟踪本会话 live 最大 requestIndex：识别旧请求迟到的 DONE
    if (!replaying && typeof msg.requestIndex === 'number' && msg.requestIndex > latestLiveReqIdx) {
      latestLiveReqIdx = msg.requestIndex;
    }
    switch (msg.type) {
      case 'AUTH_FAILED':
        outboundQueue.length = 0;
        onAuthFailed(msg.reason || msg.text || '');
        break;
      case 'SYSTEM_MESSAGE': {
        if (msg.visibility === 'internal' || msg.internal === true) break;
        const t = String(msg.text || '');
        // 服务端落盘核验失败（inject 宣称送达但 transcript 无此轮）→ 销待答
        // 条目 + 原文回填输入框。泡不删：同文旧轮的泡会误删，让 sys 提示解释。
        try {
          if (msg.notPersisted) {
            const npKey = userTextDedupeKey(String(msg.notPersisted));
            for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
              if (userTextDedupeKey(sentAwaitingReply[i].text) === npKey) sentAwaitingReply.splice(i, 1);
            }
            if (!(input.value || '').trim()) {
              input.value = String(msg.notPersisted);
              sendVerifyRestoredText = String(msg.notPersisted);
            }
          }
        } catch (_) {}
        // auth failed 曾只关 socket → PWA 无限重连显示 connecting
        if (/auth failed/i.test(t) || /auth required/i.test(t)) {
          onAuthFailed(t);
          break;
        }
        if (shouldSkipSys(t)) break;
        addSys(t);
        break;
      }
      case 'USER_MESSAGE': {
        // 发送核验：自己的消息被服务器回声了 = 真送达，撤銷核验计时。
        // 但回声须来自当前绑定会话——绑定/桌面活跃分叉时（P2），别会话里同文
        // 的迟到的 USER 回声会误清核验，把一次真吞包伪装成已送达。
        const echoSessOk = (() => {
          if (!msg._sess) return true;
          const bound = baseNameAny(currentSessionMeta.file || '').replace(/\.jsonl$/i, '');
          const mBase = baseNameAny(msg._sess).replace(/\.jsonl$/i, '');
          return !bound || !mBase || bound === mBase;
        })();
        if (
          pendingSendCheck &&
          echoSessOk &&
          userTextDedupeKey(msg.text || '') === pendingSendCheck.textKey
        ) {
          clearTimeout(pendingSendCheck.timer);
          pendingSendCheck = null;
        }
        // 收到 USER 回声 = 送达确认：若与持久化的待发文本同文，清掉防误回填
        // （同样须当前会话回声——别会话的同文回声不得清）
        try {
          const raw = sessionStorage.getItem(PENDING_SEND_KEY);
          if (raw && echoSessOk) {
            const p = JSON.parse(raw);
            if (p && userTextDedupeKey(msg.text || '') === userTextDedupeKey(p.text || '')) {
              sessionStorage.removeItem(PENDING_SEND_KEY);
            }
          }
        } catch {}
        // 迟到重投影（ts ≤ 回放覆盖范围）且同文已在屏 → 丢弃，防用户泡堆叠
        if (isStaleReplayEvent(eventTsNum(msg)) && userTextRendered(msg.text || '')) break;
        if (!replaying) {
          const uts = eventTsNum(msg);
          if (Number.isFinite(uts) && uts > latestUserLiveTs) latestUserLiveTs = uts;
        }
        // requestId 优先；否则文案 key。addUser 短窗去重吞掉 doSend 乐观与 bridge 回声。
        const key = msg.requestId
          ? `user:${msg.requestId}`
          : userTextDedupeKey(msg.text || '');
        // ts 取 eventTsNum：无 requestId 的回声（soft-unverified 注入路径）只带
        // 事件级 ts 不带内层 timestamp——不兜底则泡无 dataset.ts，后续按时序插入
        // 的元素会把无 ts 泡当「尾端」跳过、插到它前面 → 新轮排在在途轮之前。
        addUser(msg.text || '', key, { ts: eventTsNum(msg) });
        // 回声只证明消息入列，不证明泡仍在 feed（clearFeed 随时可能抹掉）。
        // 待答清单刻意保留到答案落地（AGENT_MESSAGE._ut 匹配或真 DONE）才释放。
        break;
      }
      case 'CONNECTED_ACK':
        if (msg.vapidPublicKey) {
          vapidPublicKey = msg.vapidPublicKey;
          subscribePush(vapidPublicKey);
        }
        setStatus(true, connectedLabel());
        // 静默预热：仅为初始化 trigger 胶囊文字，不打开 sheet
        send({ type: 'PHONE_MODEL_LIST' });
        send({ type: 'PHONE_PERMISSION_LIST' });
        flushOutboundQueue();
        break;
      case 'AGENT_STREAM_START':
        if (frameRearms(msg)) lastStreamActivityAt = Date.now();
        ensurePendingUserBubble();
        // 不立刻 startAssistantTurn：否则 tool-only / 空 turn 会留下「Copilot •••」空壳。
        // 真正正文在 CHUNK/SET/MESSAGE 时再创建行；这里只进入 running + 顶部 typing。
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (msg.streamId) lastActiveStreamId = msg.streamId;
        if (!replaying && frameRearms(msg)) {
          setRequestRunning(true);
          showTyping();
        }
        break;
      case 'AGENT_STREAM_SET':
        if (frameRearms(msg)) lastStreamActivityAt = Date.now();
        setEntryMarkdown(msg.streamId || 'default', msg.text || '', msg.timestamp, msg._ut);
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (!replaying && frameRearms(msg)) setRequestRunning(true);
        break;
      case 'AGENT_STREAM_CHUNK':
        if (frameRearms(msg)) lastStreamActivityAt = Date.now();
        appendAssistantChunk(msg.streamId || 'default', msg.text || '', msg.timestamp, msg._ut);
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (!replaying && frameRearms(msg)) setRequestRunning(true);
        break;
      case 'AGENT_STREAM_END':
        if (frameRearms(msg)) lastStreamActivityAt = Date.now();
        doneStreams.delete(msg.streamId || 'default');
        completeAssistantTurn(msg.streamId || 'default');
        clearTyping();
        // 若已无 streaming 行，立即藏掉残余 ••• 并恢复发送键（不等 COPILOT_DONE）
        {
          let any = false;
          for (const e of streamingTurns.values()) {
            if (e.element && e.element.isConnected && e.element.classList.contains('streaming')) {
              any = true; break;
            }
          }
          if (!any) {
            feed.querySelectorAll('.msg.agent .typing-label').forEach((n) => {
              n.style.display = 'none';
              n.classList.add('is-done');
            });
            markAllToolsDone();
          }
          // END 只是「某条流」的终止帧——骨架/进度块的 END len=0 会在轮中途来，
          // 立即释放会让在途态在静默窗内提前落回「发送」（连发逃逸+停止落空，
          // R28 实测）。统一走宽限复查：真轮终必经历 ≥5s 静默才释放；
          // DONE 被判死丢弃的轮也由这里兜底（静默后同样释放+出队）。
          if (!replaying) setRequestRunning(false, undefined, { deferMs: 3000 });
          if (!any) setStatus(true, connectedLabel());
        }
        break;
      case 'AGENT_MESSAGE': {
        // sessiondb 快路径答案无 STREAM_START 前置——同样先补画待发用户泡
        ensurePendingUserBubble();
        // 答案带 _ut 且与待发同题 = 消息已送达并作答，清核验计时防回填误报
        try {
          if (pendingSendCheck && msg._ut &&
              userTextDedupeKey(String(msg._ut)) === pendingSendCheck.textKey) {
            clearTimeout(pendingSendCheck.timer);
            pendingSendCheck = null;
            sessionStorage.removeItem(PENDING_SEND_KEY);
          }
          // 答案落地→同题待答条目释放（多条在途只清已答的）；答案到达也是
          // flush 时机——requestRunning 早已释放而答案后到时，队列靠这里放行
          if (msg._ut) {
            const aut = userTextDedupeKey(String(msg._ut));
            for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
              if (userTextDedupeKey(sentAwaitingReply[i].text) === aut) sentAwaitingReply.splice(i, 1);
            }
            setTimeout(flushPendingSendQueue, 50);
          }
        } catch (_) {}
        // 迟到重投影且同文已渲染 → 丢；未渲染的迟到 final 照常追加。
        // 判据（同文已渲染为前提，任一即丢）：
        //  a) ts ≤ 回放水位（经典迟到件）；
        //  b) 空闲态且 _ut 不属于最新用户轮——激活/切会话的整文件重投影
        //     都在空闲时到，最新轮的同款回答（"ok"×2）仍放行；
        //  c) _ut 命中的用户轮后面已有助手块（该轮已答），反向找同名泡，
        //     快速连发时未答轮（_ut 是最新一条）必须放行。
        // 回放期间不判：历史里不同轮次的同文回答（如连续的 ⚠️ 失败标记）
        // 必须各自渲染，否则 collapsed 成首个 → 光秃 USER 连排。
        if (!(replaying || replayingInstant) && agentTextRendered(String(msg.text || ''))) {
          const users = feed.querySelectorAll('.msg.user');
          const lastKey = users.length ? users[users.length - 1].dataset.textKey : '';
          const utIsLatest =
            !!msg._ut && !!lastKey && userTextDedupeKey(String(msg._ut)) === lastKey;
          // d) 事件自带源 ts 早于最新用户泡的发送时刻 >2s → 旧轮经慢通道
          //    迟到的重投影：在途态（requestRunning）不影响判定。
          //    例外：_ut 自证属于最新轮（同题重问时上游复用首轮响应，答案的
          //    事件 ts 继承旧轮时刻）——按 _ut 归位而非按 ts 丢弃。
          const lastUserTs = users.length ? Number(users[users.length - 1].dataset.ts) : NaN;
          const evTs = eventTsNum(msg);
          // _ut 命中最新用户泡 = 当前轮真答：豁免 ts 判定——Copilot 源 ts 与客户端
          // 泡 ts 不同时钟，真答可能携带早于泡的 request-start ts（R94 误杀）。
          const predatesLatestUser =
            !utIsLatest &&
            Number.isFinite(evTs) && Number.isFinite(lastUserTs) && evTs < lastUserTs - 2000;
          let oldTurnReproj =
            isStaleReplayEvent(evTs) || (predatesLatestUser && !utIsLatest) || (!requestRunning && !utIsLatest);
          if (!oldTurnReproj && msg._ut) {
            const utKey2 = userTextDedupeKey(String(msg._ut));
            for (let i = users.length - 1; i >= 0; i--) {
              if (users[i].dataset.textKey !== utKey2) continue;
              let sib = users[i].nextElementSibling;
              while (sib && !sib.classList.contains('user')) {
                // 只算真答案：thinking/孤儿占位等无正文块不算「该轮已答」
                if (sib.classList.contains('agent') && !sib.dataset.orphanPh) {
                  const sb = sib.querySelector('.body');
                  if (sb && String(sb.dataset.raw || '').trim()) { oldTurnReproj = true; break; }
                  const ssid = sib.dataset && sib.dataset.streamId;
                  const sst = ssid ? streamingTurns.get(ssid) : null;
                  if (sst && String(sst.markdown || '').trim()) { oldTurnReproj = true; break; }
                }
                sib = sib.nextElementSibling;
              }
              break;
            }
          }
          if (oldTurnReproj) {
            clearTyping();
            break;
          }
        }
        // 变体重投影（内容剥壳版）：归一化不等所以走不到上面的 exact 同文判断，
        // 但 _ut 归属的用户轮已有答案、且这条文本归一化后是该答案的子集/前缀——
        // 同答案的残缺重投影，不是新内容 → 丢弃，防孤儿泡（R13 实测 +35s 变体）。
        let variantReproj = false;
        if (!(replaying || replayingInstant) && msg._ut) {
          const strip = (s) => String(s || '').replace(/[\s`*_~#>\-]+/g, '');
          const incomingNorm = strip(msg.text);
          if (incomingNorm) {
            const wantKey = userTextDedupeKey(String(msg._ut));
            const users2 = feed.querySelectorAll('.msg.user');
            for (let i = users2.length - 1; i >= 0; i--) {
              if (users2[i].dataset.textKey !== wantKey) continue;
              let sib = users2[i].nextElementSibling;
              while (sib && !sib.classList.contains('user')) {
                if (sib.classList.contains('agent') && !sib.classList.contains('typing-row')) {
                  const bd = sib.querySelector('.body');
                  const haveNorm = strip(bd && (bd.dataset.raw || bd.textContent));
                  // 来文是已渲染答案的「子序列」= 丢中段内容的剥壳变体
                  // （`Created \`f.txt\` - done` 剥壳成 `Created - done` 后归一化
                  // 非连续子串，includes 判不中）。约束：来文足够长且覆盖率 ≥60%，
                  // 防真新短答（"ok"式）撞子序列误杀。
                  if (
                    haveNorm &&
                    incomingNorm.length >= 6 &&
                    incomingNorm.length >= haveNorm.length * 0.4 &&
                    (() => {
                      let j = 0;
                      for (
                        let k = 0;
                        k < haveNorm.length && j < incomingNorm.length;
                        k++
                      ) {
                        if (haveNorm[k] === incomingNorm[j]) j++;
                      }
                      return j === incomingNorm.length;
                    })()
                  ) {
                    variantReproj = true;
                  }
                }
                if (variantReproj) break;
                sib = sib.nextElementSibling;
              }
              break;
            }
          }
        }
        if (variantReproj) {
          clearTyping();
          break;
        }
        if (msg.streamId) {
          completeAssistantTurn(msg.streamId, msg.text || '', msg);
        } else {
          addAgentFinal(msg.text || '', null, {
            ts: eventTsNum(msg),
            gapFill: !!msg.gapFill,
            ut: msg._ut,
          });
        }
        clearTyping();
        // 正文段落后收拢已完成工具，贴近桌面「已完成 N 个步骤」节奏
        collapseCompletedToolSteps();
        break;
      }
      case 'TOOL_CALL':
        upsertTool(msg);
        break;
      case 'PROGRESS_STEP': {
        const pEntry = resolveEntryFor(msg);
        if (pEntry) appendStatus(pEntry, msg);
        break;
      }
      case 'THINKING_STEP': {
        // 思考步骤也算在途活动：给 DONE 的延迟释放续命，防 thinking 间隙释放发送键。
        // 已答轮（doneStreams/归属轮已有答案）的尾帧不再续命——否则轮尾 thinking 顶满队列。
        if (frameRearms(msg)) {
          lastStreamActivityAt = Date.now();
          if (!replaying && requestRunning) setRequestRunning(true);
        }
        const tEntry = resolveEntryFor(msg);
        if (tEntry) appendThinking(tEntry, msg.text || '');
        break;
      }
      case 'AGENT_CONFIRM':
        showConfirm(msg);
        break;
      case 'AGENT_CONFIRM_RESOLVED':
        confirmBar.classList.add('hidden');
        addSys(`确认已解决: ${msg.button || ''}`);
        break;
      case 'COPILOT_TYPING':
        lastStreamActivityAt = Date.now();
        if (!replaying) {
          showTyping();
          setRequestRunning(true, 'Copilot 正在输入…');
        }
        break;
      case 'COPILOT_DONE':
        // inject_soft_unverified = 服务端已把消息提交进目标会话（Windows 落盘确认慢
        // 会触发该路径）——送达核验立即通过，别让 9s 计时器误报「可能未送达」。
        if (msg.reason === 'inject_soft_unverified') {
          if (pendingSendCheck) {
            clearTimeout(pendingSendCheck.timer);
            pendingSendCheck = null;
            try { sessionStorage.removeItem(PENDING_SEND_KEY); } catch (_) {}
          } else if (sendVerifyMissedAt && Date.now() - sendVerifyMissedAt < 120000) {
            sendVerifyMissedAt = 0;
            clearRestoredIfConfirmed(null);
            addSys('已确认送达（此前误报未送达，勿重复发送）');
          }
        }
        // 回复结束→按 _ut 逐条释放待答条目：服务端 DONE 现带归属轮次，
        // 只清已答的；任意 DONE 整表清会把别轮在途条目误杀 → 用户泡丢、答案裸奔。
        // 无 _ut 的 DONE（解析不到归属）不清：条目留着，重放靠它补画已发未答泡。
        // 先清再放行：下面的释放判断要看「清完本 DONE 归属后还剩谁没答」。
        if (!replaying && !replayingInstant && msg._ut) {
          const daut = userTextDedupeKey(String(msg._ut));
          for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
            if (userTextDedupeKey(sentAwaitingReply[i].text) === daut) sentAwaitingReply.splice(i, 1);
          }
        }
        // 旧请求的迟到 DONE（requestIndex 小于已见过的最大 live 下标）不动
        // 当前在途轮的发送键/视觉/队列——否则连发 U1U2A1A2 堆叠、长轮无法停。
        // requestIndex 之外加时间戳兜底：sessiondb/兜底通道的 DONE 常不带
        // requestIndex，但其 ts 是轮完成时刻——早于最近 live USER 发送时刻
        // 就是旧轮迟到件，不得释放当前在途轮的发送键/队列。
        const doneIdx = typeof msg.requestIndex === 'number' ? msg.requestIndex : null;
        const doneTs = eventTsNum(msg);
        // 服务端裁决器（turnArbiter）已按轮次状态判过 stale/ack——直接采信，
        // 本地判定留作兜底（旧版扩展无标记时仍生效）。
        const staleDone =
          msg.stale === true ||
          (doneIdx != null && latestLiveReqIdx > doneIdx) ||
          (doneIdx == null && Number.isFinite(doneTs) && doneTs + 2000 < latestUserLiveTs);
        // 注入回执 DONE（发送后 ~2s 必发的那批，无 _ut/requestIndex 归属）不是
        // 轮终——恰好落在「已发未答」消息的头 8s 里就拒绝释放：此前它 +3s 宽限
        // 在首流事件前放行 rr → 连发绕过排队直接插队（U1U2A1A2 回归形态）。
        // 带 _ut 归属的 DONE 已在上面先清掉自己的待答条目，不受此门限制。
        const now0 = Date.now();
        const youngestAwaitAt = Math.max(
          0,
          ...sentAwaitingReply.map((e) => e.at || 0),
        );
        const doneImmediate = msg.reason === 'phone_stop' || msg.reason === 'isCanceled';
        const injectAckDone =
          msg.ack === true ||
          (!doneImmediate && youngestAwaitAt > 0 && now0 - youngestAwaitAt < 8000);
        const releaseDone = !staleDone && !injectAckDone;
        if (injectAckDone) {
          // 被挡的 DONE 不会重发——若它其实是真轮终（无 _ut 的收尾通道），
          // 8s 窗口到期后补一次释放评估，否则 rr 要靠 75s 看门狗才放得掉。
          setTimeout(() => {
            if (!requestRunning) return;
            const n2 = Date.now();
            const y2 = Math.max(0, ...sentAwaitingReply.map((e) => e.at || 0));
            if (y2 === 0 || n2 - y2 >= 8000) {
              markAllToolsDone();
              finishAllAssistantVisuals();
              setRequestRunning(false, undefined, { deferMs: 1500 });
            }
          }, 8100);
          // 被挡 DONE 也上硬看门狗：8.1s 复评可能因新待答条目入列而不放，
          // 之后 rr 再无任何释放触发 → 发送键永久卡「停止」。
          // 看门狗按 lastStreamActivityAt 判：5s 无活动即强制释放，有活动再续。
          if (releaseHardTimer) clearTimeout(releaseHardTimer);
          releaseHardTimer = setTimeout(hardReleaseCheck, 15000);
        }
        if (releaseDone) {
          markAllToolsDone();
          finishAllAssistantVisuals();
        }
        // 服务端裁决：停止类 DONE 已解出确切归属轮次（closedUt），按它精确清
        if (!replaying && !replayingInstant && msg.closedUt) {
          const cut = userTextDedupeKey(String(msg.closedUt));
          for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
            if (userTextDedupeKey(sentAwaitingReply[i].text) === cut) {
              sentAwaitingReply.splice(i, 1);
              break;
            }
          }
        }
        // 停止/取消的 DONE（phone_stop/isCanceled）常不带 _ut——它终止的就是
        // 当前在途轮，其用户泡是最新一条待答条目；不清会永远「已发未答」，
        // 之后每次会话切换/重连回放都被 repaintAwaitingUserBubbles 补画回来。
        if (!replaying && !replayingInstant && doneImmediate && !msg._ut && !msg.closedUt) {
          const curBase = baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '');
          for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
            const e = sentAwaitingReply[i];
            const eBase = baseNameAny(e.sess || '').replace(/\.jsonl$/i, '');
            if (now0 - (e.at || 0) >= AWAIT_REPLY_FLUSH_BLOCK_MS) break;
            if (!eBase || !curBase || eBase === curBase) {
              sentAwaitingReply.splice(i, 1);
              break;
            }
          }
        }
        // 中途 DONE（tool 循环 turn_end / thinking 间隙、旧请求迟到）提前于请求
        // 真正结束——立即释放会让发送键提前变回「发送」，长轮几乎停不掉。
        // 3s 宽限释放：期间任何新流活动自动取消；用户主动停/取消仍立即释放。
        if (!replaying && releaseDone) {
          // DONE 判本轮已答：归属轮的活流卡标 doneStreams——尾帧照渲染收尾，
          // 但不再计流活动撑起 rr（transcript 尾流顶队列 ~78s 的根治）。
          // _ut 缺失时只标锚在最新 user 泡下的卡（当前轮），不碰旧轮残流。
          {
            const dUtKey2 = msg._ut ? userTextDedupeKey(String(msg._ut)) : '';
            const allU = feed.querySelectorAll('.msg.user');
            const lastU = allU.length ? allU[allU.length - 1] : null;
            for (const [sid, e] of streamingTurns) {
              let owner = e && e.element;
              while (owner && !owner.classList.contains('user')) owner = owner.previousElementSibling;
              const match = dUtKey2
                ? (owner && owner.dataset.textKey === dUtKey2)
                : (owner && owner === lastU);
              // 广义收尾：归属轮已有真答案的流卡一并判 done——requests/N 流
              // sid 跨轮复用且常无 END（僵尸卡），错锚到其他泡下的尾帧此前
              // 漏标仍能源源重武装 rr（实测排队被顶 ~57s）。turnHasOtherAnswer
              // 排除自产答案在写的卡，在途轮不误标。
              const sweep = owner && turnHasOtherAnswer(owner, sid);
              if (match || sweep) { e.turnDone = true; doneStreams.add(sid); }
            }
          }
          setRequestRunning(false, undefined, doneImmediate ? { force: true } : { deferMs: 3000 });
          // 硬释放兜底：上面 defer 链若被迟到事件重置 rr 而取消，15s 后兜底检查
          if (releaseHardTimer) clearTimeout(releaseHardTimer);
          releaseHardTimer = setTimeout(hardReleaseCheck, 15000);
        }
        // live 失败/空轮占位：DONE 归属轮没产出任何 agent 内容时，在该用户泡下
        // 补终态占位（回放侧由服务端 annotateOrphanUserTurns 兜底；live 原来完全
        // 缺失 → 上游 reqerr 轮只剩光秃用户泡，「发送堆一起」的 live 形态）。
        if (releaseDone && !replaying && !replayingInstant) {
          const utTxt = String(msg._ut || msg.closedUt || '');
          const users = feed.querySelectorAll('.msg.user');
          let ownerEl = null;
          let want = '';
          let bareDone = false;
          if (utTxt) {
            want = userTextDedupeKey(utTxt);
            for (let i = users.length - 1; i >= 0; i--) {
              const b = users[i].querySelector('.user-bubble');
              if (b && userTextDedupeKey(b.textContent || '') === want) { ownerEl = users[i]; break; }
            }
          } else {
            // 裸 DONE（无 _ut/closedUt）：归属回退到 feed 末尾最近一个还没答案的
            // 用户泡——sessiondb 孤儿轮就是这种形态（上游写出空流壳+裸 DONE）。
            // 若末尾用户泡已有答案，跳过（这是迟到杂散 DONE，不误画占位）。
            bareDone = true;
            for (let i = users.length - 1; i >= 0; i--) {
              const u = users[i];
              let answered = false;
              for (let n = u.nextSibling; n; n = n.nextSibling) {
                if (n.classList && n.classList.contains('user')) break;
                if (n.classList && n.classList.contains('agent') && !n.classList.contains('typing-row')) {
                  const bd = n.querySelector('.body');
                  if (bd && String(bd.dataset.raw || bd.textContent || '').trim()) { answered = true; break; }
                }
              }
              if (!answered) { ownerEl = u; break; }
              break;
            }
            if (ownerEl) {
              const ob = ownerEl.querySelector('.user-bubble');
              want = ob ? userTextDedupeKey(ob.textContent || '') : '';
            }
          }
          const drawOrphanPlaceholder = () => {
            if (!ownerEl || !ownerEl.isConnected) return;
            let hasContent = false;
            for (let n = ownerEl.nextSibling; n; n = n.nextSibling) {
              if (n.classList && n.classList.contains('user')) break;
              if (n.classList && n.classList.contains('agent') && !n.classList.contains('typing-row')) {
                const bd = n.querySelector('.body');
                if (bd && String(bd.dataset.raw || bd.textContent || '').trim()) { hasContent = true; break; }
              }
            }
            if (!hasContent) {
              const ob2 = ownerEl.querySelector('.user-bubble');
              const ph = addAgentFinal(
                '*（该轮无回复——已停止或请求失败）*',
                `orphan-live-${want || 'last'}-${Date.now()}`,
                {
                  ts: Number.isFinite(doneTs) ? doneTs : Date.now(),
                  ut: utTxt || (ob2 && ob2.textContent) || undefined,
                },
              );
              if (ph) {
                ph.dataset.orphanPh = '1';
                // 裸 DONE（phone_stop 等无 _ut）时 addAgentFinal 的 ts 归属会把
                // 占位落到最新 user 泡下——以已判定的 ownerEl 为准，插回其回合
                // 区末尾（下一个 user 泡之前），别跑到别人轮子里。
                let at = ownerEl;
                for (let n = ownerEl.nextSibling; n; n = n.nextSibling) {
                  if (n.classList && n.classList.contains('user')) break;
                  if (n === ph) continue;
                  at = n;
                }
                if (at.nextSibling) feed.insertBefore(ph, at.nextSibling);
                else feed.appendChild(ph);
              }
            }
          };
          if (ownerEl) {
            if (bareDone) {
              // 裸 DONE 可能早于在途答案（TOOL→DONE→+13s 正文形态实测）：
              // 延迟复核——到时该泡若已有答案就不画，真孤儿轮才补占位。
              // want 锁的是这条用户泡本身，期间新发的消息不影响归属。
              // 裸 DONE 无法自证终止的是这个轮（无 _ut/closedUt）——上游慢推理轮
              // 实测 ~5min 才出答，期间任何杂散 DONE（elapsedMs 清理、通道终标）
              // 若在「尚无答案」下就画占位 = 误报（dr2 实测 ~30s 误画）。复核前看
              // 该轮待答条目龄：未过陈旧阈说明还可能活着，续查不画；条目被真 DONE
              // 归属裁掉/熬到陈旧，才按孤儿画占位。
              const recheckOrphan = () => {
                if (!ownerEl.isConnected) return;
                const entry = sentAwaitingReply.find(
                  (e) => want && userTextDedupeKey(e.text) === want,
                );
                if (
                  !doneImmediate &&
                  entry &&
                  Date.now() - (entry.at || 0) < STREAM_STALE_AWAIT_MS
                ) {
                  setTimeout(recheckOrphan, 15000);
                  return;
                }
                drawOrphanPlaceholder();
              };
              setTimeout(recheckOrphan, 15000);
            } else {
              drawOrphanPlaceholder();
            }
          }
        }
        if (doneImmediate && releaseDone) setStatus(true, connectedLabel());
        if (!replaying) Haptics.success();
        // 回复结束→排队消息出队（防抖宽限后判 requestRunning）
        setTimeout(flushPendingSendQueue, 800);
        break;
      case 'SESSION_LIST':
        renderSessionList(msg.sessions);
        break;
      case 'SESSION_SELECTED': {
        if (msg.ok) {
          // Clear immediately so a delayed/lost replay cannot leave the previous
          // session visible under the new session title.
          // 离线队列里是没送达的用户文本——静默清空 = 重绑竞态吞掉首发
          // （无泡/无广播/无落盘三空）。捞回输入框再丢队列。
          {
            const unsent = outboundQueue.splice(0).filter((m) => m && m.type === 'PHONE_MESSAGE');
            if (unsent.length) {
              const lastText = String(unsent[unsent.length - 1].text || '');
              if (lastText && !(input.value || '').trim()) { input.value = lastText; sendVerifyRestoredText = lastText; }
              addSys('切换会话：未送达的消息已回填输入框');
            }
          }
          clearFeed();
          latestLiveReqIdx = -1; // 新会话 requestIndex 从 0 起
          latestUserLiveTs = 0;
          replayingInstant = true;
          // 模型选择按会话分：切完刷新 chip，不然 PWA 显示上个会话的模型
          send({ type: 'PHONE_MODEL_LIST' });
          // 待答清单按会话分：sess 与即将切到的会话不符就丢——旧会话在途条目
          // 会补画进新 feed（残泡/答案裸奔归因错乱）。无 sess（旧写入）保留。
          {
            const selBase = baseNameAny(msg.file).replace(/\.jsonl$/i, '');
            for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
              const s = sentAwaitingReply[i].sess;
              const sBase = baseNameAny(s).replace(/\.jsonl$/i, '');
              if (sBase && selBase && sBase !== selBase) sentAwaitingReply.splice(i, 1);
            }
          }
          if (sessionSwitchFallbackTimer) {
            clearTimeout(sessionSwitchFallbackTimer);
            sessionSwitchFallbackTimer = null;
          }
          // 4s 兜底保护：若服务端未返回 HISTORY_REPLAY 或历史为空导致回放未触达，自动退出切换态
          sessionSwitchFallbackTimer = setTimeout(() => {
            if (replayingInstant) {
              replayingInstant = false;
              setStatus(true, connectedLabel());
            }
            sessionSwitchFallbackTimer = null;
          }, 4000);
          // 0.5.16：立刻收尾上一会话的 typing/streaming/发送键，避免切会话后
          // 「正在输入」残影或发送键一直停在停止态（live 洪水/双通道时尤其明显）。
          try {
            if (requestDoneTimer) {
              clearTimeout(requestDoneTimer);
              requestDoneTimer = null;
            }
            finishAllAssistantVisuals();
            requestRunning = false;
            paintSendButton();
          } catch (_) {}
          // 换会话后排队消息的目标已变化：泡丢掉（防注入到新会话），但文本
          // 捞回输入框而不是蒸发——用户重发还是复制走由用户决定。
          if (pendingSendQueue.length) {
            let lastText = '';
            for (const qi of pendingSendQueue) {
              if (qi && qi.el && qi.el.isConnected) qi.el.remove();
              if (qi && qi.text) lastText = qi.text;
            }
            pendingSendQueue.length = 0;
            persistQueuedSends();
            if (lastText && !(input.value || '').trim()) input.value = lastText;
            addSys('已切换会话，排队消息已回填输入框');
            if (queuedHintEl) { queuedHintEl.remove(); queuedHintEl = null; }
          }
          setStatus(true, '切换会话…');
          const f = msg.file || currentSessionMeta.file || '';
          // 切到新会话时 currentSessionMeta.title 是旧会话名，不能先于文件缓存
          // 兜底命中——否则头部滞留旧标题。msg.title → 列表缓存/文件名 → 旧 meta。
          const t = (msg.title && String(msg.title).trim()) || titleFromSessionFile(f) || currentSessionMeta.title;
          if (f || t) setSessionTitle(t, f);
        } else {
          replayingInstant = false;
          if (sessionSwitchFallbackTimer) {
            clearTimeout(sessionSwitchFallbackTimer);
            sessionSwitchFallbackTimer = null;
          }
          addSys(`切换会话失败${msg.error ? ': ' + msg.error : ''}`);
        }
        break;
      }
      case 'MODEL_LIST':
        renderModelList(msg.models);
        break;
      case 'MODEL_SELECTED':
        onModelSelected(msg);
        break;
      case 'PERMISSION_LIST':
        renderPermissionList(msg.levels, msg.current);
        break;
      case 'PERMISSION_SET':
        onPermissionSet(msg);
        break;
      case 'TERMINAL_LIST':
        renderTerminalList(msg.terminals);
        break;
      case 'INSTANCE_LIST':
        clearTimeout(instanceListTimer);
        instanceListTimer = null;
        renderInstanceList(msg.instances);
        break;
      case 'TERMINAL_OUTPUT': {
        if (msg.userInitiated || terminalPanel.classList.contains('open')) openTerminalPanel();
        if (msg.ok === false) {
          appendTerminalOutput(`[错误] ${String(msg.error || '执行失败')}\n`, 'term-error');
        }
        if (msg.content) appendTerminalOutput(String(msg.content));
        if (msg.exitCode != null) {
          const code = Number(msg.exitCode);
          const ok = code === 0;
          appendTerminalOutput(
            `\n${ok ? '✓ 退出码: 0' : '⚠ 退出码: ' + code}\n`,
            ok ? 'term-ok' : 'term-error',
          );
        }
        break;
      }
      case 'AGENT_LIST':
        if (!lastTunnelUrl) setStatus(true, `agent: ${(msg.active || (msg.agents || [])[0] || 'Copilot')}`);
        break;
      case 'HISTORY_REPLAY': {
        // 切会话 / 重连回放：一次性渲染，禁止逐条滚动；结束时 instant 跳到底部。
        //
        // 0.5.6 空白 bug 根因：这里曾给未声明的旧变量赋值
        //   activeStreamId / assistantTurnEl / assistantBodyEl / ...
        // 整个 app.js 顶层是 'use strict'，赋值瞬间抛 ReferenceError；
        // 外层 ws.onmessage 的 try/catch 吞掉异常 → clearFeed 已执行、消息循环未跑 → feed 空白。
        // clearFeed() 已重置 streamingTurns/tools/seenKeys/lastActiveStreamId，无需再清幽灵变量。
        replaying = true;
        replayingInstant = true;
        if (sessionSwitchFallbackTimer) {
          clearTimeout(sessionSwitchFallbackTimer);
          sessionSwitchFallbackTimer = null;
        }
        // 回放携带 file 时同步会话元数据（滚动记忆 / 后续 PHONE_MESSAGE.file）
        if (typeof msg.file === 'string' && msg.file) {
          try {
            // 标题权威序：回放自带的 msg.title > 本地缓存/列表 titleFromSessionFile。
            // 旧逻辑把 currentSessionMeta.title（可能还是上个会话的名字）放在最前，
            // 切回一个会话后标题滞留在上一会话名。
            // 同一文件的 meta 可信（重连回放同会话）；文件不同说明 meta
            // 还是旧会话的——它的 title 不得作回退，否则切回后标题滞留。
            const sameMeta =
              baseNameAny(currentSessionMeta.file || '') === baseNameAny(msg.file);
            const t =
              (typeof msg.title === 'string' && msg.title.trim() && msg.title) ||
              (sameMeta ? currentSessionMeta.title : '') ||
              titleFromSessionFile(msg.file);
            setSessionTitle(t, msg.file);
          } catch (_) {}
        }
        // list 必须在 try 外声明——finally 也引用它；块内 const 会让
        // finally 里的引用抛 ReferenceError 被静默吞掉（曾导致
        // replayFloorTs 恒为 0、stale-replay 门整体失效）。
        const list = Array.isArray(msg.messages) ? msg.messages : [];
        try {
          try { feed.style.scrollBehavior = 'auto'; } catch (_) {}
          clearFeed();
          for (const m of list) {
            // 单条失败不阻断整段回放（marked/DOM 偶发错误）
            try {
              handle(m);
            } catch (_) {}
          }
        } finally {
          markAllToolsDone();
          replaying = false;
          replayingInstant = false;
          try {
            for (const m of list) {
              const t = eventTsNum(m);
              if (Number.isFinite(t) && t > replayFloorTs) replayFloorTs = t;
            }
          } catch (_) {}
          // 历史里不应残留「正在输入」态
          finishAllAssistantVisuals();
          if (requestDoneTimer) {
            clearTimeout(requestDoneTimer);
            requestDoneTimer = null;
          }
          requestRunning = false;
          // 回放会清空 feed：把未确认送达的本地待发消息补画回去（发后遭遇 REPLAY 丢泡）
          try {
            const raw = sessionStorage.getItem(PENDING_SEND_KEY);
            if (raw) {
              const p = JSON.parse(raw);
              if (p && typeof p.text === 'string' && p.text.trim() && pendingSendSessOk(p)) {
                addUser(p.text, p.key || `user:pending:${Date.now()}:${userTextDedupeKey(p.text)}`, { force: true, ts: p.at || Date.now() });
              }
            }
          } catch (_) {}
          // 刷新把内存待答清单蒸发了：从持久化快照恢复——回放 USER 已含的行说明
          // 轮次已落盘（无需跟踪/补画），只有「桥已确认、transcript 懒写盘窗口内刷新」
          // 的条目存活，让待答匹配与未送达校验在重载后仍能工作。
          try {
            const rawA = sessionStorage.getItem(SENT_AWAITING_KEY);
            if (rawA) {
              const arrA = JSON.parse(rawA);
              const boundBaseA = baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '');
              const replayedA = new Set();
              for (const m of list) {
                if (m && m.type === 'USER_MESSAGE' && typeof m.text === 'string') {
                  replayedA.add(userTextDedupeKey(m.text));
                }
              }
              const nowA = Date.now();
              const keptA = [];
              for (const a of Array.isArray(arrA) ? arrA : []) {
                if (!a || typeof a.text !== 'string' || !a.text.trim()) continue;
                if (nowA - (a.at || 0) > 5 * 60 * 1000) continue;
                const aBase = baseNameAny(a.sess || '').replace(/\.jsonl$/i, '');
                if (!boundBaseA || aBase !== boundBaseA) continue;
                if (replayedA.has(userTextDedupeKey(a.text))) continue;
                keptA.push(a);
                if (!sentAwaitingReply.some((e) => userTextDedupeKey(e.text) === userTextDedupeKey(a.text))) {
                  sentAwaitingReply.push({ text: a.text, key: a.key || `user:restored:${nowA}:${userTextDedupeKey(a.text)}`, sess: a.sess, at: a.at || nowA });
                }
              }
              if (keptA.length) sessionStorage.setItem(SENT_AWAITING_KEY, JSON.stringify(keptA));
              else sessionStorage.removeItem(SENT_AWAITING_KEY);
            }
          } catch (_) {}
          // 「已发未答」的泡也补回（发完即切/跟随重选的交错态不丢泡）
          repaintAwaitingUserBubbles();
          // 回放权威校验：已确认回声的待答文本若在回放 USER 里完全缺席，
          // 说明桥端确认后、上游落盘前链路中断（VS Code 被杀等）——
          // 该轮永远不会有答案，按未送达处理（回填+移出待答），否则泡
          // 会干等且占住 rr/收割器的在途判断。
          try {
            const replayedUserKeys = new Set();
            for (const m of list) {
              if (m && m.type === 'USER_MESSAGE' && typeof m.text === 'string') {
                replayedUserKeys.add(userTextDedupeKey(m.text));
              }
            }
            const boundBaseR = baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '');
            // 懒写盘在途证据：回放里 send 之后仍有 agent 活动（AGENT/TOOL/THINKING 帧 ts）
            // 说明管道活着——USER 行要轮次完成才写盘，在途轮缺席不等于丢失，
            // 误报未送达会把仍在生成的条目回填+移出待答（答案随后裸挂上一轮）。
            let lastReplayAgentAt = 0;
            for (const m of list) {
              if (m && /^(AGENT|TOOL|THINKING)/.test(String(m.type || ''))) {
                const t = eventTsNum(m);
                if (Number.isFinite(t) && t > lastReplayAgentAt) lastReplayAgentAt = t;
              }
            }
            // 「落盘已过此点」判据：transcript 按轮次完成顺序追加，回放里任何 ts 晚于
            // 该 send 的 USER 行都证明本轮若已落盘必然在场——缺席才是真丢失；
            // 否则条目仍可能在途（USER 行要轮完才写），除非已越过服务端 45s 核验窗。
            let lastReplayUserTs = 0;
            for (const m of list) {
              if (m && m.type === 'USER_MESSAGE' && typeof m.text === 'string') {
                const t = eventTsNum(m);
                if (Number.isFinite(t) && t > lastReplayUserTs) lastReplayUserTs = t;
              }
            }
            for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
              const e = sentAwaitingReply[i];
              const eBase = baseNameAny(e.sess || '').replace(/\.jsonl$/i, '');
              if (!boundBaseR || eBase !== boundBaseR) continue;
              // 上行落盘有 ~1-2s 延迟：发送太新的条目跳过，回放可能先于落盘
              if (Date.now() - (e.at || 0) < 3000) continue;
              // 在途证据须「新」：真在途轮持续产帧，lastReplayAgentAt 必然距今很近；
              // 进程在生成途中被杀的轮，其 agent 证据全部停在过去——陈旧证据不当
              // 在途判据，否则死轮泡永远干等不报未送达（实测 br1 在途被杀静默悬挂）。
              if (lastReplayAgentAt && lastReplayAgentAt >= (e.at || 0) &&
                  Date.now() - lastReplayAgentAt < 90000) continue;
              if (!(lastReplayUserTs && lastReplayUserTs >= (e.at || 0)) &&
                  Date.now() - (e.at || 0) < 45000) continue;
              if (replayedUserKeys.has(userTextDedupeKey(e.text))) continue;
              sentAwaitingReply.splice(i, 1);
              if (!(input.value || '').trim()) { input.value = e.text; sendVerifyRestoredText = e.text; }
              sendVerifyMissedAt = Date.now();
              addSys('发送可能未送达（连接中断），文本已回填，请重新发送');
            }
            // 排队消息在刷新时随内存蒸发：从持久化副本恢复——入队后更新的
            // 回放 USER 说明刷新瞬间已出队送达（销账）；否则把最近一条回填
            // 输入框（不自动重发）。按 ts 判送达：同文重问时老 USER 不算数。
            const rawQ = sessionStorage.getItem(QUEUED_SENDS_KEY);
            if (rawQ) {
              const arrQ = JSON.parse(rawQ);
              if (Array.isArray(arrQ) && arrQ.length) {
                const replayedUserTs = new Map();
                for (const m of list) {
                  if (m && m.type === 'USER_MESSAGE' && typeof m.text === 'string') {
                    const k = userTextDedupeKey(m.text);
                    const t = eventTsNum(m);
                    replayedUserTs.set(k, Math.max(replayedUserTs.get(k) || 0, Number.isFinite(t) ? t : 0));
                  }
                }
                const nowQ = Date.now();
                const keepQ = [];
                for (const q of arrQ) {
                  if (!q || typeof q.text !== 'string' || !q.text.trim()) continue;
                  if (nowQ - (q.at || 0) > 5 * 60 * 1000) continue;
                  const qBase = baseNameAny(q.sess || '').replace(/\.jsonl$/i, '');
                  if (boundBaseR && qBase && qBase !== boundBaseR) continue;
                  const rt = replayedUserTs.get(userTextDedupeKey(q.text)) || 0;
                  if (rt && rt >= (q.at || 0) - 15000) continue;
                  keepQ.push(q);
                }
                if (keepQ.length) {
                  if (!(input.value || '').trim()) {
                    const lastQ = keepQ[keepQ.length - 1];
                    input.value = lastQ.text;
                    sendVerifyRestoredText = lastQ.text;
                    addSys('排队消息因页面刷新中断，文本已回填，请重新发送');
                  }
                  sessionStorage.setItem(QUEUED_SENDS_KEY, JSON.stringify(keepQ));
                } else {
                  sessionStorage.removeItem(QUEUED_SENDS_KEY);
                }
              }
            }
          } catch (_) {}
          jumpFeedToBottom();
          // 回放完成后恢复顶部状态文案（SESSION_SELECTED 可能写成「切换会话…」）
          setStatus(true, connectedLabel());
        }
        break;
      }
      case 'TUNNEL_URL': {
        const next = msg.url || null;
        if (!next) {
          // 0.5.30: tunnel 已关闭，停止旧 URL 重连
          lastTunnelUrl = null;
          setStatus(false, msg.text || 'tunnel closed / 隧道已关闭');
          addSys('公网隧道已断开，请在扩展面板重新开启并刷新页面');
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (ws) { try { ws.close(); } catch {} ws = null; }
          break;
        }
        if (next === lastTunnelUrl) {
          setStatus(true, 'tunnel ready');
          break;
        }
        lastTunnelUrl = next;
        if (lastTunnelUrl) {
          const tok = pageToken();
          let display = lastTunnelUrl;
          try {
            const u = new URL(lastTunnelUrl.endsWith('/') ? lastTunnelUrl : lastTunnelUrl + '/');
            if (tok) u.searchParams.set('token', tok);
            display = u.toString();
          } catch {}
          setStatus(true, 'tunnel ready');
          let hint = document.getElementById('tunnelHint');
          if (!hint) {
            hint = document.createElement('div');
            hint.id = 'tunnelHint';
            hint.className = 'msg sys';
            if (feed.firstChild) feed.insertBefore(hint, feed.firstChild);
            else feed.appendChild(hint);
          }
          hint.innerHTML = '';
          const pill = document.createElement('span');
          pill.className = 'sys-pill';
          pill.textContent = `公网入口: ${display}`;
          hint.appendChild(pill);
          addSys('公网入口已更新');
        }
        break;
      }
      default:
        break;
    }
  }

  /* ==================== 会话列表抽屉 ==================== */

  function openDrawer() {
    drawerOverlay.classList.remove('hidden');
    sessionDrawer.classList.add('open');
    // 每次开抽屉重置搜索：残留过滤让用户看不到其余会话（实测开过搜索
    // 后只剩命中项），重头列全量更符合抽屉语义。
    if (sessionSearch) sessionSearch.value = '';
    // 打开瞬间拍下当前排序，之后刷新不再位移行
    sessionRowFreeze = new Map();
    lastSessions.forEach((s, i) => {
      const k = String(s.file || s.id || s.title || i);
      if (!sessionRowFreeze.has(k)) sessionRowFreeze.set(k, i);
    });
    // 每次打开都向 bridge 请求最新会话列表；开抽屉后只渲染第一批应答，
    // 打开期间收到的后续推送不再重建（防点击瞬间行被换走——见 renderSessionList）
    drawerRenderedOnce = true;
    send({ type: 'PHONE_SESSION_LIST' });
  }

  function closeDrawer() {
    drawerOverlay.classList.add('hidden');
    sessionDrawer.classList.remove('open');
    sessionRowFreeze = null;
  }

  /** SESSION_LIST 入口：缓存原始数据后按当前搜索词渲染。
   *  抽屉打开中跳过整树重建：会话活动持续推 SESSION_LIST，innerHTML 重建会在
   *  点击下落瞬间换掉目标行（实测误点 3 次）。数据照常更新，打开时渲染一次、
   *  搜索输入仍实时渲染（renderSessionGroups 由 input 监听直接调）。 */
  let drawerRenderedOnce = false;
  function renderSessionList(sessions) {
    lastSessions = Array.isArray(sessions) ? sessions : [];
    const drawerOpen = sessionDrawer && sessionDrawer.classList.contains('open');
    const searching = sessionSearch && String(sessionSearch.value || '').trim();
    if (drawerOpen && !searching) {
      if (!drawerRenderedOnce) return;
      drawerRenderedOnce = false;
    }
    renderSessionGroups();
  }

  /** mtime → 可比较的毫秒数（无效值当 0） */
  function mtimeMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  /**
   * 按 workspaceId 分组渲染会话列表。
   * 组排序：当前窗口工作区优先 → 组内最近活动时间倒序。
   * 默认只展开当前组（其余折叠，避免列表过长）；用户手动 toggle 后以 wsGroupOpen 为准。
   */
  function renderSessionGroups() {
    if (!sessionList) return;
    const q = String((sessionSearch && sessionSearch.value) || '')
      .trim()
      .toLowerCase();
    // 搜索：title / qualifiedName / displayName / machineName / name 任一 includes 命中
    const arr = lastSessions.filter((s) => {
      if (!q) return true;
      const hay = [s.title, s.qualifiedName, s.displayName, s.machineName, s.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    sessionList.innerHTML = '';
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = q ? '无匹配会话' : '暂无会话';
      sessionList.appendChild(empty);
      return;
    }

    // 分组（缺 workspaceId 的会话归入 __unknown__ 兜底组）
    const groups = new Map();
    for (const s of arr) {
      const gid = s.workspaceId ? String(s.workspaceId) : '__unknown__';
      let g = groups.get(gid);
      if (!g) {
        g = {
          id: gid,
          qualifiedName: s.qualifiedName || s.displayName || '(未知工作区)',
          machineName: s.machineName || null,
          isRemote: !!s.isRemote,
          isCurrent: !!s.isCurrent,
          latest: 0,
          items: [],
        };
        groups.set(gid, g);
      }
      // 组级标记取「任一会话为真」（服务端同组字段一致，这里防御性合并）
      if (s.isCurrent) g.isCurrent = true;
      if (s.isRemote) g.isRemote = true;
      if (!g.machineName && s.machineName) g.machineName = s.machineName;
      const ms = mtimeMs(s.mtime);
      if (ms > g.latest) g.latest = ms;
      g.items.push(s);
    }

    const list = Array.from(groups.values()).sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (sessionRowFreeze) {
        const ia = sessionRowFreeze.get(String((a.items[0] || {}).file || a.id)) ?? 1e9;
        const ib = sessionRowFreeze.get(String((b.items[0] || {}).file || b.id)) ?? 1e9;
        if (ia !== ib) return ia - ib;
      }
      return b.latest - a.latest;
    });

    for (const g of list) {
      g.items.sort((a, b) => {
        if (sessionRowFreeze) {
          const ia = sessionRowFreeze.get(String(a.file || a.id || a.title || '')) ?? 1e9;
          const ib = sessionRowFreeze.get(String(b.file || b.id || b.title || '')) ?? 1e9;
          if (ia !== ib) return ia - ib;
        }
        return mtimeMs(b.mtime) - mtimeMs(a.mtime);
      });
      // 默认：当前组展开、其余折叠；搜索中全部展开便于查看命中项
      const defaultOpen = q ? true : g.isCurrent;
      const open = wsGroupOpen.has(g.id) ? !!wsGroupOpen.get(g.id) : defaultOpen;

      const groupEl = document.createElement('div');
      groupEl.className = 'ws-group' + (open ? ' open' : '');

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'ws-group-header';
      header.setAttribute('aria-expanded', open ? 'true' : 'false');

      const caret = document.createElement('span');
      caret.className = 'codicon codicon-chevron-right ws-caret';

      if (g.isRemote) {
        const remoteIcon = document.createElement('span');
        remoteIcon.className = 'codicon codicon-remote ws-remote-icon';
        remoteIcon.title = '远程工作区';
        header.append(caret, remoteIcon);
      } else {
        header.append(caret);
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'ws-group-name';
      nameEl.textContent = g.qualifiedName;
      nameEl.title = g.qualifiedName;
      header.appendChild(nameEl);

      if (g.isRemote && g.machineName) {
        const mb = document.createElement('span');
        mb.className = 'ws-badge remote';
        mb.textContent = g.machineName;
        header.appendChild(mb);
      }
      if (g.isCurrent) {
        const cb = document.createElement('span');
        cb.className = 'ws-badge current';
        cb.textContent = '当前';
        header.appendChild(cb);
      }
      const cnt = document.createElement('span');
      cnt.className = 'ws-group-count';
      cnt.textContent = String(g.items.length);
      header.appendChild(cnt);

      header.addEventListener('click', () => {
        const next = !groupEl.classList.contains('open');
        wsGroupOpen.set(g.id, next);
        groupEl.classList.toggle('open', next);
        header.setAttribute('aria-expanded', next ? 'true' : 'false');
      });

      const body = document.createElement('div');
      body.className = 'ws-group-body';

      for (const s of g.items) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'session-item';
        // 标记当前绑定会话——抽屉重开时用户需要一眼看到「我正连着哪个」。
        if (s.file && currentSessionMeta.file &&
            baseNameAny(s.file).replace(/\.jsonl$/i, '') ===
            baseNameAny(currentSessionMeta.file).replace(/\.jsonl$/i, '')) {
          item.classList.add('bound');
          item.setAttribute('aria-current', 'true');
        }
        // 优先显示标题（官方 customTitle / 首条消息截断），无标题才用 UUID
        const label = (s.title && String(s.title).trim()) || s.name || '(未命名)';
        const name = document.createElement('span');
        name.className = 'session-name';
        name.textContent = label;
        name.title = s.file || '';
        const meta = document.createElement('span');
        meta.className = 'session-meta';
        const count = Number.isFinite(Number(s.requestCount)) ? Number(s.requestCount) : 0;
        meta.textContent = `${relTime(s.mtime)} · ${count} 次请求`;
        item.append(name, meta);
        item.addEventListener('click', () => {
          try {
            if (!window.__sessionTitleCache) window.__sessionTitleCache = Object.create(null);
            const lab = (s.title && String(s.title).trim()) || s.name || titleFromSessionFile(s.file);
            if (s.file && lab) window.__sessionTitleCache[s.file] = lab;
            setSessionTitle(lab, s.file);
          } catch (_) {}
          send({ type: 'PHONE_SESSION_SELECT', file: s.file });
          closeDrawer();
        });
        body.appendChild(item);
      }

      groupEl.append(header, body);
      sessionList.appendChild(groupEl);
    }
  }

  /** mtime → 相对时间（支持 ISO 字符串 / 秒 / 毫秒时间戳） */
  function relTime(v) {
    if (v == null || v === '') return '';
    let ms;
    if (typeof v === 'number') {
      ms = v < 1e12 ? v * 1000 : v; // 秒 → 毫秒
    } else {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '';
      ms = d.getTime();
    }
    const diff = Date.now() - ms;
    const abs = Math.abs(diff);
    if (abs < 60000) return '刚刚';
    const min = Math.floor(abs / 60000);
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    return new Date(ms).toLocaleDateString();
  }

  /* ==================== VS Code 实例抽屉 ==================== */

  function openInstanceDrawer() {
    instanceOverlay.classList.remove('hidden');
    instanceDrawer.classList.add('open');
    // 每次打开都向 bridge 请求实例列表（服务端扫描 basePort..+20）
    clearTimeout(instanceListTimer);
    instanceListTimer = setTimeout(() => {
      // 服务端无响应兜底（如未接线 PHONE_INSTANCE_LIST）
      if (!instanceList.querySelector('.instance-item')) {
        instanceList.innerHTML = '<div class="drawer-empty">未获取到实例列表</div>';
      }
      instanceListTimer = null;
    }, 3000);
    send({ type: 'PHONE_INSTANCE_LIST' });
  }

  function closeInstanceDrawer() {
    clearTimeout(instanceListTimer);
    instanceListTimer = null;
    instanceOverlay.classList.add('hidden');
    instanceDrawer.classList.remove('open');
  }

  /** 当前 ws 连接的端口（用于标注"当前实例"；端口在实例间唯一） */
  function currentWsPort() {
    try {
      return Number(new URL(wsUrl()).port) || 0;
    } catch {
      return 0;
    }
  }

  /** 渲染 INSTANCE_LIST.instances：workspaceName + 主徽标 + host:port + 当前标注 */
  function renderInstanceList(instances) {
    const arr = Array.isArray(instances) ? instances : [];
    instanceList.innerHTML = '';
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.className = 'drawer-empty';
      empty.textContent = '未发现其他实例';
      instanceList.appendChild(empty);
      return;
    }
    const curPort = currentWsPort();
    for (const inst of arr) {
      const port = Number(inst.port) || 0;
      const isCurrent = port > 0 && port === curPort;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'instance-item' + (isCurrent ? ' current' : '');
      // 第一行：workspaceName + "主"徽标（isPrimary）
      const nameRow = document.createElement('span');
      nameRow.className = 'instance-name-row';
      const name = document.createElement('span');
      name.className = 'instance-name';
      name.textContent = inst.workspaceName || '(未命名工作区)';
      nameRow.appendChild(name);
      if (inst.isPrimary === true) {
        const badge = document.createElement('span');
        badge.className = 'instance-badge primary';
        badge.textContent = '主';
        nameRow.appendChild(badge);
      }
      // 第二行：host:port + 当前实例标注
      const meta = document.createElement('span');
      meta.className = 'instance-meta';
      const host = inst.host || '127.0.0.1';
      meta.textContent = `${host}:${port}`;
      if (isCurrent) {
        const cur = document.createElement('span');
        cur.className = 'instance-current';
        cur.textContent = '当前实例';
        meta.appendChild(cur);
      }
      item.append(nameRow, meta);
      item.addEventListener('click', () => switchInstance(inst, item));
      instanceList.appendChild(item);
    }
  }

  /** 切换到目标实例：持久化 ws 地址 → 关闭旧连接 → 重连（token 沿用页面 ?token=） */
  function switchInstance(inst, itemEl) {
    if (itemEl && itemEl.classList.contains('current')) {
      closeInstanceDrawer();
      return; // 已是当前实例，无需重连
    }
    let targetHost = inst.host || '127.0.0.1';
    // 手机可达性：bridge 上报的 host 常为 127.0.0.1（本机视角），
    // 若页面正通过非回环地址访问（局域网 IP），则沿用页面 host 替换，仅换端口
    const pageHost = location.hostname;
    if (isLoopbackHost(targetHost) && pageHost && !isLoopbackHost(pageHost)) {
      targetHost = pageHost;
    }
    const url = `ws://${targetHost}:${Number(inst.port) || 0}`;
    try {
      localStorage.setItem('sidecar.instanceUrl', url);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    instanceUrlOverride = url;
    lastTunnelUrl = null; // 新实例的隧道状态未知，等 TUNNEL_URL 重新上报
    // 关闭旧连接（摘掉 onclose 防止触发 scheduleReconnect），随后立即重连
    const old = ws;
    if (old) {
      old.onclose = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    reconnectAttempt = 0;
    connect();
    closeInstanceDrawer();
    addSys(`已切换到实例: ${inst.workspaceName || '(未命名工作区)'} (${targetHost}:${Number(inst.port) || 0})`);
  }

  /* ==================== 终端面板 ==================== */

  function openTerminalPanel() {
    terminalPanel.classList.add('open');
    terminalInput.focus();
    send({ type: 'PHONE_TERMINAL_LIST' });
  }

  function closeTerminalPanel() {
    terminalPanel.classList.remove('open');
  }

  /** 渲染 TERMINAL_LIST.terminals 到下拉框 */
  function renderTerminalList(terminals) {
    const arr = Array.isArray(terminals) ? terminals : [];
    terminalSelect.innerHTML = '';
    if (!arr.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（无终端）';
      terminalSelect.appendChild(opt);
      currentTerminalId = null;
      return;
    }
    for (const t of arr) {
      const opt = document.createElement('option');
      opt.value = t.id != null ? String(t.id) : '';
      opt.textContent = t.name || t.id || 'terminal';
      terminalSelect.appendChild(opt);
    }
    // 尽量保持上次选择
    if (currentTerminalId != null) {
      const found = Array.from(terminalSelect.options).some(
        (o) => o.value === String(currentTerminalId),
      );
      if (found) terminalSelect.value = String(currentTerminalId);
    }
    currentTerminalId = terminalSelect.value || null;
  }

  function execTerminal() {
    const command = (terminalInput.value || '').trim();
    if (!command) return;
    const terminalId = terminalSelect.value || currentTerminalId || undefined;
    if (!send({ type: 'PHONE_TERMINAL_EXEC', command, terminalId })) {
      appendTerminalOutput('[未连接，无法执行]\n', 'term-error');
      return;
    }
    appendTerminalOutput(`$ ${command}\n`);
    terminalInput.value = '';
    terminalInput.focus();
  }

  /** 追加一行终端输出（textContent 保证安全转义） */
  function appendTerminalOutput(text, cls) {
    if (text == null || text === '') return;
    // 剥 shell-integration OSC（ESC]…BEL 或 ESC]…ESC\，如 PowerShell 633;C）、
    // ANSI CSI 序列（ESC[…letter，颜色/光标——pre 渲不出颜色只留乱码）
    // 与其余 C0 控制符。
    text = String(text)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    if (!text) return;
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    terminalOutput.appendChild(span);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  /* ==================== 模型 / 审批模式底部 sheet ==================== */

  /** 模型切换在途标记（防止重复点击） */
  let modelSwitching = false;
  /** 本次 PHONE_MODEL_SELECT 的目标 id（MODEL_SELECTED 未回传 id 时兜底） */
  let pendingModelId = null;
  /** 审批级别切换在途标记 */
  let permissionSwitching = false;
  /** 本次 PHONE_PERMISSION_SET 的目标 level */
  let pendingPermissionLevel = null;

  /** trigger 胶囊文字截断（默认 14 字符，超长省略） */
  function truncLabel(s, max) {
    const t = String(s == null ? '' : s).trim();
    const n = max || 14;
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  /** 显示/隐藏 sheet 顶部错误条（text 为空即隐藏） */
  function setSheetError(el, text) {
    if (!el) return;
    if (text) {
      el.textContent = String(text);
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  /** 列表占位文字（加载中 / 空态） */
  function setSheetPlaceholder(container, text) {
    if (!container) return;
    container.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'sheet-empty';
    d.textContent = String(text || '');
    container.appendChild(d);
  }

  /**
   * 构造一行 sheet 选项：左侧 ✓ 占位 + 主文字 + 次文字
   * @returns {{ row: HTMLElement, sub: HTMLElement }}
   */
  function buildSheetRow(title, subText, isCurrent) {
    const row = document.createElement('div');
    row.className = 'sheet-row' + (isCurrent ? ' current' : '');
    row.setAttribute('role', 'button');

    const check = document.createElement('span');
    check.className = 'sheet-check';
    // 非当前项也保留占位，保证文字左对齐
    if (isCurrent) check.classList.add('codicon', 'codicon-check');
    row.appendChild(check);

    const body = document.createElement('div');
    body.className = 'sheet-row-body';
    const t = document.createElement('div');
    t.className = 'sheet-row-title';
    t.textContent = String(title || '');
    body.appendChild(t);
    const sub = document.createElement('div');
    sub.className = 'sheet-row-sub';
    sub.textContent = String(subText || '');
    body.appendChild(sub);
    row.appendChild(body);

    return { row, sub };
  }

  /** 打开指定 sheet（显示遮罩，同时关闭另一个 sheet） */
  function openSheet(sheetEl) {
    if (!sheetEl) return;
    if (modelSheet && modelSheet !== sheetEl) modelSheet.classList.remove('open');
    if (permissionSheet && permissionSheet !== sheetEl) permissionSheet.classList.remove('open');
    if (sheetOverlay) sheetOverlay.classList.remove('hidden');
    sheetEl.classList.add('open');
  }

  /** 关闭全部 sheet 与共用遮罩 */
  function closeSheets() {
    if (modelSheet) modelSheet.classList.remove('open');
    if (permissionSheet) permissionSheet.classList.remove('open');
    if (sheetOverlay) sheetOverlay.classList.add('hidden');
  }

  /** MODEL_LIST 入口：缓存 + 同步 trigger 标签 + 重绘（不负责打开 sheet） */
  function renderModelList(models) {
    modelsCache = Array.isArray(models) ? models.slice() : [];
    let cur = modelsCache.find((m) => m && m.isCurrent);
    if (!cur && currentModelId) {
      cur = modelsCache.find((m) => m && m.id === currentModelId);
    }
    if (cur) {
      currentModelId = cur.id || null;
      if (btnModelLabel) btnModelLabel.textContent = truncLabel(cur.name || cur.id || '模型');
    } else if (btnModelLabel && !modelsCache.length) {
      btnModelLabel.textContent = '模型';
    }
    paintModelRows();
  }

  /** 按 modelSearch 过滤后重绘模型行 */
  function paintModelRows() {
    if (!modelList) return;
    const all = modelsCache || [];
    const q = String((modelSearch && modelSearch.value) || '')
      .trim()
      .toLowerCase();
    const list = q
      ? all.filter((m) => {
          if (!m) return false;
          const hay = `${m.name || ''} ${m.family || ''} ${m.id || ''}`.toLowerCase();
          return hay.includes(q);
        })
      : all.filter(Boolean);

    if (!list.length) {
      setSheetPlaceholder(modelList, all.length ? '无匹配模型' : '无可用模型');
      return;
    }

    modelList.innerHTML = '';
    for (const m of list) {
      const parts = [];
      if (m.vendor) parts.push(String(m.vendor));
      if (m.family) parts.push(String(m.family));
      const maxTok = Number(m.maxInputTokens);
      if (Number.isFinite(maxTok) && maxTok > 0) parts.push(`${Math.round(maxTok / 1000)}K 上下文`);
      const built = buildSheetRow(m.name || m.id || '(未命名模型)', parts.join(' · '), !!m.isCurrent);
      const row = built.row;
      const sub = built.sub;
      row.addEventListener('click', () => {
        if (modelSwitching) return;
        Haptics.tap();
        modelSwitching = true;
        pendingModelId = m.id || null;
        setSheetError(modelError, '');
        sub.textContent = '切换中…';
        row.classList.add('disabled');
        const ok = send({
          type: 'PHONE_MODEL_SELECT',
          id: m.id,
          vendor: m.vendor,
          family: m.family,
        });
        if (!ok) {
          modelSwitching = false;
          pendingModelId = null;
          setSheetError(modelError, '未连接，无法切换模型');
          paintModelRows();
        }
      });
      modelList.appendChild(row);
    }
  }

  /** MODEL_SELECTED 处理：成功则更新 trigger 并关闭 sheet，失败显示错误条 */
  function onModelSelected(msg) {
    modelSwitching = false;
    const ok = !!(msg && msg.ok);
    if (ok) {
      const id = (msg && msg.id) || pendingModelId;
      let name = '';
      for (const m of modelsCache || []) {
        if (!m) continue;
        const hit = m.id === id;
        m.isCurrent = hit;
        if (hit) name = m.name || m.id || '';
      }
      if (id) currentModelId = id;
      if (btnModelLabel && (name || id)) btnModelLabel.textContent = truncLabel(name || id);
      setSheetError(modelError, '');
      paintModelRows();
      closeSheets();
    } else {
      setSheetError(modelError, (msg && msg.error) || '切换模型失败');
      paintModelRows();
    }
    pendingModelId = null;
  }

  /** PERMISSION_LIST 入口：缓存 + 同步 trigger 标签 + 重绘（不负责打开 sheet） */
  function renderPermissionList(levels, current) {
    permissionLevelsCache = Array.isArray(levels) ? levels.slice() : [];
    if (current) currentPermissionLevel = String(current);
    const cur = permissionLevelsCache.find((l) => l && l.id === currentPermissionLevel);
    if (cur && btnPermissionLabel) {
      btnPermissionLabel.textContent = truncLabel(cur.label || cur.id || '审批');
    }
    paintPermissionRows();
  }

  /** 重绘审批级别行（default / assisted / autoApprove / autopilot） */
  function paintPermissionRows() {
    if (!permissionList) return;
    const all = (permissionLevelsCache || []).filter(Boolean);
    if (!all.length) {
      setSheetPlaceholder(permissionList, '无可用审批模式');
      return;
    }

    permissionList.innerHTML = '';
    for (const lv of all) {
      const isCurrent = lv.id === currentPermissionLevel;
      const disabled = lv.available === false;
      let subText = String(lv.description || '');
      if (disabled && lv.unavailableReason) {
        subText = subText ? `${subText} · ${lv.unavailableReason}` : String(lv.unavailableReason);
      }
      const built = buildSheetRow(lv.label || lv.id || '(未命名)', subText, isCurrent);
      const row = built.row;
      const sub = built.sub;
      if (disabled) {
        row.classList.add('disabled');
        row.setAttribute('aria-disabled', 'true');
        permissionList.appendChild(row);
        continue; // 不可用行不绑点击
      }
      row.addEventListener('click', () => {
        if (permissionSwitching) return;
        Haptics.tap();
        permissionSwitching = true;
        pendingPermissionLevel = lv.id || null;
        setSheetError(permissionError, '');
        sub.textContent = '切换中…';
        row.classList.add('disabled');
        const ok = send({ type: 'PHONE_PERMISSION_SET', level: lv.id, persist: true });
        if (!ok) {
          permissionSwitching = false;
          pendingPermissionLevel = null;
          setSheetError(permissionError, '未连接，无法切换审批模式');
          paintPermissionRows();
        }
      });
      permissionList.appendChild(row);
    }
  }

  /** PERMISSION_SET 处理：notice 一律进 feed；ok 更新 trigger 并关闭，失败显示错误条 */
  function onPermissionSet(msg) {
    permissionSwitching = false;
    const ok = !!(msg && msg.ok);
    if (msg && msg.notice) addSys(String(msg.notice));
    if (ok) {
      const level = (msg && msg.level) || pendingPermissionLevel;
      if (level) currentPermissionLevel = String(level);
      const cur = (permissionLevelsCache || []).find((l) => l && l.id === currentPermissionLevel);
      if (btnPermissionLabel) {
        btnPermissionLabel.textContent = truncLabel(
          (cur && (cur.label || cur.id)) || currentPermissionLevel || '审批',
        );
      }
      setSheetError(permissionError, '');
      paintPermissionRows();
      closeSheets();
    } else {
      setSheetError(permissionError, (msg && msg.error) || '切换审批模式失败');
      paintPermissionRows();
    }
    pendingPermissionLevel = null;
  }

  function send(obj) {
    return sendMessage(obj);
  }

  function sendMessage(obj, opts) {
    if (!obj || typeof obj !== 'object') return false;
    // 半死 socket：OPEN 但超过 3 个心跳周期无任何入站 → ws.send 会静默吞。
    // 不碰这条链路：判离线入队 + 立即重连，消息经重连后 flushOutboundQueue 送达。
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      lastInboundAt > 0 &&
      Date.now() - lastInboundAt > SOCKET_STALE_MS
    ) {
      if (opts && opts.queueIfOffline && obj.type === 'PHONE_MESSAGE') {
        if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) outboundQueue.shift();
        obj.at = Date.now();
        outboundQueue.push(obj);
      }
      forceReconnect();
      return false;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (opts && opts.queueIfOffline && obj.type === 'PHONE_MESSAGE') {
        if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) outboundQueue.shift();
        obj.at = Date.now();
        outboundQueue.push(obj);
      }
      return false;
    }
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {
      if (opts && opts.queueIfOffline && obj.type === 'PHONE_MESSAGE') {
        if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) outboundQueue.shift();
        obj.at = Date.now();
        outboundQueue.push(obj);
      }
      return false;
    }
  }

  function flushOutboundQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !outboundQueue.length) return;
    const now = Date.now();
    let pending = outboundQueue.splice(0, outboundQueue.length);
    // 丢弃过期消息（半死 socket 恢复后，几分钟前的待发不该再幽灵补发撞车）
    const fresh = [];
    let expired = 0;
    for (const m of pending) {
      if (m.type === 'PHONE_MESSAGE' && m.at && now - m.at > OUTBOUND_QUEUE_TTL_MS) { expired++; continue; }
      fresh.push(m);
    }
    pending = fresh;
    if (expired) addSys(`有 ${expired} 条离线消息已过期，未送达`);
    for (let i = 0; i < pending.length; i++) {
      if (sendMessage(pending[i])) continue;
      outboundQueue.unshift(...pending.slice(i));
      break;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectAttempt += 1;
    const delay = Math.min(8000, 800 + reconnectAttempt * 400);
    reconnectTimer = setTimeout(connect, delay);
  }

  /** 半死/断链强制重连：摘掉旧 handler 防重复触发，close 后立刻 connect */
  function forceReconnect() {
    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch (_) {}
      ws = null;
    }
    clearTimeout(reconnectTimer);
    connect();
  }

  function connect() {
    intentionalClose = false;
    // 新连接视为活性起点：首个 PING 未达前不误判半死
    lastInboundAt = Date.now();
    const tok = pageToken();
    setStatus(
      false,
      reconnectAttempt
        ? `重连中… (#${reconnectAttempt})`
        : tok
          ? 'connecting…'
          : 'connecting…（若一直失败请确认 URL 含 token）',
    );
    try {
      // 清掉上一连接的 handler，避免 intentionalClose 后旧 onclose 仍触发重连
      if (ws) {
        try {
          ws.onclose = null;
          ws.onerror = null;
          ws.onmessage = null;
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        } catch {
          /* ignore */
        }
      }
      ws = new WebSocket(wsUrl());
    } catch (e) {
      setStatus(false, 'WebSocket 创建失败');
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      reconnectAttempt = 0;
      setStatus(true, '已连接');
      pushSubscribed = false;
      const t = pageToken();
      if (!t) {
        // 仍发 CONNECT：无 auth 的 bridge 可进；有 auth 的会回 AUTH_FAILED
        send({ type: 'PHONE_CONNECT' });
      } else {
        send({ type: 'PHONE_CONNECT', token: t });
      }
      // 断线重连后重申已选会话：服务端连上即推一次“当前绑定会话”回放，而
      // 重启/冷启动后绑定可能漂到别的最新文件（空 New Chat、被停止会话等），
      // 不重申的话错会话历史会直接盖到 feed（标题留旧、内容是别人的）。
      // 重申后服务端回 SESSION_SELECTED + 正式回放，视图被拉回用户会话。
      if (hasConnectedOnce && currentSessionMeta.file) {
        send({ type: 'PHONE_SESSION_SELECT', file: currentSessionMeta.file, reannounce: true });
      }
      hasConnectedOnce = true;
    };
    ws.onmessage = (ev) => {
      // 任何入站（含服务端 PING）都算活性证据
      lastInboundAt = Date.now();
      try {
        handle(JSON.parse(String(ev.data)));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (intentionalClose) {
        // 鉴权失败等主动断开：不再 connecting 死循环
        return;
      }
      setStatus(false, '已断开，重连中…');
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (!intentionalClose) setStatus(false, '连接错误');
    };
  }

  function doSend() {
    // 请求进行中：发送键已变成停止；但流已静默超阈值的僵尸态直接当作空闲
    if (requestRunning && lastStreamActivityAt && Date.now() - lastStreamActivityAt > STREAM_STALE_MS) {
      forceFinishDeadStream();
    }
    if (requestRunning) {
      // 有文本 = 排队发送（杀在途轮太狠）；空文本 = 停止（需双击确认）
      const queuedText = (input.value || '').trim();
      if (queuedText) {
        // 入队即渲泡（半透明排队态）：出队时复用同一元素转正常，不再「提示在泡不在」。
        const qKey = `user:queued:${Date.now()}:${userTextDedupeKey(queuedText)}`;
        const qEl = addUser(queuedText, qKey, { force: true, ts: Date.now() });
        if (qEl) qEl.classList.add('queued');
        pendingSendQueue.push({ text: queuedText, mode: modeEl.value || 'agent', el: qEl, key: qKey, at: Date.now(), sess: currentSessionMeta.file || '' });
        persistQueuedSends();
        input.value = '';
        input.style.height = 'auto';
        queuedHintEl = addSys('已排队：当前回复结束后自动发送');
        return;
      }
      if (Date.now() < stopArmUntil) {
        stopArmUntil = 0;
        try { sendBtn.title = '停止当前 Copilot 请求'; } catch (_) {}
        doStop();
        return;
      }
      stopArmUntil = Date.now() + 3000;
      addSys('再次点击「停止」中断当前回复');
      try { sendBtn.title = '再次点击确认停止'; } catch (_) {}
      setTimeout(() => {
        if (stopArmUntil && Date.now() >= stopArmUntil) {
          stopArmUntil = 0;
          try { sendBtn.title = '停止当前 Copilot 请求'; } catch (_) {}
        }
      }, 3100);
      return;
    }
    const text = (input.value || '').trim();
    if (!text) return;
    sendTextNow(text, modeEl.value || 'agent');
  }

  /** 队列出队发送（仅在未运行且有连接时）；供回复结束/停止/收尸后触发 */
  function flushPendingSendQueue() {
    if (!pendingSendQueue.length) return;
    // 僵尸 rr：DONE 丢失/被去重吞掉时 rr 卡死，flush 全靠 10s 看门狗兜底，
    // 实测排队消息滞留 40-55s。这里就地收尸（内部会再调本函数重试）。
    if (requestRunning && lastStreamActivityAt && Date.now() - lastStreamActivityAt > STREAM_STALE_MS) {
      forceFinishDeadStream();
      return;
    }
    if (requestRunning) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 刚发未答的条目挡队列：0.67 无流路径上 DONE+宽限不等于真轮终，
    // 此时放行会让下一条插队成 U1U2A1A2。超龄条目（死轮/孤儿）不挡队列。
    const now = Date.now();
    if (sentAwaitingReply.some((e) => now - (e.at || 0) < AWAIT_REPLY_FLUSH_BLOCK_MS)) return;
    const n = pendingSendQueue.shift();
    persistQueuedSends();
    if (n) {
      if (n.el && n.el.isConnected) {
        // 复用入队时已渲的泡：去掉排队态，别再画第二个
        n.el.classList.remove('queued');
        sendTextNow(n.text, n.mode, n.el, n.key, true);
      } else {
        // 泡已被回放/跟随重建换掉时走无 el 分支——同样不得清输入框：
        // 入队时已清过，排队期用户可能打了新草稿（实测泡失联路径草稿被抹）。
        sendTextNow(n.text, n.mode, undefined, undefined, true);
      }
    }
    if (!pendingSendQueue.length && queuedHintEl) {
      queuedHintEl.remove();
      queuedHintEl = null;
    }
  }

  function sendTextNow(text, mode, existingEl, existingKey, keepDraft) {
    Haptics.tap();
    // 0.5.19+：手机发送 force 上屏，避免短文案「1」被历史同文去重吞掉
    // existingEl：排队期已渲的泡——复用，不再重复画（localKey 沿用入队时的 key）。
    const localKey = existingKey || `user:local:${Date.now()}:${userTextDedupeKey(text)}`;
    if (!(existingEl && existingEl.isConnected)) {
      const painted = addUser(text, localKey, { force: true, ts: Date.now() });
      if (!painted) {
        try {
          recentPhoneUserAt.delete(userTextDedupeKey(text));
          seenKeys.delete(localKey);
          seenKeys.delete(userTextDedupeKey(text));
        } catch (_) {}
        addUser(text, localKey, { force: true });
      }
    } else {
      // 入队泡已带 textKey；补齐 dataset.key 使回声去重链路一致
      try { if (localKey && !existingEl.dataset.key) existingEl.dataset.key = localKey; } catch (_) {}
      // 出队才是真正发送时刻：重新盖章回声去重窗——入队时盖的章在
      // 排队 >15s 后已过期，回声穿透去重会再画一个用户泡。
      try { notePhoneUserText(text); } catch (_) {}
      // 泡随真实发送时刻归位：入队 ts 早于前轮答案 → 留在原位置会把
      // feed 呈现成 U1U2A1A2 堆叠（线上顺序实为 U1A1U2A2）。
      try {
        existingEl.dataset.ts = String(Date.now());
        appendFeedChronological(existingEl, Date.now());
      } catch (_) {}
    }
    const beforeQueue = outboundQueue.length;
    const sent = sendMessage(
      { type: 'PHONE_MESSAGE', text, mode, file: currentSessionMeta.file || undefined },
      { queueIfOffline: true },
    );
    if (!sent && outboundQueue.length === beforeQueue) {
      addSys('未连接，消息未发送');
      return;
    }
    if (!sent) {
      // 离线入队≠送达：保留输入框文本供重发（入队副本仍在，送达前用户可编辑）
      addSys('当前离线，消息已加入发送队列');
      input.focus();
      return;
    }
    setRequestRunning(true, 'Copilot 正在输入…');
    showTyping();
    // 出队发送不清输入框：入队时已清空，此后用户可能又打了新草稿——
    // 出队抹掉它是静默丢稿（R29-X1）。直连发送照常清空。
    if (!keepDraft) {
      input.value = '';
      input.style.height = 'auto';
    }
    sendVerifyRestoredText = null; // 新发送即抛弃旧回填标记
    // 半死 socket 防御：N 秒内服务器没回声这条消息就判丢，回填文本让用户重发。
    // 同时写 sessionStorage——半死 socket 报错可能刷新页面杀死计时器，刷新后启动时回填。
    if (pendingSendCheck) clearTimeout(pendingSendCheck.timer);
    persistPendingSend(text, localKey);
    if (sentAwaitingReply.length >= 8) sentAwaitingReply.shift();
    // sess 标发送时的会话文件：SESSION_SELECTED 切换后丢别会话残留，防跨会话误重画
    sentAwaitingReply.push({ text, key: localKey, sess: currentSessionMeta.file, at: Date.now() });
    persistSentAwaiting();
    const sentTextKey = userTextDedupeKey(text);
    pendingSendCheck = {
      textKey: sentTextKey,
      text,
      timer: setTimeout(() => {
        if (!pendingSendCheck) return;
        const lost = pendingSendCheck.text;
        const lostKey = pendingSendCheck.textKey;
        pendingSendCheck = null;
        clearPendingSend();
        if (!(input.value || '').trim()) { input.value = lost; sendVerifyRestoredText = lost; }
        if (requestRunning) {
          requestRunning = false;
          paintSendButton();
        }
        // 判定未送达的消息不再是「待答」——残留条目会让后来的真 DONE 因
        // hasFreshAwait 永远拿不到释放权（rr 卡 120s），队列随之卡死。
        for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
          if (userTextDedupeKey(sentAwaitingReply[i].text) === lostKey) sentAwaitingReply.splice(i, 1);
        }
        sendVerifyMissedAt = Date.now();
        addSys('发送可能未送达（连接异常），文本已回填，请重新发送');
      }, SEND_VERIFY_MS),
    };
  }

  /** 僵尸流收尸：清 streaming 视觉态 + 释放发送键（不发 phone_stop——流本就死了） */
  function forceFinishDeadStream() {
    for (const entry of streamingTurns.values()) {
      if (entry.element) entry.element.classList.remove('streaming');
      if (entry.bubble) entry.bubble.classList.remove('streaming');
    }
    streamingTurns.clear();
    markAllToolsDone();
    clearTyping();
    if (requestDoneTimer) {
      clearTimeout(requestDoneTimer);
      requestDoneTimer = null;
    }
    requestRunning = false;
    paintSendButton();
    if (statusText) statusText.textContent = connectedLabel();
    setTimeout(flushPendingSendQueue, 800);
  }

  function doStop() {
    Haptics.stop();
    if (!requestRunning && !requestDoneTimer) return;
    if (!send({ type: 'PHONE_STOP' })) {
      addSys('未连接，无法停止');
      return;
    }
    finishAllAssistantVisuals();
    if (requestDoneTimer) {
      clearTimeout(requestDoneTimer);
      requestDoneTimer = null;
    }
    requestRunning = false;
    // stop 后死流引用全清，防止后续广播挂进已终态的 turn 元素造成 feed 尾部腐坏
    streamingTurns.clear();
    reqToStream.clear();
    lastActiveStreamId = null;
    paintSendButton();
    if (statusText) statusText.textContent = connectedLabel();
    addSys('已请求停止');
    setTimeout(flushPendingSendQueue, 800);
  }

  sendBtn.addEventListener('click', () => {
    // 焦点陷阱：按钮点击后持焦，之后按 Space（翻页/惯性）会二次触发 click——
    // 发送后变「停止」态，Space 误停；点完即失焦。
    try { sendBtn.blur(); } catch {}
    doSend();
  });

  // 会话抽屉事件
  btnSessions.addEventListener('click', () => {
    if (sessionDrawer.classList.contains('open')) closeDrawer();
    else openDrawer();
  });
  drawerClose.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  // 搜索框：输入即按当前关键词重绘分组（renderSessionGroups 内部读 value 过滤）
  if (sessionSearch) {
    sessionSearch.addEventListener('input', () => renderSessionGroups());
    // 移动端 search 输入框的清除按钮触发 search 事件而非 input
    sessionSearch.addEventListener('search', () => renderSessionGroups());
  }

  // 实例抽屉事件
  btnInstances.addEventListener('click', () => {
    if (instanceDrawer.classList.contains('open')) closeInstanceDrawer();
    else openInstanceDrawer();
  });
  instanceClose.addEventListener('click', closeInstanceDrawer);
  instanceOverlay.addEventListener('click', closeInstanceDrawer);

  // 终端面板事件
  btnTerminal.addEventListener('click', () => {
    if (terminalPanel.classList.contains('open')) closeTerminalPanel();
    else openTerminalPanel();
  });
  terminalClose.addEventListener('click', closeTerminalPanel);
  terminalExec.addEventListener('click', execTerminal);
  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      execTerminal();
    }
  });
  terminalSelect.addEventListener('change', () => {
    currentTerminalId = terminalSelect.value || null;
  });

  // 模型 / 审批模式 sheet 事件（元素缺失时静默跳过）
  if (btnModel) {
    btnModel.addEventListener('click', () => {
      if (modelSheet && modelSheet.classList.contains('open')) {
        closeSheets();
        return;
      }
      setSheetError(modelError, '');
      modelSwitching = false;
      openSheet(modelSheet);
      setSheetPlaceholder(modelList, '加载模型…');
      if (!send({ type: 'PHONE_MODEL_LIST' })) {
        setSheetPlaceholder(modelList, '未连接，无法获取模型列表');
      }
    });
  }
  if (btnPermission) {
    btnPermission.addEventListener('click', () => {
      if (permissionSheet && permissionSheet.classList.contains('open')) {
        closeSheets();
        return;
      }
      setSheetError(permissionError, '');
      permissionSwitching = false;
      openSheet(permissionSheet);
      setSheetPlaceholder(permissionList, '加载审批模式…');
      if (!send({ type: 'PHONE_PERMISSION_LIST' })) {
        setSheetPlaceholder(permissionList, '未连接，无法获取审批模式');
      }
    });
  }
  if (modelSheetClose) modelSheetClose.addEventListener('click', closeSheets);
  if (permissionSheetClose) permissionSheetClose.addEventListener('click', closeSheets);
  if (sheetOverlay) sheetOverlay.addEventListener('click', closeSheets);
  if (modelSearch) modelSearch.addEventListener('input', paintModelRows);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheets();
  });
  input.addEventListener('keydown', (e) => {
    // IME 组词期间 Enter 是选词确认，不是发送——缺此判断中文输入会误发。
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  });
  bindScrollHold();

  const btnScrollBottom = document.getElementById('btnScrollBottom');
  if (btnScrollBottom) {
    btnScrollBottom.addEventListener('click', () => {
      Haptics.tap();
      feed.style.scrollBehavior = 'smooth';
      feed.scrollTop = feed.scrollHeight;
      setTimeout(() => {
        try { feed.style.scrollBehavior = 'auto'; } catch (_) {}
      }, 300);
    });
  }

  if (feed) {
    feed.addEventListener('scroll', () => {
      if (btnScrollBottom) {
        if (!feedIsAtBottom()) {
          btnScrollBottom.classList.add('visible');
        } else {
          btnScrollBottom.classList.remove('visible');
        }
      }
    }, { passive: true });
  }

  // Visual Viewport safe height calculation for iOS/Android on-screen keyboards
  if (window.visualViewport) {
    const updateViewportHeight = () => {
      const vh = window.visualViewport.height;
      document.documentElement.style.setProperty('--viewport-height', `${vh}px`);
    };
    window.visualViewport.addEventListener('resize', updateViewportHeight);
    window.visualViewport.addEventListener('scroll', updateViewportHeight);
    updateViewportHeight();
  }

  let lastHiddenTime = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      lastHiddenTime = Date.now();
    } else if (document.visibilityState === 'visible') {
      const elapsed = lastHiddenTime ? Date.now() - lastHiddenTime : 0;
      const isZombieOrClosed = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
      // 唤醒即查活性：后台挂起期间入站停摆，lastInboundAt 超时即半死 → 重连
      const stale = lastInboundAt > 0 && Date.now() - lastInboundAt > SOCKET_STALE_MS;
      if (elapsed > 15000 || isZombieOrClosed || stale) {
        forceReconnect();
      }
      lastHiddenTime = 0;
    }
  });

  // 前台空闲半死看门狗：页面不挂起时 socket 仍可能静默断（NAT 超时/网络切换），
  // 每 10s 查一次——超过 SOCKET_STALE_MS 无任何入站（含服务端 8s PING）即重连。
  linkWatchdog = setInterval(() => {
    if (
      !intentionalClose &&
      ws &&
      ws.readyState === WebSocket.OPEN &&
      lastInboundAt > 0 &&
      Date.now() - lastInboundAt > SOCKET_STALE_MS
    ) {
      setStatus(false, '连接超时，重连中…');
      forceReconnect();
      return;
    }
    // 排空兜底：消息曾落进 outboundQueue（发送瞬间 socket 半死/未 OPEN），
    // 之后 socket 恢复但没走 onopen 的 flush 路径时，队列会无声滞留——
    // 消息不丢全靠重连。这里在连接健康时主动冲掉（TTL 过期判由 flush 内部做）。
    if (
      !intentionalClose &&
      ws &&
      ws.readyState === WebSocket.OPEN &&
      outboundQueue.length
    ) {
      flushOutboundQueue();
    }
  }, 10000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update();
        });
      })
      .catch(() => {});
  }

  // 初始化 marked（CDN 不可用时静默降级到 <pre>）
  configureMarkdown();

  restorePendingSend();
  connect();
})();
