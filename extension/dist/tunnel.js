"use strict";
// Cloudflare quick tunnel (trycloudflare) — hardened after 续杯/xn-repro cf-tunnel.
// No Cloudflare account / license / activation. No aggressive auto-restart.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TunnelManager = void 0;
exports.writeChannelState = writeChannelState;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const url_1 = require("url");
const MIN_BINARY_BYTES = 900_000;
const DEFAULT_TIMEOUT_MS = 35_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const TAIL_MAX = 40;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
function cacheDir() {
    return path.join(os.homedir(), '.copilot-sidecar-companion');
}
function tunnelUrlPath() {
    return path.join(cacheDir(), 'tunnel.url');
}
function channelJsonPath() {
    return path.join(cacheDir(), 'channel.json');
}
/** Persist simple channel state for external tools. */
function writeChannelState(state) {
    try {
        fs.mkdirSync(cacheDir(), { recursive: true });
        fs.writeFileSync(channelJsonPath(), JSON.stringify(state, null, 2), 'utf8');
    }
    catch {
        // ignore disk errors
    }
}
function writeTunnelUrlFile(url) {
    try {
        fs.mkdirSync(cacheDir(), { recursive: true });
        const p = tunnelUrlPath();
        if (url) {
            fs.writeFileSync(p, url, 'utf8');
        }
        else if (fs.existsSync(p)) {
            fs.writeFileSync(p, '', 'utf8');
        }
    }
    catch {
        // ignore
    }
}
function which(cmd) {
    try {
        const out = (0, child_process_1.execFileSync)(process.platform === 'win32' ? 'where' : 'which', [cmd], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const line = out
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find(Boolean);
        return line || undefined;
    }
    catch {
        return undefined;
    }
}
function binName() {
    return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}
function validBinary(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size < MIN_BINARY_BYTES)
            return false;
        if (process.platform === 'win32' && !/\.exe$/i.test(p))
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function assetPath() {
    if (process.platform === 'darwin') {
        const a = process.arch === 'arm64' ? 'arm64' : 'amd64';
        return { name: `cloudflared-darwin-${a}.tgz`, isTgz: true };
    }
    if (process.platform === 'win32') {
        const a = process.arch === 'arm64' ? 'arm64' : 'amd64';
        return { name: `cloudflared-windows-${a}.exe`, isTgz: false };
    }
    // linux
    let arch = 'amd64';
    if (process.arch === 'arm64')
        arch = 'arm64';
    else if (process.arch === 'arm')
        arch = 'arm';
    return { name: `cloudflared-linux-${arch}`, isTgz: false };
}
/** Official + common GitHub proxy mirrors (domestic / restricted nets). */
function mirrors() {
    return [
        'https://github.com/cloudflare/cloudflared/releases/latest/download/',
        'https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/',
        'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/',
        'https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/',
        'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/',
        'https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/',
    ];
}
function findFile(root, name) {
    const stack = [root];
    while (stack.length) {
        const cur = stack.pop();
        let ents;
        try {
            ents = fs.readdirSync(cur, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const ent of ents) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory())
                stack.push(full);
            else if (ent.name === name)
                return full;
        }
    }
    return undefined;
}
function downloadFile(url, dest, redirects = 5) {
    return new Promise((resolve, reject) => {
        if (redirects < 0)
            return reject(new Error('too many redirects'));
        const lib = url.startsWith('http://') ? http : https;
        const req = lib.get(url, {
            headers: { 'User-Agent': 'copilot-sidecar-companion' },
            timeout: DOWNLOAD_TIMEOUT_MS,
        }, (res) => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location) {
                res.resume();
                const next = new url_1.URL(res.headers.location, url).toString();
                downloadFile(next, dest, redirects - 1).then(resolve, reject);
                return;
            }
            if (code !== 200) {
                res.resume();
                return reject(new Error(`download HTTP ${code}: ${url}`));
            }
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
            file.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('download timeout (60s)')));
        req.on('error', reject);
    });
}
/**
 * Optional Cloudflare quick tunnel via system/local cloudflared.
 * No license/activation. Download only when explicitly enabled and binary missing.
 *
 * start() resolves only after a public trycloudflare URL is obtained.
 * Unexpected exit after ready clears URL and fires onExit — no auto-restart loop.
 */
