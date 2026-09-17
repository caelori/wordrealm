import Dexie, { type EntityTable } from 'dexie';
import { loadSeeds } from './dataSource';
import type {
  CardRecord,
  DailyStat,
  MistakeRecord,
  QuestionRecord,
  ReviewLogRow,
  Settings,
  SeedWord,
} from './types';
import { Rating, State } from 'ts-fsrs';
import type { StoredFsrsCard } from './types';

/** 全新卡片的初始 FSRS 状态（避免依赖 systems/fsrs 造成循环导入） */
export function initStoredCard(now = Date.now()): StoredFsrsCard {
  return {
    due: now,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
  };
}

export const DEFAULT_SETTINGS: Omit<Settings, 'id'> = {
  dailyNewLimit: 10,
  dailyReviewLimit: 0,
  requestRetention: 0.9,
  accent: 'en-US',
  speechRate: 1,
  maxSenses: 3,
  seeded: false,
  // W3：AI 语法题
  aiApiKey: '',
  aiBaseUrl: 'https://api.deepseek.com',
  // ⚠️ 2026-09 实测：DeepSeek 的 /models 只返回 deepseek-flash 和 deepseek-v4-pro
  aiModel: 'deepseek-flash',
  aiTimeoutMs: 90_000,
  dailyGrammarCount: 10,
  grammarDifficulty: 2,
};

class WordrealmDB extends Dexie {
  cards!: EntityTable<CardRecord, 'id'>;
  reviews!: EntityTable<ReviewLogRow, 'id'>;
  dailyStats!: EntityTable<DailyStat, 'date'>;
  settings!: EntityTable<Settings, 'id'>;
  questions!: EntityTable<QuestionRecord, 'id'>;
  mistakes!: EntityTable<MistakeRecord, 'id'>;

  constructor() {
    super('wordrealm');
    this.version(1).stores({
      cards: 'id, status, frq, createdAt, fsrs.due',
      reviews: '++id, word, reviewedAt, rating',
      dailyStats: 'date',
      settings: 'id',
    });

    // v2：新增 AI 语法题的题库与错题本
    this.version(2)
      .stores({
        cards: 'id, status, frq, createdAt, fsrs.due',
        reviews: '++id, word, reviewedAt, rating',
        dailyStats: 'date',
        settings: 'id',
        questions: 'id, point, difficulty, createdAt, lastSeenAt, unused, origin',
        mistakes: '++id, questionId, point, createdAt, resolvedCorrect',
      })
      .upgrade(async tx => {
        // 老用户的 settings 里没有 AI 字段，补上默认值，否则读出来是 undefined
        const table = tx.table<Settings, string>('settings');
        const cur = await table.get('app');
        if (cur) {
          await table.put({
            ...cur,
            aiApiKey: cur.aiApiKey ?? DEFAULT_SETTINGS.aiApiKey,
            aiBaseUrl: cur.aiBaseUrl ?? DEFAULT_SETTINGS.aiBaseUrl,
            aiModel: cur.aiModel ?? DEFAULT_SETTINGS.aiModel,
            aiTimeoutMs: cur.aiTimeoutMs ?? DEFAULT_SETTINGS.aiTimeoutMs,
            dailyGrammarCount: cur.dailyGrammarCount ?? DEFAULT_SETTINGS.dailyGrammarCount,
            grammarDifficulty: cur.grammarDifficulty ?? DEFAULT_SETTINGS.grammarDifficulty,
          });
        }
      });
  }
}

export const db = new WordrealmDB();

/** 今日日期键 YYYY-MM-DD（本地时区，不用 UTC，否则凌晨会跳天） */
export function todayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 当天 00:00 的时间戳 */
export function startOfDay(d = new Date()): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export async function getSettings(): Promise<Settings> {
  let s = await db.settings.get('app');
  if (!s) {
    s = { id: 'app', ...DEFAULT_SETTINGS };
    await db.settings.put(s);
  }
  return s;
}

