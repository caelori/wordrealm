/**
 * LLM 输出清理与校验。
 *
 * 为什么需要这一层：模型几乎不会老老实实"只返回 JSON"。
 * 实测常见的花样：
 *   1. 用 ```json ... ``` 包起来
 *   2. 前后加一句"好的，这是题目："
 *   3. 对象里带尾随逗号
 *   4. 直接返回一个数组而不是 {questions: [...]}
 *   5. 全角引号 “ ” 而不是 "
 *   6. 选项个数不是 4、answer 越界、answer 指向的选项根本填不对
 *
 * 这一层的职责：尽最大努力把文本变成结构化数据，然后**严格校验**，
 * 校验不过的直接丢弃（宁少勿错——错题比没题危害大得多）。
 */

import {
  GRAMMAR_POINTS,
  isGrammarPoint,
  type Difficulty,
  type GrammarQuestion,
  type GrammarPoint,
  type RawQuestion,
} from './types';

/** 从任意文本里抠出 JSON 候选串 */
export function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;

  let t = text.trim();

  // 去掉 ```json ... ``` 围栏（含无语言标记的 ```）
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) out.push(fence[1].trim());

  out.push(t);

  // 括号配对扫描：从每个 { 或 [ 出发找匹配的闭合位置
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) {
        if (depth === 0) start = i;
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(t.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return [...new Set(out.filter(Boolean))];
}

/** 修复常见的 JSON 语法毛病 */
export function repairJson(s: string): string {
  let t = s;
  // 全角引号 -> 半角（只在疑似 JSON 结构里替换，避免破坏中文内容）
  t = t.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // 去掉对象/数组结尾的尾随逗号
  t = t.replace(/,(\s*[}\]])/g, '$1');
  // 去掉 BOM 和零宽字符
  t = t.replace(/^\uFEFF/, '').replace(/[\u200b-\u200d\uFEFF]/g, '');
  return t;
}

/** 尝试把文本解析成任意 JSON 值；失败返回 null */
export function tryParseJson(text: string): unknown {
  for (const cand of extractJsonCandidates(text)) {
    for (const attempt of [cand, repairJson(cand)]) {
      try {
        return JSON.parse(attempt);
      } catch {
        /* 继续试下一个候选 */
      }
    }
  }
  return null;
}

/**
 * 抢救被截断的 JSON 数组。
 *
 * 真实场景：模型生成 8 道题时命中 max_tokens，响应在最后一道题中途断掉，
 * JSON 不闭合 → JSON.parse 必然失败 → 前 7 道完好的题被一起丢掉。
 * 实测就踩到了，浪费了一整次 API 调用。
 *
 * 做法：按括号配对扫描出所有**顶层完整对象**，重新拼成一个合法数组。
 * 截断处那个不完整的对象自然会被跳过。
 */
export function salvageTruncatedArray(text: string): unknown[] {
  // 先剥掉 markdown 围栏和前置说明，找到第一个 '[' 或 '{'
  let t = text;
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];

  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const chunk = repairJson(t.slice(start, i + 1));
        try {
          items.push(JSON.parse(chunk));
        } catch {
          /* 这个对象本身不合法，跳过 */
        }
        start = -1;
      }
      // 深度变成负数说明遇到了孤立右括号，忽略
      if (depth < 0) depth = 0;
    }
  }

  return items;
}

/** 从解析结果里取出题目数组，兼容 {questions:[...]} / {data:[...]} / 裸数组 */
export function pickQuestionArray(parsed: unknown): RawQuestion[] {
  if (Array.isArray(parsed)) return parsed as RawQuestion[];
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['questions', 'data', 'items', 'result', 'list']) {
      if (Array.isArray(obj[key])) return obj[key] as RawQuestion[];
    }
  }
  return [];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 选项最大长度，超过基本说明是模型跑偏了 */
const MAX_OPTION_LENGTH = 60;

/** 零冠词的几种合法写法，统一成 ∅（空集符号） */
const ZERO_ARTICLE_FORMS = new Set(['', '∅', 'ø', '/', '-', '—', 'none', '(none)', '(零冠词)']);
export const ZERO_ARTICLE = '∅';

/**
 * 规整选项。
 *
 * 为什么要专门处理空字符串：出冠词题时，"零冠词"是**正确答案之一**，
 * 模型会非常自然地把它写成 ""。如果直接当空值过滤掉，
 * 这道题就只剩 3 个选项，会被校验整道丢弃——实测就踩到了这个坑。
 * 所以这里把各种"零冠词"写法统一成 ∅，而不是丢掉。
 */
