/**
 * 语法出题 prompt。
 *
 * 设计要点（每一条都是为了让题目"可控"）：
 *
 * 1. **限定 12 个考点**。不限定的话题目没法按考点聚合错题，
 *    "薄弱点分析"这个 W4 的核心功能就无从谈起。
 *
 * 2. **空必须挖在功能词上**（冠词/介词/助动词/连接词/关系词/非谓语）。
 *    如果空里填的是实义词，题目就变成了词汇题而不是语法题。
 *
 * 3. **必须能"只看语法"选出答案**。如果做题人得先看懂整句意思才能选，
 *    那测的是阅读理解，不是语法。
 *
 * 4. **强制 trap 字段**。这是本设计里性价比最高的一个约束：
 *    模型必须先想清楚"学生为什么选错"，解析才有针对性。
 *    没有 trap 的解析只会说"正确答案是 B"。
 *
 * 5. **给模型一份"学习者已学单词表"**，要求干扰项也用这些词，
 *    避免出现生词导致"因为不认识单词而做错"。
 */

import { GRAMMAR_POINTS, type Difficulty, type GrammarPoint } from './types';

/** 允许挖空的语法位置与对应的考点提示 */
const BLANK_TYPES = [
  '动词形态（时态/语态/主谓一致）',
  '冠词或限定词（a / an / the / 零冠词 / some / any）',
  '介词（含固定搭配中的介词）',
  '连接词或连接副词（however / therefore / although ...）',
  '关系词（which / that / who / whose / where ...）',
  '非谓语形式（to do / doing / done）',
  '助动词或情态动词',
  '代词或反身代词',
  '比较结构或平行结构成分',
];

export interface PromptInput {
  points: GrammarPoint[];
  /** 学习者的已学单词，用来把词汇难度压到可控范围 */
  words: string[];
  count: number;
  difficulty: Difficulty;
  /** 避免重复：已出过的题干开头片段 */
  avoidStems?: string[];
}

const DIFFICULTY_HINT: Record<Difficulty, string> = {
  1: '基础：单句、结构清晰、干扰项差异明显。适合刚接触该考点的学习者。',
  2: '中等：句子稍长，可能含一个从句；干扰项要有迷惑性，但正解必须唯一且可判定。',
  3: '进阶：句中出现从句嵌套、插入语或较长修饰成分；干扰项必须体现真实的易混点。',
};

export function buildSystemPrompt(): string {
  return [
    '你是一位资深的英语语法出题老师，专门为中国学习者准备雅思/学术英语语法练习。',
    '',
    '你的任务：生成高质量的英语语法单选题。',
    '',
    '【硬性规则】',
    '1. 每题必须是"完形填空"形式：一个英文句子，其中**一个语法位置**用 ___ 代替。',
    `2. 挖空位置只能是以下语法成分之一：${BLANK_TYPES.join('；')}。`,
    '   **绝对不能把空挖在实义词（名词/动词原形/形容词）上**，否则就变成词汇题了。',
    '3. 必须做到"只看语法就能定答案"：做题人不需要理解整句含义也能选出唯一正解。',
    '4. 恰好 4 个选项，有且只有一个正确。干扰项必须是学生真实会犯的错，不能是明显荒谬的凑数项。',
    '5. 四个选项必须在语法范畴上可比（比如都是介词、都是动词形式），不能混搭。',
    '6. 正解必须唯一且无争议。如果某个干扰项在某种合理解读下也说得通，就换掉它。',
    '7. why 字段：用中文解释**语法依据**，说清句子结构，不要只说"这是固定搭配"。',
    '8. trap 字段：用中文说明学生**最可能误选哪个选项、以及为什么会那样想**。这一项必填且要具体。',
    '9. zh 字段：题干的中文翻译，帮助学习者确认自己理解对了句子。',
    '10. 干扰项和题干里的词汇要简单常见，不要用生僻词——这道题考的是语法，不是词汇量。',
    '11. 出冠词题时，如果要表达"零冠词"（此处不加任何冠词），**必须写成 ∅ 这个符号**，',
    '    不要留空字符串、也不要写 none。例如选项 ["a", "an", "the", "∅"]。',
    '',
    '【输出格式】',
    '只输出一个 JSON 对象，不要有任何解释文字、不要用 markdown 代码块。格式严格如下：',
    '{',
    '  "questions": [',
    '    {',
    '      "point": "T5",',
    '      "difficulty": 2,',
    '      "stem": "The report ___ by the committee was rejected.",',
    '      "options": ["writing", "written", "to write", "writes"],',
    '      "answer": 1,',
    '      "why": "此处需要过去分词作后置定语。report 与 write 之间是被动关系，因此用 written。",',
    '      "trap": "容易误选 A（writing），因为学生看到 by 就想用主动的现在分词，忽略了 report 是被写的。",',
    '      "zh": "委员会写的那份报告被否决了。"',
    '    }',
    '  ]',
    '}',
    '',
    '【字段约束】',
    `- point：必须是以下之一：${Object.keys(GRAMMAR_POINTS).join(' / ')}`,
    `- difficulty：1、2 或 3`,
    '- stem：英文句子，必须包含 ___（三个下划线）',
    '- options：恰好 4 个字符串',
    '- answer：0 到 3 的整数，指向 options 里的正解下标',
    '- why、trap、zh：非空中文字符串',
  ].join('\n');
}

export function buildUserPrompt(input: PromptInput): string {
  const { points, words, count, difficulty, avoidStems } = input;

  const pointLines = points
    .map(p => `- ${p}：${GRAMMAR_POINTS[p]}`)
    .join('\n');

  const wordSample = words.slice(0, 60);
  const wordLine =
    wordSample.length > 0
      ? `学习者最近学过的单词（鼓励在题干或干扰项里复用，但**不要为了用词而扭曲句子**）：\n${wordSample.join(', ')}`
      : '（暂无已学单词参考，请使用最常见的英语词汇）';

  const avoidLine =
    avoidStems && avoidStems.length > 0
      ? `\n以下句子结构已经出过，请**换个语境和句式**，不要重复：\n${avoidStems
          .slice(0, 12)
          .map(s => `- ${s}`)
          .join('\n')}`
      : '';

  return [
    `请生成 ${count} 道英语语法单选题。`,
    '',
    '【本次要覆盖的考点】**必须从下面的考点里选**，并在 point 字段标注实际考点：',
    pointLines,
    '',
    `【难度要求】${DIFFICULTY_HINT[difficulty]}`,
    '',
    wordLine,
    avoidLine,
    '',
    `请让 ${count} 道题尽量均匀分布在上述考点上。`,
    '再次强调：只输出 JSON，不要 markdown 代码块，不要任何额外说明。',
  ].join('\n');
}
