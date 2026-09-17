import { create } from 'zustand';
import { Rating } from 'ts-fsrs';
import {
  applyRating,
  db,
  DEFAULT_SETTINGS,
  getCounts,
  getQueue,
  getSettings,
  getStreak,
  getTodayStat,
  seedIfNeeded,
  updateSettings,
} from '../db/db';
import type { CardRecord, DailyStat, Settings } from '../db/types';
import { review, stateToStatus, emptyStoredCard } from '../systems/fsrs';
import { stopSpeaking } from '../systems/tts';

type Phase = 'boot' | 'seeding' | 'today' | 'learn' | 'done' | 'error';

/** 给可能永久挂起的操作兜一个超时。
 *  IndexedDB 在无头 / 隐私模式下会"既不成功也不失败"地卡住，
 *  没有这层保护界面会永远停在加载态。 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(message)), ms)),
  ]);
}

interface Counts {
  total: number;
  learned: number;
  due: number;
  newRemaining: number;
}

interface SessionCard {
  card: CardRecord;
  /** 本次会话中这是第几次看到它（用于显示"重来"标记） */
  requeued: boolean;
}

interface Store {
  phase: Phase;
  seedProgress: { done: number; total: number } | null;
  error: string | null;

  settings: Settings;
  counts: Counts;
  todayStat: DailyStat;
  streak: number;

  session: SessionCard[];
  sessionIndex: number;
  /** 会话里已评分的次数（含重来的） */
  sessionAnswered: number;
  sessionStartedAt: number;
  /** 当前这张卡是什么时候显示出来的，用于算单题耗时 */
  cardShownAt: number;
  /** 本次会话中新学的词数 */
  sessionNewCount: number;

  boot: () => Promise<void>;
  startSession: () => Promise<void>;
  rate: (rating: Rating) => Promise<void>;
  finishSession: () => Promise<void>;
  backToToday: () => Promise<void>;
  saveSettings: (patch: Partial<Omit<Settings, 'id'>>) => Promise<void>;
  /** 只重新加载设置（设置页改动后同步用），不重跑引导 */
  bootSettingsOnly: () => Promise<void>;
  resetWord: (word: string) => Promise<void>;
}

const EMPTY_STAT: DailyStat = {
  date: '',
  newLearned: 0,
  reviewed: 0,
  again: 0,
  hard: 0,
  good: 0,
  easy: 0,
  durationMs: 0,
};

const EMPTY_COUNTS: Counts = { total: 0, learned: 0, due: 0, newRemaining: 0 };

