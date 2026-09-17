import { useStore } from '../store/useStore';

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export default function Done() {
  const todayStat = useStore(s => s.todayStat);
  const counts = useStore(s => s.counts);
  const streak = useStore(s => s.streak);
  const backToToday = useStore(s => s.backToToday);
  const startSession = useStore(s => s.startSession);

  const accuracy =
    todayStat.reviewed > 0
      ? Math.round(((todayStat.reviewed - todayStat.again) / todayStat.reviewed) * 100)
      : 0;

  const stillDue = counts.due;

  return (
    <div className="donebox">
      <div className="empty-art">
        <img className="mascot mascot-lg" src="/art/cheer.png" alt="" />
      </div>
      <h2>这一轮结束了</h2>

      <div className="small muted" style={{ lineHeight: 1.8, maxWidth: 380 }}>
        本轮共复习 <b>{todayStat.reviewed}</b> 次，
        其中新学 <b>{todayStat.newLearned}</b> 词，
        正确率 <b>{accuracy}%</b>，
        用时 <b>{fmtDuration(todayStat.durationMs)}</b>。
        <br />
        连续打卡 <b>{streak}</b> 天。
      </div>

      <div className="statgrid" style={{ width: '100%', maxWidth: 420 }}>
        <div className="stat">
          <div className="n">{todayStat.again}</div>
          <div className="k">忘记</div>
        </div>
        <div className="stat">
          <div className="n">{todayStat.hard}</div>
          <div className="k">模糊</div>
        </div>
        <div className="stat">
          <div className="n">{todayStat.good + todayStat.easy}</div>
          <div className="k">记得</div>
        </div>
        <div className="stat accent">
          <div className="n">{counts.learned}</div>
          <div className="k">累计已学</div>
        </div>
      </div>

      <div className="row gap12">
        <button className="primary big" onClick={() => void backToToday()}>
          回到今日
        </button>
        {(stillDue > 0 || counts.newRemaining > 0) && (
          <button className="big" onClick={() => void startSession()}>
            再来一轮
          </button>
        )}
      </div>

      {stillDue === 0 && counts.newRemaining > 0 && (
        <div className="tiny faint" style={{ maxWidth: 340, lineHeight: 1.6 }}>
          今日新词额度已用完。想多学的话，在设置里调高每日新词数。
        </div>
      )}
    </div>
  );
}

