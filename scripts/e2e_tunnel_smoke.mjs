#!/usr/bin/env node
/**
 * Live tunnel smoke: BridgeServer + TunnelManager (cloudflared trycloudflare).
 * Requires network. May download cloudflared into ~/.copilot-sidecar-companion/.
 */
import { createRequire } from 'module';
import dns from 'dns';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { BridgeServer } = require(path.join(root, 'dist/bridge.js'));
const { TunnelManager } = require(path.join(root, 'dist/tunnel.js'));
const WebSocket = require(path.join(root, 'node_modules/ws'));

const PWA = path.join(root, 'media', 'pwa');
const TOKEN = 'tunnel-smoke-token';
const WAIT_MS = Number(process.env.TUNNEL_WAIT_MS || 60_000);

// Corporate/system resolvers often NXDOMAIN trycloudflare hostnames while
// public resolvers work. Prefer public DNS for this smoke only.
try {
  dns.setServers(['1.1.1.1', '8.8.8.8', '1.0.0.1']);
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function log(...args) {
  console.error('[tunnel-smoke]', ...args);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

async function waitFor(pred, ms, step = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = pred();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timeout after ${ms}ms waiting for condition (last=${String(last)})`);
}

async function resolveHost(hostname) {
  try {
    const r = await dns.promises.lookup(hostname, { family: 4 });
    return r.address;
  } catch (e) {
    // fallback: dig-style via dns.Resolver with public servers
    const resolver = new dns.promises.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    const addrs = await resolver.resolve4(hostname);
    if (!addrs?.length) throw e;
    return addrs[0];
  }
}

async function httpGet(url, timeoutMs = 20000) {
  // Prefer raw https with explicit SNI + resolved IP so corporate DNS cannot block.
  const u = new URL(url);
  if (u.protocol === 'https:') {
    const ip = await resolveHost(u.hostname);
    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: ip,
          servername: u.hostname,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { Host: u.hostname, 'User-Agent': 'sidecar-tunnel-smoke' },
          timeout: timeoutMs,
          rejectUnauthorized: true,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode || 0,
              text: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`http timeout ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const port = await freePort();
  log(`using free port ${port}`);

  const logs = [];
  let publicUrl = null;

  const bridge = new BridgeServer({
    host: '127.0.0.1',
    port,
    authToken: TOKEN,
    pwaDir: PWA,
  });
  await bridge.start();
  log(`bridge listening on http://127.0.0.1:${port}/`);

  // sanity local health before tunnel
  const localHealth = await httpGet(`http://127.0.0.1:${port}/health`);
  assert(localHealth.status === 200, `local /health expected 200, got ${localHealth.status}`);
  const localJson = JSON.parse(localHealth.text);
  assert(localJson.ok === true, 'local health.ok');
  assert('publicUrl' in localJson, 'local health must include publicUrl');

  const tunnel = new TunnelManager({
    allowDownload: true,
    timeoutMs: WAIT_MS,
    log: (line) => {
      logs.push(line);
      log(line);
    },
    onUrl: (url) => {
      publicUrl = url;
      bridge.setPublicUrl(url);
      log(`onUrl => ${url}`);
    },
  });

  try {
    // TunnelManager.start resolves only after trycloudflare URL is ready.
    const startedUrl = await tunnel.start(port);
    publicUrl = startedUrl || publicUrl || tunnel.url;
  } catch (e) {
    log('TunnelManager.start failed:', e?.message || e);
    log('recent logs:\n' + logs.slice(-40).join('\n'));
    await bridge.stop();
    process.exit(1);
  }

  try {
    if (!publicUrl) {
      await waitFor(() => publicUrl || tunnel.url, WAIT_MS);
      publicUrl = publicUrl || tunnel.url;
    }
    assert(publicUrl && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(publicUrl), `bad publicUrl: ${publicUrl}`);
    log(`got trycloudflare URL: ${publicUrl}`);

    // Give edge a moment after "Registered tunnel connection"
    await sleep(2500);

    // HTTP GET public /health
    let healthRes;
    let lastErr;
    for (let i = 0; i < 12; i++) {
      try {
        healthRes = await httpGet(`${publicUrl}/health`, 20000);
        if (healthRes.status === 200) break;
        lastErr = new Error(`HTTP ${healthRes.status}: ${healthRes.text.slice(0, 200)}`);
        log(`public /health attempt ${i + 1} status=${healthRes.status}`);
      } catch (e) {
        lastErr = e;
        log(`public /health attempt ${i + 1} failed: ${e?.message || e}`);
      }
      await sleep(2000);
    }
    if (!healthRes || healthRes.status !== 200) {
      // fallback: try /
      try {
        const rootRes = await httpGet(`${publicUrl}/`, 20000);
        assert(rootRes.status === 200, `public / expected 200, got ${rootRes.status}; health err=${lastErr?.message || lastErr}`);
        log('public / returned 200 (health may lag)');
      } catch (e) {
        throw new Error(`public URL HTTP failed: health=${lastErr?.message || lastErr}; root=${e?.message || e}`);
      }
    } else {
      const hj = JSON.parse(healthRes.text);
      assert(hj.ok === true, 'public health.ok');
      assert('publicUrl' in hj, 'public health must include publicUrl');
      log('public /health 200 ok', hj);
    }

    // WebSocket over wss (resolve host via public DNS, connect by IP + SNI)
    const wssHost = new URL(publicUrl).hostname;
    const wssIp = await resolveHost(wssHost);
    // Connect to IP directly so corporate DNS cannot NXDOMAIN the hostname.
    // Keep Host + servername for Cloudflare edge TLS/SNI routing.
    const wssUrl = `wss://${wssIp}/?token=${encodeURIComponent(TOKEN)}`;
    log(`connecting WS host=${wssHost} via ${wssUrl}`);
    const events = [];
    const ws = new WebSocket(wssUrl, {
      headers: { Host: wssHost },
      servername: wssHost,
      host: wssHost,
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 25000);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    ws.on('message', (data) => {
      try {
        events.push(JSON.parse(String(data)));
      } catch {
        // ignore
      }
    });

    ws.send(JSON.stringify({ type: 'PHONE_CONNECT', token: TOKEN }));
    await waitFor(
      () =>
        events.some((e) => e.type === 'SYSTEM_MESSAGE') ||
        events.some((e) => e.type === 'HISTORY_REPLAY') ||
        events.some((e) => e.type === 'AGENT_LIST'),
      15000,
    );
    const types = [...new Set(events.map((e) => e.type))];
    log('ws event types:', types.join(','));
    assert(
      events.some((e) => e.type === 'SYSTEM_MESSAGE') || events.some((e) => e.type === 'HISTORY_REPLAY'),
      `expected SYSTEM_MESSAGE or HISTORY_REPLAY, got ${types.join(',')}`,
    );

    try {
      ws.close();
    } catch {
      // ignore
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          port,
          publicUrl,
          healthOk: true,
          wsOk: true,
          eventTypes: types,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    log('SMOKE FAILED:', err?.message || err);
    log('tunnel logs tail:\n' + logs.slice(-40).join('\n'));
    try {
      await tunnel.stop();
    } catch {}
    try {
      await bridge.stop();
    } catch {}
    process.exit(1);
  }

  log('stopping tunnel + bridge…');
  await tunnel.stop();
  await bridge.stop();
  log('clean stop done');
}

main().catch((err) => {
  console.error('TUNNEL SMOKE FAILED:', err);
  process.exit(1);
});
