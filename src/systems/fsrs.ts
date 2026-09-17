import {
  fsrs,
  createEmptyCard,
  Rating,
  State,
  type Card,
  type Grade,
  type FSRS,
} from 'ts-fsrs';
import type { CardStatus, StoredFsrsCard } from '../db/types';

/**
 * 调度器参数
 *  - maximum_interval 设 365 天：36500（默认 100 年）对语言学习没有意义，
 *    而且会让高频词被"挤出"复习队列
 *  - enable_fuzz 打开：避免一大批同期学的词永远黏在同一天到期
 */
export const DEFAULT_MAX_INTERVAL = 365;

let _fsrs: FSRS | null = null;
let _retention = 0.9;

export function getScheduler(requestRetention = 0.9): FSRS {
  if (!_fsrs || _retention !== requestRetention) {
    _retention = requestRetention;
    _fsrs = fsrs({
      request_retention: requestRetention,
      maximum_interval: DEFAULT_MAX_INTERVAL,
      enable_fuzz: true,
      // 保留短时学习步进：新词当天会在会话内再次出现，符合"当天记住"的直觉
      enable_short_term: true,
      learning_steps: ['1m', '10m'],
      relearning_steps: ['10m'],
    });
  }
  return _fsrs;
}

/** 持久化表示 -> ts-fsrs 的 Card（Date 对象） */
export function toFsrsCard(s: StoredFsrsCard): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
    last_review: s.last_review != null ? new Date(s.last_review) : undefined,
  };
}

/** ts-fsrs 的 Card -> 持久化表示（Date 转时间戳） */
export function fromFsrsCard(c: Card): StoredFsrsCard {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review != null ? c.last_review.getTime() : undefined,
  };
}

/** 新建一张空卡的持久化状态 */
export function emptyStoredCard(now = Date.now()): StoredFsrsCard {
  return fromFsrsCard(createEmptyCard(new Date(now)));
}

/**
 * 计算评分后的新状态。
 * ⚠️ 必须传同一个 now：如果这里用 new Date()，而评分前又取了一次时间，
 *    会导致 ts-fsrs 内部的 elapsed_days 计算出现跨天误差。
 */
export function review(
  stored: StoredFsrsCard,
  rating: Rating,
  now: Date,
  requestRetention = 0.9,
): { next: StoredFsrsCard; intervalDays: number; dueAt: number } {
  const scheduler = getScheduler(requestRetention);
  const item = scheduler.next(toFsrsCard(stored), now, rating as Grade);
  const next = fromFsrsCard(item.card);
  return {
    next,
    intervalDays: item.card.scheduled_days,
    dueAt: item.card.due.getTime(),
  };
}

/** FSRS State -> 业务状态 */
export function stateToStatus(state: number): CardStatus {
  switch (state) {
    case State.New:
      return 'new';
    case State.Review:
      return 'review';
    case State.Learning:
    case State.Relearning:
      return 'learning';
    default:
      return 'learning';
  }
}

/** 当前可提取性（还记得的概率），用于界面显示 */
export function retrievability(
  stored: StoredFsrsCard,
  now = new Date(),
  requestRetention = 0.9,
): number {
  if (stored.state === State.New || stored.stability <= 0) return 0;
  return getScheduler(requestRetention).get_retrievability(toFsrsCard(stored), now, false);
}

/** 三档评分按钮的展示信息 */
export const RATING_BUTTONS: {
  rating: Rating;
  label: string;
  hint: string;
  hotkey: string;
  tone: 'again' | 'hard' | 'good';
}[] = [
  { rating: Rating.Again, label: '忘记', hint: '完全想不起来', hotkey: '1', tone: 'again' },
  { rating: Rating.Hard, label: '模糊', hint: '想起来了但很吃力', hotkey: '2', tone: 'hard' },
  { rating: Rating.Good, label: '记得', hint: '顺利想起', hotkey: '3', tone: 'good' },
];

/** 把间隔天数转成人话 */
export function humanInterval(days: number): string {
  if (days <= 0) return '今天';
  if (days < 1) return '今天';
  if (days === 1) return '明天';
  if (days < 30) return `${Math.round(days)} 天后`;
  if (days < 365) return `${Math.round(days / 30)} 个月后`;
  return `${(days / 365).toFixed(1)} 年后`;
}

export { Rating, State };
