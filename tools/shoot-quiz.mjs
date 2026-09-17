/**
 * 点进语法答题并截图（用于验收答题页/反馈页的视觉）。
 * 用法: node tools/shoot-quiz.mjs [答对|答错]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9333';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '_shots');
const mode = process.argv[2] || '答错';
const width = Number(process.argv[3] || 820);
const height = Number(process.argv[4] || 1250);
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
await waitFor("!document.body.innerText.includes('正在唤醒') && document.querySelector('.navtab')", 30000, '引导');
await sleep(600);

console.log('点语法 -> ' + (await ev(`[...document.querySelectorAll('.navtab')].find(e=>e.textContent.trim()==='语法').click(), 'ok'`)));
await waitFor("document.querySelector('.navtab.active')?.textContent.trim()==='语法'", 8000, '标签');
await waitFor("document.body.innerText.includes('开始做题')", 15000, '待开始页');

console.log('点开始做题 -> ' + (await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='开始做题');
  if (!b) return 'not-found';
  b.click(); return 'clicked';
})()`)));
await waitFor("document.querySelectorAll('.opt').length > 0", 20000, '答题页');
await sleep(500);

// 选一个答案：答错就选非正确项，答对就选正确项
const pickIdx = await ev(`(() => {
  const spans = [...document.querySelectorAll('.opt')];
  // 正确答案在下发数据里，但 DOM 上还没揭示；用 order 猜：
  // 这里直接点第 1 个或第 2 个，两种都覆盖到
  return ${mode === '答对' ? 0 : 1};
})()`);
console.log(`点第 ${pickIdx + 1} 个选项 -> ` + (await ev(`(() => {
  const opts = [...document.querySelectorAll('.opt')];
  if (!opts[${pickIdx}]) return 'not-found';
  opts[${pickIdx}].click(); return 'clicked';
})()`)));

await waitFor("document.querySelector('.feedback') !== null", 8000, '反馈');
await sleep(700);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const file = join(OUT_DIR, `quiz-${mode}.png`);
writeFileSync(file, Buffer.from(shot.data, 'base64'));
console.log('截图: ' + file);
console.log('--- 页面文字 ---');
console.log(await ev('document.body.innerText.replace(/\\n{2,}/g,"\\n").slice(0,1000)'));

ws.close();
