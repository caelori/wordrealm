/** W3：AI 语法题 —— 数据模型 */

/** 12 个语法考点。限定枚举是为了让错题统计有意义：
 *  如果放任 AI 自由发挥，错题就没法按考点聚合，"薄弱点分析"也就无从谈起。 */
export const GRAMMAR_POINTS = {
  T1: '时态与体（一般/进行/完成/完成进行）',
  T2: '主谓一致',
  T3: '冠词与限定词（a/an/the/零冠词）',
  T4: '介词与固定搭配',
  T5: '非谓语动词（不定式/动名词/分词）',
  T6: '定语从句（关系代词/关系副词）',
  T7: '状语从句（时间/条件/让步/原因）',
  T8: '名词性从句（主语/宾语/表语/同位语）',
  T9: '虚拟语气与 would/could 用法',
  T10: '倒装与强调句',
  T11: '平行结构与比较结构',
  T12: '逻辑连接与句间关系',
} as const;

export type GrammarPoint = keyof typeof GRAMMAR_POINTS;
export const GRAMMAR_POINT_KEYS = Object.keys(GRAMMAR_POINTS) as GrammarPoint[];

export function isGrammarPoint(v: unknown): v is GrammarPoint {
  return typeof v === 'string' && v in GRAMMAR_POINTS;
}

export type Difficulty = 1 | 2 | 3;

/** 一道语法题（AI 生成后的形态） */
export interface GrammarQuestion {
  /** 主键，形如 t5-1742381923-7 */
  id: string;
  point: GrammarPoint;
  difficulty: Difficulty;
  /** 题干，空格处用 ___ 表示 */
  stem: string;
  options: string[];
  /** 正确选项下标 */
  answer: number;
  /** 为什么选它 */
  why: string;
  /** 典型错因：学生会误选哪个、为什么 */
  trap: string;
  /** 题干中文翻译（可选，做题后再显示） */
  zh?: string;
}

/** 入库形态：题目 + 使用情况 */
export interface QuestionRecord extends GrammarQuestion {
  createdAt: number;
  /** 出题时用到的目标词 */
  sourceWords: string[];
  /** 展示次数 */
  seen: number;
  /** 答对次数 */
  correct: number;
  /** 是否从未做过。冗余字段，为了能用 Dexie 索引直接查（索引查不了 seen === 0） */
  unused: 0 | 1;
  lastSeenAt?: number;
  /** 该题是否已由 AI 生成（false 表示来自内置降级题库） */
  origin: 'ai' | 'builtin';
}

/** 错题记录 */
export interface MistakeRecord {
  id?: number;
  questionId: string;
  point: GrammarPoint;
  difficulty: Difficulty;
  stem: string;
  options: string[];
  answer: number;
  /** 用户选的下标 */
  chosen: number;
  why: string;
  trap: string;
  zh?: string;
  sourceWords: string[];
  createdAt: number;
  /** 重做次数 */
  retries: number;
  /** 重做是否做对 */
  resolvedCorrect?: boolean;
  lastRetryAt?: number;
}

/** AI 生成的原始响应形态（未经校验） */
export interface RawQuestion {
  point?: unknown;
  difficulty?: unknown;
  stem?: unknown;
  options?: unknown;
  answer?: unknown;
  why?: unknown;
  trap?: unknown;
  zh?: unknown;
}

/** 出题请求参数 */
export interface GenerateOptions {
  points: GrammarPoint[];
  words: string[];
  count: number;
  difficulty: Difficulty;
}

/** 校验结果 */
export interface ValidationIssue {
  index: number;
  reason: string;
}

/** 一个考点上的统计 */
export interface PointStat {
  point: GrammarPoint;
  total: number;
  wrong: number;
  accuracy: number;
}
