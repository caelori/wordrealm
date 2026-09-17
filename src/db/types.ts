/** 词库种子数据（由 tools/etl.mjs 从 ECDICT 生成） */
export interface SeedWord {
  /** 单词 */
  w: string;
  /** 词性，如 n. / v. / adj. */
  pos: string;
  /** 中文义项（已清洗、去重、最多 8 条） */
  cn: string[];
  /** 当代语料库词频排名（越小越常用） */
  frq: number;
  /** 英国国家语料库词频排名 */
  bnc: number;
  /** 柯林斯星级 0-5 */
  col: number;
  /** 是否牛津三千核心词 */
  ox: 0 | 1;
  /** 考试标签 */
  tags: string[];
  /** 英文释义（首条） */
  def: string;
  /** 变形信息 */
  ex: {
    /** lemma：若本词是变形，指向原型（用于词族聚类） */
    lemma: string;
    /** 变形表 */
    forms: Record<string, string>;
  };
}

export interface SeedsFile {
  version: number;
  generatedAt: string;
  source: string;
  filter: unknown;
  words: SeedWord[];
  families: Record<string, string[]>;
}

/** 卡片当前状态 */
export type CardStatus = 'new' | 'learning' | 'review' | 'suspended';

/** ⚠️ ts-fsrs v5 的 Card 里 due/last_review 是 Date 对象，
 *  IndexedDB 不能直接存 Date，必须转成时间戳。这是持久化表示。 */
export interface StoredFsrsCard {
  /** 到期时间（毫秒时间戳） */
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  /** ts-fsrs State 枚举值 0=New 1=Learning 2=Review 3=Relearning */
  state: number;
  /** 上次复习时间（毫秒时间戳） */
  last_review?: number;
}

/** 每张卡片一条记录，主键是单词本身 */
export interface CardRecord {
  /** 主键：单词 */
  id: string;
  word: string;
  /** 冗余存一份卡片内容，避免每次渲染都查种子表 */
  pos: string;
  cn: string[];
  frq: number;
  col: number;
  tags: string[];
  def: string;
  ex: SeedWord['ex'];
  /** 业务状态 */
  status: CardStatus;
  /** 首次学习时间 */
  createdAt: number;
  /** FSRS 调度状态 */
  fsrs: StoredFsrsCard;
}

/** 每次评分留痕，供统计和 FSRS 优化使用 */
export interface ReviewLogRow {
  id?: number;
  word: string;
  /** 1=Again 2=Hard 3=Good 4=Easy */
  rating: number;
  /** 评分时所在状态 */
  prevState: number;
  /** 评分前的间隔天数 */
  prevInterval: number;
  /** 本次耗时（毫秒） */
  durationMs: number;
  /** 是否为当天首次接触该词 */
  isNew: boolean;
  reviewedAt: number;
}

/** 每日统计 */
export interface DailyStat {
  /** 主键：YYYY-MM-DD */
  date: string;
  newLearned: number;
  reviewed: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  durationMs: number;
  /** 语法题：当天做了多少道（旧数据没有这两个字段） */
  grammarTotal?: number;
  /** 语法题：答对多少道 */
  grammarCorrect?: number;
}

/** 用户设置（单行，主键恒为 'app'） */
export interface Settings {
  id: 'app';
  /** 每天新词上限 */
  dailyNewLimit: number;
  /** 每天复习上限（0 = 不限） */
  dailyReviewLimit: number;
  /** 目标记忆保持率 */
  requestRetention: number;
  /** 首选发音口音 */
  accent: 'en-US' | 'en-GB';
  /** 发音语速 */
  speechRate: number;
  /** 卡片上显示中文释义的义项数量上限 */
  maxSenses: number;
  /** 词库是否已导入 */
  seeded: boolean;

  // ---------- W3：AI 语法题 ----------
  /** DeepSeek（或兼容服务）的 API Key，只存在本地 IndexedDB */
  aiApiKey: string;
  /** 接口地址，形如 https://api.deepseek.com */
  aiBaseUrl: string;
  /** 模型名。DeepSeek 调整过模型名，所以做成可配置而不是写死 */
  aiModel: string;
  /** 单次请求超时（毫秒） */
  aiTimeoutMs: number;
  /** 每天出多少道语法题 */
  dailyGrammarCount: number;
  /** 出题难度 1/2/3 */
  grammarDifficulty: 1 | 2 | 3;
}

/** 每日统计里追加语法题字段（可选，兼容旧数据） */
export interface GrammarDailyStat {
  date: string;
  grammarTotal: number;
  grammarCorrect: number;
}

export type {
  GrammarQuestion,
  QuestionRecord,
  MistakeRecord,
  GrammarPoint,
  Difficulty,
  PointStat,
} from '../systems/grammar/types';