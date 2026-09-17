/**
 * 端到端验收：新建一个干净的 CDP target，加载页面，收集网络与控制台事件，
 * 最后截图并 dump 页面文字。用来验证生产构建 / 线上站点是否真的能跑。
 *
 * 用法: node tools/verify-page.mjs <url> [等待毫秒] [截图名]
 */
const CDP = 'http://127.0.0.1:9333';
const url = process.argv[2];
if (!url) {
  console.error('用法: node tools/verify-page.mjs <url> [waitMs] [shotName]');
  process.exit(1);
}
const waitMs = Number(process.argv[3] || 45000);
const shotName = process.argv[4] || '';
const { writeFileSync, mkdirSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');

// 新建 target，避免复用状态异常的旧 target
const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const page = created;
if (!page.webSocketDebuggerUrl) {
  console.error('无法创建 target: ' + JSON.stringify(page).slice(0, 200));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });

const events = [];
const reqUrl = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
    return;
  }
  const p = m.params ?? {};
  if (m.method === 'Network.requestWillBeSent') reqUrl.set(p.requestId, p.request.url);
  else if (m.method === 'Network.responseReceived') {
    events.push({ kind: 'res', status: p.response.status, url: p.response.url, mime: p.response.mimeType, sw: !!p.response.fromServiceWorker });
  } else if (m.method === 'Network.loadingFailed') {
    events.push({ kind: 'fail', url: reqUrl.get(p.requestId) ?? p.requestId, reason: p.errorText });
  } else if (m.method === 'Runtime.exceptionThrown') {
    events.push({ kind: 'exc', text: (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300) });
  } else if (m.method === 'Log.entryAdded' && /error/i.test(p.entry?.level ?? '')) {
    events.push({ kind: 'logerr', text: (p.entry.text ?? '').slice(0, 300) });
  }
});

await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Log.enable');

await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, waitMs));

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC: ' + r.exceptionDetails.text : r.result.value;
};

console.log('=== 加载失败 / 异常 ===');
const bad = events.filter(e => e.kind === 'fail' || e.kind === 'exc' || e.kind === 'logerr' || (e.kind === 'res' && e.status >= 400));
if (bad.length === 0) console.log('  （无）');
for (const b of bad) {
  if (b.kind === 'res') console.log(`  ❌ HTTP ${b.status}  ${b.url}`);
  else if (b.kind === 'fail') console.log(`  ❌ 请求失败 ${b.url}\n     ${b.reason}`);
  else console.log(`  ⚠ ${b.text}`);
}

console.log('\n=== 关键资源 ===');
for (const e of events.filter(x => x.kind === 'res' && /seeds\.json|sw\.js|art\/|index-.*\.js|manifest/.test(x.url))) {
  console.log(`  ${e.status < 400 ? '✅' : '❌'} ${e.status}  ${e.mime.padEnd(26)} ${e.url.split('/').slice(-2).join('/')}${e.sw ? '  [SW]' : ''}`);
}

console.log('\n=== 页面状态 ===');
console.log(await ev(`JSON.stringify({
  boot: document.body.innerText.includes('正在唤醒'),
  seeding: document.body.innerText.includes('首次导入'),
  ready: document.body.innerText.includes('开始学习'),
  dbError: document.body.innerText.includes('打不开本地数据库'),
  avatarOk: (()=>{const i=document.querySelector('.brand-avatar');return i? i.complete && i.naturalWidth>0 : null})(),
  sw: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 'n/a',
}, null, 1)`));

if (shotName) {
  mkdirSync(OUT_DIR, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT_DIR, `${shotName}.png`);
  writeFileSync(f, Buffer.from(shot.data, 'base64'));
  console.log('\n截图: ' + f);
}

console.log('\n=== 页面文字（前 400 字）===');
console.log(String(await ev('document.body.innerText.slice(0,400)')));

await fetch(`${CDP}/json/close/${page.id}`).catch(() => undefined);
ws.close();
