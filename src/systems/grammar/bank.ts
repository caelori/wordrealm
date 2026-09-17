/**
 * 题库调度：批量预生成 + 缓存。
 *
 * 为什么不"做一题调一次 API"：
 *  - 调用量差 10 倍以上
 *  - 每题都要转圈等待，做题体验会被打断
 *  - 断网/API 挂掉时整个功能不可用
 *
 * 所以策略是：一次生成一批（默认 20 道）存进 IndexedDB，
 * 做题时零延迟从本地取。只有当题库快见底时才再生成一批。
 */

import {
  addQuestions,
  db,
  getQuestionBankCount,
  getSettings,
} from '../../db/db';
import type { QuestionRecord } from '../../db/types';
import { GRAMMAR_POINT_KEYS, type Difficulty, type GrammarPoint } from './types';
import { AiError, generateQuestions, type AiConfig } from './provider';
import { makeQuestionId } from './parse';

/** 低于这个存量就补充 */
export const LOW_WATER_MARK = 8;
/** 每次补充生成多少道 */
export const REFILL_BATCH = 20;

export function configFromSettings(s: {
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  aiTimeoutMs: number;
}): AiConfig {
  return {
    apiKey: s.aiApiKey,
    baseUrl: s.aiBaseUrl || 'https://api.deepseek.com',
    model: s.aiModel || 'deepseek-chat',
    timeoutMs: s.aiTimeoutMs || 90_000,
  };
}

export function hasApiKey(s: { aiApiKey: string }): boolean {
  return Boolean(s.aiApiKey && s.aiApiKey.trim().length > 8);
}

/**
 * 从当前词表的"已学/待学"里挑一批词给出题用。
 *
 * 为什么优先用**已学过的词**：出题 prompt 里给的单词表会被模型复用到题干和干扰项里，
 * 如果塞进学习者没见过的词，就会出现"因为不认识单词而做错语法题"，
 * 那测的就不是语法了。
 */
export async function pickSourceWords(limit = 40): Promise<string[]> {
  // 已学的词优先（status != new），不足再用即将学的新词补
  const learned = await db.cards
    .filter(c => c.status !== 'new')
    .limit(limit * 3)
    .toArray();
  learned.sort((a, b) => (b.fsrs.reps ?? 0) - (a.fsrs.reps ?? 0));

  const words = learned.slice(0, limit).map(c => c.word);
  if (words.length >= limit) return words;

  const fresh = await db.cards.where('status').equals('new').limit(limit).toArray();
  fresh.sort((a, b) => a.frq - b.frq);
  for (const c of fresh) {
    if (words.length >= limit) break;
    if (!words.includes(c.word)) words.push(c.word);
  }
  return words;
}

/**
 * 决定这一批要覆盖哪些考点。
 * 优先补"正确率低"的考点——这是错题回流的第一步（完整版在 W4）。
 */
export async function pickPoints(count: number): Promise<GrammarPoint[]> {
  const answered = await db.questions.toArray();
  const stats = new Map<GrammarPoint, { n: number; correct: number }>();

  for (const q of answered) {
    if (q.seen === 0) continue;
    const cur = stats.get(q.point) ?? { n: 0, correct: 0 };
    cur.n += 1;
    if (q.correct > 0) cur.correct += 1;
    stats.set(q.point, cur);
  }

  // 没做过的考点优先（保证覆盖面），其次按正确率从低到高
  const scored = GRAMMAR_POINT_KEYS.map(p => {
    const s = stats.get(p);
    if (!s) return { p, priority: -1 }; // 完全没做过，最优先
    return { p, priority: s.correct / s.n };
  }).sort((a, b) => a.priority - b.priority);

  const picked: GrammarPoint[] = [];
  while (picked.length < count) {
    for (const s of scored) {
      if (picked.length >= count) break;
      picked.push(s.p);
    }
  }
  return picked;
}

