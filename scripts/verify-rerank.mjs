#!/usr/bin/env node
/**
 * Rerank 真机自检 —— 一条命令给出 PASS / FAIL。
 *
 *   npm run verify:rerank                        # 自动找唯一一台已连接设备
 *   npm run verify:rerank -- --device <serial>   # 指定设备
 *
 * 原理：
 *   通过 adb forward + Chrome DevTools Protocol 连到 App 的 WebView，
 *   往聊天页注入一组「判别性」候选，直接调用页面里的精排逻辑，然后断言：
 *
 *     query = 论文里说的样本量不足是什么意思
 *     B_keyword   「样本量的估计公式为 n = Z²p(1-p)/E²…」     ← 字面命中"样本量"3 次
 *     A_semantic  「本研究纳入病例仅 32 例，统计效能偏低…」     ← 字面没有"样本量"，但语义相关
 *     C_irrelevant「zeta potential and particle size…」        ← 完全无关
 *
 *   输入顺序刻意是 [B, A, C]：如果排序是空操作，A 就会留在第 2 位。
 *   只有真的做了语义精排，A 才会升到第 1 位。
 *
 * 为什么需要它（而不是肉眼看界面）：
 *   1. rerank 只在「回答带 references」时才触发 —— 要花一次真实的 LLM 额度；
 *   2. 界面上只看得到档位，看不出排序是否真的按语义变了。
 *   本脚本两者都不需要，也顺带能抓住「档位显示成 cross-encoder 但分数恒等、
 *   排序其实没生效」这类假成功（这个坑真踩过一次）。
 *
 * ⚠️ 每次运行都用带随机后缀的候选 id，使缓存键必然不同 ⇒ 强制走一次**全新推理**，
 *    缓存命中不会伪装成 PASS（脚本另有一条断言专门检查 cacheHit）。
 *
 * ⚠️ 依赖页面内部结构（ll-chat-page / runRerank / bubbles / rerankPref）。
 *    重构了组件记得同步这里；断言失败会明确报出来，不会静默通过。
 *
 * 注：模型是内置的，本自检**不需要联网**，也不消耗任何模型额度。
 */

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PORT = Number(getArg('--port') || 9222);
const WANT_DEVICE = getArg('--device');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const fail = (msg) => {
  console.error(R('✗ ') + msg);
  process.exit(1);
};

const adb = (args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();

// ---------- 1. 找设备 ----------
let devices = [];
try {
  devices = adb(['devices'])
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial);
} catch {
  fail('执行 adb 失败：请确认已安装 platform-tools 且 adb 在 PATH 里');
}

if (WANT_DEVICE) {
  if (!devices.includes(WANT_DEVICE)) fail(`设备 ${WANT_DEVICE} 不在线（在线：${devices.join(', ') || '无'}）`);
  devices = [WANT_DEVICE];
}
if (devices.length === 0) fail('没有已连接的设备。插上 USB、开启 USB 调试后重试。');
if (devices.length > 1) fail(`检测到多台设备：${devices.join(', ')}。用 --device <serial> 指定一台。`);
const DEV = devices[0];

// ---------- 2. App 是否在跑 ----------
const pid = (() => {
  try { return adb(['-s', DEV, 'shell', 'pidof', 'com.weknora.app']); } catch { return ''; }
})();
if (!pid) fail('App 没在运行。先在手机上打开 WeKnora，并停在有会话的聊天页，再跑本脚本。');

let version = '(unknown)';
try {
  const out = adb(['-s', DEV, 'shell', 'dumpsys', 'package', 'com.weknora.app']);
  version = (out.match(/versionName=(\S+)/) || [])[1] || version;
} catch { /* 可选信息 */ }

adb(['-s', DEV, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);

// ---------- 3. 连 CDP ----------
let target;
try {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  target = list.find((t) => t.type === 'page');
} catch (e) {
  fail(`连不上 WebView 调试端口（adb forward 成功但 CDP 无响应）：${e.message}`);
}
if (!target) fail('没找到 page 类型的调试目标。');

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')));
});
await send('Runtime.enable');
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.value ?? r.result;
};

console.log('WeKnora Rerank 自检');
console.log(`  设备   : ${DEV}`);
console.log(`  App    : versionName=${version}`);
console.log('');

