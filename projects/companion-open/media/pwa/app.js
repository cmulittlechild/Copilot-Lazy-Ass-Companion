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
  /**
   * 当前是否有进行中的 Copilot 请求（对齐 VS Code 发送键 → Stop）。
   * true：按钮变「停止」；false：恢复「发送」。
   * 由 COPILOT_TYPING / STREAM_* 置位，COPILOT_DONE 清除。
   */
  let requestRunning = false;
  /** 停止需双击确认：空输入点击发送键先武装 3s，再点才真正停（防误触/打字未落框杀掉在途回复） */
  let stopArmUntil = 0;
  /** COPILOT_DONE 防抖：agent 多 turn（tool 循环）中间 turn_end 也会 DONE，短延迟避免发送键闪烁 */
  let requestDoneTimer = null;
  /** 乐观用户消息短窗：textKey → at（与 bridge 回声去重，不永久禁同文） */
  const recentPhoneUserAt = new Map();
  const USER_TEXT_DEDUP_MS = 15000;
  const REQUEST_DONE_GRACE_MS = 600;
  /**
   * 死流容忍窗口：最后一次 STREAM_* / COPILOT_TYPING 活动距现在超过该值，
   * 视为僵尸流——requests/N 开流后 END 被服务器端抑制时按钮会永远卡在「停止」。
   */
  const STREAM_STALE_MS = 75 * 1000;
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
  /** 待发核验持久化 key：页面被半死 socket 刷新杀死内存计时器时，刷新后从这里回填 */
  const PENDING_SEND_KEY = 'sidecar.pendingSend';
  function persistPendingSend(text, key) {
    try { sessionStorage.setItem(PENDING_SEND_KEY, JSON.stringify({ text, key: key || '', at: Date.now() })); } catch {}
  }
  /** 已发出但未收到回答的用户消息（清屏/重放后重画用）；回声到达或回答完成即移除 */
  const sentAwaitingReply = [];
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
      if (!(input.value || '').trim()) input.value = p.text;
      addSys('发送可能未送达（连接中断），文本已回填，请重新发送');
    } catch {}
  }
  const MAX_OUTBOUND_QUEUE = 20;
  const outboundQueue = [];
  /** 离线入队消息允许的最大滞留毫秒数——超过即丢弃，防止半死 socket 恢复后数分钟前的消息幽灵补发撞车 */
  const OUTBOUND_QUEUE_TTL_MS = 90000;
  /** 请求进行中用户再次输入的消息队列：排队而非停轮（发送键=有文本就排队，空文本才停止） */
  const pendingSendQueue = [];

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
    // force：立即结束（COPILOT_DONE / 切会话 / stop），不给残影宽限
    if (force || !anyStreamingNow()) {
      requestDoneTimer = null;
      // 即使 map 里还有僵尸 streaming，视觉已 finish 过则强制停
      if (force) {
        for (const entry of streamingTurns.values()) {
          if (entry.element) entry.element.classList.remove('streaming');
          if (entry.bubble) entry.bubble.classList.remove('streaming');
        }
      }
      if (force || !anyStreamingNow()) {
        requestRunning = false;
        paintSendButton();
        if (statusText && !replaying && !replayingInstant) {
          statusText.textContent = connectedLabel();
        }
        return;
      }
    }
    // 仍有 streaming：短宽限等下一 turn
    requestDoneTimer = setTimeout(() => {
      requestDoneTimer = null;
      if (anyStreamingNow()) return;
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
  /** 判断用户是否手动向上滚动了一定距离（> 96px） */
  function isUserScrolledUp() {
    if (!feed) return false;
    const distanceToBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    return distanceToBottom > 96;
  }

  function scrollFeed(force) {
    // 回放期间完全禁止滚动——逐条渲染若每次 scroll，手机会从第一条一路滑到尾。
    if (replaying || replayingInstant) return;
    // 非强制且用户手动向上滑动翻阅历史时，不打断用户
    if (!force && isUserScrolledUp()) return;
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
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 4); i--) {
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
    if (key) seenKeys.add(key);
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
   */
  function appendFeedChronological(el, ts) {
    if (!el || !feed) return;
    // 回放期间：projectHistory 已排好顺序，直接 append
    if (replaying || replayingInstant) {
      feed.appendChild(el);
      return;
    }
    const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Number(ts);
    if (Number.isFinite(t) && t > 0) el.dataset.ts = String(t);
    const isAgent = el.classList && (el.classList.contains('agent') || el.classList.contains('tool-card'));
    if (isAgent) {
      const users = feed.querySelectorAll('.msg.user');
      let owner = null;
      if (Number.isFinite(t) && t > 0) {
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
    appendFeedChronological(el, opts && (opts.ts != null ? opts.ts : opts.timestamp));

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
    if (!replaying) setRequestRunning(true);
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
    return startAssistantTurn(sid);
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
  function setEntryMarkdown(streamId, text, ts) {
    const entry = startAssistantTurn(streamId, { ts: ts });
    entry.markdown = String(text || '');
    if (ts != null && entry.element) entry.element.dataset.ts = String(ts);
    renderEntryBody(entry);
  }

  /** AGENT_STREAM_CHUNK：增量追加（仅纯文本追加 + rAF 合批，不调 marked.parse） */
  function appendAssistantChunk(streamId, chunk, ts) {
    const entry = startAssistantTurn(streamId, { ts: ts });
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
  function completeAssistantTurn(streamId, finalText, msg) {
    const entry = streamingTurns.get(streamId || 'default');
    if (!entry || !entry.element || !entry.element.isConnected) {
      if (typeof finalText === 'string' && finalText) {
        addAgentFinal(finalText, streamId ? 'agent:' + streamId : null, {
          ts: msg && msg.timestamp,
          gapFill: !!(msg && msg.gapFill),
          streamId: streamId,
        });
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
    else {
      if (entry.rafId != null) {
        cancelAnimationFrame(entry.rafId);
        entry.rafId = null;
      }
      entry.bodyEl.innerHTML = '';
    }
    maybeAddFooter(entry.element, entry.markdown);
    streamingTurns.delete(streamId || 'default');
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
        setRequestRunning(false);
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
          if (body && body.dataset.raw === text) return null;
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
    appendFeedChronological(el, opts && (opts.ts != null ? opts.ts : opts.timestamp));
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
    if (!running) el.dataset.toolDone = '1';

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
    if (requestRunning && lastStreamActivityAt && Date.now() - lastStreamActivityAt > STREAM_STALE_MS) {
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
      let found = false;
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 4); i--) {
        const body = nodes[i].querySelector('.user-bubble');
        if (body && body.textContent === p.text) { found = true; break; }
      }
      if (!found) addUser(p.text, p.key || `user:pending:${Date.now()}:${userTextDedupeKey(p.text)}`, { force: true });
    } catch (_) {}
    repaintAwaitingUserBubbles();
  }
  /** 重放/清屏后补画「已发未答」的用户泡（待发路径只覆盖 pendingSend 一条） */
  function repaintAwaitingUserBubbles() {
    for (const m of sentAwaitingReply) {
      let found = false;
      const nodes = feed.querySelectorAll('.msg.user');
      for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 4); i--) {
        const body = nodes[i].querySelector('.user-bubble');
        if (body && body.textContent === m.text) { found = true; break; }
      }
      if (!found) addUser(m.text, m.key, { force: true });
    }
  }

  function handle(msg) {
    if (!msg || !msg.type) return;
    // 别会话的桌面消息：系统行提示而不是用户泡——否则 foreign 事件无 _sess 打标时
    // 穿过过滤冒充当前会话的发言，看起来像本会话的轮次（实测漏泡根因）。
    if (msg.type === 'USER_MESSAGE' && msg.foreign === true) {
      const sid = String(msg._sess || '');
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
    switch (msg.type) {
      case 'AUTH_FAILED':
        outboundQueue.length = 0;
        onAuthFailed(msg.reason || msg.text || '');
        break;
      case 'SYSTEM_MESSAGE': {
        if (msg.visibility === 'internal' || msg.internal === true) break;
        const t = String(msg.text || '');
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
        // 发送核验：自己的消息被服务器回声了 = 真送达，撤銷核验计时
        if (pendingSendCheck && userTextDedupeKey(msg.text || '') === pendingSendCheck.textKey) {
          clearTimeout(pendingSendCheck.timer);
          pendingSendCheck = null;
        }
        // 收到 USER 回声 = 送达确认：若与持久化的待发文本同文，清掉防误回填
        try {
          const raw = sessionStorage.getItem(PENDING_SEND_KEY);
          if (raw) {
            const p = JSON.parse(raw);
            if (p && userTextDedupeKey(msg.text || '') === userTextDedupeKey(p.text || '')) {
              sessionStorage.removeItem(PENDING_SEND_KEY);
            }
          }
        } catch {}
        // requestId 优先；否则文案 key。addUser 短窗去重吞掉 doSend 乐观与 bridge 回声。
        const key = msg.requestId
          ? `user:${msg.requestId}`
          : userTextDedupeKey(msg.text || '');
        addUser(msg.text || '', key, { ts: msg.timestamp });
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
        lastStreamActivityAt = Date.now();
        ensurePendingUserBubble();
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
        lastStreamActivityAt = Date.now();
        setEntryMarkdown(msg.streamId || 'default', msg.text || '', msg.timestamp);
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (!replaying) setRequestRunning(true);
        break;
      case 'AGENT_STREAM_CHUNK':
        lastStreamActivityAt = Date.now();
        appendAssistantChunk(msg.streamId || 'default', msg.text || '', msg.timestamp);
        if (msg.requestIndex != null) reqToStream.set(msg.requestIndex, msg.streamId || 'default');
        if (!replaying) setRequestRunning(true);
        break;
      case 'AGENT_STREAM_END':
        lastStreamActivityAt = Date.now();
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
            if (!replaying) setRequestRunning(false, undefined, { force: true });
            setStatus(true, connectedLabel());
          }
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
          // 答案落地→同题待答条目释放（多条在途只清已答的）
          if (msg._ut) {
            const aut = userTextDedupeKey(String(msg._ut));
            for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
              if (userTextDedupeKey(sentAwaitingReply[i].text) === aut) sentAwaitingReply.splice(i, 1);
            }
          }
        } catch (_) {}
        if (msg.streamId) {
          completeAssistantTurn(msg.streamId, msg.text || '', msg);
        } else {
          addAgentFinal(msg.text || '', null, {
            ts: msg.timestamp,
            gapFill: !!msg.gapFill,
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
            addSys('已确认送达（此前误报未送达，勿重复发送）');
          }
        }
        markAllToolsDone();
        // 全量收尾：独立 typing-row + 所有行上的 ••• + streaming 光标
        // force：回复已结束后绝不能继续「…」跳动或发送键停在停止
        finishAllAssistantVisuals();
        if (!replaying) setRequestRunning(false, undefined, { force: true });
        setStatus(true, connectedLabel());
        if (!replaying) Haptics.success();
        // 回复结束→按 _ut 逐条释放待答条目：服务端 DONE 现带归属轮次，
        // 只清已答的；任意 DONE 整表清会把别轮在途条目误杀 → 用户泡丢、答案裸奔。
        // 无 _ut 的 DONE（解析不到归属）不清：条目留着，重放靠它补画已发未答泡。
        if (!replaying && !replayingInstant && msg._ut) {
          const daut = userTextDedupeKey(String(msg._ut));
          for (let i = sentAwaitingReply.length - 1; i >= 0; i--) {
            if (userTextDedupeKey(sentAwaitingReply[i].text) === daut) sentAwaitingReply.splice(i, 1);
          }
        }
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
          outboundQueue.length = 0;
          clearFeed();
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
          // 换会话后排队消息的目标已变化，丢弃并提示（防注入到新会话）
          if (pendingSendQueue.length) {
            pendingSendQueue.length = 0;
            addSys('已切换会话，排队消息已丢弃');
          }
          setStatus(true, '切换会话…');
          const f = msg.file || currentSessionMeta.file || '';
          // 已有标题优先于文件名回退：后续不带 title 的广播不得盖掉真会话名
          const t = (msg.title && String(msg.title).trim()) || currentSessionMeta.title || titleFromSessionFile(f);
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
            // 已有标题（SESSION_SELECTED.title）优先——文件名回退会盖掉真实会话名
            setSessionTitle(currentSessionMeta.title || titleFromSessionFile(msg.file), msg.file);
          } catch (_) {}
        }
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
          markAllToolsDone();
          replaying = false;
          replayingInstant = false;
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
              if (p && typeof p.text === 'string' && p.text.trim()) {
                addUser(p.text, p.key || `user:pending:${Date.now()}:${userTextDedupeKey(p.text)}`, { force: true, ts: p.at || Date.now() });
              }
            }
          } catch (_) {}
          // 「已发未答」的泡也补回（发完即切/跟随重选的交错态不丢泡）
          repaintAwaitingUserBubbles();
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
        pendingSendQueue.push({ text: queuedText, mode: modeEl.value || 'agent' });
        input.value = '';
        input.style.height = 'auto';
        addSys('已排队：当前回复结束后自动发送');
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
    if (!pendingSendQueue.length || requestRunning) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const n = pendingSendQueue.shift();
    if (n) sendTextNow(n.text, n.mode);
  }

  function sendTextNow(text, mode) {
    Haptics.tap();
    // 0.5.19+：手机发送 force 上屏，避免短文案「1」被历史同文去重吞掉
    const localKey = `user:local:${Date.now()}:${userTextDedupeKey(text)}`;
    const painted = addUser(text, localKey, { force: true, ts: Date.now() });
    if (!painted) {
      try {
        recentPhoneUserAt.delete(userTextDedupeKey(text));
        seenKeys.delete(localKey);
        seenKeys.delete(userTextDedupeKey(text));
      } catch (_) {}
      addUser(text, localKey, { force: true });
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
    input.value = '';
    input.style.height = 'auto';
    // 半死 socket 防御：N 秒内服务器没回声这条消息就判丢，回填文本让用户重发。
    // 同时写 sessionStorage——半死 socket 报错可能刷新页面杀死计时器，刷新后启动时回填。
    if (pendingSendCheck) clearTimeout(pendingSendCheck.timer);
    persistPendingSend(text, localKey);
    if (sentAwaitingReply.length >= 8) sentAwaitingReply.shift();
    // sess 标发送时的会话文件：SESSION_SELECTED 切换后丢别会话残留，防跨会话误重画
    sentAwaitingReply.push({ text, key: localKey, sess: currentSessionMeta.file });
    const sentTextKey = userTextDedupeKey(text);
    pendingSendCheck = {
      textKey: sentTextKey,
      text,
      timer: setTimeout(() => {
        if (!pendingSendCheck) return;
        const lost = pendingSendCheck.text;
        pendingSendCheck = null;
        clearPendingSend();
        if (!(input.value || '').trim()) input.value = lost;
        if (requestRunning) {
          requestRunning = false;
          paintSendButton();
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
        if (isUserScrolledUp()) {
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
