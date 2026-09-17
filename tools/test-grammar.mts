/**
 * 语法题解析层测试。
 * 用真实 LLM 会返回的各种脏格式来打这一层，确认它不会崩、也不会放进坏题。
 *
 * 用法: npx vite-node tools/test-grammar.mts
 */
import {
  extractJsonCandidates,
  makeQuestionId,
  pickQuestionArray,
  repairJson,
  tryParseJson,
  validateQuestion,
  validateQuestions,
} from '../src/systems/grammar/parse';
import { GRAMMAR_POINT_KEYS, isGrammarPoint } from '../src/systems/grammar/types';
import { buildSystemPrompt, buildUserPrompt } from '../src/systems/grammar/prompt';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}${extra ? '  [' + extra + ']' : ''}`);
    failures++;
  }
}

const GOOD_Q = {
  point: 'T5',
  difficulty: 2,
  stem: 'The report ___ by the committee was rejected.',
  options: ['writing', 'written', 'to write', 'writes'],
  answer: 1,
  why: '此处需要过去分词作后置定语，report 与 write 是被动关系。',
  trap: '容易误选 writing，看到 by 就以为要用主动的现在分词。',
  zh: '委员会写的那份报告被否决了。',
};

// ---------- 1. 考点枚举 ----------
console.log('\n[1] 考点枚举');
check('共 12 个考点', GRAMMAR_POINT_KEYS.length === 12, String(GRAMMAR_POINT_KEYS.length));
check('T1 合法', isGrammarPoint('T1'));
check('T13 非法', !isGrammarPoint('T13'));
check('数字非法', !isGrammarPoint(13));
check('null 非法', !isGrammarPoint(null));

// ---------- 2. JSON 抽取：真实脏格式 ----------
console.log('\n[2] JSON 抽取容错');
const cases: [string, string][] = [
  ['裸 JSON', '{"questions":[]}'],
  ['markdown 围栏', '```json\n{"questions":[]}\n```'],
  ['无语言标记围栏', '```\n{"questions":[]}\n```'],
  ['前后有解释文字', '好的，这是题目：\n{"questions":[]}\n希望对你有帮助！'],
  ['尾随逗号', '{"questions":[],}'],
  ['对象内尾随逗号', '{"questions":[{"a":1,},],}'],
  ['全角引号', '{\u201cquestions\u201d:[]}'],
  ['裸数组', '[{"stem":"x"}]'],
  ['嵌在文字里的数组', '结果如下 [{"stem":"x"}] 以上。'],
];
for (const [name, text] of cases) {
  const parsed = tryParseJson(text);
  check(`能解析：${name}`, parsed !== null, JSON.stringify(parsed));
}

check('纯文本返回 null', tryParseJson('对不起，我不能完成这个请求。') === null);
check('空字符串返回 null', tryParseJson('') === null);
check('截断的 JSON 返回 null', tryParseJson('{"questions":[{"stem":"a"') === null);

// ---------- 3. 题目数组提取 ----------
console.log('\n[3] 题目数组提取');
check('questions 键', pickQuestionArray({ questions: [1, 2] }).length === 2);
check('data 键', pickQuestionArray({ data: [1] }).length === 1);
check('裸数组', pickQuestionArray([1, 2, 3]).length === 3);
check('找不到返回空数组', pickQuestionArray({ foo: 1 }).length === 0);
check('null 返回空数组', pickQuestionArray(null).length === 0);

// ---------- 4. 修复函数 ----------
console.log('\n[4] JSON 修复');
check('去尾随逗号', repairJson('{"a":1,}') === '{"a":1}');
check('全角转半角', repairJson('{\u201ca\u201d:1}') === '{"a":1}');
check('保留中文内容', repairJson('{"a":"中文，测试"}').includes('中文，测试'));

// ---------- 5. 单题校验：合法 ----------
console.log('\n[5] 单题校验（应通过）');
const v1 = validateQuestion(GOOD_Q);
check('合法题目通过', v1.question !== null, v1.reason);
check('id 未生成（由调用方生成）', v1.question !== null && !('id' in v1.question));
check('难度解析正确', v1.question?.difficulty === 2, String(v1.question?.difficulty));
check('答案下标正确', v1.question?.answer === 1, String(v1.question?.answer));
check('zh 被保留', v1.question?.zh === GOOD_Q.zh);

// answer 用字符串 "1" 也应接受
const vStr = validateQuestion({ ...GOOD_Q, answer: '1' } as never);
check('answer 为字符串 "1" 也能接受', vStr.question?.answer === 1, vStr.reason);

// ---------- 6. 单题校验：各种非法 ----------
console.log('\n[6] 单题校验（应拒绝）');
const badCases: [string, Record<string, unknown>][] = [
  ['缺题干', { ...GOOD_Q, stem: '' }],
  ['题干没下划线', { ...GOOD_Q, stem: 'The report by the committee was rejected.' }],
  ['题干过短', { ...GOOD_Q, stem: 'a ___ b' }],
  ['缺选项', { ...GOOD_Q, options: undefined }],
  ['选项只有 3 个', { ...GOOD_Q, options: ['a', 'b', 'c'] }],
  ['选项有 5 个', { ...GOOD_Q, options: ['a', 'b', 'c', 'd', 'e'] }],
  ['选项重复', { ...GOOD_Q, options: ['same', 'same', 'c', 'd'] }],
  ['选项过长', { ...GOOD_Q, options: ['x'.repeat(80), 'b', 'c', 'd'] }],
  ['答案越界', { ...GOOD_Q, answer: 7 }],
  ['答案为负', { ...GOOD_Q, answer: -1 }],
  ['答案非数字', { ...GOOD_Q, answer: 'B' }],
  ['缺解析', { ...GOOD_Q, why: '' }],
  ['解析过短', { ...GOOD_Q, why: '选B' }],
  ['缺错因', { ...GOOD_Q, trap: '' }],
  ['考点非法且无默认值', { ...GOOD_Q, point: 'T99' }],
];
for (const [name, raw] of badCases) {
  const r = validateQuestion(raw as never);
  check(`拒绝：${name}`, r.question === null, r.question ? '竟然通过了' : `原因=${r.reason}`);
}

// 考点非法但有默认值时应该回退
const fallback = validateQuestion({ ...GOOD_Q, point: 'T99' } as never, { point: 'T7' });
check('考点非法 -> 回退到默认值', fallback.question?.point === 'T7', fallback.reason);

// 难度非法但有默认值
const difFallback = validateQuestion({ ...GOOD_Q, difficulty: 9 } as never, { difficulty: 3 });
check('难度非法 -> 回退到默认值', difFallback.question?.difficulty === 3);

// ---------- 7. 批量校验与去重 ----------
console.log('\n[7] 批量校验');
const batch = validateQuestions([
  GOOD_Q,
  { ...GOOD_Q }, // 题干重复
  { ...GOOD_Q, stem: 'She ___ to school every day.', options: ['go', 'goes', 'going', 'gone'], answer: 1 },
  { ...GOOD_Q, stem: '' }, // 非法
] as never);
check('通过 2 道', batch.ok.length === 2, String(batch.ok.length));
check('丢弃 2 道', batch.dropped.length === 2, JSON.stringify(batch.dropped));
check('重复题干被识别', batch.dropped.some(d => d.reason === '题干重复'), JSON.stringify(batch.dropped));
check('空题干被识别', batch.dropped.some(d => d.reason === '缺少题干'));

// 下划线数量不一的都应被规整成 ___
const under = validateQuestion({ ...GOOD_Q, stem: 'The report _____ by the committee was rejected.' } as never);
check('多余下划线被规整为 ___', under.question?.stem.includes('___') === true && !under.question?.stem.includes('____'));

// 零冠词：空字符串 / 各种写法都应被规整成 ∅，而不是导致整题被丢弃
console.log('\n[7.5] 零冠词（实测模型会返回空字符串）');
for (const form of ['', '∅', 'none', '__', '-']) {
  const r = validateQuestion({
    point: 'T3',
    difficulty: 1,
    stem: 'She goes to ___ school every day.',
    options: ['a', 'an', form, 'the'],
    answer: 2,
    why: 'go to school 表示去上学，是固定搭配，不加冠词。',
    trap: '容易选 the，因为中文里会说"去那个学校"。',
  } as never);
  check(`零冠词写法 ${JSON.stringify(form)} 被接受`, r.question !== null, r.reason);
  check(`  且被规整为 ∅`, r.question?.options[2] === '∅', r.question?.options[2]);
}

// ---------- 8. id 生成 ----------
console.log('\n[8] 题目 id');
const id1 = makeQuestionId('T5', 0);
const id2 = makeQuestionId('T5', 1);
check('id 带考点前缀', id1.startsWith('t5-'), id1);
check('两次生成不重复', id1 !== id2);

// ---------- 9. prompt 完整性 ----------
console.log('\n[9] prompt');
const sys = buildSystemPrompt();
check('system 含 12 个考点', GRAMMAR_POINT_KEYS.every(p => sys.includes(p)), '缺考点');
check('system 要求只输出 JSON', sys.includes('只输出一个 JSON 对象'));
check('system 要求 trap 必填', sys.includes('trap') && sys.includes('必填'));
check('system 禁止实义词挖空', sys.includes('绝对不能把空挖在实义词'));
check('system 含输出示例', sys.includes('"questions"'));

const user = buildUserPrompt({
  points: ['T5', 'T3'],
  words: ['perceive', 'rural'],
  count: 8,
  difficulty: 2,
  avoidStems: ['The report ___ by the committee'],
});
check('user 含考点说明', user.includes('非谓语动词') && user.includes('冠词'));
check('user 含题量', user.includes('8 道'));
check('user 含单词表', user.includes('perceive'));
check('user 含避重提示', user.includes('已经出过'));
check('user 含难度说明', user.includes('中等'));

const userNoWords = buildUserPrompt({ points: ['T1'], words: [], count: 3, difficulty: 1 });
check('无单词表时降级提示', userNoWords.includes('暂无已学单词'));

// ---------- 10. 真实模型响应模拟 ----------
console.log('\n[10] 端到端：模拟一次带 markdown 围栏的真实响应');
const fakeResponse = [
  '好的，我为你生成了以下题目：',
  '```json',
  JSON.stringify({
    questions: [
      GOOD_Q,
      {
        point: 'T3',
        difficulty: 1,
        stem: 'She is ___ honest student.',
        options: ['a', 'an', 'the', '∅'],
        answer: 1,
        why: 'honest 的 h 不发音，首音是元音，所以用 an。',
        trap: '容易选 a，因为看到辅音字母 h 就以为要用 a。',
        zh: '她是个诚实的学生。',
      },
    ],
  }),
  '```',
  '需要更多题目可以继续告诉我。',
].join('\n');

const parsed = tryParseJson(fakeResponse);
const arr = pickQuestionArray(parsed);
const final = validateQuestions(arr as never);
check('能从围栏+闲聊里解出 2 道题', final.ok.length === 2, `实得 ${final.ok.length}`);
check('考点被正确识别', final.ok.every(q => isGrammarPoint(q.point)));
check('没有丢弃', final.dropped.length === 0, JSON.stringify(final.dropped));

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
