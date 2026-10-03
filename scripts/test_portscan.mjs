#!/usr/bin/env node
// 端口冲突测试：复现 dev host 里的 EADDRINUSE，验证 portRange 扫描是否真的生效
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { BridgeServer } = require(path.join(ROOT, 'dist/bridge.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`); }
}

const BASE = 3610; // 用不常见端口避开真实实例

function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function main() {
  console.log('=== A. 端口未占用：应绑定首选端口 ===');
  let b = new BridgeServer({ host: '127.0.0.1', port: BASE, portRange: 20, pwaDir: path.join(ROOT, 'media/pwa') });
  await b.start();
  check(`绑定首选端口 ${BASE}`, b.port === BASE, `got ${b.port}`);
  await b.stop();

  console.log('\n=== B. 首选端口被占用：应扫到下一个（复现 dev host 场景）===');
  const blocker = await occupy(BASE);
  let b2 = new BridgeServer({ host: '127.0.0.1', port: BASE, portRange: 20, pwaDir: path.join(ROOT, 'media/pwa') });
  let err = null;
  try {
    await b2.start();
  } catch (e) {
    err = e;
  }
  check('端口占用时 start() 不抛错', err === null, err ? String(err.message).slice(0, 90) : '');
  check(`回退到 ${BASE + 1}（而非失败）`, b2.port === BASE + 1, `got port=${b2.port}`);
  if (!err && b2.port) {
    const r = await fetch(`http://127.0.0.1:${b2.port}/health`).then((x) => x.json()).catch(() => null);
    check('回退端口上 /health 可用', r?.ok === true, JSON.stringify(r));
  }
  try { await b2.stop(); } catch { /* ignore */ }

  console.log('\n=== C. 连续多个端口被占用：应跳过全部占用端口 ===');
  const blockers = [blocker];
  for (let i = 1; i <= 3; i++) blockers.push(await occupy(BASE + i));
  let b3 = new BridgeServer({ host: '127.0.0.1', port: BASE, portRange: 20, pwaDir: path.join(ROOT, 'media/pwa') });
  let err3 = null;
  try { await b3.start(); } catch (e) { err3 = e; }
  check('连续占用时不抛错', err3 === null, err3 ? String(err3.message).slice(0, 90) : '');
  check(`跳到 ${BASE + 4}`, b3.port === BASE + 4, `got ${b3.port}`);
  try { await b3.stop(); } catch { /* ignore */ }

  console.log('\n=== D. portRange 未传时的默认行为 ===');
  let b4 = new BridgeServer({ host: '127.0.0.1', port: BASE, pwaDir: path.join(ROOT, 'media/pwa') });
  let err4 = null;
  try { await b4.start(); } catch (e) { err4 = e; }
  check('未传 portRange 时占用端口仍能回退（默认应 >0）', err4 === null && b4.port > BASE,
    err4 ? `抛错: ${String(err4.message).slice(0, 70)}` : `port=${b4.port}`);
  try { await b4.stop(); } catch { /* ignore */ }

  for (const s of blockers) { try { s.close(); } catch { /* ignore */ } }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`结果: ${pass} 通过, ${fail} 失败`);
  if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
