import { useEffect, useRef, useState } from 'react';
import { useGrammarStore } from '../store/useGrammarStore';
import { GRAMMAR_POINTS } from '../systems/grammar/types';
import { speak } from '../systems/tts';
import { ART } from '../systems/assets';

const DIFF_LABEL: Record<number, string> = { 1: '基础', 2: '中等', 3: '进阶' };

/** 把题干按 ___ 切成前后两段，好让空位有视觉强调 */
function splitStem(stem: string): [string, string] {
  const i = stem.indexOf('___');
  if (i < 0) return [stem, ''];
  return [stem.slice(0, i), stem.slice(i + 3)];
}

export default function Grammar() {
  const phase = useGrammarStore(s => s.phase);
  const items = useGrammarStore(s => s.items);
  const index = useGrammarStore(s => s.index);
  const answers = useGrammarStore(s => s.answers);
  const progressText = useGrammarStore(s => s.progressText);
  const error = useGrammarStore(s => s.error);
  const bank = useGrammarStore(s => s.bank);
  const settings = useGrammarStore(s => s.settings);

  const start = useGrammarStore(s => s.start);
  const answer = useGrammarStore(s => s.answer);
  const next = useGrammarStore(s => s.next);
  const reset = useGrammarStore(s => s.reset);
  const refreshStats = useGrammarStore(s => s.refreshStats);
  const reloadSettings = useGrammarStore(s => s.reloadSettings);

  const [chosen, setChosen] = useState<number | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    void reloadSettings();
    void refreshStats();
  }, [reloadSettings, refreshStats]);

  const item = items[index];
  const answered = chosen !== null;
  const isCorrect = answered && item && chosen === item.question.answer;

  // 换题时重置作答状态
  useEffect(() => {
    setChosen(null);
    busyRef.current = false;
  }, [index]);

  async function pick(i: number) {
    if (chosen !== null || !item) return;
    setChosen(i);
    await answer(i);
  }

  function goNext() {
    next();
    setChosen(null);
  }

  // 键盘：1-4 选择，回车/空格下一题
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (chosen === null && item) {
        const n = Number(e.key);
        if (n >= 1 && n <= item.question.options.length) {
          e.preventDefault();
          void pick(n - 1);
          return;
        }
      }
      if (chosen !== null && (e.key === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, item, index]);

  // ---------- 未配置 Key ----------
  if (!settings.aiApiKey) {
    return (
      <div className="bootbox">
        <div className="empty-art">
          <img className="mascot mascot-md" src={ART.reading()} alt="" />
        </div>
        <h2 style={{ margin: 0, fontSize: 19 }}>还没配置 AI</h2>
        <div className="small muted" style={{ maxWidth: 420, lineHeight: 1.8, textAlign: 'left' }}>
          语法题由 AI 现场生成，需要先填一个 API Key。
          <br />
          <br />
          · 支持 <b>DeepSeek</b> 及任何 OpenAI 兼容接口
          <br />
          · Key 只保存在你这台机器的浏览器里，不会上传到别处
          <br />· 出题是<b>批量预生成</b>的，一次调用能出 20 道，成本很低
        </div>
        <div className="tiny faint">打开右上角「⚙ 设置 → AI 语法题」填入 Key</div>
      </div>
    );
  }

  // ---------- 加载中 ----------
  if (phase === 'loading') {
    return (
      <div className="bootbox">
        <div className="empty-art">
          <img className="mascot mascot-md" src={ART.reading()} alt="" />
        </div>
        <div style={{ fontWeight: 700 }}>{progressText || '正在准备题目…'}</div>
        <div className="tiny faint" style={{ maxWidth: 360, lineHeight: 1.7 }}>
          首次出题需要等模型响应，大约十几秒。
          <br />
          生成后会存进本地题库，之后做题是瞬时的。
        </div>
      </div>
    );
  }

  // ---------- 出错 ----------
  if (error && phase === 'idle') {
    return (
      <div className="bootbox">
        <div className="doneglyph">⚠</div>
        <h2 style={{ margin: 0, fontSize: 18 }}>{error.title}</h2>
        <div
          className="small muted"
          style={{ maxWidth: 420, lineHeight: 1.7, whiteSpace: 'pre-wrap', textAlign: 'left' }}
        >
          {error.hint}
        </div>
        <div className="row gap8">
          <button className="primary big" onClick={() => void start()}>
            重试
          </button>
          <button className="big" onClick={() => reset()}>
            返回
          </button>
        </div>
      </div>
    );
  }

  // ---------- 小结 ----------
  if (phase === 'summary') {
    const total = answers.filter(a => a !== undefined).length;
    const correct = items.filter((it, i) => answers[i] === it.question.answer).length;
    const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
    const wrongItems = items.filter((it, i) => answers[i] !== it.question.answer);

    return (
      <div className="donebox">
        <div className="empty-art">
          <img
            className="mascot mascot-lg"
            src={acc >= 60 ? '/art/cheer.png' : '/art/reading.png'}
            alt=""
          />
        </div>
        <h2>这一轮做完了</h2>
        <div className="small muted" style={{ lineHeight: 1.8 }}>
          共 {total} 题，答对 <b>{correct}</b> 题，正确率 <b>{acc}%</b>
        </div>

        {wrongItems.length > 0 && (
          <div style={{ width: '100%', maxWidth: 480, textAlign: 'left' }}>
            <div className="divider" />
            <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>
              这轮做错的 {wrongItems.length} 题
            </div>
            {wrongItems.slice(0, 5).map((it, i) => (
              <div key={i} className="small" style={{ marginBottom: 8, lineHeight: 1.6 }}>
                <span className="tag" style={{ marginRight: 6 }}>
                  {it.question.point}
                </span>
                {it.question.stem.replace('___', `【${it.question.options[it.question.answer]}】`)}
              </div>
            ))}
            <div className="tiny faint" style={{ marginTop: 10 }}>
              已收进错题本，下次会自动重做。
            </div>
          </div>
        )}

        <div className="row gap12">
          <button className="primary big" onClick={() => void start()}>
            再来一轮
          </button>
          <button className="big" onClick={() => reset()}>
            返回
          </button>
        </div>
      </div>
    );
  }

  // ---------- 待开始 ----------
  if (phase === 'idle' || !item) {
    return (
      <div className="bootbox">
        <div className="empty-art">
          <img className="mascot mascot-md" src={ART.reading()} alt="" />
        </div>
        <h2 style={{ margin: 0, fontSize: 19 }}>语法练习</h2>
        <div className="small muted" style={{ lineHeight: 1.9, textAlign: 'left', maxWidth: 400 }}>
          题库：<b>{bank.unseen}</b> 道未做 / 共 {bank.total} 道
          <br />
          每轮 <b>{settings.dailyGrammarCount}</b> 道 · 难度{' '}
          <b>{DIFF_LABEL[settings.grammarDifficulty]}</b>
          <br />
          考点覆盖 12 类（时态、冠词、非谓语、从句……）
        </div>
        {bank.unseen < 3 && (
          <div className="tiny faint" style={{ maxWidth: 360, lineHeight: 1.7 }}>
            题库快空了，开始时会自动让 AI 生成一批新题。
          </div>
        )}
        <button className="primary big" onClick={() => void start()}>
          开始做题
        </button>
      </div>
    );
  }

  // ---------- 做题 ----------
  const q = item.question;
  const [before, after] = splitStem(q.stem);

  return (
    <div className="center-col">
      <div className="learnhead">
        <span className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {index + 1} / {items.length}
        </span>
        <div className="bar">
          <i style={{ width: `${(index / Math.max(1, items.length)) * 100}%` }} />
        </div>
        <span className="pill">{q.point}</span>
        <span className="pill">{DIFF_LABEL[q.difficulty]}</span>
        <button className="ghost small" onClick={() => reset()}>
          退出
        </button>
      </div>

      <div className="cardwrap">
        <div className="wordcard" key={`${q.id}-${index}`}>
          <div className="tiny faint" style={{ marginBottom: 10 }}>
            {GRAMMAR_POINTS[q.point]}
            {item.previousWrong !== undefined && (
              <span className="requeue-badge" style={{ marginLeft: 8 }}>
                错题重做
              </span>
            )}
          </div>

          <div className="quizstem">
            {before}
            <span className={`blank ${answered ? (isCorrect ? 'ok' : 'bad') : ''}`}>
              {answered ? q.options[chosen!] : '___'}
            </span>
            {after}
            <button
              className="ghost tiny speakbtn"
              onClick={() => speak(q.stem.replace('___', q.options[q.answer]), { accent: settings.accent })}
              title="朗读完整句子"
            >
              🔊
            </button>
          </div>

          <div className="divider" />

          <div className="options">
            {q.options.map((opt, i) => {
              const isAnswer = i === q.answer;
              const isPicked = i === chosen;
              let cls = 'opt';
              if (answered) {
                if (isAnswer) cls += ' correct';
                else if (isPicked) cls += ' wrong';
                else cls += ' dim';
              }
              return (
                <button key={i} className={cls} onClick={() => void pick(i)} disabled={answered}>
                  <span className="optkey">{i + 1}</span>
                  <span className="opttext">{opt === '∅' ? '（不加冠词）' : opt}</span>
                  {answered && isAnswer && <span className="optmark">✓</span>}
                  {answered && isPicked && !isAnswer && <span className="optmark">✕</span>}
                </button>
              );
            })}
          </div>

          {answered && (
            <div className={`feedback ${isCorrect ? 'ok' : 'bad'}`}>
              <div className="fbline">
                <b>{isCorrect ? '对了' : '错了'}</b>
                {!isCorrect && (
                  <span className="small">
                    {' '}
                    正确答案是 {q.options[q.answer] === '∅' ? '（不加冠词）' : q.options[q.answer]}
                  </span>
                )}
              </div>
              <div className="small" style={{ marginTop: 6, lineHeight: 1.75 }}>
                <b>为什么：</b>
                {q.why}
              </div>
              <div className="small" style={{ marginTop: 5, lineHeight: 1.75 }}>
                <b>易错点：</b>
                {q.trap}
              </div>
              {q.zh && (
                <div className="tiny faint" style={{ marginTop: 6, lineHeight: 1.7 }}>
                  句意：{q.zh}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '0 26px 26px' }}>
        {answered ? (
          <button className="primary big" style={{ width: '100%' }} onClick={goNext}>
            {index + 1 >= items.length ? '完成' : '下一题'}
            <span className="tiny" style={{ opacity: 0.75, marginLeft: 8 }}>
              回车
            </span>
          </button>
        ) : (
          <div className="tiny faint" style={{ textAlign: 'center' }}>
            按 1–4 选择答案
          </div>
        )}
      </div>
    </div>
  );
}
