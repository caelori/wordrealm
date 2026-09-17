/**
 * ETL: ECDICT (ecdict.csv) -> 干净的词库 seeds.json
 *
 * 用法:  node tools/etl.mjs
 * 输入:  项目根目录的 _ecdict.csv
 * 输出:  src/data/seeds.json
 *
 * 设计依据（实测得出，见对话记录）:
 *  - pos 字段全表为空 -> 从 translation 的词性前缀提取
 *  - detail 字段全表为空 -> 没有例句，留给 AI 后补
 *  - phonetic 混用西里尔 ә(U+04D9) 与旧式 "i:" -> 直接弃用，改用 TTS
 *  - frq 全表仅 5.5% 覆盖 -> 但考试词覆盖 93%，够用
 *  - 必须先过滤掉 36 万条短语 / 9 万条专名
 *  - 绝不能用裸 split(',')：字段内含逗号和换行
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_CSV = join(ROOT, '_ecdict.csv');
const OUT_JSON = join(ROOT, 'src', 'data', 'seeds.json');

// 目标词表区间：考试标签词 ∩ 词频 2001–20000
// 下限用「排除 <= 2000」：词频前 2000 基本是 in/on/say 这类已会词，
// 不设这个下限的话，ielts 标签会把全部基础词都捞进来（实测前 30 名一个雅思词都没有）
const FRQ_EXCLUDE_TOP = 2000;
const FRQ_MAX = 20000;
const EXAM_TAGS = ['zk', 'gk', 'cet4', 'cet6', 'ky', 'ielts', 'toefl', 'gre'];

// ECDICT 词性缩写 -> 展示用
const POS_MAP = {
  n: 'n.', a: 'adj.', adj: 'adj.', v: 'v.', vt: 'v.', vi: 'v.',
  adv: 'adv.', prep: 'prep.', conj: 'conj.', pron: 'pron.', num: 'num.',
  int: 'int.', art: 'art.', aux: 'aux.', abbr: 'abbr.',
};

/** 真正的 CSV 解析：处理引号包裹、转义引号、字段内换行 */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 清洗中文释义：去掉领域标记、提取词性、拆成义项 */
function cleanTranslation(raw) {
  if (!raw) return { pos: '', senses: [] };
  const text = raw.replace(/\\n/g, '\n');

  let pos = '';
  const senses = [];

  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) continue;

    // 提取行首词性，如 "a. 乡下的, 田园的"
    const m = line.match(/^([a-z]{1,5})\.\s*(.*)$/);
    let linePos = '';
    if (m && POS_MAP[m[1]]) {
      linePos = POS_MAP[m[1]];
      line = m[2].trim();
      if (!pos) pos = linePos;
    }

    // 去掉领域标记 [医] [化] [计] ...（全库 3962 种，绝大多数是噪音）
    line = line.replace(/\[[^\]]{1,8}\]/g, '').trim();
    if (!line) continue;

    // 按逗号/分号拆义项，过滤空项
    for (const s of line.split(/[,;，；]/)) {
      const t = s.trim();
      if (t) senses.push(t);
    }
  }

  // 去重保序，最多留 8 个义项（卡片上放太多记不住）
  const seen = new Set();
  const uniq = [];
  for (const s of senses) {
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
    if (uniq.length >= 8) break;
  }

  return { pos, senses: uniq };
}

/** 解析 exchange -> 变形信息 + lemma(词族键) */
function parseExchange(raw) {
  const out = { lemma: '', forms: {} };
  if (!raw) return out;
  const KEY = { p: 'past', d: 'pp', i: 'ing', '3': 's', r: 'comp', t: 'sup', s: 'plural' };
  for (const item of raw.split('/')) {
    const idx = item.indexOf(':');
    if (idx <= 0) continue;
    const k = item.slice(0, idx), v = item.slice(idx + 1);
    if (k === '0') out.lemma = v;
    else if (KEY[k]) out.forms[KEY[k]] = v;
  }
  return out;
}

