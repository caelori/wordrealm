/**
 * 端到端集成测试：在 Node 里用 fake-indexeddb 跑真实数据层。
 * 覆盖首次导入 -> 计数 -> 取队列 -> 评分调度 -> 统计 -> 连签 -> 重导不覆盖。
 *
 * 用法: node --experimental-strip-types tools/test-integration.mts
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { Rating, State } from 'ts-fsrs';

// 注入种子数据（Node 无法解析 Vite 的 JSON 导入）
const seeds = JSON.parse(readFileSync('src/data/seeds.json', 'utf8'));
(globalThis as Record<string, unknown>).__WORDREALM_SEEDS__ = seeds;

const dbmod = await import('../src/db/db.ts');
const fsrsmod = await import('../src/systems/fsrs.ts');

const {
  db,
  seedIfNeeded,
  getCounts,
  getQueue,
  applyRating,
  getTodayStat,
  getStreak,
  getSettings,
  updateSettings,
  todayKey,
  shiftDayKey,
} = dbmod;
const { review, stateToStatus, emptyStoredCard, humanInterval } = fsrsmod;

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}${extra ? '  [' + extra + ']' : ''}`);
    failures++;
  }
}

// ---------- 0. 种子数据完整性 ----------
console.log('\n[0] 种子数据完整性');
const words = seeds.words;
check('词数 > 9000', words.length > 9000, String(words.length));
const noPos = words.filter((w: any) => !w.pos).length;
check('缺词性的词 < 2%', noPos / words.length < 0.02, `${noPos} 个 (${(noPos / words.length * 100).toFixed(1)}%)`);
const noCn = words.filter((w: any) => !w.cn?.length).length;
check('没有空释义', noCn === 0, `${noCn} 个`);
const badWord = words.filter((w: any) => !/^[a-z][a-z'-]*$/.test(w.w)).length;
check('全部是纯字母单词（无短语/专名）', badWord === 0, `${badWord} 个`);
const withFrq = words.filter((w: any) => w.frq > 2000 && w.frq <= 20000).length;
check('词频全部落在 2001–20000', withFrq === words.length, `${withFrq}/${words.length}`);
const lowest = Math.min(...words.map((w: any) => w.frq));
check('最低词频 > 2000（已会词被排除）', lowest > 2000, String(lowest));
const withEx = words.filter((w: any) => w.ex?.lemma || Object.keys(w.ex?.forms ?? {}).length).length;
check('多数词带变形数据', withEx / words.length > 0.7, `${(withEx / words.length * 100).toFixed(0)}%`);
// 抽查几个已知词
const byWord = new Map(words.map((w: any) => [w.w, w]));
check('包含 invest 且词性正确', (byWord.get('invest') as any)?.pos === 'v.', JSON.stringify((byWord.get('invest') as any)?.pos));
check('包含 rural', byWord.has('rural'));

// ---------- 1. 首次导入 ----------
console.log('\n[1] 首次导入');
const t0 = Date.now();
let lastProgress = 0;
let plannedTotal = 0;
const { inserted, skipped } = await seedIfNeeded(prog => {
  lastProgress = Math.max(lastProgress, prog.done);
  plannedTotal = prog.total;
});
const seedMs = Date.now() - t0;
check('插入数量 = 词库词数', inserted === words.length, `${inserted}`);
check('首次无跳过', skipped === 0, `${skipped}`);
check('进度回调被触发到末尾', lastProgress === plannedTotal && plannedTotal === inserted, `${lastProgress}/${plannedTotal} 插入${inserted}`);
check('导入耗时 < 60s', seedMs < 60_000, `${seedMs}ms`);

let counts = await getCounts();
check('总数正确', counts.total === words.length, `${counts.total}`);
check('初始全部是未学', counts.learned === 0 && counts.newRemaining === words.length, JSON.stringify(counts));
check('初始无到期复习', counts.due === 0, String(counts.due));

const settings = await getSettings();
check('设置已标记为已导入', settings.seeded === true);

// ---------- 2. 取队列 ----------
console.log('\n[2] 取学习队列');
const q1 = await getQueue(10, 0);
check('新词队列 = 每日上限', q1.news.length === 10, `${q1.news.length}`);
check('复习队列为空', q1.reviews.length === 0, `${q1.reviews.length}`);
const frqs = q1.news.map(c => c.frq);
const sorted = [...frqs].sort((a, b) => a - b);
check('新词按词频升序（先学高频）', JSON.stringify(frqs) === JSON.stringify(sorted), JSON.stringify(frqs));
check('全部是未学状态', q1.news.every(c => c.status === 'new'));
check('队列卡片刻有内容', q1.news.every(c => c.cn.length > 0 && c.id === c.word));

// ---------- 3. 评分调度 ----------
console.log('\n[3] 评分调度');
const card = q1.news[0];
const now = new Date();
const r1 = review(card.fsrs, Rating.Good, now, settings.requestRetention);
const st1 = stateToStatus(r1.next.state);
await applyRating(card, r1.next, st1, Rating.Good, 3200);

check('评分后离开 New 状态', r1.next.state !== State.New, `state=${State[r1.next.state]}`);
check('业务状态不是 new', st1 !== 'new', st1);
check('reps 增加', r1.next.reps === 1, String(r1.next.reps));
check('due 时间被写入', r1.next.due > 0);

counts = await getCounts();
check('已学 +1', counts.learned === 1, `${counts.learned}`);
check('未学 -1', counts.newRemaining === words.length - 1, `${counts.newRemaining}`);

const stat = await getTodayStat();
check('今日日期键正确', stat.date === todayKey(), stat.date);
check('今日复习次数 = 1', stat.reviewed === 1, String(stat.reviewed));
check('今日新学 = 1', stat.newLearned === 1, String(stat.newLearned));
check('今日 good = 1', stat.good === 1, String(stat.good));
check('用时被记录', stat.durationMs === 3200, String(stat.durationMs));

// ---------- 4. 到期卡回到复习队列 ----------
console.log('\n[4] 到期后进入复习队列');
const dueCard = await db.cards.get(card.id);
await db.cards.put({ ...dueCard!, fsrs: { ...dueCard!.fsrs, due: Date.now() - 1000 } });
const q2 = await getQueue(10, 0);
check('到期卡出现在复习队列', q2.reviews.some(c => c.id === card.id), `reviews=${q2.reviews.length}`);
check('复习队列按到期时间升序', q2.reviews.every((c, i) => i === 0 || q2.reviews[i - 1].fsrs.due <= c.fsrs.due));

counts = await getCounts();
check('计数反映到期', counts.due >= 1, String(counts.due));

// ---------- 5. 评"忘记" -> lapses + 重学 ----------
console.log('\n[5] 评"忘记"的后果');
// FSRS 语义：lapses 只在已毕业（State.Review）的卡上评 Again 才 +1。
// 先把卡推进到真正的复习态，否则测的不是这条路径。
const dueNow = (await db.cards.get(card.id))!;
// ⚠️ learning_steps 必须一起归零。真实的已毕业卡片 learning_steps 一定是 0；
//    如果留着 1，就等于造出"已毕业但还在短时学习步进里"的矛盾状态，
//    FSRS 会按学习态处理，测不到真正的遗忘路径。
await db.cards.put({
  ...dueNow,
  status: 'review',
  fsrs: {
    ...dueNow.fsrs,
    state: State.Review,
    stability: 10,
    difficulty: 5,
    scheduled_days: 10,
    learning_steps: 0,
    reps: 3,
  },
});
const graduated = (await db.cards.get(card.id))!;
check('前置条件：卡已进入复习态', graduated.fsrs.state === State.Review, State[graduated.fsrs.state]);
check('前置条件：已脱离短时学习步进', graduated.fsrs.learning_steps === 0, String(graduated.fsrs.learning_steps));

const r2 = review(graduated.fsrs, Rating.Again, new Date(), settings.requestRetention);
console.log(
  `  DEBUG 输入state=${graduated.fsrs.state} 输出state=${r2.next.state} (${State[r2.next.state]}) ` +
    `lapses=${graduated.fsrs.lapses}->${r2.next.lapses} 保留率=${settings.requestRetention}`,
);
check('毕业卡评 Again -> lapses +1', r2.next.lapses === graduated.fsrs.lapses + 1, `${graduated.fsrs.lapses} -> ${r2.next.lapses}`);
check('进入重学状态', r2.next.state === State.Relearning, `${r2.next.state} (${State[r2.next.state]})`);
check('间隔被压缩到远小于原来', r2.intervalDays < graduated.fsrs.scheduled_days, `${r2.intervalDays} vs ${graduated.fsrs.scheduled_days}`);
await applyRating(graduated, r2.next, stateToStatus(r2.next.state), Rating.Again, 1500);
const stat2 = await getTodayStat();
check('今日 again = 1', stat2.again === 1, String(stat2.again));
check('今日复习次数累加到 2', stat2.reviewed === 2, String(stat2.reviewed));

// ---------- 6. 连续天数 ----------
console.log('\n[6] 连续打卡');
const streak1 = await getStreak();
check('今天学了 -> 连签 >= 1', streak1 >= 1, String(streak1));
// 造昨天和前天的记录。
// ⚠️ 不能用 setDate(getDate()-2) 连着减：现在是 23:30 这种时刻会落成"前天"而不是"两天前"，
//    必须走 shiftDayKey 做自然日位移。
const today = todayKey();
const yKey = shiftDayKey(today, -1);
const dbKey = shiftDayKey(today, -2);
await db.dailyStats.put({ date: yKey, newLearned: 5, reviewed: 20, again: 2, hard: 3, good: 15, easy: 0, durationMs: 60000 });
await db.dailyStats.put({ date: dbKey, newLearned: 5, reviewed: 20, again: 2, hard: 3, good: 15, easy: 0, durationMs: 60000 });
const streak3 = await getStreak();
check('连续 3 天被正确识别', streak3 === 3, `得到 ${streak3}`);

// 中间断一天，连签必须归零重算
await db.dailyStats.delete(yKey);
const streakBroken = await getStreak();
check('中间断签 -> 只算到今天为止的连续段', streakBroken === 1, `得到 ${streakBroken}`);
await db.dailyStats.put({ date: yKey, newLearned: 5, reviewed: 20, again: 2, hard: 3, good: 15, easy: 0, durationMs: 60000 });

// ---------- 7. 重复导入不能覆盖进度 ----------
console.log('\n[7] 重复导入的保护');
const before = await getCounts();
const r3 = await seedIfNeeded();
check('第二次导入插入 0 条', r3.inserted === 0, String(r3.inserted));
check('第二次全部跳过', r3.skipped === words.length, String(r3.skipped));
const after = await getCounts();
check('已学数量没有被重置', after.learned === before.learned && after.learned === 1, `${before.learned} -> ${after.learned}`);

// ---------- 8. 设置持久化 ----------
console.log('\n[8] 设置持久化');
await updateSettings({ dailyNewLimit: 25, accent: 'en-GB' });
const s2 = await getSettings();
check('新词上限已保存', s2.dailyNewLimit === 25, String(s2.dailyNewLimit));
check('口音已保存', s2.accent === 'en-GB', s2.accent);
check('seeded 标志未被覆盖', s2.seeded === true);
const q3 = await getQueue(25, 0);
check('新上限生效', q3.news.length === 25, String(q3.news.length));

// ---------- 9. 复习上限生效 ----------
console.log('\n[9] 复习上限限流');
for (let i = 0; i < 5; i++) {
  const w = words[i + 100];
  const rec = await db.cards.get(w.w);
  await db.cards.put({ ...rec!, status: 'review', fsrs: { ...emptyStoredCard(), state: State.Review, due: Date.now() - 5000, scheduled_days: 3, stability: 3 } });
}
const qUnlimited = await getQueue(10, 0);
const qLimited = await getQueue(10, 2);
check('不限流时全部返回', qUnlimited.reviews.length >= 5, String(qUnlimited.reviews.length));
check('限流 2 只返回 2 个', qLimited.reviews.length === 2, String(qLimited.reviews.length));
check('复习优先：队列里复习排在前面', qLimited.reviews[0].fsrs.due <= Date.now());

// ---------- 10. 复习排序与新词顺序的组合 ----------
console.log('\n[10] 人工可读性检查');
console.log('  间隔文案: ' + [0, 1, 5, 30, 200, 400].map(d => `${d}d->${humanInterval(d)}`).join('  '));
const sample = q1.news.slice(0, 5);
for (const c of sample) {
  console.log(`  ${c.word.padEnd(14)} [${c.pos.padEnd(6)}] frq=${String(c.frq).padStart(5)}  ${c.cn.slice(0, 3).join(' / ').slice(0, 44)}`);
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
