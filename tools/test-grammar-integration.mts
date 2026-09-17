/**
 * W3 端到端：题库 -> 作答 -> 错题本 -> 考点统计 -> 重做攻克
 * 用 fake-indexeddb 跑真实数据层，不打真实 API。
 *
 * 用法: npm run test:grammar-int
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';

const seeds = JSON.parse(readFileSync('public/data/seeds.json', 'utf8'));
(globalThis as Record<string, unknown>).__WORDREALM_SEEDS__ = seeds;

const dbmod = await import('../src/db/db.ts');
const bankmod = await import('../src/systems/grammar/bank.ts');
const storemod = await import('../src/store/useGrammarStore.ts');
const { makeQuestionId } = await import('../src/systems/grammar/parse.ts');

const {
  db,
  seedIfNeeded,
  addQuestions,
  getGrammarQueue,
  getQuestionBankCount,
  recordAnswer,
  getMistakes,
  getPointStats,
  clearQuestionBank,
  getSettings,
  updateSettings,
  todayKey,
} = dbmod;

const { pickPoints, pickSourceWords, ensureQuestionBank, hasApiKey, describeAiError } = bankmod;
const { useGrammarStore } = storemod;

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}${extra ? '  [' + extra + ']' : ''}`);
    failures++;
  }
}

function mkQ(point: string, i: number, over: Record<string, unknown> = {}) {
  return {
    id: makeQuestionId(point as never, i),
    point,
    difficulty: 2,
    stem: `Test sentence number ${i} has ___ here.`,
    options: ['alpha', 'beta', 'gamma', 'delta'],
    answer: 1,
    why: '测试用的解析文字，长度足够通过校验。',
    trap: '测试用的错因说明，长度足够通过。',
    zh: '测试句。',
    createdAt: Date.now() + i,
    sourceWords: ['test'],
    seen: 0,
    correct: 0,
    unused: 1 as const,
    origin: 'ai' as const,
    ...over,
  };
}

// ---------- 0. 准备词库（让 pickSourceWords 有数据） ----------
console.log('\n[0] 准备数据');
await seedIfNeeded();
const cardCount = await db.cards.count();
check('词库已导入', cardCount > 9000, String(cardCount));

// ---------- 1. 未配置 Key 时的行为 ----------
console.log('\n[1] 未配置 API Key');
let s = await getSettings();
check('默认没有 Key', s.aiApiKey === '', JSON.stringify(s.aiApiKey));
check('默认接口地址正确', s.aiBaseUrl === 'https://api.deepseek.com', s.aiBaseUrl);
check(
  '默认模型名是实测可用的 deepseek-flash',
  s.aiModel === 'deepseek-flash',
  s.aiModel,
);
check('默认每日题量 10', s.dailyGrammarCount === 10, String(s.dailyGrammarCount));
check('默认难度 2', s.grammarDifficulty === 2, String(s.grammarDifficulty));
check('hasApiKey 判空正确', hasApiKey(s) === false);

const noKey = await ensureQuestionBank(8);
check('无 Key 时不生成', noKey.generated === false && noKey.added === 0);
check('无 Key 时返回明确错误', noKey.error?.kind === 'no-key', noKey.error?.kind);
check('错误提示可读', describeAiError(noKey.error!).hint.includes('设置'), describeAiError(noKey.error!).hint);

// ---------- 2. 出题素材挑选 ----------
console.log('\n[2] 出题素材');
const words = await pickSourceWords(30);
check('能挑出单词', words.length > 0, String(words.length));
check('单词数量不超上限', words.length <= 30, String(words.length));
check('无重复单词', new Set(words).size === words.length);

const points = await pickPoints(4);
check('挑出 4 个考点', points.length === 4, String(points.length));
check('考点均合法', points.every(p => /^T\d+$/.test(p)), JSON.stringify(points));
check('初期优先未做过的考点', new Set(points).size === 4, JSON.stringify(points));

// ---------- 3. 手动灌题（模拟 AI 已生成） ----------
console.log('\n[3] 题库写入与读取');
const batch = [
  mkQ('T5', 1),
  mkQ('T5', 2),
  mkQ('T3', 3),
  mkQ('T3', 4),
  mkQ('T1', 5),
];
const added = await addQuestions(batch);
check('写入 5 道', added === 5, String(added));

const dup = await addQuestions([mkQ('T5', 1)]); // 题干完全相同
check('重复题干被去重', dup === 0, String(dup));

let bank = await getQuestionBankCount();
check('题库总数 5', bank.total === 5, String(bank.total));
check('未做 5 道', bank.unseen === 5, String(bank.unseen));

const q1 = await getGrammarQueue(3);
check('取队列返回 3 道', q1.fresh.length === 3, String(q1.fresh.length));
check('新题队列为空', q1.retry.length === 0, String(q1.retry.length));
check('按创建时间升序', q1.fresh.every((q, i) => i === 0 || q1.fresh[i - 1].createdAt <= q.createdAt));

// ---------- 4. 作答：答对 ----------
console.log('\n[4] 答对');
const target = q1.fresh[0];
let r = await recordAnswer(target, target.answer);
check('判为正确', r.correct === true);

const after = await db.questions.get(target.id);
check('seen +1', after?.seen === 1, String(after?.seen));
check('correct +1', after?.correct === 1, String(after?.correct));
check('unused 置 0（否则会被反复取出）', after?.unused === 0, String(after?.unused));
check('lastSeenAt 被写入', (after?.lastSeenAt ?? 0) > 0);

bank = await getQuestionBankCount();
check('未做数降到 4', bank.unseen === 4, String(bank.unseen));

let stat = await db.dailyStats.get(todayKey());
check('今日语法总数 1', stat?.grammarTotal === 1, String(stat?.grammarTotal));
check('今日语法答对 1', stat?.grammarCorrect === 1, String(stat?.grammarCorrect));

const noMistake = await getMistakes({ onlyOpen: true });
check('答对不产生错题', noMistake.length === 0, String(noMistake.length));

// ---------- 5. 作答：答错 ----------
console.log('\n[5] 答错');
// 明确挑一道 T3 出来答错，不要依赖队列顺序——
// 否则"T3 有错题"这条断言会因为前面的步骤把 T3 消费掉而假失败。
const t3Card = (await db.questions.toArray()).find(q => q.point === 'T3' && q.unused === 1);
if (!t3Card) throw new Error('测试前置失败：找不到未做的 T3 题目');
r = await recordAnswer(t3Card, 3);
check('判为错误', r.correct === false);

const openMistakes = await getMistakes({ onlyOpen: true });
check('产生 1 条错题', openMistakes.length === 1, String(openMistakes.length));
check('错题记录了考生的选择', openMistakes[0].chosen === 3, String(openMistakes[0].chosen));
check('错题保留了正确答案', openMistakes[0].answer === 1, String(openMistakes[0].answer));
check('错题保留了 why', openMistakes[0].why.length > 5);
check('错题保留了 trap', openMistakes[0].trap.length > 5);

stat = await db.dailyStats.get(todayKey());
check('今日总数 2', stat?.grammarTotal === 2, String(stat?.grammarTotal));
check('今日答对仍为 1', stat?.grammarCorrect === 1, String(stat?.grammarCorrect));

// ---------- 6. 错题优先重做 + 攻克 ----------
console.log('\n[6] 错题重做');
// 重做题不应该挤占新题名额：请求 5 道，错题 1 道 + 新题仍应给满
const qRetry = await getGrammarQueue(5);
check('错题出现在重做队列', qRetry.retry.length === 1, String(qRetry.retry.length));
check('重做队列带上次错选', qRetry.retry[0].chosen === 3, String(qRetry.retry[0].chosen));
check('错题不挤占新题名额', qRetry.fresh.length === 3, String(qRetry.fresh.length));

// 重做并答对
const retryQ = await db.questions.get(qRetry.retry[0].questionId);
r = await recordAnswer(retryQ!, retryQ!.answer);
check('重做答对', r.correct === true);

const stillOpen = await getMistakes({ onlyOpen: true });
check('错题被标记为已攻克', stillOpen.length === 0, String(stillOpen.length));

const allMistakes = await getMistakes({ onlyOpen: false });
check('历史错题仍保留', allMistakes.length === 1, String(allMistakes.length));
check('已解决标记为 true', allMistakes[0].resolvedCorrect === true);
check('retries 被记录', allMistakes[0].retries === 1, String(allMistakes[0].retries));

// ---------- 7. 考点统计 ----------
console.log('\n[7] 考点统计');
const stats = await getPointStats();
check('有统计结果', stats.length > 0, String(stats.length));
check('按正确率升序', stats.every((p, i) => i === 0 || stats[i - 1].accuracy <= p.accuracy), JSON.stringify(stats));
const t5 = stats.find(p => p.point === 'T5');
check('T5 有数据', t5 !== undefined);
check('T5 正确率 100%（两题都答对了）', t5?.accuracy === 1, String(t5?.accuracy));
const t3 = stats.find(p => p.point === 'T3');
// wrong 统计的是"历史错题总数"，不是"当前未攻克数"——
// 否则一旦把错题做对，这个考点的历史表现就被抹掉了，看不出它曾经薄弱。
check('T3 记录了历史错题', (t3?.wrong ?? 0) === 1, String(t3?.wrong));

// 错题会让该考点排到前面（正确率低优先）
check('正确率低的考点排在前面', stats[0].accuracy <= stats[stats.length - 1].accuracy);

// ---------- 8. store 行为 ----------
console.log('\n[8] store 行为');
const store = useGrammarStore.getState();
await store.reloadSettings();
check('store 读到设置', useGrammarStore.getState().settings.aiModel === 'deepseek-flash');

await store.refreshStats();
const st = useGrammarStore.getState();
check('store 题库统计已更新', st.bank.total === 5, String(st.bank.total));
check('store 考点统计已更新', st.pointStats.length > 0, String(st.pointStats.length));

// 无 Key，但本地题库里还有没做过的题 —— 应该照样能做题，不该因为没 Key 就拦人。
// 只有"本地题不够、必须调 API"时才需要 Key。
await useGrammarStore.getState().start(2);
const noKeyStart = useGrammarStore.getState();
check('本地有题时，没 Key 也能开始', noKeyStart.phase === 'quiz', noKeyStart.phase);
check('且不会报错', noKeyStart.error === null, JSON.stringify(noKeyStart.error));
check('确实取到了题', noKeyStart.items.length > 0, String(noKeyStart.items.length));
useGrammarStore.getState().reset();

// 本地题被耗尽后，没 Key 就必须报错
await db.questions.toCollection().modify({ unused: 0 });
await useGrammarStore.getState().start(3);
const exhausted = useGrammarStore.getState();
check('本地无题且无 Key -> 回到 idle', exhausted.phase === 'idle', exhausted.phase);
check('本地无题且无 Key -> 给出提示', exhausted.error !== null, JSON.stringify(exhausted.error));
check('提示指向设置页', (exhausted.error?.hint ?? '').includes('设置'), JSON.stringify(exhausted.error));

// 恢复：灌回几道题，继续测后续流程
console.log('\n[8.5] 恢复题库并跑完整会话');
const restored = await addQuestions([mkQ('T7', 10), mkQ('T7', 11)]);
check('恢复 2 道题', restored === 2, String(restored));

await updateSettings({ aiApiKey: 'sk-test-fake-key-for-local-bank' });
await useGrammarStore.getState().reloadSettings();
await useGrammarStore.getState().start(2);
const started = useGrammarStore.getState();
check('有本地题时进入 quiz', started.phase === 'quiz', started.phase);
check('取到 2 道题', started.items.length === 2, String(started.items.length));

// 作答 + 推进
const first = started.items[0].question;
const correct = await useGrammarStore.getState().answer(first.answer);
check('store 作答返回正确性', correct === true);
check('answers 被记录', useGrammarStore.getState().answers[0] === first.answer);
useGrammarStore.getState().next();
check('index 推进到 1', useGrammarStore.getState().index === 1);
useGrammarStore.getState().next();
check('做完后进入 summary', useGrammarStore.getState().phase === 'summary', useGrammarStore.getState().phase);

// ---------- 9. 清空题库 ----------
console.log('\n[9] 清空题库');
await clearQuestionBank();
const cleared = await getQuestionBankCount();
check('题库已清空', cleared.total === 0, String(cleared.total));
const mistakesSurvive = await getMistakes({ onlyOpen: false });
check('错题本不受影响', mistakesSurvive.length === 1, String(mistakesSurvive.length));

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