export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await db.settings.put(next);
  return next;
}

/**
 * 首次导入词库。
 * 关键：必须先查已存在的 key，避免重跑时覆盖已经积累的学习进度。
 */
export async function seedIfNeeded(
  onProgress?: (p: { done: number; total: number }) => void,
): Promise<{ inserted: number; skipped: number }> {
  const settings = await getSettings();
  const seeds = await loadSeeds();
  const total = seeds.words.length;

  const existingKeys = new Set(await db.cards.toCollection().primaryKeys());
  const toInsert: CardRecord[] = [];
  const now = Date.now();

  for (const w of seeds.words as SeedWord[]) {
    if (existingKeys.has(w.w)) continue;
    toInsert.push(makeCardRecord(w, now));
  }

  onProgress?.({ done: 0, total: toInsert.length });

  const BATCH = 500;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    await db.cards.bulkPut(toInsert.slice(i, i + BATCH));
    onProgress?.({ done: Math.min(i + BATCH, toInsert.length), total: toInsert.length });
  }

  if (!settings.seeded) await updateSettings({ seeded: true });

  return { inserted: toInsert.length, skipped: total - toInsert.length };
}

export function makeCardRecord(w: SeedWord, now = Date.now()): CardRecord {
  return {
    id: w.w,
    word: w.w,
    pos: w.pos,
    cn: w.cn,
    frq: w.frq,
    col: w.col,
    tags: w.tags,
    def: w.def,
    ex: w.ex,
    status: 'new',
    createdAt: now,
    fsrs: initStoredCard(now),
  };
}

export async function getCounts() {
  const now = Date.now();
  let total = 0;
  let learned = 0;
  let due = 0;
  let newRemaining = 0;

  // 一次遍历算完，避免三次全表扫描
  await db.cards.each(c => {
    total += 1;
    if (c.status === 'new') {
      newRemaining += 1;
    } else {
      learned += 1;
      if (c.status !== 'suspended' && c.fsrs.due <= now) due += 1;
    }
  });

  return { total, learned, due, newRemaining };
}

/**
 * 取出待学队列：
 *  - 到期复习卡（按到期时间升序）
 *  - 新词（按词频升序，即先学高频）
 */
export async function getQueue(
  newLimit: number,
  reviewLimit: number,
): Promise<{ reviews: CardRecord[]; news: CardRecord[] }> {
  const now = Date.now();

  const reviews = await db.cards
    .filter(c => c.status !== 'new' && c.status !== 'suspended' && c.fsrs.due <= now)
    .toArray();
  reviews.sort((a, b) => a.fsrs.due - b.fsrs.due);

  const news = await db.cards.where('status').equals('new').toArray();
  news.sort((a, b) => a.frq - b.frq);

  return {
    reviews: reviewLimit > 0 ? reviews.slice(0, reviewLimit) : reviews,
    news: news.slice(0, newLimit),
  };
}

/** 应用一次评分：更新卡片 + 写日志 + 更新当日统计 */
export async function applyRating(
  card: CardRecord,
  nextFsrs: CardRecord['fsrs'],
  nextStatus: CardRecord['status'],
  rating: Rating,
  durationMs: number,
) {
  const now = Date.now();
  const key = todayKey();

  await db.transaction('rw', db.cards, db.reviews, db.dailyStats, async () => {
    await db.cards.put({
      ...card,
      status: nextStatus,
      fsrs: nextFsrs,
    });

    await db.reviews.add({
      word: card.word,
      rating,
      prevState: card.fsrs.state,
      prevInterval: card.fsrs.scheduled_days,
      durationMs,
      isNew: card.status === 'new',
      reviewedAt: now,
    });

    const stat = (await db.dailyStats.get(key)) ?? {
      date: key,
      newLearned: 0,
      reviewed: 0,
      again: 0,
      hard: 0,
      good: 0,
      easy: 0,
      durationMs: 0,
    };
    if (card.status === 'new') stat.newLearned += 1;
    stat.reviewed += 1;
    stat.durationMs += durationMs;
    if (rating === Rating.Again) stat.again += 1;
    else if (rating === Rating.Hard) stat.hard += 1;
    else if (rating === Rating.Good) stat.good += 1;
    else if (rating === Rating.Easy) stat.easy += 1;
    await db.dailyStats.put(stat);
  });
}

