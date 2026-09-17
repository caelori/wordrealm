/**
 * 生成 PWA 图标（从 public/art/avatar.png 裁出圆角方形图标）。
 *
 * 为什么用浏览器 canvas 而不是 sharp/jimp：
 *   不引入原生依赖，CI 里也不用额外步骤。图标已经提交进仓库，
 *   只有换了立绘才需要重跑，所以这点开销可以接受。
 *
 * 前置：需要一个带 --remote-debugging-port=9333 的 Edge/Chrome
 * 用法：node tools/gen-icons.mjs
 */
import { mkdirSync, readdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const ROOT = 'D:\\English words game';
const DL = join(ROOT, '_dl');
const OUT = join(ROOT, 'public', 'icons');

/** 内联的生成页：写成临时文件供无头浏览器打开 */
const GEN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>icon gen</title>
<style>body{font:13px monospace;background:#111;color:#0f0;padding:14px;margin:0;white-space:pre-wrap}</style>
</head><body><div id="log">working...</div>
<script>
const log = s => { document.getElementById('log').textContent += '\\n' + s; };
const SIZES = [
  { size: 180, name: 'apple-touch-icon.png' },
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 32,  name: 'favicon-32.png' },
];
(async () => {
  const img = new Image();
  img.src = '/art/avatar.png';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('avatar load fail')); });
  log('原图 ' + img.naturalWidth + 'x' + img.naturalHeight);

  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');

  for (const { size, name } of SIZES) {
    cv.width = size; cv.height = size;
    const r = size * 0.22;
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#eaf7fd');
    g.addColorStop(1, '#d3ecfb');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(size, 0, size, size, r);
    ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r);
    ctx.arcTo(0, 0, size, 0, r);
    ctx.closePath();
    ctx.fill();

    // 原图头部在中间偏上；裁紧一点，否则小尺寸下看不清脸
    const s = img.naturalWidth;
    const crop = s * 0.40;
    const sx = (s - crop) / 2;
    const sy = s * 0.19;
    const pad = size * 0.02;
    const d = size - pad * 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, crop, crop, pad, pad, d, d);

    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('导出 ' + name + ' (' + size + 'px)');
    await new Promise(r => setTimeout(r, 220));
  }
  log('DONE');
})().catch(e => log('ERROR: ' + e.message));
</script></body></html>`;

for (const d of [DL, OUT]) {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}
const genPath = join(ROOT, 'public', '_gen-icons.html');
const { writeFileSync } = await import('node:fs');
writeFileSync(genPath, GEN_HTML, 'utf8');

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('找不到 page target。请先启动带 --remote-debugging-port=9333 的浏览器。');
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
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
await send('Page.navigate', { url: 'http://127.0.0.1:5180/_gen-icons.html' });

const t0 = Date.now();
let done = false;
while (Date.now() - t0 < 60000) {
  await new Promise(r => setTimeout(r, 700));
  const r = await send('Runtime.evaluate', {
    expression: "document.getElementById('log').textContent.includes('DONE')",
    returnByValue: true,
  });
  if (r.result.value === true) { done = true; break; }
}

const logText = await send('Runtime.evaluate', {
  expression: "document.getElementById('log').textContent",
  returnByValue: true,
});
console.log(logText.result.value);

rmSync(genPath, { force: true });

if (!done) {
  console.error('⚠ 生成未完成');
  process.exit(1);
}

await new Promise(r => setTimeout(r, 1500));
const files = readdirSync(DL).filter(f => f.endsWith('.png'));
for (const f of files) renameSync(join(DL, f), join(OUT, f));
console.log(`\n图标已写入 public/icons/ : ${files.join(', ')}`);

ws.close();