export const useStore = create<Store>((set, get) => ({
  phase: 'boot',
  seedProgress: null,
  error: null,
  settings: { id: 'app', ...DEFAULT_SETTINGS },
  counts: EMPTY_COUNTS,
  todayStat: EMPTY_STAT,
  streak: 0,

  session: [],
  sessionIndex: 0,
  sessionAnswered: 0,
  sessionStartedAt: 0,
  cardShownAt: 0,
  sessionNewCount: 0,

  async boot() {
    try {
      set({ phase: 'boot', error: null });
      const settings = await withTimeout(getSettings(), 10_000, '数据库打开超时');

      if (!settings.seeded) set({ phase: 'seeding', seedProgress: { done: 0, total: 0 } });

      await seedIfNeeded(p => set({ seedProgress: p }));

      const [counts, todayStat, streak] = await Promise.all([
        getCounts(),
        getTodayStat(),
        getStreak(),
      ]);
      set({ settings, counts, todayStat, streak, phase: 'today', seedProgress: null });
    } catch (e) {
      set({
        phase: 'error',
        error: e instanceof Error ? e.message : String(e),
        seedProgress: null,
      });
    }
  },

  async startSession() {
    const { settings } = get();
    const { reviews, news } = await getQueue(settings.dailyNewLimit, settings.dailyReviewLimit);

    // 先复习旧词，再学新词（顺序很重要：先巩固再用新内容冲淡）
    const session: SessionCard[] = [
      ...reviews.map(c => ({ card: c, requeued: false })),
      ...news.map(c => ({ card: c, requeued: false })),
    ];

    if (session.length === 0) {
      set({ phase: 'done' });
      return;
    }

    set({
      session,
      sessionIndex: 0,
      sessionAnswered: 0,
      sessionStartedAt: Date.now(),
      cardShownAt: Date.now(),
      sessionNewCount: news.length,
      phase: 'learn',
    });
  },

  async rate(rating: Rating) {
    const state = get();
    const current = state.session[state.sessionIndex];
    if (!current) return;

    const now = new Date();
    const { next } = review(current.card.fsrs, rating, now, state.settings.requestRetention);
    const nextStatus = stateToStatus(next.state);

    // 单题耗时 = 从这张卡显示出来到现在，不是整个会话的时长
    const answeredAt = Date.now();
    const durationMs = state.cardShownAt > 0 ? answeredAt - state.cardShownAt : 0;

    await applyRating(current.card, next, nextStatus, rating, durationMs);

    const wasNew = current.card.status === 'new';

    // 评"忘记"则把这张卡放回队尾，本次会话内再过一遍（Anki 的做法）
    const queue = [...state.session];
    const updated: SessionCard = {
      card: { ...current.card, fsrs: next, status: nextStatus },
      requeued: current.requeued,
    };
    queue[state.sessionIndex] = updated;

    if (rating === Rating.Again) {
      queue.push({ card: updated.card, requeued: true });
    }

    // 更新今日统计（本地增量，避免每次评分都全表查）
    // 注意：重来的卡在本次会话里会被评两次，两次都应计入 reviewed
    const stat = { ...state.todayStat };
    stat.reviewed += 1;
    if (wasNew) stat.newLearned += 1;
    if (rating === Rating.Again) stat.again += 1;
    else if (rating === Rating.Hard) stat.hard += 1;
    else if (rating === Rating.Good) stat.good += 1;
    else stat.easy += 1;

    const counts = { ...state.counts };
    if (wasNew) {
      counts.newRemaining = Math.max(0, counts.newRemaining - 1);
      counts.learned += 1;
    }
    // 评"忘记"的卡还在本次会话里，不算离开到期队列
    if (rating !== Rating.Again) counts.due = Math.max(0, counts.due - 1);

    const nextIndex = state.sessionIndex + 1;
    const shownAt = Date.now();

    if (nextIndex >= queue.length) {
      set({
        session: queue,
        sessionIndex: nextIndex,
        sessionAnswered: state.sessionAnswered + 1,
        todayStat: stat,
        counts,
      });
      await get().finishSession();
      return;
    }

    set({
      session: queue,
      sessionIndex: nextIndex,
      sessionAnswered: state.sessionAnswered + 1,
      cardShownAt: shownAt,
      todayStat: stat,
      counts,
    });
  },

  async finishSession() {
    stopSpeaking();
    const [counts, todayStat, streak] = await Promise.all([
      getCounts(),
      getTodayStat(),
      getStreak(),
    ]);
    set({ phase: 'done', counts, todayStat, streak });
  },

  async backToToday() {
    const [counts, todayStat, streak] = await Promise.all([
      getCounts(),
      getTodayStat(),
      getStreak(),
    ]);
    set({ phase: 'today', session: [], sessionIndex: 0, counts, todayStat, streak });
  },

  async saveSettings(patch) {
    const settings = await updateSettings(patch);
    set({ settings });
  },

  async bootSettingsOnly() {
    set({ settings: await getSettings() });
  },

  /** 把某个词打回未学状态（手滑评错的补救） */
  async resetWord(word: string) {
    const card = await db.cards.get(word);
    if (!card) return;
    await db.cards.put({ ...card, status: 'new', fsrs: emptyStoredCard() });
    const counts = await getCounts();
    set({ counts });
  },
}));