class TunnelManager {
    proc = null;
    currentUrl = null;
    port = 0;
    disposed = false;
    starting = false;
    ready = false;
    log;
    onUrl;
    onExit;
    allowDownload;
    timeoutMs;
    edgeIpVersion;
    constructor(opts = {}) {
        this.log = opts.log || (() => { });
        this.onUrl = opts.onUrl || (() => { });
        this.onExit = opts.onExit;
        this.allowDownload = opts.allowDownload !== false;
        this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
        this.edgeIpVersion = opts.edgeIpVersion || '4';
    }
    get url() {
        return this.currentUrl;
    }
    get running() {
        return this.proc !== null && !this.proc.killed && this.ready;
    }
    /**
     * Start quick tunnel. Resolves with public URL only when ready.
     * Rejects on timeout / early exit with recent log tail.
     */
    async start(port) {
        if (this.starting) {
            throw new Error('tunnel is already starting');
        }
        if (this.proc) {
            await this.stop();
        }
        this.disposed = false;
        this.ready = false;
        this.starting = true;
        this.port = port;
        this.setUrl(null, false);
        try {
            await this.killTunnelsForPort(port);
            const bin = await this.resolveBinary();
            const url = await this.spawnAndWait(bin, port);
            return url;
        }
        finally {
            this.starting = false;
        }
    }
    async stop() {
        this.disposed = true;
        this.ready = false;
        const p = this.proc;
        this.proc = null;
        this.setUrl(null, true);
        if (p && !p.killed) {
            try {
                p.kill('SIGTERM');
            }
            catch {
                // ignore
            }
            await new Promise((r) => setTimeout(r, 200));
            try {
                if (!p.killed)
                    p.kill('SIGKILL');
            }
            catch {
                // ignore
            }
        }
    }
    setUrl(url, writeChannel) {
        this.currentUrl = url;
        try {
            this.onUrl(url);
        }
        catch {
            // ignore consumer errors
        }
        writeTunnelUrlFile(url);
        if (writeChannel) {
            writeChannelState({
                publicUrl: url,
                localPort: this.port,
                updated: new Date().toISOString(),
                running: !!url && this.ready && this.proc !== null && !this.proc.killed,
            });
        }
    }
    persistChannel(running) {
        writeChannelState({
            publicUrl: this.currentUrl,
            localPort: this.port,
            updated: new Date().toISOString(),
            running,
        });
    }
    killTunnelsForPort(port) {
        return new Promise((resolve) => {
            try {
                // Match both localhost and 127.0.0.1 forms used by various launchers.
                if (process.platform === 'win32') {
                    // Best-effort; Windows lacks portable pkill.
                    (0, child_process_1.spawn)('powershell', [
                        '-NoProfile',
                        '-Command',
                        `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'cloudflared' -and $_.CommandLine -match '${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
                    ], { stdio: 'ignore', windowsHide: true });
                }
                else {
                    // Two patterns: spawn uses 127.0.0.1; older launchers may use localhost.
                    (0, child_process_1.spawn)('pkill', ['-f', `cloudflared.*127\\.0\\.0\\.1:${port}`], { stdio: 'ignore' });
                    (0, child_process_1.spawn)('pkill', ['-f', `cloudflared.*localhost:${port}`], { stdio: 'ignore' });
                }
            }
            catch {
                // ignore
            }
            setTimeout(() => resolve(), 300);
        });
    }
    spawnAndWait(bin, port) {
        const args = [
            'tunnel',
            '--no-autoupdate',
            '--protocol',
            'http2',
            '--edge-ip-version',
            this.edgeIpVersion,
            '--url',
            `http://127.0.0.1:${port}`,
        ];
        this.log(`Starting tunnel: ${bin} ${args.join(' ')}`);
        const tail = [];
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finishReject = (err) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                this.ready = false;
                const p = this.proc;
                this.proc = null;
                if (p && !p.killed) {
                    try {
                        p.kill('SIGTERM');
                    }
                    catch {
                        // ignore
                    }
                }
                this.setUrl(null, true);
                reject(err);
            };
            const finishResolve = (url) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                this.ready = true;
                this.setUrl(url, true);
                this.log(`Tunnel ready: ${url}`);
                resolve(url);
            };
            let p;
            try {
                p = (0, child_process_1.spawn)(bin, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    shell: false,
                    env: { ...process.env, TUNNEL_TRANSPORT_PROTOCOL: 'http2' },
                });
            }
            catch (e) {
                return finishReject(e instanceof Error ? e : new Error(String(e)));
            }
            this.proc = p;
            const scan = (buf) => {
                const s = buf.toString('utf8');
                for (const line of s.split(/\r?\n/)) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    this.log(`[cf] ${t}`);
                    tail.push(t);
                    if (tail.length > TAIL_MAX)
                        tail.shift();
                }
                if (!this.currentUrl) {
                    const m = s.match(URL_RE);
                    if (m)
                        finishResolve(m[0]);
                }
            };
            p.stdout?.on('data', scan);
            p.stderr?.on('data', scan);
            p.on('error', (err) => {
                if (!settled) {
                    finishReject(err);
                }
                else {
                    this.log(`Tunnel error: ${err.message}`);
                }
            });
            p.on('exit', (code, signal) => {
                this.log(`Tunnel exited (code=${code} signal=${signal})`);
                const wasReady = this.ready && settled;
                this.proc = null;
                this.ready = false;
                if (!settled) {
                    const recent = tail.length
                        ? `。最近输出：\n${tail.slice(-12).join('\n')}`
                        : '（无输出）';
                    finishReject(new Error(`cloudflared 未拿到公网 URL 就退出 (code=${code} signal=${signal})${recent}`));
                    return;
                }
                // Ready then died: clear URL, notify, do NOT auto-restart.
                if (wasReady && !this.disposed) {
                    this.setUrl(null, true);
                    this.persistChannel(false);
                    try {
                        this.onExit?.(code, signal);
                    }
                    catch {
                        // ignore
                    }
                }
                else {
                    this.persistChannel(false);
                }
            });
            timer = setTimeout(() => {
                if (settled)
                    return;
                const recent = tail.length
                    ? `。最近输出：\n${tail.slice(-12).join('\n')}`
                    : '（无输出）';
                finishReject(new Error(`cloudflared 启动超时（${this.timeoutMs}ms 未拿到公网 URL）。请检查机器能否出站访问外网${recent}`));
            }, this.timeoutMs);
        });
    }
    async resolveBinary() {
        const fromPath = which('cloudflared');
        if (fromPath && validBinary(fromPath)) {
            this.log(`Using cloudflared from PATH: ${fromPath}`);
            return fromPath;
        }
        if (fromPath) {
            this.log(`PATH cloudflared invalid (size/type): ${fromPath}`);
        }
        const cached = path.join(cacheDir(), binName());
        if (validBinary(cached)) {
            this.log(`Using cached cloudflared: ${cached}`);
            return cached;
        }
        if (!this.allowDownload) {
            throw new Error('cloudflared not found (PATH/cache) and download disabled');
        }
        this.log('Downloading cloudflared…');
        await this.downloadCloudflared(cached);
        return cached;
    }
    async downloadCloudflared(dest) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const { name, isTgz } = assetPath();
        const mirrorList = mirrors();
        let lastErr = null;
        for (let i = 0; i < mirrorList.length; i++) {
            const src = mirrorList[i] + name;
            this.log(`Download cloudflared mirror ${i + 1}/${mirrorList.length}: ${src}`);
            try {
                if (isTgz) {
                    const tgz = dest + '.tgz';
                    const extractDir = dest + '.extract';
                    await downloadFile(src, tgz);
                    fs.rmSync(extractDir, { recursive: true, force: true });
                    fs.mkdirSync(extractDir, { recursive: true });
                    (0, child_process_1.execFileSync)('tar', ['-xzf', tgz, '-C', extractDir], { stdio: 'ignore' });
                    const found = findFile(extractDir, 'cloudflared');
                    if (!found)
                        throw new Error('cloudflared binary missing in archive');
                    fs.copyFileSync(found, dest);
                    fs.rmSync(extractDir, { recursive: true, force: true });
                    try {
                        fs.unlinkSync(tgz);
                    }
                    catch {
                        // ignore
                    }
                }
                else {
                    const tmp = dest + '.download';
                    await downloadFile(src, tmp);
                    fs.renameSync(tmp, dest);
                }
                if (process.platform !== 'win32') {
                    fs.chmodSync(dest, 0o755);
                }
                if (!validBinary(dest)) {
                    throw new Error('downloaded cloudflared failed size validation');
                }
                this.log(`cloudflared installed: ${dest}`);
                return;
            }
            catch (e) {
                lastErr = e;
                this.log(`Mirror failed: ${e?.message || e}`);
                try {
                    fs.rmSync(dest + '.tgz', { force: true });
                    fs.rmSync(dest + '.download', { force: true });
                    fs.rmSync(dest + '.extract', { recursive: true, force: true });
                }
                catch {
                    // ignore
                }
            }
        }
        throw new Error(`cloudflared download failed (all mirrors). Place binary at ${dest} and chmod +x. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
}
exports.TunnelManager = TunnelManager;
//# sourceMappingURL=tunnel.js.map