export interface RefillResult {
  added: number;
  requested: number;
  batches: number;
  dropped: { index: number; reason: string }[];
}

/** 补充题库。失败会抛 AiError，由上层决定怎么提示。 */
export async function refillQuestionBank(
  count = REFILL_BATCH,
  onProgress?: (stage: string) => void,
): Promise<RefillResult> {
  const settings = await getSettings();
  const cfg = configFromSettings(settings);

  onProgress?.('正在挑选出题词汇…');
  const words = await pickSourceWords(40);

  onProgress?.('正在挑选考点…');
  const points = await pickPoints(4);

  // 避免重复：把最近出过的题干开头给模型看
  const recent = await db.questions.orderBy('createdAt').reverse().limit(15).toArray();
  const avoidStems = recent.map(q => q.stem.slice(0, 60));

  onProgress?.(`正在生成 ${count} 道题…`);
  const res = await generateQuestions(
    cfg,
    {
      points,
      words,
      count,
      difficulty: settings.grammarDifficulty as Difficulty,
      avoidStems,
    },
    (done, total) => onProgress?.(`已生成 ${done}/${total} 道`),
  );

  const now = Date.now();
  const records: QuestionRecord[] = res.ok.map((q, i) => ({
    ...q,
    id: makeQuestionId(q.point, i),
    createdAt: now,
    sourceWords: words.slice(0, 10),
    seen: 0,
    correct: 0,
    unused: 1,
    origin: 'ai',
  }));

  const added = await addQuestions(records);

  return { added, requested: count, batches: res.batches, dropped: res.dropped };
}

/**
 * 确保题库里至少有 min 道未做的题。
 * 返回是否真的触发了生成。
 */
export async function ensureQuestionBank(
  min = LOW_WATER_MARK,
  onProgress?: (stage: string) => void,
): Promise<{ generated: boolean; added: number; error?: AiError }> {
  const settings = await getSettings();
  if (!hasApiKey(settings)) {
    return {
      generated: false,
      added: 0,
      error: new AiError(
        'no-key',
        '还没有配置 API Key',
        '打开「设置 → AI 语法题」填入 DeepSeek API Key 后即可出题。',
      ),
    };
  }

  const { unseen } = await getQuestionBankCount();
  if (unseen >= min) return { generated: false, added: 0 };

  try {
    const r = await refillQuestionBank(REFILL_BATCH, onProgress);
    return { generated: true, added: r.added };
  } catch (e) {
    if (e instanceof AiError) return { generated: false, added: 0, error: e };
    throw e;
  }
}

/** 把 AiError 翻译成给用户看的一段话 */
export function describeAiError(e: AiError): { title: string; hint: string } {
  switch (e.kind) {
    case 'no-key':
      return { title: e.message, hint: e.detail ?? '请先配置 API Key。' };
    case 'auth':
      return {
        title: 'API Key 被拒绝',
        hint: '检查 Key 是否正确、是否已过期，以及账户余额。',
      };
    case 'rate-limit':
      return { title: '请求太频繁', hint: '等十几秒再试，或把每日题量调小。' };
    case 'timeout':
      return {
        title: '请求超时',
        hint: '模型响应慢。可以重试，或在设置里调大超时时间 / 换更快的模型。',
      };
    case 'network':
      return { title: '网络不通', hint: e.detail ?? '检查网络连接。' };
    case 'server':
      return { title: '模型服务出错', hint: e.detail ?? '稍后重试。' };
    case 'bad-json':
      return {
        title: '模型返回的内容无法解析',
        hint: '通常重试一次就好。若反复出现，换一个模型名试试。',
      };
    case 'no-valid-questions':
      return {
        title: '生成的题目都没通过校验',
        hint: `多数是格式不合规。可以重试，或把难度调低。\n${e.detail ?? ''}`,
      };
    default:
      return { title: e.message, hint: e.detail ?? '' };
  }
}