export async function getTodayStat(): Promise<DailyStat> {
  const key = todayKey();
  return (
    (await db.dailyStats.get(key)) ?? {
      date: key,
      newLearned: 0,
      reviewed: 0,
      again: 0,
      hard: 0,
      good: 0,
      easy: 0,
      durationMs: 0,
    }
  );
}

/** 取某个日期往前推 n 个自然日的日期键。
 *  不能用 setDate(getDate()-1) 反复减：跨夏令时那一天会有 23/25 小时，
 *  在 23:30 这种时刻容易整出错位。统一从当天中午起算最稳。 */
export function shiftDayKey(base: string, deltaDays: number): string {
  const [y, m, d] = base.split('-').map(Number);
  const x = new Date(y, m - 1, d, 12, 0, 0, 0);
  x.setDate(x.getDate() + deltaDays);
  return todayKey(x);
}

/** 连续打卡天数 */
export async function getStreak(): Promise<number> {
  const rows = await db.dailyStats.orderBy('date').reverse().limit(400).toArray();
  const active = rows.filter(r => r.reviewed > 0).map(r => r.date);
  if (active.length === 0) return 0;

  const today = todayKey();
  const yesterday = shiftDayKey(today, -1);

  // 今天还没学也不立刻断签：从昨天开始算，给用户一天缓冲
  let cursor: string;
  if (active[0] === today) cursor = today;
  else if (active[0] === yesterday) cursor = yesterday;
  else return 0;

  const set = new Set(active);
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  return streak;
}

// ============================================================
// W3：AI 语法题
// ============================================================

/**
 * 取待做的语法题。
 *
 * 注意 fresh 与 retry 是**各自独立**的，不是共享一个配额：
 * 错题重做是"顺带复习"，不应该挤占新题的名额
 * （否则请求 10 道新题可能只拿到 8 道，因为 2 个名额被错题占了）。
 * 两者相加后的总量由调用方按会话上限截断，重做题排在新题前面。
 */
export async function getGrammarQueue(
  limit: number,
): Promise<{ fresh: QuestionRecord[]; retry: MistakeRecord[] }> {
  // 用 unused 索引直接查，避免全表 toArray
  const fresh = await db.questions.where('unused').equals(1).sortBy('createdAt');

  // 错题重做：还没做对的，按时间倒序（先重做最近的，记忆最新鲜）
  const retry = (await db.mistakes.toArray())
    .filter(m => m.resolvedCorrect !== true)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return { fresh: fresh.slice(0, limit), retry };
}

/** 题库剩余量 */
export async function getQuestionBankCount(): Promise<{ total: number; unseen: number }> {
  const total = await db.questions.count();
  const unseen = await db.questions.where('unused').equals(1).count();
  return { total, unseen };
}

/** 批量入库题目 */
export async function addQuestions(records: QuestionRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  // 题干去重：同一句话不要出现两次
  const existing = new Set(
    (await db.questions.toArray()).map(q => q.stem.toLowerCase().replace(/\s+/g, ' ')),
  );
  const toAdd = records.filter(
    r => !existing.has(r.stem.toLowerCase().replace(/\s+/g, ' ')),
  );
  await db.questions.bulkPut(toAdd);
  return toAdd.length;
}

export interface AnswerResult {
  correct: boolean;
  /** 这道题累计被做对了几次，用于界面提示 */
  timesCorrect: number;
}