function normalizeOptions(raw: unknown[]): string[] {
  return raw.map(v => {
    const s = str(v).replace(/^_{2,}$/, ZERO_ARTICLE);
    if (ZERO_ARTICLE_FORMS.has(s)) return ZERO_ARTICLE;
    return s;
  });
}

/** 校验并规整成一道合法题目；不合法返回 null */
export function validateQuestion(
  raw: RawQuestion,
  defaults?: { point?: GrammarPoint; difficulty?: Difficulty },
): { question: Omit<GrammarQuestion, 'id'> | null; reason?: string } {
  const stem = str(raw.stem);
  if (!stem) return { question: null, reason: '缺少题干' };
  if (!stem.includes('___') && !stem.includes('____')) {
    return { question: null, reason: '题干没有下划线空格' };
  }
  if (stem.length < 12) return { question: null, reason: '题干过短' };

  if (!Array.isArray(raw.options)) return { question: null, reason: '缺少选项' };
  const options = normalizeOptions(raw.options);
  if (options.length !== 4) return { question: null, reason: `选项数 ${options.length}，应为 4` };
  // 去重时把 ∅ 当作正常选项参与比较
  if (new Set(options.map(o => o.toLowerCase())).size !== 4) {
    return { question: null, reason: '存在重复选项' };
  }
  if (options.some(o => o.length > MAX_OPTION_LENGTH)) {
    return { question: null, reason: '选项过长' };
  }

  const answerRaw = raw.answer;
  const answer =
    typeof answerRaw === 'number'
      ? answerRaw
      : typeof answerRaw === 'string' && /^[0-3]$/.test(answerRaw.trim())
        ? Number(answerRaw.trim())
        : NaN;
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
    return { question: null, reason: `答案下标非法: ${String(answerRaw)}` };
  }

  const why = str(raw.why);
  if (!why) return { question: null, reason: '缺少解析' };
  if (why.length < 6) return { question: null, reason: '解析过短' };

  const trap = str(raw.trap);
  if (!trap) return { question: null, reason: '缺少错因说明' };

  // 考点：优先用模型给的，非法时退回调用方指定的默认值
  let point: GrammarPoint | undefined;
  if (isGrammarPoint(raw.point)) point = raw.point;
  else if (defaults?.point) point = defaults.point;
  if (!point) return { question: null, reason: `考点非法: ${String(raw.point)}` };

  // 难度：1/2/3，非法则用默认
  let difficulty: Difficulty | undefined;
  const dRaw = raw.difficulty;
  const d = typeof dRaw === 'number' ? dRaw : Number(dRaw);
  if (d === 1 || d === 2 || d === 3) difficulty = d;
  else if (defaults?.difficulty) difficulty = defaults.difficulty;
  else difficulty = 2;

  return {
    question: {
      point,
      difficulty,
      stem: stem.replace(/_{4,}/g, '___'),
      options,
      answer,
      why,
      trap,
      zh: str(raw.zh) || undefined,
    },
  };
}

/** 批量校验，返回通过的和被丢弃的原因 */
export function validateQuestions(
  raws: RawQuestion[],
  defaults?: { point?: GrammarPoint; difficulty?: Difficulty },
): { ok: Omit<GrammarQuestion, 'id'>[]; dropped: { index: number; reason: string }[] } {
  const ok: Omit<GrammarQuestion, 'id'>[] = [];
  const dropped: { index: number; reason: string }[] = [];
  const seenStems = new Set<string>();

  raws.forEach((raw, index) => {
    const { question, reason } = validateQuestion(raw, defaults);
    if (!question) {
      dropped.push({ index, reason: reason ?? '未知原因' });
      return;
    }
    // 同一批里题干重复的直接丢掉
    const key = question.stem.toLowerCase().replace(/\s+/g, ' ');
    if (seenStems.has(key)) {
      dropped.push({ index, reason: '题干重复' });
      return;
    }
    seenStems.add(key);
    ok.push(question);
  });

  return { ok, dropped };
}

/** 生成题目 id：带考点前缀，方便出问题时定位是哪一类题 */
export function makeQuestionId(point: GrammarPoint, seq = 0): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${point.toLowerCase()}-${Date.now().toString(36)}-${seq}-${rand}`;
}

/** 考点中文名，用于界面显示 */
export function pointLabel(p: GrammarPoint): string {
  return GRAMMAR_POINTS[p];
}

/** 全角/半角混排的题干在窄屏上容易断错，统一一下空白 */
export function normalizeStem(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
