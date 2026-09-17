/**
 * 用 CDP 截图：导航 → 等应用引导完成 →（可选）点导航标签 → 等目标内容 → 截图。
 *
 * 为什么不用 msedge --screenshot：
 *   1. 那是"加载完就拍"，而本应用启动后还要往 IndexedDB 导入 9382 个词
 *   2. 绝对不要加 --virtual-time-budget，它会让 IndexedDB 的异步回调永远排不上队，
 *      应用会卡在"打不开本地数据库"
 *
 * 用法: node tools/shoot-ui.mjs <名字> <路径> [就绪表达式] [最长毫秒] [宽] [高] [要点的标签]
 * 例:   node tools/shoot-ui.mjs grammar / "document.body.innerText.includes('语法练习')" 20000 820 1200 语法
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const OUT_DIR = 'D:\\English words game\\_shots';

const name = process.argv[2] || 'shot';
const path = process.argv[3] || '/';
const readyExpr = process.argv[4] || 'true';
const maxWait = Number(process.argv[5] || 45000);
const width = Number(process.argv[6] || 820);
const height = Number(process.argv[7] || 1300);
const clickText = process.argv[8] || '';

mkdirSync(OUT_DIR, { recursive: true });

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('找不到 page target，确认 Edge 是否带 --remote-debugging-port=9333 启动');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  }
});

await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});

const evaluate = async expr => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) return { error: r.exceptionDetails.text };
  return { value: r.result.value };
};

const waitFor = async (expr, budgetMs, label) => {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    await new Promise(r => setTimeout(r, 600));
    const r = await evaluate(`(() => { try { return Boolean(${expr}); } catch(e) { return false; } })()`);
    if (r.value === true) return true;
  }
  console.log(`  ⚠ 等待「${label}」超时`);
  return false;
};

await send('Page.navigate', { url: `http://127.0.0.1:5180${path}` });
const t0 = Date.now();

// 顺序很重要：先等应用自身引导完成，再点标签，最后等目标内容。
// 反过来的话，导航标签上的同名文字会让内容条件假通过。
const appReady =
  "!document.body.innerText.includes('正在唤醒') && !document.body.innerText.includes('首次导入') && document.querySelector('.topbar')";
await waitFor(appReady, maxWait, '应用引导');
await new Promise(r => setTimeout(r, 700));

if (clickText) {
  const clickRes = await evaluate(`(() => {
    const els = [...document.querySelectorAll('.navtab, button')];
    const el = els.find(e => (e.textContent || '').trim() === ${JSON.stringify(clickText)});
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
  console.log(`点击「${clickText}」-> ${clickRes.value}`);
  await waitFor(
    `(() => { const a = document.querySelector('.navtab.active'); return a && a.textContent.trim() === ${JSON.stringify(clickText)}; })()`,
    8000,
    '标签切换',
  );
}

const ready = await waitFor(readyExpr, maxWait, '页面内容');
await new Promise(r => setTimeout(r, 900));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const file = join(OUT_DIR, `${name}.png`);
writeFileSync(file, Buffer.from(shot.data, 'base64'));

const text = await evaluate('document.body.innerText.replace(/\\n{2,}/g,"\\n").slice(0, 1400)');

console.log(ready ? `就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : '⚠ 未完全就绪，但仍已截图');
console.log(`截图: ${file}`);
console.log('--- 页面文字 ---');
console.log(text.value ?? '(读取失败)');

ws.close();
process.exit(0);