// ---------- 4. 等聊天页 + 等模型 ----------
let ready = false;
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!!document.querySelector('ll-chat-page')`)) { ready = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) fail('聊天页没挂载。请在手机上进入一个会话（Chat 页）后再跑。');

let ce = 'unknown';
for (let i = 0; i < 120; i++) {
  ce = await evaluate(`document.querySelector('ll-chat-page')?.ceState || 'unknown'`);
  if (ce === 'ready' || ce === 'failed') break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`  跨编码器: ${ce === 'ready' ? G('ready') + '（本地内置模型已加载）' : R(String(ce))}`);
if (ce === 'loading') console.log(DIM('  （模型仍在加载，下面大概率会退化成 BM25 —— 等几秒再跑一次）'));

// ---------- 5. 跑判别性用例（每次全新推理） ----------
const NONCE = Date.now().toString(36).slice(-6);
const res = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chat = document.querySelector('ll-chat-page');
  const prev = { ...chat.rerankPref };
  const N = ${JSON.stringify(NONCE)};
  const out = { prefBefore: { ...prev }, nonce: N };

  // 带随机后缀 ⇒ 缓存键必然不同 ⇒ 强制全新推理
  const REFS = [
    { id: 'B_keyword__' + N,    title: '样本量计算公式', score: 0.55,
      content: '样本量的估计公式为 n = Z^2 p (1-p) / E^2，可用于计算所需样本量。' },
    { id: 'A_semantic__' + N,   title: '研究局限性',     score: 0.30,
      content: '本研究纳入病例仅 32 例，统计效能偏低，结论外推至更广泛人群时需谨慎。' },
    { id: 'C_irrelevant__' + N, title: '粒径表征',       score: 0.28,
      content: 'zeta potential and particle size distributions were measured by dynamic light scattering.' },
  ];

  // 关着就先临时打开（跑完恢复），否则 runRerank 会直接 return
  if (!chat.rerankPref.enabled) chat.rerankPref = { ...chat.rerankPref, enabled: true };

  chat.bubbles = [
    { id: '__self_u', role: 'user', content: '论文里说的样本量不足是什么意思', tools: [], references: [], streaming: false },
    { id: '__self_a', role: 'assistant', content: '（自检占位）', tools: [], streaming: false,
      references: REFS.map((r) => ({ ...r })) },
  ];
  await sleep(150);

  const t0 = performance.now();
  await chat.runRerank('__self_a');
  out.tookMs = Math.round(performance.now() - t0);

  const b = chat.bubbles.find((x) => x.id === '__self_a');
  out.stats = b?.rerankStats || null;
  out.orderAfter = (b?.references || []).map((r) => String(r.id).replace('__' + N, ''));
  out.scoresAfter = (b?.references || []).map((r) => Number((r.score ?? 0).toFixed(4)));
  out.contentIntact = (b?.content || '') === '（自检占位）';

  chat.bubbles = [];
  chat.rerankPref = prev;
  try { await chat.loadSession(); } catch {}
  await sleep(1200);
  out.restoredBubbles = chat.bubbles.length;
  return out;
})()`);

if (res?.__error) fail('自检表达式在页面里执行失败：' + res.__error);

// ---------- 6. 断言 ----------
const order = res.orderAfter || [];
const scores = res.scoresAfter || [];
const stats = res.stats || {};

const checks = [
  ['精排档位是 cross-encoder', () => stats.level === 'cross-encoder', `level = ${stats.level ?? '(无 stats —— 精排没执行)'}`],
  ['候选分数互不相同（不是恒等 1.0 的空操作）', () => new Set(scores).size > 1, `scores = [${scores.join(', ')}]`],
  ['语义相关但无关键词重合的条目排到第 1', () => String(order[0] || '').startsWith('A_semantic'), `order = [${order.join(', ')}]`],
  ['完全无关的条目排到最后', () => String(order[order.length - 1] || '').startsWith('C_irrelevant'), ''],
  ['本次是全新推理，而非缓存命中', () => stats.cacheHit !== true, stats.cacheHit ? 'cacheHit = true' : `新推理 ${stats.durationMs ?? '?'}ms`],
  ['精排未覆盖消息正文', () => res.contentIntact !== false, ''],
];

console.log('  用例   : 「论文里说的样本量不足是什么意思」');
console.log('  输入   : [B_keyword(字面命中), A_semantic(仅语义相关), C_irrelevant]');
console.log(`  输出   : [${order.join(', ')}]`);
console.log(`  分数   : [${scores.join(', ')}]`);
console.log(`  档位   : ${stats.level ?? '-'} / ${stats.durationMs ?? '-'}ms（含调用共 ${res.tookMs}ms）`);
console.log('');

let pass = true;
for (const [label, ok, detail] of checks) {
  const good = ok();
  if (!good) pass = false;
  console.log(`  ${good ? G('✅') : R('❌')} ${label}${detail ? DIM('  — ' + detail) : ''}`);
}

console.log('');
if (pass) {
  console.log(G('结果: PASS') + ' —— 神经网络精排确实在工作（本地内置模型，未消耗任何额度）');
  console.log(DIM(`  真实对话已恢复（${res.restoredBubbles ?? 0} 条消息），精排开关恢复为「${res.prefBefore?.enabled ? '开' : '关'}」`));
} else {
  console.log(R('结果: FAIL'));
  if (ce !== 'ready') {
    console.log(`  跨编码器状态是 ${ce}：模型没就绪。确认 App 是 0.3.0，且 models/ 与 ort/ 都打进了包（npm run fetch-model 后重新构建）。`);
  } else if (stats.level === 'bm25-rescore') {
    console.log('  模型已加载但这次走了 BM25 —— 属于「降级运行」，不是崩溃。多为此前一次调用撞了 5s 超时；重跑一次通常就好。');
  }
}

ws.close();
process.exit(pass ? 0 : 1);
