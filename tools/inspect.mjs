/**
 * 用 CDP 连进无头浏览器，读取页面真实状态与控制台错误。
 * 用法: node tools/inspect.mjs [url] [waitMs]
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:5180/';
const WAIT = Number(process.argv[3] || 30000);

const listRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await listRes.json();
const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('找不到 page target。targets=' + JSON.stringify(targets.map(t => t.type)));
  process.exit(1);
}
console.log('已连接 target: ' + page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map(a => a.value ?? a.description ?? a.unserializableValue ?? `<${a.type}>`)
      .join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${d.exception?.description || d.text}`);
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// 导航到目标页
await send('Page.navigate', { url: URL_ });
console.log(`等待 ${WAIT}ms 让应用初始化…\n`);
await new Promise(r => setTimeout(r, WAIT));

// 读取页面状态
const evalExpr = async expr => {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) return `<错误: ${res.exceptionDetails.text}>`;
  return res.result.value;
};

const state = await evalExpr(`(() => {
  const q = s => document.querySelector(s);
  const bodyText = (document.body.innerText || '').trim();
  return JSON.stringify({
    title: document.title,
    rootChildren: q('#root')?.children.length ?? -1,
    textSample: bodyText.slice(0, 600),
    hasBootMsg: bodyText.includes('正在唤醒'),
    hasSeedMsg: bodyText.includes('首次导入'),
    indexedDBAvailable: typeof indexedDB !== 'undefined',
    speechAvailable: typeof speechSynthesis !== 'undefined',
  }, null, 1);
})()`);

console.log('--- 页面状态 ---');
console.log(state);

// 尝试直接读 IndexedDB 里的卡片数
const dbInfo = await evalExpr(`(async () => {
  try {
    const dbs = await indexedDB.databases();
    const names = dbs.map(d => d.name + '(v' + d.version + ')');
    const count = await new Promise((resolve) => {
      const req = indexedDB.open('wordrealm');
      req.onerror = () => resolve('open-error');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards')) { resolve('no-cards-store'); return; }
        const tx = db.transaction('cards', 'readonly');
        const c = tx.objectStore('cards').count();
        c.onsuccess = () => resolve(c.result);
        c.onerror = () => resolve('count-error');
      };
      setTimeout(() => resolve('timeout'), 8000);
    });
    return JSON.stringify({ databases: names, cardCount: count });
  } catch (e) { return 'ERR: ' + e.message; }
})()`);

console.log('\n--- IndexedDB ---');
console.log(dbInfo);

console.log('\n--- 控制台输出 (' + logs.length + ' 条) ---');
if (logs.length === 0) console.log('（无）');
else logs.slice(0, 40).forEach(l => console.log('  ' + l));

ws.close();
