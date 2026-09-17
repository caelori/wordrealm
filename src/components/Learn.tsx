import { useEffect, useMemo, useRef } from 'react';
import { Rating } from 'ts-fsrs';
import { useStore } from '../store/useStore';
import { RATING_BUTTONS, humanInterval, review, retrievability } from '../systems/fsrs';
import { speak } from '../systems/tts';

const FORM_LABELS: Record<string, string> = {
  past: '过去式',
  pp: '过去分词',
  ing: '现在分词',
  s: '三单',
  plural: '复数',
  comp: '比较级',
  sup: '最高级',
};

const TAG_LABELS: Record<string, string> = {
  zk: '中考',
  gk: '高考',
  cet4: '四级',
  cet6: '六级',
  ky: '考研',
  ielts: '雅思',
  toefl: '托福',
  gre: 'GRE',
};

export default function Learn() {
  const session = useStore(s => s.session);
  const sessionIndex = useStore(s => s.sessionIndex);
  const settings = useStore(s => s.settings);
  const rate = useStore(s => s.rate);
  const backToToday = useStore(s => s.backToToday);

  const entry = session[sessionIndex];
  const busyRef = useRef(false);

  const card = entry?.card;

  // 进度：已答过的不同卡 / 会话总卡数
  const progress = useMemo(() => {
    const total = session.length;
    const done = Math.min(sessionIndex, total);
    return { done, total };
  }, [session.length, sessionIndex]);

  // 切卡时自动朗读
  useEffect(() => {
    if (!card) return;
    busyRef.current = false;
    const t = setTimeout(() => {
      speak(card.word, { accent: settings.accent, rate: settings.speechRate });
    }, 90);
    return () => clearTimeout(t);
  }, [card, settings.accent, settings.speechRate]);

  // 键盘：1/2/3 评分，空格重播
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (card) speak(card.word, { accent: settings.accent, rate: settings.speechRate });
        return;
      }
      const hit = RATING_BUTTONS.find(b => b.hotkey === e.key);
      if (hit) {
        e.preventDefault();
        void doRate(hit.rating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, settings.accent, settings.speechRate, sessionIndex]);

  async function doRate(rating: Rating) {
    if (busyRef.current || !card) return;
    busyRef.current = true;
    await rate(rating);
  }

  if (!card) {
    return (
      <div className="bootbox">
        <div className="muted">这一轮结束了</div>
        <button className="primary" onClick={() => void backToToday()}>
          回到今日
        </button>
      </div>
    );
  }

  const senses = card.cn.slice(0, settings.maxSenses);
  const forms = Object.entries(card.ex?.forms ?? {}).filter(([k]) => FORM_LABELS[k]);
  const lem = card.ex?.lemma;
  const isNew = card.status === 'new' || card.fsrs.reps === 0;
  const retriev =
    isNew ? 0 : Math.round(retrievability(card.fsrs, new Date(), settings.requestRetention) * 100);

  return (
    <div className="center-col">
      <div className="learnhead">
        <span className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {progress.done} / {progress.total}
        </span>
        <div className="bar">
          <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
        </div>
        {entry.requeued && <span className="requeue-badge">重来</span>}
        <button className="ghost small" onClick={() => void backToToday()}>
          退出
        </button>
      </div>

      <div className="cardwrap">
        <div className="wordcard" key={`${card.word}-${sessionIndex}`}>
          <div>
            <span
              className="theword"
              onClick={() =>
                speak(card.word, { accent: settings.accent, rate: settings.speechRate })
              }
              title="点击朗读"
            >
              {card.word}
              <span className="speakicon">🔊</span>
            </span>
            {card.pos && <span className="posbadge">{card.pos}</span>}
          </div>

          <div className="senses">
            {senses.map((s, i) => (
              <div className="sense" key={i}>
                {senses.length > 1 && <span className="num">{i + 1}</span>}
                {s}
              </div>
            ))}
            {card.cn.length > senses.length && (
              <div className="tiny faint">
                还有 {card.cn.length - senses.length} 个义项（设置里可调显示数量）
              </div>
            )}
          </div>

          {(forms.length > 0 || lem) && (
            <>
              <div className="divider" />
              <div className="exform">
                {lem && (
                  <>
                    原形 <b>{lem}</b>
                    {'　'}
                  </>
                )}
                {forms.map(([k, v]) => (
                  <span key={k} style={{ marginRight: 12 }}>
                    {FORM_LABELS[k]} <b>{v}</b>
                  </span>
                ))}
              </div>
            </>
          )}

          <div className="divider" />
          <div className="meta">
            {card.tags.map(t => (
              <span className="tag" key={t}>
                {TAG_LABELS[t] ?? t}
              </span>
            ))}
            <span className="tag">词频 #{card.frq}</span>
            {card.col > 0 && <span className="tag">柯林斯 {'★'.repeat(card.col)}</span>}
            {!isNew && <span className="tag">记忆强度 {retriev}%</span>}
          </div>
        </div>
      </div>

      <div className="ratebar">
        {RATING_BUTTONS.map(b => {
          const { intervalDays } = review(
            card.fsrs,
            b.rating,
            new Date(),
            settings.requestRetention,
          );
          return (
            <button
              key={b.hotkey}
              className={`ratebtn ${b.tone}`}
              onClick={() => void doRate(b.rating)}
            >
              <span>{b.label}</span>
              <span className="hint">
                {b.hint} · {humanInterval(intervalDays)}
              </span>
              <span className="key">按 {b.hotkey}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