function main() {
  if (!existsSync(SRC_CSV)) {
    console.error(`✗ 找不到源文件: ${SRC_CSV}`);
    console.error('  请先把 ecdict.csv 放到项目根目录（用 gh-proxy 下载）');
    process.exit(1);
  }

  console.log('读取 ecdict.csv ...');
  const rows = parseCSV(readFileSync(SRC_CSV, 'utf8'));
  const H = Object.fromEntries(rows[0].map((h, i) => [h, i]));
  console.log(`  原始词条: ${rows.length - 1}`);

  const stats = { total: 0, notClean: 0, noCJK: 0, noTag: 0, outOfRange: 0, kept: 0 };
  const seeds = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 11) continue;
    stats.total++;

    const word = (r[H.word] || '').trim().toLowerCase();
    // 1. 必须纯字母单词（踢掉 36 万短语 + 9 万专名）
    if (!/^[a-z][a-z'-]*$/.test(word)) { stats.notClean++; continue; }

    const transRaw = r[H.translation] || '';
    // 2. 必须有中文释义
    if (!/[\u4e00-\u9fff]/.test(transRaw)) { stats.noCJK++; continue; }

    // 3. 必须命中考试标签
    const tags = (r[H.tag] || '').trim().split(/\s+/).filter(Boolean);
    const examTags = tags.filter(t => EXAM_TAGS.includes(t));
    if (examTags.length === 0) { stats.noTag++; continue; }

    // 4. 词频必须在目标区间
    const frq = +r[H.frq] || 0;
    if (frq <= FRQ_EXCLUDE_TOP || frq > FRQ_MAX) { stats.outOfRange++; continue; }

    const { pos, senses } = cleanTranslation(transRaw);
    if (senses.length === 0) { stats.noCJK++; continue; }

    const ex = parseExchange(r[H.exchange] || '');

    seeds.push({
      w: word,
      pos,
      cn: senses,
      frq,
      bnc: +r[H.bnc] || 0,
      col: +r[H.collins] || 0,
      ox: r[H.oxford] === '1' ? 1 : 0,
      tags: examTags,
      def: (r[H.definition] || '').replace(/\\n/g, '\n').split('\n')[0].slice(0, 200),
      ex,
    });
    stats.kept++;
  }

  // 去重（同词可能在两档都出现）+ 按词频排序
  const byWord = new Map();
  for (const s of seeds) if (!byWord.has(s.w)) byWord.set(s.w, s);
  const final = [...byWord.values()].sort((a, b) => a.frq - b.frq);

  // 词族聚类
  const famMap = new Map();
  for (const s of final) {
    const key = s.ex.lemma || s.w;
    if (!famMap.has(key)) famMap.set(key, []);
    famMap.get(key).push(s.w);
  }
  const families = {};
  for (const [k, members] of famMap) if (members.length > 1) families[k] = members;

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'ECDICT (MIT) https://github.com/skywind3000/ECDICT',
    filter: { frqExcludeTop: FRQ_EXCLUDE_TOP, frqMax: FRQ_MAX, examTags: EXAM_TAGS },
    words: final,
    families,
  };
  const json = JSON.stringify(payload);
  writeFileSync(OUT_JSON, json, 'utf8');

  console.log('\n--- 筛选统计 ---');
  console.log(`  扫描词条      ${stats.total}`);
  console.log(`  非纯字母剔除  -${stats.notClean}`);
  console.log(`  无中文释义    -${stats.noCJK}`);
  console.log(`  无考试标签    -${stats.noTag}`);
  console.log(`  词频不在区间  -${stats.outOfRange}`);
  console.log(`  保留          ${final.length}`);
  console.log('\n--- 输出 ---');
  console.log(`  文件      ${OUT_JSON}`);
  console.log(`  大小      ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  词族      ${Object.keys(families).length} 组，覆盖 ${Object.values(families).reduce((a, b) => a + b.length, 0)} 词`);

  const noPhon = final.filter(s => !s.pos).length;
  console.log(`  无词性    ${noPhon} (${(noPhon / final.length * 100).toFixed(1)}%)`);

  console.log('\n--- 前 10 词抽样 ---');
  for (const s of final.slice(0, 10)) {
    console.log(`  ${s.w.padEnd(14)} [${s.pos.padEnd(6)}] frq=${String(s.frq).padStart(5)} ${s.cn.slice(0, 4).join(' / ').slice(0, 46)}`);
  }

  console.log('\n✓ ETL 完成');
}

main();
