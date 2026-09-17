/**
 * 验证 setup 引导链接的编解码与写入。
 * 用法: node tools/make-setup-link.mjs '<json>'
 * 例:   node tools/make-setup-link.mjs '{"key":"sk-xxx","model":"deepseek-flash"}'
 */
const arg = process.argv[2];
if (!arg) {
  console.error('用法: node tools/make-setup-link.mjs \'{"key":"...","model":"..."}\'');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(arg);
} catch (e) {
  console.error('参数不是合法 JSON: ' + e.message);
  process.exit(1);
}

// 与 src/db/setup.ts 的 buildSetupLink 完全一致的编码
const bytes = new TextEncoder().encode(JSON.stringify(payload));
let bin = '';
for (const b of bytes) bin += String.fromCharCode(b);
const b64 = Buffer.from(bin, 'binary').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 反向验证一次：确认服务端能解回原样
const back = b64.replace(/-/g, '+').replace(/_/g, '/');
const pad = back.length % 4 === 0 ? '' : '='.repeat(4 - (back.length % 4));
const decoded = new TextDecoder().decode(Buffer.from(back + pad, 'base64'));
const ok = decoded === JSON.stringify(payload);
console.log('往返校验: ' + (ok ? '通过' : '失败'));
if (!ok) {
  console.log('  原文: ' + JSON.stringify(payload));
  console.log('  解回: ' + decoded);
  process.exit(1);
}
console.log('写入字段: ' + Object.keys(payload).join(', '));
console.log('链接长度: ' + b64.length + ' 字符');
console.log('\n--- 一次性链接 ---');
console.log('http://127.0.0.1:5180/?setup=' + b64);
