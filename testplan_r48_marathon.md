# R48 marathon — mac side (8f1ab3f+ head: endedStreams / 排队泡 / hard-release watchdog)

Build: vsix `copilot-sidecar-companion-1.0.6.vsix` (Sep 29 21:27) == installed `local-dev.copilot-sidecar-companion-1.0.6` byte-identical (all dist + media/pwa verified); reinstall forced via `code --install-extension --force`; VS Code window reloaded → ext host pid 2677. HEAD a91a689 contains 8f1ab3f. Bridge :3010, bound `7ede0df3`, clients=2 (PWA + passive monitor). Monitor → `~/mon_m48.log`; send markers `echo "#### TAG $(date +%T)" >> ~/mon_m48.log`. PWA = Chrome left, VS Code chat right, Terminal bottom-left. Model: deepseek-v4-flash, mode Agent, permission 默认审批.

Sessions: A = `7ede0df3` (bound, R68 history), B = `a66e818f` (2.8KB, small).

All sends prefixed `M48`. In-log marker before each send/stop/close action.

## Steps

0. **Re-anchor** — PWA ☰ → select `7ede0df3`. PASS: SESSION_SELECTED ok on wire; feed = R68 history; VS Code chat snaps to same session. Then warmup send `M48W: reply with exactly: w48 ok` → AGENT_MESSAGE ≤15s. (Proves pipeline alive before stacking.)

1. **快速三连发 (triple-send queue)** — send `M48A1: reply with exactly: a48-1 ok` → immediately `M48A2: reply with exactly: a48-2 ok` → immediately `M48A3: reply with exactly: a48-3 ok`.
   PASS UI: A2/A3 bubbles semi-transparent `.queued` + sys 「已排队：当前回复结束后自动发送」; each un-queues in order.
   PASS wire: strict `U A1DONE U A2DONE U A3DONE` — never U1U2 interleave; each AGENT_MESSAGE correct sess=7ede0df3; no queue stall >45s (watchdog must release).

2. **停止+立即连发** — `M48B1: write a 300 word essay about deserts` → mid-stream click 停止 (armed: click1 arms 「再次点击「停止」中断当前回复」, click2 ≤3s sends PHONE_STOP) → IMMEDIATELY `M48B2: reply with exactly: b48 ok`.
   PASS wire: DONE immediate/closedUt for B1 ≤2s after 2nd click (or stop ack); B2 USER_MESSAGE→AGENT_MESSAGE ≤20s, not eaten, not stuck queued.
   PASS UI: B1 card stops mid-text (partial), B2 answered.

3. **长文流式中连发 (2000字+代码块+表格)** — `M48C1: 写一篇2000字以上的技术长文介绍分布式系统，必须包含至少一个代码块和一个表格` → ~10s into stream (markdown visibly rendering) → queue `M48C2: reply with exactly: c48 ok` → wait for C1 END.
   PASS UI: C1 renders long body incl. code block + table; C2 queued bubble → flushes after C1 DONE; finished C1 card does NOT re-render/flicker from late chunks (endedStreams).
   PASS wire: C1 END then ~0.8s flush → U(C2) → A2. No stream frames for C1's streamId after its END reaching client.

4. **在途轮切会话再切回** — `M48D1: write a 250 word essay about forests` → ~4s into stream → ☰ → select `a66e818f` → stay in B while wire shows A answer completing (sess=7ede0df3 AGENT_MESSAGE+DONE) → `M48D2: reply with exactly: d48 ok` sent into B → get B answer → ☰ → select back `7ede0df3`.
   PASS wire: switch-back SESSION_SELECTED 7ede0df3 + HISTORY_REPLAY file=7ede0df3 containing D1 U+A; D2 events sess=a66e818f only.
   PASS UI: back in A — D1 user bubble + complete forest answer rendered (R66 pending-turn supplement: no missing bubble/card); B feed never painted A's stream; order U before A.

5. **浏览器关闭重开冷连接回放（在途轮）** — `M48E1: write a 300 word essay about oceans` → ~3s into stream → queue `M48E2: reply with exactly: e48 ok` → Cmd+W close tab → wait ~10s → new tab 127.0.0.1:3010.
   PASS UI: feed replays E1 (completed answer or stream-SET catch-up + live tail); E2 text refilled into input or lost-per-sessionStorage (document actual); NO duplicated E1 user bubble; no phantom 无回复 card.
   PASS wire (monitor view): E1 chunks/DONE continue during browser absence (server-side unaffected); after reconnect clients→2. Then send restored E2 → normal answer.
   Then quick second cycle at idle: Cmd+W → reopen → full replay ≤5s, correct tail.

6. **工具调用连续两轮** — `M48F1: create a file named m48a.txt containing m48a-ok then reply with exactly: f48a done` → approve tool in VS Code when prompted → after DONE immediately `M48F2: create a file named m48b.txt containing m48b-ok then reply with exactly: f48b done` → approve → 
   PASS wire: TOOL_CALL (running/progress) both rounds, AGENT_MESSAGE each, correct sess/ridx.
   PASS fs: `~/sidecar-test-ws/m48a.txt` = m48a-ok; `m48b.txt` = m48b-ok.
   PASS UI: tool cards render both rounds; second round not blocked by first's pending state.

7. **空闲 3–5min 后发** — idle ~4min (PING ~8s cadence on wire; zero CLOSED while idle) → `M48G: reply with exactly: g48 ok`.
   PASS wire: USER_MESSAGE → AGENT_MESSAGE g48 ≤15s; no reconnect storm, no replay flood.

8. **Forensics** — dump `window.__dbg()` → `~/dbg_r48.json`; greps on mon_m48.log: `CLOSED` census (only intentional monitor/close events), `sess=` mis-tags = 0 for M48 turns in wrong feed, dup USER ut census, STALE/INTERIM/ack markings sane, no >45s request gaps mid-test; sessiondb turn rows for all M48 markers land in right session.

## Notes / risks
- Stop needs DOUBLE click within 3s (armed stop) — single click just arms.
- sessionStorage queue persistence survives reload but NOT tab close — E2 refill assertion documents actual behavior; flag if lost.
- Pending-approval card from R68 may render on A replays — benign, ignore unless it blocks a send.
- Permission 默认审批 → tool rounds need VS Code-side approve click (visible right pane).
- Screenshots before send clicks (IME drops); click #input before typing while a turn runs (send btn = stop holds kb focus).
