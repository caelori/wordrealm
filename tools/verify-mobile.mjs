/**
 * 用 iPhone 的 UA + 全新 profile 复现移动端问题。
 * 用法: node tools/verify-page.mjs 的移动版，带 UA 与触摸模拟
 *   node tools/verify-mobile.mjs <url> [waitMs]
 */
const CDP = 'http://127.0.0.1:9333';
const url = process.argv[2];
const waitMs = Number(process.argv[3] || 60000);

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

const created = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
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
  else if (m.method === 'Network.responseReceived')
    events.push({ k: 'res', status: p.response.status, url: p.response.url, mime: p.response.mimeType, sw: !!p.response.fromServiceWorker });
  else if (m.method === 'Network.loadingFailed')
    events.push({ k: 'fail', url: reqUrl.get(p.requestId) ?? p.requestId, reason: p.errorText });
  else if (m.method === 'Runtime.exceptionThrown')
    events.push({ k: 'exc', text: String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 400) });
  else if (m.method === 'Runtime.consoleAPICalled')
    events.push({ k: 'log', text: (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300) });
  else if (m.method === 'Log.entryAdded' && /error/i.test(p.entry?.level ?? ''))
    events.push({ k: 'logerr', text: String(p.entry.text ?? '').slice(0, 300) });
});

await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Log.enable');
await send('Network.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
try {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
} catch (e) {
  console.log('（设备模拟失败：' + e.message + '）');
}

console.log(`以 iPhone UA 访问 ${url}\n`);
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, waitMs));

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC: ' + r.exceptionDetails.text : r.result.value;
};

console.log('=== 失败 / 异常 ===');
const bad = events.filter(e => ['fail', 'exc', 'logerr'].includes(e.k) || (e.k === 'res' && e.status >= 400));
if (!bad.length) console.log('  （无）');
for (const b of bad) {
  if (b.k === 'res') console.log(`  ❌ HTTP ${b.status}  ${b.url}${b.sw ? '  [SW]' : ''}`);
  else if (b.k === 'fail') console.log(`  ❌ 请求失败 ${b.url}\n     ${b.reason}`);
  else console.log(`  ⚠ ${b.text}`);
}

console.log('\n=== 关键资源 ===');
for (const e of events.filter(x => x.k === 'res' && /seeds|sw\.js|art\/|manifest|index-.*\.js/.test(x.url))) {
  console.log(`  ${e.status < 400 ? '✅' : '❌'} ${e.status}  ${(e.mime || '').padEnd(24)} ${e.url.replace('https://caelori.github.io', '')}${e.sw ? '  [SW]' : ''}`);
}

console.log('\n=== 页面状态 ===');
console.log(await ev(`JSON.stringify({
  text: document.body.innerText.slice(0, 160),
  swCount: ('serviceWorker' in navigator) ? 'checking' : 'unsupported',
})`));

const swInfo = await ev(`(async()=>{
  if(!('serviceWorker' in navigator)) return 'no sw';
  const rs = await navigator.serviceWorker.getRegistrations();
  const out = [];
  for (const r of rs) out.push({scope: r.scope, active: r.active?.state, script: r.active?.scriptURL});
  const keys = await caches.keys();
  const cacheEntries = {};
  for (const k of keys) { const c = await caches.open(k); cacheEntries[k] = (await c.keys()).map(x=>x.url.replace('https://caelori.github.io','')); }
  return JSON.stringify({regs: out, caches: cacheEntries}, null, 1);
})()`);
console.log('\n=== Service Worker / 缓存 ===');
console.log(swInfo);

await fetch(`${CDP}/json/close/${created.id}`).catch(() => undefined);
ws.close();
