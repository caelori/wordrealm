import { useEffect, useState } from 'react';
import { useStore } from './store/useStore';
import { useGrammarStore } from './store/useGrammarStore';
import Today from './components/Today';
import Learn from './components/Learn';
import Done from './components/Done';
import Settings from './components/Settings';
import Grammar from './components/Grammar';
import Mistakes from './components/Mistakes';
import ErrorBoundary from './components/ErrorBoundary';
import { ttsSupported } from './systems/tts';
import { consumeSetupParam } from './db/setup';

type Tab = 'today' | 'grammar' | 'mistakes';

const TAB_LABEL: Record<Tab, string> = {
  today: '今日',
  grammar: '语法',
  mistakes: '错题本',
};

export default function App() {
  const phase = useStore(s => s.phase);
  const boot = useStore(s => s.boot);
  const seedProgress = useStore(s => s.seedProgress);
  const error = useStore(s => s.error);
  const reloadWordSettings = useStore(s => s.bootSettingsOnly);
  const refreshStats = useGrammarStore(s => s.refreshStats);
  const reloadGrammarSettings = useGrammarStore(s => s.reloadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<Tab>('today');
  const [setupNote, setSetupNote] = useState<string | null>(null);

  useEffect(() => {
    void boot();
  }, [boot]);

  // 一次性配置引导：?setup=<base64url> 打开即自动填好 API 配置
  useEffect(() => {
    void (async () => {
      const r = await consumeSetupParam();
      if (!r.applied && !r.error) return;
      if (r.applied) {
        await Promise.all([reloadGrammarSettings(), reloadWordSettings()]);
        setSetupNote(`已自动填入：${r.fields.join('、')}。可以去「语法」标签开始做题了。`);
      } else {
        setSetupNote(`配置引导失败：${r.error}`);
      }
    })();
  }, [reloadGrammarSettings, reloadWordSettings]);

  // 引导完成后拉一次语法题/错题统计
  useEffect(() => {
    if (phase === 'today') void refreshStats();
  }, [phase, refreshStats]);

  // 单词学习进行中时隐藏导航，避免误点丢掉本轮进度
  const inWordSession = phase === 'learn';

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">
          <span className="brand-avatar-wrap">
            <img className="brand-avatar" src="/art/avatar.png" alt="" />
          </span>
          词域<span className="en">Wordrealm</span>
        </span>

        {!inWordSession && phase === 'today' && (
          <nav className="navtabs">
            {(Object.keys(TAB_LABEL) as Tab[]).map(t => (
              <button
                key={t}
                className={`navtab ${tab === t ? 'active' : ''}`}
                onClick={() => setTab(t)}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </nav>
        )}

        <span className="spacer" />
        {!ttsSupported && (
          <span className="pill" title="浏览器不支持语音合成，发音功能不可用">
            发音不可用
          </span>
        )}
        <button
          className="ghost"
          onClick={() => setShowSettings(true)}
          title="设置"
          disabled={phase === 'boot' || phase === 'seeding' || phase === 'error'}
        >
          ⚙ 设置
        </button>
      </div>

      {phase === 'boot' && (
        <div className="bootbox">
          <div className="empty-art">
            <img className="mascot mascot-md" src="/art/reading.png" alt="" />
          </div>
          <div className="muted">正在唤醒词域…</div>
        </div>
      )}

      {phase === 'seeding' && (
        <div className="bootbox">
          <div className="empty-art">
            <img className="mascot mascot-md" src="/art/reading.png" alt="" />
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>首次导入词库</div>
            <div className="small muted">
              {seedProgress && seedProgress.total > 0
                ? `${seedProgress.done} / ${seedProgress.total}`
                : '正在读取 ECDICT 数据…'}
            </div>
          </div>
          <div className="small faint" style={{ maxWidth: 320, lineHeight: 1.7 }}>
            只做一次，之后所有数据都存在本地浏览器里，不再需要联网。
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="bootbox">
          <div className="doneglyph">⚠</div>
          <h2 style={{ margin: 0, fontSize: 19 }}>打不开本地数据库</h2>
          <div
            className="small muted"
            style={{ maxWidth: 420, lineHeight: 1.75, textAlign: 'left' }}
          >
            这个应用把全部数据存在浏览器的 <b>IndexedDB</b> 里，而现在它没有响应。
            <br />
            <br />
            常见原因：
            <br />
            · 用了<b>无痕 / 隐私模式</b>（IndexedDB 常被禁用）
            <br />
            · 浏览器设置了<b>禁止站点存储数据</b>
            <br />
            · 无头 / 自动化浏览器环境
            <br />
            <br />
            换一个普通窗口打开即可。
          </div>
          <div
            className="tiny faint"
            style={{
              maxWidth: 420,
              fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
              wordBreak: 'break-word',
              lineHeight: 1.6,
            }}
          >
            {error}
          </div>
          <button className="primary big" onClick={() => void boot()}>
            重试
          </button>
        </div>
      )}

      {inWordSession && (
        <ErrorBoundary label="单词学习">
          <Learn />
        </ErrorBoundary>
      )}

      {/* phase 为 done 时展示本轮小结，Done 组件自带「回到今日」 */}
      {phase === 'done' && (
        <ErrorBoundary label="本轮小结">
          <Done />
        </ErrorBoundary>
      )}

      {phase === 'today' && (
        <>
          {setupNote && (
            <div className="hero" style={{ margin: '14px 26px 0', padding: 14 }}>
              <div className="row gap12">
                <span className="small" style={{ lineHeight: 1.6 }}>
                  {setupNote}
                </span>
                <span className="spacer" />
                <button className="ghost small" onClick={() => setSetupNote(null)}>
                  知道了
                </button>
              </div>
            </div>
          )}
          {tab === 'today' && (
            <ErrorBoundary label="今日">
              <Today onOpenGrammar={() => setTab('grammar')} />
            </ErrorBoundary>
          )}
          {tab === 'grammar' && (
            <ErrorBoundary label="语法练习">
              <Grammar />
            </ErrorBoundary>
          )}
          {tab === 'mistakes' && (
            <ErrorBoundary label="错题本">
              <Mistakes />
            </ErrorBoundary>
          )}
        </>
      )}

      {showSettings && (
        <ErrorBoundary label="设置">
          <Settings onClose={() => setShowSettings(false)} />
        </ErrorBoundary>
      )}
    </div>
  );
}
