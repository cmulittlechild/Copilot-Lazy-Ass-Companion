import * as vscode from 'vscode';
import * as QRCode from 'qrcode';

export interface QrPanelState {
  bridgeUrl: string | null;
  publicUrl: string | null;
  phoneConnected: boolean;
  tunnelEnabled: boolean;
  port: number | null;
  tokenHint: string | null;
  logLines: string[];
}

/**
 * Sidebar panel: local/public URL + QR generated on extension host (no CDN).
 */
export class QrPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotSidecar.qrPanel';
  private view?: vscode.WebviewView;
  public state: QrPanelState = {
    bridgeUrl: null,
    publicUrl: null,
    phoneConnected: false,
    tunnelEnabled: false,
    port: null,
    tokenHint: null,
    logLines: [],
  };
  private qrGen = 0;

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready') this.replay();
      if (msg?.type === 'copy' && typeof msg.text === 'string') {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage(vscode.l10n.t('Copied URL'));
      }
      if (msg?.type === 'open' && typeof msg.text === 'string' && msg.text) {
        await vscode.env.openExternal(vscode.Uri.parse(msg.text));
      }
      if (msg?.type === 'startTunnel') {
        await vscode.commands.executeCommand('copilotSidecar.startTunnel');
      }
      if (msg?.type === 'stopTunnel') {
        await vscode.commands.executeCommand('copilotSidecar.stopTunnel');
      }
      if (msg?.type === 'copyToken') {
        await vscode.commands.executeCommand('copilotSidecar.copyToken');
      }
    });
    this.replay();
  }

  setBridgeUrl(url: string | null) {
    this.state.bridgeUrl = url;
    this.post({ type: 'state', key: 'bridgeUrl', value: url });
    void this.postQr();
  }

  setPublicUrl(url: string | null) {
    this.state.publicUrl = url;
    this.post({ type: 'state', key: 'publicUrl', value: url });
    void this.postQr();
  }

  setPhoneConnected(v: boolean) {
    this.state.phoneConnected = v;
    this.post({ type: 'state', key: 'phoneConnected', value: v });
  }

  setTunnelEnabled(v: boolean) {
    this.state.tunnelEnabled = v;
    this.post({ type: 'state', key: 'tunnelEnabled', value: v });
  }

  setPort(port: number | null) {
    this.state.port = port;
    this.post({ type: 'state', key: 'port', value: port });
  }

  setTokenHint(hint: string | null) {
    this.state.tokenHint = hint;
    this.post({ type: 'state', key: 'tokenHint', value: hint });
  }

  addLog(line: string) {
    // 连续重复行合并为「×N」后缀：模型列表轮询等高频日志会刷屏淹掉有效行。
    const last = this.state.logLines[this.state.logLines.length - 1];
    const m = last && last.match(/^(.*) ×(\d+)$/);
    if (last === line) {
      this.state.logLines[this.state.logLines.length - 1] = `${line} ×2`;
      return;
    } else if (m && m[1] === line) {
      this.state.logLines[this.state.logLines.length - 1] = `${line} ×${parseInt(m[2], 10) + 1}`;
      return;
    }
    this.state.logLines.push(line);
    if (this.state.logLines.length > 40) this.state.logLines.shift();
    this.post({ type: 'log', line });
  }

  private async postQr() {
    const url = this.state.publicUrl || this.state.bridgeUrl;
    const gen = ++this.qrGen;
    this.post({ type: 'state', key: 'qrUrl', value: url });
    if (!url) {
      this.post({ type: 'state', key: 'qrDataUrl', value: null });
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
      if (gen !== this.qrGen) return;
      this.post({ type: 'state', key: 'qrDataUrl', value: dataUrl });
    } catch (e: any) {
      this.post({ type: 'log', line: `QR failed: ${e?.message || e}` });
      this.post({ type: 'state', key: 'qrDataUrl', value: null });
    }
  }

  private replay() {
    this.post({ type: 'state', key: 'bridgeUrl', value: this.state.bridgeUrl });
    this.post({ type: 'state', key: 'publicUrl', value: this.state.publicUrl });
    this.post({ type: 'state', key: 'phoneConnected', value: this.state.phoneConnected });
    this.post({ type: 'state', key: 'tunnelEnabled', value: this.state.tunnelEnabled });
    this.post({ type: 'state', key: 'port', value: this.state.port });
    this.post({ type: 'state', key: 'tokenHint', value: this.state.tokenHint });
    void this.postQr();
    for (const line of this.state.logLines) this.post({ type: 'log', line });
  }

  private post(msg: unknown) {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(): string {
    const L = {
      phone: vscode.l10n.t("Phone connected"),
      yes: vscode.l10n.t("Yes"),
      no: vscode.l10n.t("No"),
      port: vscode.l10n.t("Port"),
      local: vscode.l10n.t("Local"),
      pub: vscode.l10n.t("Public"),
      token: vscode.l10n.t("Token"),
      hintOff: vscode.l10n.t("Public tunnel is off. Start the tunnel to get a trycloudflare URL and token."),
      hintOn: vscode.l10n.t("Tunnel ready: scan the QR or open the public URL (with token) on your phone"),
      waitUrl: vscode.l10n.t("Waiting for URL…"),
      startTun: vscode.l10n.t("Start tunnel"),
      stopTun: vscode.l10n.t("Stop tunnel"),
      copyUrl: vscode.l10n.t("Copy URL"),
      copyTok: vscode.l10n.t("Copy Token"),
      openPwa: vscode.l10n.t("Open PWA"),
    };
    const lang = vscode.env.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: dark; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: transparent;
      margin: 0; padding: 12px;
    }
    h2 { font-size: 13px; margin: 0 0 8px; }
    .row { margin: 8px 0; font-size: 12px; word-break: break-all; }
    .muted { opacity: 0.75; }
    .ok { color: #3dd68c; }
    .bad { color: #ff6b6b; }
    #qr { width: 220px; height: 220px; margin: 10px 0; background: #fff; border-radius: 8px; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    #qr img { width: 200px; height: 200px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-right: 6px; margin-top: 6px;
    }
    #log {
      margin-top: 12px; max-height: 180px; overflow: auto;
      font-family: var(--vscode-editor-font-family); font-size: 11px;
      border-top: 1px solid var(--vscode-widget-border); padding-top: 8px;
    }
    .logline { opacity: 0.85; margin: 2px 0; }
  </style>
</head>
<body>
  <h2>Copilot Lazy Ass</h2>
  <div class="row">${L.phone}: <span id="phone" class="bad">${L.no}</span></div>
  <div class="row muted">${L.port}: <span id="port">—</span></div>
  <div class="row muted">${L.local}: <span id="local">—</span></div>
  <div class="row muted">${L.pub}: <span id="pub">—</span></div>
  <div class="row muted">${L.token}: <span id="tok">—</span></div>
  <div class="row muted" id="hint">${L.hintOff}</div>
  <div id="qr"><span class="muted">等待 URL…</span></div>
  <div>
    <button id="startTun">${L.startTun}</button>
    <button id="stopTun">${L.stopTun}</button>
  </div>
  <div>
    <button id="copy">${L.copyUrl}</button>
    <button id="copyTok">${L.copyTok}</button>
    <button id="open">${L.openPwa}</button>
  </div>
  <div id="log"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const state = { bridgeUrl: null, publicUrl: null, qrUrl: null };
    const phoneEl = document.getElementById('phone');
    const localEl = document.getElementById('local');
    const pubEl = document.getElementById('pub');
    const portEl = document.getElementById('port');
    const tokEl = document.getElementById('tok');
    const qrEl = document.getElementById('qr');
    const logEl = document.getElementById('log');

    function activeUrl() {
      return state.publicUrl || state.bridgeUrl || state.qrUrl;
    }

    function renderQrData(dataUrl, fallbackUrl) {
      qrEl.innerHTML = '';
      if (dataUrl) {
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'QR';
        qrEl.appendChild(img);
        return;
      }
      if (fallbackUrl) {
        const s = document.createElement('span');
        s.className = 'muted';
        s.style.padding = '8px';
        s.style.fontSize = '11px';
        s.style.wordBreak = 'break-all';
        s.textContent = fallbackUrl;
        qrEl.appendChild(s);
        return;
      }
      qrEl.innerHTML = '<span class="muted">${L.waitUrl}</span>';
    }

    window.addEventListener('message', (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'log') {
        const d = document.createElement('div');
        d.className = 'logline';
        d.textContent = msg.line;
        logEl.appendChild(d);
        logEl.scrollTop = logEl.scrollHeight;
        return;
      }
      if (msg.type !== 'state') return;
      if (msg.key === 'bridgeUrl') { state.bridgeUrl = msg.value; localEl.textContent = msg.value || '—'; }
      if (msg.key === 'publicUrl') {
        state.publicUrl = msg.value;
        pubEl.textContent = msg.value || '—';
        const hint = document.getElementById('hint');
        if (hint) hint.textContent = msg.value
          ? L.hintOn : L.hintOff;
      }
      if (msg.key === 'port') { portEl.textContent = msg.value != null ? String(msg.value) : '—'; }
      if (msg.key === 'tokenHint') { tokEl.textContent = msg.value || '—'; }
      if (msg.key === 'qrUrl') { state.qrUrl = msg.value; }
      if (msg.key === 'qrDataUrl') { renderQrData(msg.value, activeUrl()); }
      if (msg.key === 'phoneConnected') {
        phoneEl.textContent = msg.value ? L.yes : L.no;
        phoneEl.className = msg.value ? 'ok' : 'bad';
      }
    });

    document.getElementById('copy').onclick = () => {
      const u = activeUrl();
      if (u) vscode.postMessage({ type: 'copy', text: u });
      else vscode.postMessage({ type: 'copy', text: '' });
    };
    document.getElementById('open').onclick = () => {
      const u = activeUrl();
      if (u) vscode.postMessage({ type: 'open', text: u });
    };
    document.getElementById('startTun').onclick = () => vscode.postMessage({ type: 'startTunnel' });
    document.getElementById('stopTun').onclick = () => vscode.postMessage({ type: 'stopTunnel' });
    document.getElementById('copyTok').onclick = () => vscode.postMessage({ type: 'copyToken' });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
