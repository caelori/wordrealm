import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  getGrammarQueue,
  getMistakes,
  getPointStats,
  getQuestionBankCount,
  getSettings,
  recordAnswer,
  updateSettings,
} from '../db/db';
import type { MistakeRecord, QuestionRecord, Settings } from '../db/types';
import { AiError } from '../systems/grammar/provider';
import { describeAiError, ensureQuestionBank } from '../systems/grammar/bank';

export type GrammarPhase = 'idle' | 'loading' | 'quiz' | 'summary';

/** 一道待做的题（可能来自题库，也可能是错题重做） */
export interface QuizItem {
  question: QuestionRecord;
  /** 来自错题本时，记录上次选错的答案 */
  previousWrong?: number;
}

interface GrammarStore {
  phase: GrammarPhase;
  /** 生成题库时的进度文案 */
  progressText: string;
  error: { title: string; hint: string } | null;

  items: QuizItem[];
  index: number;
  /** 已作答的结果：每题选的选项下标 */
  answers: number[];
  startedAt: number;
  itemShownAt: number;

  bank: { total: number; unseen: number };
  mistakes: MistakeRecord[];
  pointStats: { point: string; total: number; wrong: number; accuracy: number }[];

  refreshStats: () => Promise<void>;
  start: (count?: number) => Promise<void>;
  answer: (chosen: number) => Promise<boolean>;
  next: () => void;
  finish: () => Promise<void>;
  reset: () => void;
  loadMistakes: (onlyOpen?: boolean) => Promise<void>;
  clearError: () => void;

  // 设置相关
  settings: Settings;
  reloadSettings: () => Promise<void>;
  saveAi: (patch: Partial<Omit<Settings, 'id'>>) => Promise<void>;
}

function toQuizItem(q: QuestionRecord): QuizItem {
  return { question: q };
}

export const useGrammarStore = create<GrammarStore>((set, get) => ({
  phase: 'idle',
  progressText: '',
  error: null,

  items: [],
  index: 0,
  answers: [],
  startedAt: 0,
  itemShownAt: 0,

  bank: { total: 0, unseen: 0 },
  mistakes: [],
  pointStats: [],

  settings: { id: 'app', ...DEFAULT_SETTINGS },

  async refreshStats() {
    const [bank, pointStats] = await Promise.all([getQuestionBankCount(), getPointStats()]);
    set({ bank, pointStats });
  },

  async reloadSettings() {
    set({ settings: await getSettings() });
  },

  async saveAi(patch) {
    const settings = await updateSettings(patch);
    set({ settings });
  },

  /**
   * 开始做题。
   * 关键顺序：先把本地题库取出来，不够才调 AI —— 这样大多数时候是零延迟的。
   */
  async start(count?: number) {
    const settings = await getSettings();
    const want = count ?? settings.dailyGrammarCount;

    set({ phase: 'loading', progressText: '正在准备题目…', error: null });

    try {
      // 1. 本地题库够不够。重做题排在新题前面（先巩固再学新）。
      const local = await getGrammarQueue(want);

      let items: QuizItem[] = [
        ...local.retry.map(m => ({
          question: {
            id: m.questionId,
            point: m.point,
            difficulty: m.difficulty,
            stem: m.stem,
            options: m.options,
            answer: m.answer,
            why: m.why,
            trap: m.trap,
            zh: m.zh,
            createdAt: m.createdAt,
            sourceWords: m.sourceWords,
            seen: 1,
            correct: 0,
            unused: 0 as const,
            origin: 'ai' as const,
          },
          previousWrong: m.chosen,
        })),
        ...local.fresh.map(toQuizItem),
      ];

      // 2. 新题不够就补（重做题不算在"够不够"里）
      if (local.fresh.length < want) {
        set({ progressText: '本地题目不够，正在让 AI 出题…' });
        const r = await ensureQuestionBank(want, stage => set({ progressText: stage }));
        if (r.error) {
          set({ error: describeAiError(r.error), progressText: '' });
        }
        if (r.added > 0) {
          const more = await getGrammarQueue(want - local.fresh.length);
          items = [...items, ...more.fresh.map(toQuizItem)];
        }
      }

      items = items.slice(0, want);

      if (items.length === 0) {
        set({ phase: 'idle', progressText: '', error: get().error });
        return;
      }

      set({
        items,
        index: 0,
        answers: [],
        startedAt: Date.now(),
        itemShownAt: Date.now(),
        phase: 'quiz',
        progressText: '',
        error: null,
      });
    } catch (e) {
      const err =
        e instanceof AiError
          ? describeAiError(e)
          : { title: '出题失败', hint: e instanceof Error ? e.message : String(e) };
      set({ phase: 'idle', error: err, progressText: '' });
    }
  },

  /** 作答。返回是否答对。 */
  async answer(chosen: number) {
    const { items, index } = get();
    const item = items[index];
    if (!item) return false;

    const q = item.question;
    const { correct } = await recordAnswer(q, chosen);

    set(state => {
      const answers = [...state.answers];
      answers[index] = chosen;
      return { answers };
    });

    return correct;
  },

  next() {
    const { index, items } = get();
    const nextIndex = index + 1;
    if (nextIndex >= items.length) {
      void get().finish();
      return;
    }
    set({ index: nextIndex, itemShownAt: Date.now() });
  },

  async finish() {
    // 先把界面切到小结页，再在后台刷新统计。
    // 反过来的话，做完最后一题会卡在答题页等一次数据库往返。
    set({ phase: 'summary' });
    await get().refreshStats();
  },

  reset() {
    set({
      phase: 'idle',
      items: [],
      index: 0,
      answers: [],
      error: null,
      progressText: '',
    });
  },

  async loadMistakes(onlyOpen = true) {
    set({ mistakes: await getMistakes({ onlyOpen }) });
  },

  clearError() {
    set({ error: null });
  },
}));

/** 便捷派生：当前这道题 */
export function currentItem(s: GrammarStore): QuizItem | undefined {
  return s.items[s.index];
}
