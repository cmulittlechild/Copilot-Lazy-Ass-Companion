#!/usr/bin/env node
// workspaceIndex 边界情况测试：用真实数据中观察到的所有 URI 形态
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { fileURLToPath } = await import('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { WorkspaceIndex, decodeRemoteAuthority } = require(path.join(ROOT, 'dist/workspaceIndex.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` → ${detail}` : ''}`); }
}

console.log('=== A. decodeRemoteAuthority（真实数据中的全部形态）===');
// 真实数据实测存在的 authority 形态
const cases = [
  // hex 编码的 JSON（新版 Remote-SSH）
  ['7b22686f73744e616d65223a2247435f747272227d', 'GC_trr', 'hex-JSON'],
  ['7b22686f73744e616d65223a2247435f7472725f6a756d70227d', 'GC_trr_jump', 'hex-JSON'],
  ['ssh-remote+7b22686f73744e616d65223a2247435f747272227d', 'GC_trr', 'hex-JSON 带前缀'],
  // 明文别名（旧版）
  ['gc_trr', 'gc_trr', '明文别名'],
  ['workstation', 'workstation', '明文别名'],
  ['core-mgm-alt', 'core-mgm-alt', '明文别名带连字符'],
  ['141.84.244.34', '141.84.244.34', 'IP'],
  // user@host 形式（真实数据里有 3 个）
  ['xin@141.84.244.34', 'xin@141.84.244.34', 'user@host'],
  ['ssh-remote+xin@141.84.244.34', 'xin@141.84.244.34', 'user@host 带前缀'],
];
for (const [input, want, kind] of cases) {
  const got = decodeRemoteAuthority(input);
  check(`${kind}: ${input.slice(0, 30)}${input.length > 30 ? '…' : ''} → ${want}`, got === want, `got=${got}`);
}
// 异常输入不应抛错
for (const bad of ['', 'ssh-remote+', '7b22zzz', 'deadbeef', 'ssh-remote+%2B']) {
  let threw = false;
  try { decodeRemoteAuthority(bad); } catch { threw = true; }
  check(`异常输入不抛错: ${JSON.stringify(bad)}`, !threw);
}

console.log('\n=== B. scan()：构造覆盖全部形态的临时 workspaceStorage ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsidx-'));
function mkWs(hash, workspaceJson, sessionFiles = []) {
  const d = path.join(tmp, hash);
  fs.mkdirSync(d, { recursive: true });
  if (workspaceJson !== null) fs.writeFileSync(path.join(d, 'workspace.json'), JSON.stringify(workspaceJson));
  if (sessionFiles.length) {
    const cs = path.join(d, 'chatSessions');
    fs.mkdirSync(cs, { recursive: true });
    for (const f of sessionFiles) fs.writeFileSync(path.join(cs, f), '{"kind":0,"v":{}}\n');
  }
  return d;
}

mkWs('h_local', { folder: 'file:///Users/xin/Desktop/sidecar_remote' }, ['a.jsonl', 'b.jsonl']);
mkWs('h_remote_hex', { folder: 'vscode-remote://ssh-remote%2B7b22686f73744e616d65223a2247435f747272227d/data/ag/home/xin/project/fuse_seg' }, ['c.jsonl']);
mkWs('h_remote_plain', { folder: 'vscode-remote://ssh-remote%2Bworkstation/home/xin/omniprox' }, ['d.jsonl']);
mkWs('h_remote_userhost', { folder: 'vscode-remote://ssh-remote%2Bxin@141.84.244.34/data/ag/home/xin/project/mirofish' }, ['e.jsonl']);
mkWs('h_wsfile', { workspace: 'file:///Users/xin/Library/Application%20Support/Code/User/agent-sessions.code-workspace' }, ['f.jsonl']);
mkWs('h_cjk', { folder: 'file:///Users/xin/Desktop/warp%E5%8A%A9%E6%89%8B/warp%E7%BD%91%E5%85%B3%E6%9C%AC%E5%9C%B0' }, ['g.jsonl']);
mkWs('h_empty_window', null, ['h.jsonl']);              // 无 workspace.json 但有会话
mkWs('h_no_sessions', { folder: 'file:///tmp/nothing' }, []); // 有 workspace.json 无会话
mkWs('h_broken', null, []);                              // 都没有 → 应跳过

// 损坏的 workspace.json
const corruptDir = path.join(tmp, 'h_corrupt2');
fs.mkdirSync(path.join(corruptDir, 'chatSessions'), { recursive: true });
fs.writeFileSync(path.join(corruptDir, 'workspace.json'), '{ this is not json');
fs.writeFileSync(path.join(corruptDir, 'chatSessions', 'x.jsonl'), '{}\n');

const idx = new WorkspaceIndex({ roots: [tmp] });
let all;
let scanThrew = false;
try { all = idx.scan(); } catch (e) { scanThrew = true; console.log('    scan 抛错:', e.message); }
check('scan 不因损坏数据抛错', !scanThrew);
all = all || [];

const byH = (h) => all.find((w) => w.storageHash === h);
check('本地文件夹解析', byH('h_local')?.kind === 'local_folder' && byH('h_local')?.qualifiedName === 'sidecar_remote',
  JSON.stringify({ kind: byH('h_local')?.kind, qn: byH('h_local')?.qualifiedName }));
check('本地 isRemote=false 且 machineName=null', byH('h_local')?.isRemote === false && byH('h_local')?.machineName === null);
check('会话计数正确 (2)', byH('h_local')?.sessionCount === 2, String(byH('h_local')?.sessionCount));

const hex = byH('h_remote_hex');
check('远程 hex-JSON → GC_trr:fuse_seg', hex?.qualifiedName === 'GC_trr:fuse_seg', hex?.qualifiedName);
check('远程 isRemote=true', hex?.isRemote === true);
check('远程 machineName 解码', hex?.machineName === 'GC_trr', hex?.machineName);
check('远程 cwd 是远程侧路径', hex?.cwd?.includes('/project/fuse_seg') === true, hex?.cwd);

check('远程明文别名 → workstation:omniprox', byH('h_remote_plain')?.qualifiedName === 'workstation:omniprox',
  byH('h_remote_plain')?.qualifiedName);
check('远程 user@host 形式', byH('h_remote_userhost')?.machineName === 'xin@141.84.244.34',
  byH('h_remote_userhost')?.machineName);

const wsf = byH('h_wsfile');
check('workspace 文件类型', wsf?.kind === 'workspace_file', wsf?.kind);
check('workspace 文件名去掉后缀', wsf?.displayName === 'agent-sessions', wsf?.displayName);

check('URL 编码中文路径正确解码', byH('h_cjk')?.displayName === 'warp网关本地', byH('h_cjk')?.displayName);

check('无 workspace.json 有会话 → empty_window', byH('h_empty_window')?.kind === 'empty_window',
  byH('h_empty_window')?.kind);
check('有 workspace.json 无会话仍收录', !!byH('h_no_sessions') && byH('h_no_sessions').sessionCount === 0);
check('损坏 workspace.json 不影响其他项', all.length >= 8, `all=${all.length}`);

console.log('\n=== C. 不透明 ID 与边界适配器 ===');
check('workspaceId 是不透明前缀形式', all.every((w) => /^wks_/.test(w.workspaceId)),
  all.map(w=>w.workspaceId).slice(0,3).join(','));
check('workspaceId 唯一', new Set(all.map((w) => w.workspaceId)).size === all.length);
check('byId 可查回', idx.byId(byH('h_local').workspaceId)?.storageHash === 'h_local');
check('byHash 可查回', idx.byHash('h_local')?.workspaceId === byH('h_local').workspaceId);

const sf = path.join(tmp, 'h_remote_hex', 'chatSessions', 'c.jsonl');
check('resolveBySessionFile 反查正确', idx.resolveBySessionFile(sf)?.qualifiedName === 'GC_trr:fuse_seg',
  idx.resolveBySessionFile(sf)?.qualifiedName);
check('resolveBySessionFile 未知路径返回 undefined',
  idx.resolveBySessionFile('/nowhere/x.jsonl') === undefined);
check('resolveByCwd 精确匹配',
  idx.resolveByCwd('/Users/xin/Desktop/sidecar_remote')?.storageHash === 'h_local',
  idx.resolveByCwd('/Users/xin/Desktop/sidecar_remote')?.storageHash);

console.log('\n=== D. 派生名 vs 用户覆盖分离（paseo 纪律）===');
const wid = byH('h_local').workspaceId;
idx.setTitle(wid, '我的主项目');
let after = idx.byId(wid);
check('setTitle 生效', after?.title === '我的主项目', after?.title);
check('displayName 未被覆盖', after?.displayName === 'sidecar_remote', after?.displayName);
idx.scan();
check('重新 scan 后用户标题保留', idx.byId(wid)?.title === '我的主项目', idx.byId(wid)?.title);
idx.setTitle(wid, null);
check('setTitle(null) 清除覆盖', !idx.byId(wid)?.title, String(idx.byId(wid)?.title));

console.log('\n=== E. 真实环境 ===');
const realIdx = new WorkspaceIndex();
const real = realIdx.scan();
check('真实扫描有结果', real.length > 0, String(real.length));
check('真实数据无 undefined qualifiedName', real.every((w) => !!w.qualifiedName));
const remotes = real.filter((w) => w.isRemote);
check('识别出远程工作区', remotes.length > 0, String(remotes.length));
check('远程都有 machineName', remotes.every((w) => !!w.machineName));
const hexDecoded = remotes.filter((w) => /^[0-9a-f]{20,}$/.test(String(w.machineName)));
check('无残留未解码的 hex machineName', hexDecoded.length === 0,
  hexDecoded.slice(0, 2).map(w=>w.machineName).join(','));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'='.repeat(52)}`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail) console.log('失败项:\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