/**
 * 记录一次作答。
 * 做错 -> 写入错题本；做对 -> 如果之前在错题本里且尚未解决，标记为已解决。
 */
export async function recordAnswer(
  q: QuestionRecord,
  chosen: number,
): Promise<AnswerResult> {
  const now = Date.now();
  const correct = chosen === q.answer;
  const timesCorrect = q.correct + (correct ? 1 : 0);

  await db.transaction('rw', db.questions, db.mistakes, db.dailyStats, async () => {
    await db.questions.put({
      ...q,
      seen: q.seen + 1,
      correct: timesCorrect,
      unused: 0,
      lastSeenAt: now,
    });

    if (correct) {
      // 做对了：把这道题所有未解决的错题记录标记为已解决
      const open = await db.mistakes.where('questionId').equals(q.id).toArray();
      for (const m of open) {
        if (m.resolvedCorrect !== true) {
          await db.mistakes.put({
            ...m,
            resolvedCorrect: true,
            retries: m.retries + 1,
            lastRetryAt: now,
          });
        }
      }
    } else {
      await db.mistakes.add({
        questionId: q.id,
        point: q.point,
        difficulty: q.difficulty,
        stem: q.stem,
        options: q.options,
        answer: q.answer,
        chosen,
        why: q.why,
        trap: q.trap,
        zh: q.zh,
        sourceWords: q.sourceWords,
        createdAt: now,
        retries: 0,
      });
    }

    const key = todayKey();
    const stat = (await db.dailyStats.get(key)) ?? {
      date: key,
      newLearned: 0,
      reviewed: 0,
      again: 0,
      hard: 0,
      good: 0,
      easy: 0,
      durationMs: 0,
      grammarTotal: 0,
      grammarCorrect: 0,
    };
    stat.grammarTotal = (stat.grammarTotal ?? 0) + 1;
    if (correct) stat.grammarCorrect = (stat.grammarCorrect ?? 0) + 1;
    await db.dailyStats.put(stat);
  });

  return { correct, timesCorrect };
}

/** 错题本列表 */
export async function getMistakes(filter?: {
  point?: string;
  onlyOpen?: boolean;
}): Promise<MistakeRecord[]> {
  let rows = await db.mistakes.toArray();
  if (filter?.point) rows = rows.filter(m => m.point === filter.point);
  if (filter?.onlyOpen) rows = rows.filter(m => m.resolvedCorrect !== true);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** 按考点聚合的错误统计——W4 薄弱点分析的数据基础 */
export async function getPointStats(): Promise<
  { point: string; total: number; wrong: number; accuracy: number }[]
> {
  const [questions, mistakes] = await Promise.all([
    db.questions.toArray(),
    db.mistakes.toArray(),
  ]);

  const answered = questions.filter(q => q.seen > 0);
  const byPoint = new Map<string, { total: number; correct: number }>();

  for (const q of answered) {
    const cur = byPoint.get(q.point) ?? { total: 0, correct: 0 };
    // seen 可能大于 1，这里按"题目数"而不是"作答次数"统计，避免重复刷同一题刷高正确率
    cur.total += 1;
    if (q.correct > 0) cur.correct += 1;
    byPoint.set(q.point, cur);
  }

  const wrongCount = new Map<string, number>();
  for (const m of mistakes) {
    wrongCount.set(m.point, (wrongCount.get(m.point) ?? 0) + 1);
  }

  return [...byPoint.entries()]
    .map(([point, v]) => ({
      point,
      total: v.total,
      wrong: wrongCount.get(point) ?? 0,
      accuracy: v.total > 0 ? v.correct / v.total : 0,
    }))
    .sort((a, b) => a.accuracy - b.accuracy);
}

/** 清空题库（换难度或 prompt 调整后想重新出题时用） */
export async function clearQuestionBank(): Promise<void> {
  await db.questions.clear();
}

export type { CardRecord, DailyStat, ReviewLogRow, Settings } from './types';
