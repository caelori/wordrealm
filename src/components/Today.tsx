import { useStore } from '../store/useStore';
import { useGrammarStore } from '../store/useGrammarStore';

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

export default function Today({ onOpenGrammar }: { onOpenGrammar?: () => void }) {
  const counts = useStore(s => s.counts);
  const todayStat = useStore(s => s.todayStat);
  const streak = useStore(s => s.streak);
  const settings = useStore(s => s.settings);
  const startSession = useStore(s => s.startSession);
  const saveSettings = useStore(s => s.saveSettings);

  const bank = useGrammarStore(s => s.bank);
  const grammarTotal = todayStat.grammarTotal ?? 0;
  const grammarCorrect = todayStat.grammarCorrect ?? 0;
  const grammarAcc =
    grammarTotal > 0 ? Math.round((grammarCorrect / grammarTotal) * 100) : null;

  const planned = Math.min(settings.dailyNewLimit, counts.newRemaining) + counts.due;
  // 进度 = 今天已做 / (已做 + 还剩)。分母随剩余量动态调整，
  // 这样评"忘记"导致队列变长时进度会诚实回退，而不是永远冲不到 100%。
  const doneToday = todayStat.newLearned + todayStat.reviewed;
  const pct = doneToday + planned > 0 ? Math.round((doneToday / (doneToday + planned)) * 100) : 0;

  const accuracy =
    todayStat.reviewed > 0
      ? Math.round(((todayStat.reviewed - todayStat.again) / todayStat.reviewed) * 100)
      : 0;

  const nothingToDo = counts.due === 0 && counts.newRemaining === 0;
  const emptyDb = counts.total === 0;

  return (
    <div className="pad center-col" style={{ gap: 16 }}>
      <div className="hero">
        <h1>
          {emptyDb
            ? '词库是空的'
            : nothingToDo
              ? '所有词都已进入复习循环'
              : counts.due > 0
                ? `今天有 ${counts.due} 个符文在震动`
                : '今天的复习已经清空'}
        </h1>
        <div className="small muted" style={{ lineHeight: 1.6 }}>
          {emptyDb ? (
            <>
              没能读到词库。请在项目目录执行 <b>npm run etl</b> 生成
              <b> src/data/seeds.json</b>，然后刷新页面。
            </>
          ) : nothingToDo ? (
            '今天没有待办，明天再来。'
          ) : (
            <>
              待复习 <b>{counts.due}</b> 个
              {' · '}
              新词 <b>{Math.min(settings.dailyNewLimit, counts.newRemaining)}</b> 个
              {counts.newRemaining > settings.dailyNewLimit && (
                <span className="faint">
                  （词库还剩 {counts.newRemaining} 个未学）
                </span>
              )}
            </>
          )}
        </div>

        {/* 0% 时那条空槽看着像界面坏了，所以今天没任务就直接不渲染 */}
        {(planned > 0 || doneToday > 0) && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="tiny faint" style={{ marginTop: 6 }}>
              今日已完成 {todayStat.reviewed} 次 · 新学 {todayStat.newLearned} 词
            </div>
          </>
        )}

        <div className="row gap12" style={{ marginTop: 18 }}>
          <button
            className="primary big"
            onClick={() => void startSession()}
            disabled={planned === 0 && todayStat.reviewed === 0}
          >
            {planned > 0 ? `开始学习（${planned}）` : '再练一轮'}
          </button>
          {planned === 0 && todayStat.reviewed > 0 && (
            <span className="small faint">今天的目标已完成 ✓</span>
          )}
        </div>
      </div>

      <div className="statgrid">
        <div className="stat accent">
          <div className="n">{streak}</div>
          <div className="k">连续天数</div>
        </div>
        <div className="stat">
          <div className="n">{counts.learned}</div>
          <div className="k">已学词数</div>
        </div>
        <div className="stat">
          <div className="n">{todayStat.reviewed}</div>
          <div className="k">今日次数</div>
        </div>
        <div className="stat">
          <div className="n">{todayStat.reviewed > 0 ? `${accuracy}%` : '—'}</div>
          <div className="k">今日正确率</div>
        </div>
      </div>

      <div className="statgrid">
        <div className="stat">
          <div className="n">{todayStat.newLearned}</div>
          <div className="k">今日新学</div>
        </div>
        <div className="stat">
          <div className="n">{todayStat.again}</div>
          <div className="k">忘记</div>
        </div>
        <div className="stat">
          <div className="n">{counts.total - counts.learned}</div>
          <div className="k">词库剩余</div>
        </div>
        <div className="stat">
          <div className="n">{fmtDuration(todayStat.durationMs)}</div>
          <div className="k">今日用时</div>
        </div>
      </div>

      {/* ---------- 语法题入口 ---------- */}
      <div className="hero" style={{ padding: 18 }}>
        <div className="row gap12">
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650 }}>语法练习</h2>
          <span className="spacer" />
          {grammarAcc !== null && (
            <span className="pill gold">今日正确率 {grammarAcc}%</span>
          )}
        </div>
        <div className="small muted" style={{ marginTop: 6, lineHeight: 1.65 }}>
          {bank.unseen > 0 ? (
            <>
              本地题库还有 <b>{bank.unseen}</b> 道没做过
              {bank.total > 0 && <span className="faint">（共 {bank.total} 道）</span>}
            </>
          ) : bank.total > 0 ? (
            '题库已做完，开始时会自动让 AI 生成新题'
          ) : (
            '题库是空的，第一次开始会让 AI 生成一批'
          )}
          {grammarTotal > 0 && (
            <>
              <br />
              今天已做 {grammarTotal} 道，对 {grammarCorrect} 道
            </>
          )}
        </div>
        <div className="row gap12" style={{ marginTop: 14 }}>
          <button className="primary" onClick={() => onOpenGrammar?.()}>
            去做语法题
          </button>
        </div>
      </div>

      <div className="hero" style={{ padding: 16 }}>
        <div className="row gap12">
          <span className="small" style={{ fontWeight: 600 }}>
            每日新词
          </span>
          <input
            type="range"
            min={5}
            max={50}
            step={5}
            value={settings.dailyNewLimit}
            style={{ flex: 1 }}
            onChange={e => void saveSettings({ dailyNewLimit: +e.target.value })}
          />
          <span className="small" style={{ width: 46, textAlign: 'right' }}>
            {settings.dailyNewLimit} 个
          </span>
        </div>
        <div className="tiny faint" style={{ marginTop: 8, lineHeight: 1.6 }}>
          共 {counts.total} 词 · 数据来源 ECDICT（MIT）· 全部离线存储在你的浏览器里
        </div>
      </div>
    </div>
  );
}
