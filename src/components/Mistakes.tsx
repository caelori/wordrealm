import { useEffect, useState } from 'react';
import { useGrammarStore } from '../store/useGrammarStore';
import { GRAMMAR_POINTS, type GrammarPoint } from '../systems/grammar/types';
import type { MistakeRecord } from '../db/types';

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function Mistakes() {
  const mistakes = useGrammarStore(s => s.mistakes);
  const pointStats = useGrammarStore(s => s.pointStats);
  const bank = useGrammarStore(s => s.bank);
  const loadMistakes = useGrammarStore(s => s.loadMistakes);
  const refreshStats = useGrammarStore(s => s.refreshStats);
  const start = useGrammarStore(s => s.start);
  const reset = useGrammarStore(s => s.reset);

  const [onlyOpen, setOnlyOpen] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    void loadMistakes(onlyOpen);
    void refreshStats();
  }, [onlyOpen, loadMistakes, refreshStats]);

  const openCount = mistakes.filter(m => m.resolvedCorrect !== true).length;
  const answered = pointStats.filter(p => p.total > 0);

  return (
    <div className="pad center-col" style={{ gap: 16 }}>
      <div className="hero" style={{ padding: 18 }}>
        <div className="row gap12">
          <h1 style={{ margin: 0, fontSize: 19 }}>错题本</h1>
          <span className="spacer" />
          <span className="pill">{openCount} 道未攻克</span>
        </div>
        <div className="small muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
          做错的题会自动收进来，下次出题时优先重做。
          <br />
          题库共 {bank.total} 道，其中 {bank.unseen} 道还没做过。
        </div>
        <div className="row gap12" style={{ marginTop: 14 }}>
          <button className="primary" onClick={() => void start()} disabled={bank.unseen === 0}>
            开始做题
          </button>
          <button className="ghost" onClick={() => void reset()}>
            返回今日
          </button>
        </div>
      </div>

      {answered.length > 0 && (
        <div className="hero" style={{ padding: 18 }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 10 }}>
            各考点掌握情况
          </div>
          <div className="pointlist">
            {answered.map(p => (
              <div className="pointrow" key={p.point}>
                <span className="pointname">{GRAMMAR_POINTS[p.point as GrammarPoint] ?? p.point}</span>
                <span className="pointbar">
                  <i
                    style={{
                      width: pct(p.accuracy),
                      background:
                        p.accuracy >= 0.8 ? '#2f7a4f' : p.accuracy >= 0.5 ? '#b07a1e' : '#a83232',
                    }}
                  />
                </span>
                <span className="pointpct" title={`错过 ${p.wrong} 次`}>
                  {pct(p.accuracy)}
                </span>
              </div>
            ))}
          </div>
          <div className="tiny faint" style={{ marginTop: 8, lineHeight: 1.6 }}>
            按正确率从低到高排。下一轮出题会优先覆盖靠前的考点。
          </div>
        </div>
      )}

      <div className="row gap12" style={{ paddingLeft: 2 }}>
        <label className="row gap8 small" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={e => setOnlyOpen(e.target.checked)}
          />
          只看还没攻克的
        </label>
        <span className="spacer" />
        <span className="tiny faint">共 {mistakes.length} 条</span>
      </div>

      {mistakes.length === 0 ? (
        <div className="hero" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted small">
            {onlyOpen ? '还没有未攻克的错题。' : '错题本是空的。'}
          </div>
        </div>
      ) : (
        <div className="mistakelist">
          {mistakes.map(m => (
            <MistakeCard
              key={m.id}
              m={m}
              expanded={expanded === m.id}
              onToggle={() => setExpanded(expanded === m.id ? null : (m.id ?? null))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MistakeCard({
  m,
  expanded,
  onToggle,
}: {
  m: MistakeRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const resolved = m.resolvedCorrect === true;

  // 防御性处理：错题记录理论上字段齐全，但数据可能来自旧版本、
  // 手动导入、或未来某个 bug。绝不能因为一条脏数据让整个页面白屏。
  const stem = typeof m.stem === 'string' ? m.stem : '';
  const options = Array.isArray(m.options) ? m.options : [];
  const optAt = (i: unknown) =>
    typeof i === 'number' && i >= 0 && i < options.length ? options[i] : undefined;
  const pretty = (v: string | undefined) =>
    v === undefined ? '—' : v === '∅' ? '（不加冠词）' : v;

  const picked = optAt(m.chosen);
  const correct = optAt(m.answer);
  const hasQuestion = stem.length > 0 && options.length > 0;

  return (
    <div className={`mistake ${resolved ? 'resolved' : ''}`}>
      <button className="mistakehead" onClick={onToggle}>
        <span className="tag">{m.point}</span>
        <span className="mistakestem">
          {hasQuestion ? stem.replace('___', `【${pretty(picked)}】`) : '（这条错题数据不完整）'}
        </span>
        <span className="spacer" />
        <span className={`mark ${resolved ? 'ok' : 'bad'}`}>{resolved ? '已攻克' : '未攻克'}</span>
        <span className="tiny faint">{expanded ? '收起' : '展开'}</span>
      </button>

      {expanded && (
        <div className="mistakebody">
          {!hasQuestion && (
            <div className="small" style={{ color: 'var(--again)', marginBottom: 8 }}>
              这条错题缺少题干或选项数据，无法展开重做。可以忽略它，不影响其他题目。
            </div>
          )}
          <div className="small" style={{ marginBottom: 6 }}>
            <b>你选了：</b>
            <span style={{ color: 'var(--again)' }}>{pretty(picked)}</span>
          </div>
          <div className="small" style={{ marginBottom: 8 }}>
            <b>正确答案：</b>
            <span style={{ color: 'var(--good)' }}>{pretty(correct)}</span>
          </div>
          {m.why && (
            <div className="small" style={{ lineHeight: 1.75, marginBottom: 5 }}>
              <b>为什么：</b>
              {m.why}
            </div>
          )}
          {m.trap && (
            <div className="small" style={{ lineHeight: 1.75 }}>
              <b>易错点：</b>
              {m.trap}
            </div>
          )}
          {m.zh && (
            <div className="tiny faint" style={{ marginTop: 6, lineHeight: 1.7 }}>
              句意：{m.zh}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
