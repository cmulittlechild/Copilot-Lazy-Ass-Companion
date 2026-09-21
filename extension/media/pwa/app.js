(() => {
  'use strict';

  // 官方 chat-avatar 图标（VS Code dark+：用户 person 剪影 / Copilot 星形徽标）
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
  /** 最近一次 MODEL_LIST；null = 尚未加载 */
  let modelsCache = null;
  /** 当前选中模型 id */
  let currentModelId = null;
  /** 最近一次 PERMISSION_LIST.levels；null = 尚未加载 */
  let permissionLevelsCache = null;
  /** 当前审批级别 id */
  let currentPermissionLevel = null;

  let ws;
  let reconnectTimer;
  let intentionalClose = false;
  let lastTunnelUrl = null;
  let reconnectAttempt = 0;
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
  /**
   * 当前是否有进行中的 Copilot 请求（对齐 VS Code 发送键 → Stop）。
   * true：按钮变「停止」；false：恢复「发送」。
   * 由 COPILOT_TYPING / STREAM_* 置位，COPILOT_DONE 清除。
   */
  let requestRunning = false;
  /** COPILOT_DONE 防抖：agent 多 turn（tool 循环）中间 turn_end 也会 DONE，短延迟避免发送键闪烁 */
  let requestDoneTimer = null;
  /** 乐观用户消息短窗：textKey → at（与 bridge 回声去重，不永久禁同文） */
  const recentPhoneUserAt = new Map();
  const USER_TEXT_DEDUP_MS = 15000;
  const REQUEST_DONE_GRACE_MS = 600;

  function pageToken() {
    try {
      return new URL(location.href).searchParams.get('token') || undefined;
    } catch {
      return undefined;
    }
  }

  /** 读取持久化的目标实例地址（隐私模式等场景可能抛异常，静默降级） */
  function readStoredInstanceUrl() {
    try {
      return localStorage.getItem('sidecar.instanceUrl') || null;
    } catch {
      return null;
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

  function setRequestRunning(on, statusLabel) {
    if (on) {
      if (requestDoneTimer) {
        clearTimeout(requestDoneTimer);
        requestDoneTimer = null;
      }
      requestRunning = true;
      paintSendButton();
      if (statusText) statusText.textContent = statusLabel || 'Copilot 正在输入…';
      return;
    }
    // off：给多 turn agent 一点宽限，下一 turn_start 到来则取消
    if (requestDoneTimer) clearTimeout(requestDoneTimer);
    requestDoneTimer = setTimeout(() => {
      requestDoneTimer = null;
      // 若宽限期内又开了流，保持 running
      let anyStreaming = false;
      for (const entry of streamingTurns.values()) {
        if (entry.element && entry.element.isConnected && entry.element.classList.contains('streaming')) {
          anyStreaming = true;
          break;
        }
      }
      if (anyStreaming) return;
      requestRunning = false;
      paintSendButton();
      if (statusText && !replaying && !replayingInstant) {
        statusText.textContent = connectedLabel();
      }
    }, REQUEST_DONE_GRACE_MS);
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

  function titleFromSessionFile(file) {
    if (!file) return '';
    // prefer cache from last SESSION_LIST render
    try {
      if (window.__sessionTitleCache && window.__sessionTitleCache[file]) {
        return window.__sessionTitleCache[file];
      }
    } catch (_) {}
    const base = String(file).split('/').pop() || '';
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

  /** marked + hljs 渲染；CDN 不可用时降级为 <pre> 包裹 */
  function renderMarkdown(src) {
    const text = String(src || '').replace(/\r\n/g, '\n');
    if (!text) return '';
    try {
      if (window.marked && typeof window.marked.parse === 'function') {
        const html = window.marked.parse(text);
        if (html) return html;
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

  function scrollFeed() {
    // 回放期间完全禁止滚动——逐条渲染若每次 scroll，手机会从第一条一路滑到尾。
    if (replaying || replayingInstant) return;
    try { feed.style.scrollBehavior = 'auto'; } catch (_) {}
    feed.scrollTop = feed.scrollHeight;
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

  /** User message — 官方 chat-row：avatar + "You" + 左对齐内容（无气泡） */
  function addUser(text, key) {
    const t = String(text || '');
    const textKey = userTextDedupeKey(t);
    // 权威 requestId key 已见过 → 丢
    if (key && key.startsWith('user:') && key !== textKey && seenKeys.has(key)) return null;
    // DOM 已有同文用户行（乐观 / bridge 回声 / JSONL）→ 吞掉，并登记 key
    {
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 12); i--) {
        const body = nodes[i].querySelector('.user-bubble');
        if (body && body.textContent === t) {
          if (key) seenKeys.add(key);
          notePhoneUserText(t);
          return null;
        }
      }
    }
    // 短窗 + seenKeys：仅当 DOM 已画过才拦截；否则允许首绘
    if (key && seenKeys.has(key) && isRecentPhoneUserText(t)) {
      // 上面 DOM 检查已放过 → 视为「登记了但没画上」的损坏态，放行重绘
    } else if (key && seenKeys.has(key)) {
      return null;
    }
    if (key) seenKeys.add(key);
    notePhoneUserText(t);
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
    feed.appendChild(el);
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
   * 同一用户回合内，连续助手片段是否应折叠「Copilot」头像/名：
   * - 上一可见消息是 agent（非 typing-row）→ 折叠
   * - 中间只隔 tool-card（工具是助手回合的一部分）→ 仍折叠
   * - 隔了 user / sys / confirm → 新开带头像的一组
   */
  function shouldContinueAssistantGroup() {
    const kids = feed.children;
    for (let i = kids.length - 1; i >= 0; i--) {
      const n = kids[i];
      if (!n || !n.classList) continue;
      if (n.classList.contains('typing-row')) continue;
      if (n.classList.contains('tool-card')) continue;
      if (n.classList.contains('agent')) return true;
      return false;
    }
    return false;
  }

  /** 开始一个助手回合（幂等）：已存在则复用 entry，否则创建 DOM 行 */
  function startAssistantTurn(streamId) {
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
    feed.appendChild(el);

    entry = {
      id,
      element: el,
      bubble,
      bodyEl: body,
      statusHost,
      markdown: '',
      thinkingItem: null,
      statusKeys: new Set(),
      continued: !!continued,
    };
    streamingTurns.set(id, entry);
    lastActiveStreamId = id;
    if (!replaying) setRequestRunning(true);
    scrollFeed();
    return entry;
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
    return startAssistantTurn(sid);
  }

  /** 整段重渲染 body（marked + hljs + 代码块装饰） */
  function renderEntryBody(entry) {
    entry.bodyEl.dataset.raw = entry.markdown;
    entry.bodyEl.innerHTML = renderMarkdown(entry.markdown);
    decorateCodeBlocks(entry.bodyEl);
    scrollFeed();
  }

  /** AGENT_STREAM_SET：整段替换 */
  function setEntryMarkdown(streamId, text) {
    const entry = startAssistantTurn(streamId);
    entry.markdown = String(text || '');
    renderEntryBody(entry);
  }

  /** AGENT_STREAM_CHUNK：增量追加 */
  function appendAssistantChunk(streamId, chunk) {
    const entry = startAssistantTurn(streamId);
    entry.markdown += String(chunk || '');
    renderEntryBody(entry);
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
      try {
        await navigator.clipboard.writeText(text);
        const label = copyBtn.querySelector('.footer-label');
        if (label) {
          label.textContent = '已复制';
          setTimeout(() => {
            label.textContent = '复制';
          }, 1200);
        }
      } catch {
        /* 剪贴板不可用 */
      }
    });
    footer.appendChild(copyBtn);
    el.appendChild(footer);
  }

  /** AGENT_STREAM_END / AGENT_MESSAGE：去掉 streaming 类（光标停止）；finalText 非空则覆盖 */
  function completeAssistantTurn(streamId, finalText) {
    const entry = streamingTurns.get(streamId || 'default');
    if (!entry || !entry.element || !entry.element.isConnected) {
      if (typeof finalText === 'string' && finalText) {
        addAgentFinal(finalText, null);
      }
      return;
    }
    if (typeof finalText === 'string' && finalText.length) {
      entry.markdown = finalText;
    }
    // 空壳回合（只有 Copilot 头 + •••，无正文/无 thinking/status）：直接移除，避免多枚空 Copilot 标
    const hasBody = !!(entry.markdown && String(entry.markdown).trim());
    const hasStatus = !!(entry.statusHost && entry.statusHost.childElementCount > 0);
    if (!hasBody && !hasStatus) {
      try { entry.element.remove(); } catch (_) {}
      streamingTurns.delete(streamId || 'default');
      return;
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
    else entry.bodyEl.innerHTML = '';
    maybeAddFooter(entry.element, entry.markdown);
    scrollFeed();
  }

  /** 独立助手消息（AGENT_MESSAGE 无 streamId 时），带去重 */
  function addAgentFinal(text, key) {
    if (!text) return null;
    if (key) {
      if (seenKeys.has(key)) return null;
      seenKeys.add(key);
    }
    // 与已有 agent 消息去重（Remote AGENT_MESSAGE dedupe）。
    // 不能只看「最后一个」，因为回放与 live 数据源可能把同一条回复
    // 交错投出（中间隔着 user/tool 消息），只看最后一个会漏掉。
    const nodes = feed.querySelectorAll('.msg.agent:not(.typing-row)');
    for (const node of nodes) {
      const body = node.querySelector('.body');
      if (body && body.dataset.raw === text) return null;
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
    bubble.appendChild(body);
    content.append(meta, bubble);
    row.append(avatar, content);
    el.appendChild(row);
    feed.appendChild(el);
    // 独立助手消息完成 → 底部操作栏（复制按钮）
    maybeAddFooter(el, text);
    scrollFeed();
    return el;
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

  /** Remote fS: independent collapsible tool card（toolId 去重，状态徽章增强） */
  function upsertTool(msg) {
    const toolId = msg.toolId || `tool:${String(msg.text || '').slice(0, 80)}`;
    let el = tools.get(toolId);
    const running = msg.isComplete === false;
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
      feed.appendChild(el);
      tools.set(toolId, el);
    }

    const title = el.querySelector('.tool-title');
    const badge = el.querySelector('.tool-badge');
    const body = el.querySelector('.tool-body');
    title.textContent = msg.text || 'tool';
    // 状态徽章：running（琥珀色脉冲）/ done（绿色对勾）/ confirmed（已确认）
    // 状态徽章：running（codicon-loading 旋转）/ done（codicon-check）/ confirmed（已确认）
    badge.innerHTML = confirmed
      ? '<span class="codicon codicon-check" aria-hidden="true"></span>已确认'
      : running
        ? '<span class="codicon codicon-loading" aria-hidden="true"></span>running'
        : '<span class="codicon codicon-check" aria-hidden="true"></span>done';
    badge.className = 'tool-badge ' + (confirmed ? 'confirmed' : running ? 'running' : 'done');

    let html = '';
    if (inputStr && inputStr !== '{}' && inputStr !== 'null') {
      html += `<div class="tool-section"><div class="tool-label">Input:</div><pre class="tool-pre">${escapeHtml(inputStr)}</pre></div>`;
    }
    if (resultStr) {
      html += `<div class="tool-section border"><div class="tool-label">Result:</div><pre class="tool-pre">${escapeHtml(resultStr)}</pre></div>`;
    }
    body.innerHTML = html;
    // keep open while running, collapse when done (user can re-open)
    const details = el.querySelector('details');
    if (running) details.open = true;
    scrollFeed();
    return el;
  }

  function showConfirm(msg) {
    // Inline feed card (Remote pS) + sticky bar for thumb reach
    const buttons = Array.isArray(msg.buttons) && msg.buttons.length ? msg.buttons : ['Continue', 'Cancel'];
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
        send({ type: 'PHONE_CONFIRM', button: b });
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
        send({ type: 'PHONE_CONFIRM', button: b });
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

  function handle(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'SYSTEM_MESSAGE': {
        if (msg.visibility === 'internal' || msg.internal === true) break;
        const t = String(msg.text || '');
        if (shouldSkipSys(t)) break;
        addSys(t);
        break;
      }
      case 'USER_MESSAGE': {
        // requestId 优先；否则文案 key。addUser 短窗去重吞掉 doSend 乐观与 bridge 回声。
        const key = msg.requestId
          ? `user:${msg.requestId}`
          : userTextDedupeKey(msg.text || '');
        addUser(msg.text || '', key);
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
        break;
      case 'AGENT_STREAM_START':
        // 不立刻 startAssistantTurn：否则 tool-only / 空 turn 会留下「Copilot •••」空壳。
        // 真正正文在 CHUNK/SET/MESSAGE 时再创建行；这里只进入 running + 顶部 typing。
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (msg.streamId) lastActiveStreamId = msg.streamId;
        if (!replaying) {
          setRequestRunning(true);
          showTyping();
        }
        break;
      case 'AGENT_STREAM_SET':
        setEntryMarkdown(msg.streamId || 'default', msg.text || '');
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (!replaying) setRequestRunning(true);
        break;
      case 'AGENT_STREAM_CHUNK':
        appendAssistantChunk(msg.streamId || 'default', msg.text || '');
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (!replaying) setRequestRunning(true);
        break;
      case 'AGENT_STREAM_END':
        completeAssistantTurn(msg.streamId || 'default');
        clearTyping();
        // 若已无 streaming 行，立即藏掉残余 •••（不等 COPILOT_DONE 防抖）
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
          }
        }
        break;
      case 'AGENT_MESSAGE': {
        if (msg.streamId) {
          completeAssistantTurn(msg.streamId, msg.text || '');
        } else {
          addAgentFinal(msg.text || '', `agent:${String(msg.text || '').slice(0, 160)}`);
        }
        clearTyping();
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
        if (!replaying) {
          showTyping();
          setRequestRunning(true, 'Copilot 正在输入…');
        }
        break;
      case 'COPILOT_DONE':
        // 全量收尾：独立 typing-row + 所有行上的 ••• + streaming 光标
        finishAllAssistantVisuals();
        if (!replaying) setRequestRunning(false);
        setStatus(true, connectedLabel());
        break;
      case 'SESSION_LIST':
        renderSessionList(msg.sessions);
        break;
      case 'SESSION_SELECTED': {
        if (msg.ok) {
          // 成功路径只做轻量准备：真正的 clear + 渲染由随后的 HISTORY_REPLAY 负责。
          replayingInstant = true;
          setStatus(true, '切换会话…');
          const f = msg.file || currentSessionMeta.file || '';
          const t = (msg.title && String(msg.title).trim()) || titleFromSessionFile(f) || currentSessionMeta.title;
          if (f || t) setSessionTitle(t, f);
        } else {
          replayingInstant = false;
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
        openTerminalPanel();
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
        try {
          try { feed.style.scrollBehavior = 'auto'; } catch (_) {}
          clearFeed();
          const list = Array.isArray(msg.messages) ? msg.messages : [];
          for (const m of list) {
            // 单条失败不阻断整段回放（marked/DOM 偶发错误）
            try {
              handle(m);
            } catch (_) {}
          }
        } finally {
          replaying = false;
          replayingInstant = false;
          // 历史里不应残留「正在输入」态
          finishAllAssistantVisuals();
          if (requestDoneTimer) {
            clearTimeout(requestDoneTimer);
            requestDoneTimer = null;
          }
          requestRunning = false;
          jumpFeedToBottom();
          // 回放完成后恢复顶部状态文案（SESSION_SELECTED 可能写成「切换会话…」）
          setStatus(true, connectedLabel());
        }
        break;
      }
      case 'TUNNEL_URL': {
        const next = msg.url || null;
        if (next && next === lastTunnelUrl) {
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
    // 每次打开都向 bridge 请求最新会话列表
    send({ type: 'PHONE_SESSION_LIST' });
  }

  function closeDrawer() {
    drawerOverlay.classList.add('hidden');
    sessionDrawer.classList.remove('open');
  }

  /** SESSION_LIST 入口：缓存原始数据后按当前搜索词渲染 */
  function renderSessionList(sessions) {
    lastSessions = Array.isArray(sessions) ? sessions : [];
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
      return b.latest - a.latest;
    });

    for (const g of list) {
      g.items.sort((a, b) => mtimeMs(b.mtime) - mtimeMs(a.mtime));
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
    const cur = modelsCache.find((m) => m && m.isCurrent);
    if (cur) {
      currentModelId = cur.id || null;
      if (btnModelLabel) btnModelLabel.textContent = truncLabel(cur.name || cur.id || '模型');
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
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectAttempt += 1;
    const delay = Math.min(8000, 800 + reconnectAttempt * 400);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    intentionalClose = false;
    setStatus(false, reconnectAttempt ? `重连中… (#${reconnectAttempt})` : 'connecting…');
    try {
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
      send({ type: 'PHONE_CONNECT', token: pageToken() });
    };
    ws.onmessage = (ev) => {
      try {
        handle(JSON.parse(String(ev.data)));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      setStatus(false, '已断开，重连中…');
      if (!intentionalClose) scheduleReconnect();
    };
    ws.onerror = () => setStatus(false, '连接错误');
  }

  function doSend() {
    // 请求进行中：发送键已变成停止
    if (requestRunning) {
      doStop();
      return;
    }
    const text = (input.value || '').trim();
    if (!text) return;
    const mode = modeEl.value || 'agent';
    // 乐观渲染：addUser 内部 notePhoneUserText + seenKeys。
    // 切勿在 addUser 之前再 note 一次——会先占 seenKeys 导致 addUser 直接 return null（0.5.7 手机看不到自己问题的根因）。
    const painted = addUser(text, userTextDedupeKey(text));
    if (!painted) {
      // 极端：短窗去重误伤时强制再画一次
      try {
        recentPhoneUserAt.delete(userTextDedupeKey(text));
        seenKeys.delete(userTextDedupeKey(text));
      } catch (_) {}
      addUser(text, userTextDedupeKey(text));
    }
    if (!send({ type: 'PHONE_MESSAGE', text, mode, file: currentSessionMeta.file || undefined })) {
      addSys('未连接，无法发送');
      return;
    }
    setRequestRunning(true, 'Copilot 正在输入…');
    showTyping();
    input.value = '';
    input.style.height = 'auto';
  }

  function doStop() {
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
    paintSendButton();
    if (statusText) statusText.textContent = connectedLabel();
    addSys('已请求停止');
  }

  sendBtn.addEventListener('click', doSend);

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // 初始化 marked（CDN 不可用时静默降级到 <pre>）
  configureMarkdown();

  connect();
})();
