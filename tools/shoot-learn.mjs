/**
 * 点进单词学习并截图。
 * 用法: node tools/shoot-learn.mjs [评分档位 1|2|3]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9333';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
const rate = process.argv[2] || '3';
const width = Number(process.argv[3] || 820);
const height = Number(process.argv[4] || 1000);
mkdirSync(OUT_DIR, { recursive: true });

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise(r => ws.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC: ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, budget, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    await sleep(500);
    if ((await ev(`(() => { try { return Boolean(${expr}); } catch(e){ return false; } })()`)) === true) return true;
  }
  console.log(`  ⚠ 等待「${label}」超时`);
  return false;
};

await send('Page.navigate', { url: 'http://127.0.0.1:5180/' });
await waitFor("document.body.innerText.includes('开始学习')", 30000, '今日页');
await sleep(600);

console.log('点开始学习 -> ' + (await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(e=>(e.textContent||'').startsWith('开始学习'));
  if (!b) return 'not-found';
  b.click(); return 'clicked';
})()`)));
await waitFor("document.querySelector('.wordcard') !== null", 15000, '单词卡');
await sleep(900);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const file = join(OUT_DIR, 'learn.png');
writeFileSync(file, Buffer.from(shot.data, 'base64'));
console.log('截图（未评分）: ' + file);
console.log('--- 页面文字 ---');
console.log(await ev('document.body.innerText.replace(/\\n{2,}/g,"\\n").slice(0,900)'));

ws.close();
