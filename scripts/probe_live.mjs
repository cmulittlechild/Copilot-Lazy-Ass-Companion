#!/usr/bin/env node
// 真机测试：连接真实运行的扩展 bridge，逐项验证协议（含 0.5.0 新增）
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { fileURLToPath } = await import('url');
const WebSocket = require(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'node_modules/ws'));

const ch = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.copilot-sidecar-companion', 'channel.json'), 'utf8'));
const url = ch.token ? `ws://127.0.0.1:${ch.port}/?token=${ch.token}` : `ws://127.0.0.1:${ch.port}`;
console.log(`连接真实扩展: ${url}`);
console.log(`  运行中监控会话: ${ch.session}`);

const got = [];
const ws = new WebSocket(url);
const sent = [];
function req(type, extra) {
  const m = { type, ...extra };
  sent.push(type);
  ws.send(JSON.stringify(m));
}

ws.on('message', (d) => {
  try { got.push(JSON.parse(String(d))); } catch { /* ignore */ }
});

ws.on('open', () => {
  req('PHONE_CONNECT', { token: ch.token || undefined });
  setTimeout(() => {
    // 0.4.x 既有协议
    req('PHONE_SESSION_LIST');
    req('PHONE_INSTANCE_STATUS');
    req('PHONE_TERMINAL_LIST');
    // 0.5.0 新增协议
    req('PHONE_MODEL_LIST');
    req('PHONE_PERMISSION_LIST');
  }, 600);

  setTimeout(() => {
    const types = [...new Set(got.map((e) => e.type))];
    console.log('\n=== 收到的消息类型 ===');
    console.log(' ', types.join(', '));

    const has = (t) => got.some((e) => e.type === t);
    console.log('\n=== 协议支持检查 ===');
    const checks = [
      ['SESSION_LIST', 'PHONE_SESSION_LIST'],
      ['INSTANCE_STATUS', 'PHONE_INSTANCE_STATUS'],
      ['TERMINAL_LIST', 'PHONE_TERMINAL_LIST'],
      ['MODEL_LIST', 'PHONE_MODEL_LIST (0.5.0)'],
      ['PERMISSION_LIST', 'PHONE_PERMISSION_LIST (0.5.0)'],
    ];
    for (const [resp, label] of checks) {
      console.log(`  ${has(resp) ? '✓' : '✗'} ${label.padEnd(30)} → ${resp}`);
    }

    // 会话列表详情：是否带 0.5.0 的工作区字段
    const sl = got.find((e) => e.type === 'SESSION_LIST');
    if (sl) {
      const ss = sl.sessions || [];
      const withWs = ss.filter((s) => s.workspaceId).length;
      console.log(`\n=== SESSION_LIST：${ss.length} 条，带 workspaceId ${withWs} 条 ===`);
      for (const s of ss.slice(0, 8)) {
        console.log(`  ${String(s.qualifiedName || '(无工作区字段)').padEnd(26)} ${String(s.title || '').slice(0, 22).padEnd(24)} cur=${s.isCurrent ? 'Y' : 'n'}`);
      }
    }

    // 模型列表详情（真实 vscode.lm 结果）
    const ml = got.find((e) => e.type === 'MODEL_LIST');
    if (ml) {
      const ms = ml.models || [];
      console.log(`\n=== MODEL_LIST：${ms.length} 个真实模型 ===`);
      for (const m of ms.slice(0, 10)) {
        console.log(`  ${String(m.name).padEnd(30)} id=${String(m.id).slice(0, 28).padEnd(30)} vendor=${m.vendor} family=${m.family}`);
      }
      if (!ms.length) console.log('  ⚠ 空列表 —— vscode.lm.selectChatModels() 未返回模型');
    }

    // 审批级别详情
    const pl = got.find((e) => e.type === 'PERMISSION_LIST');
    if (pl) {
      console.log(`\n=== PERMISSION_LIST：current=${pl.current} ===`);
      for (const l of pl.levels || []) {
        console.log(`  ${l.available ? '✓' : '✗'} ${String(l.id).padEnd(13)} ${String(l.label).padEnd(18)} ${l.unavailableReason || ''}`);
      }
    }

    const instStatus = got.find((e) => e.type === 'INSTANCE_STATUS');
    if (instStatus) {
      console.log(`\n=== 实例信息 ===`);
      console.log(`  workspaceName=${instStatus.workspaceName} port=${instStatus.port} isPrimary=${instStatus.isPrimary}`);
    }

    const is050 = has('MODEL_LIST') && has('PERMISSION_LIST');
    console.log(`\n运行版本判定: ${is050 ? '0.5.0（新协议已生效）' : '0.4.x（新协议未生效，需 Reload Window）'}`);
    ws.close();
    process.exit(0);
  }, 3500);
});

ws.on('error', (e) => { console.log('连接失败:', e.message); process.exit(1); });
