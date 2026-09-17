/**
 * FSRS 冒烟测试
 * 用法: node --experimental-strip-types tools/test-fsrs.mts
 * 不碰数据库，只验证排程算法和持久化转换是否正确。
 */
import { fsrs, Rating, State, createEmptyCard } from 'ts-fsrs';

const DAY = 86_400_000;

// 与 src/systems/fsrs.ts 保持一致的参数
const MAX_INTERVAL = 365;
function makeScheduler(retention = 0.9) {
  return fsrs({
    request_retention: retention,
    maximum_interval: MAX_INTERVAL,
    enable_fuzz: true,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m'],
  });
}

interface Stored {
  due: number; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; learning_steps: number; reps: number; lapses: number;
  state: number; last_review?: number;
}

const toCard = (s: Stored) => ({
  due: new Date(s.due), stability: s.stability, difficulty: s.difficulty,
  elapsed_days: s.elapsed_days, scheduled_days: s.scheduled_days,
  learning_steps: s.learning_steps, reps: s.reps, lapses: s.lapses,
  state: s.state as State,
  last_review: s.last_review != null ? new Date(s.last_review) : undefined,
});

const fromCard = (c: any): Stored => ({
  due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty,
  elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days,
  learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses,
  state: c.state,
  last_review: c.last_review != null ? c.last_review.getTime() : undefined,
});

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name} ${extra}`); failures++; }
}

const f = makeScheduler();

// ---------- 1. 持久化往返：Date <-> timestamp 不能丢精度 ----------
console.log('\n[1] 持久化往返');
const now = new Date('2026-03-01T09:00:00Z');
const empty = fromCard(createEmptyCard(now));
check('新卡 state = New(0)', empty.state === State.New, `实际 ${empty.state}`);
check('新卡 due = now', empty.due === now.getTime());
const round = fromCard(toCard(empty));
check('往返后完全一致', JSON.stringify(round) === JSON.stringify(empty));

// ---------- 2. 新卡三次评分 ----------
console.log('\n[2] 新卡评分路径');
for (const [label, g] of [['Again', Rating.Again], ['Hard', Rating.Hard], ['Good', Rating.Good]] as const) {
  const item = f.next(toCard(empty), now, g);
  const mins = (item.card.due.getTime() - now.getTime()) / 60000;
  console.log(
    `  ${label.padEnd(6)} -> state=${State[item.card.state].padEnd(10)} +${mins.toFixed(1).padStart(6)} 分钟  S=${item.card.stability.toFixed(3)} D=${item.card.difficulty.toFixed(2)}`,
  );
}
const againItem = f.next(toCard(empty), now, Rating.Again);
const goodItem = f.next(toCard(empty), now, Rating.Good);
check(
  '新卡 Again 的间隔 < Good 的间隔',
  (againItem.card.due.getTime() - now.getTime()) < (goodItem.card.due.getTime() - now.getTime()),
);

// ---------- 3. 间隔必须单调递增（连续评 Good） ----------
console.log('\n[3] 连续评 Good，间隔应持续增长');
let card = fromCard(createEmptyCard(now));
let t = now.getTime();
const intervals: number[] = [];
for (let i = 0; i < 8; i++) {
  const at = new Date(t);
  const item = f.next(toCard(card), at, Rating.Good);
  card = fromCard(item.card);
  t = card.due;
  intervals.push(card.scheduled_days);
}
console.log('  间隔(天): ' + intervals.map(d => d.toFixed(1)).join(' -> '));
let monotonic = true;
for (let i = 1; i < intervals.length; i++) if (intervals[i] < intervals[i - 1]) monotonic = false;
check('间隔单调不减', monotonic, JSON.stringify(intervals));
// 容 1 天：maximum_interval 约束的是 next_interval 的计算结果，
// 而 scheduled_days 是 due - last_review 的按天取整，叠加 fuzz 后会差一天。
check(
  `最终间隔被 ${MAX_INTERVAL} 天上限约束（容差 1 天）`,
  Math.max(...intervals) <= MAX_INTERVAL + 1,
  `最大 ${Math.max(...intervals)}`,
);

// ---------- 4. 忘记会导致遗忘计数 + 进入重学 ----------
console.log('\n[4] 复习中断：评 Again');
const beforeLapses = card.lapses;
const lapseItem = f.next(toCard(card), new Date(t), Rating.Again);
check('lapses 增加', lapseItem.card.lapses === beforeLapses + 1, `${beforeLapses} -> ${lapseItem.card.lapses}`);
check('state 变成 Relearning', lapseItem.card.state === State.Relearning, State[lapseItem.card.state]);
check('间隔被大幅压缩', lapseItem.card.scheduled_days < card.scheduled_days);

// ---------- 5. 目标保持率必须真的影响间隔 ----------
console.log('\n[5] 保持率 0.7 vs 0.95 的间隔差异');
function simulate(retention: number): number {
  const s = makeScheduler(retention);
  let c = fromCard(createEmptyCard(now));
  let tt = now.getTime();
  for (let i = 0; i < 6; i++) {
    const item = s.next(toCard(c), new Date(tt), Rating.Good);
    c = fromCard(item.card);
    tt = c.due;
  }
  return c.scheduled_days;
}
const lo = simulate(0.7), hi = simulate(0.95);
console.log(`  70% -> ${lo.toFixed(1)} 天 ; 95% -> ${hi.toFixed(1)} 天`);
check('低保持率间隔更长', lo > hi, `${lo} vs ${hi}`);

// ---------- 6. 可提取性 ----------
console.log('\n[6] 可提取性(retrievability)');
let c2 = fromCard(createEmptyCard(now));
let t2 = now.getTime();
for (let i = 0; i < 3; i++) {
  const item = f.next(toCard(c2), new Date(t2), Rating.Good);
  c2 = fromCard(item.card); t2 = c2.due;
}
const rNow = f.get_retrievability(toCard(c2), new Date(t2), false);
const rLate = f.get_retrievability(toCard(c2), new Date(t2 + 30 * DAY), false);
console.log(`  到期当天 R=${(rNow * 100).toFixed(1)}%  ; 30 天后 R=${(rLate * 100).toFixed(1)}%`);
check('到期时 R ≈ 90%', rNow > 0.85 && rNow <= 1.0, `${rNow}`);
check('越久越记不住', rLate < rNow);

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
