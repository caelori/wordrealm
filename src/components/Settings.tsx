import { useState } from 'react';
import { useStore } from '../store/useStore';
import { useGrammarStore } from '../store/useGrammarStore';
import { listEnglishVoices, speak } from '../systems/tts';
import {
  AiError,
  DEFAULT_AI_CONFIG,
  listModels,
  testConnection,
} from '../systems/grammar/provider';
import { clearQuestionBank } from '../db/db';
import DataPanel from './DataPanel';
import { BUILD_ID } from '../systems/assets';

export default function Settings({ onClose }: { onClose: () => void }) {
  // 两个 store 读的是同一行 settings，但各自持有一份响应式副本，
  // 所以任何一处保存后都要让两边都重新加载，否则界面会不同步。
  const settings = useStore(s => s.settings);
  const saveSettings = useStore(s => s.saveSettings);
  const reloadWordSettings = useStore(s => s.bootSettingsOnly);
  const counts = useStore(s => s.counts);

  const saveAi = useGrammarStore(s => s.saveAi);
  const reloadGrammarSettings = useGrammarStore(s => s.reloadSettings);
  const refreshGrammarStats = useGrammarStore(s => s.refreshStats);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const voices = listEnglishVoices();

  /** 保存任意设置并让两个 store 同步 */
  async function saveAll(patch: Parameters<typeof saveAi>[0]) {
    await saveAi(patch);
    await Promise.all([reloadGrammarSettings(), reloadWordSettings()]);
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testConnection({
        apiKey: settings.aiApiKey,
        baseUrl: settings.aiBaseUrl,
        model: settings.aiModel,
        timeoutMs: settings.aiTimeoutMs,
      });
      if (r.ok) {
        setTestResult({ ok: true, text: `连接成功（模型 ${r.model}）\n样例题目：${r.sample}` });
      } else {
        setTestResult({ ok: false, text: describe(r.error) });
      }
    } finally {
      setTesting(false);
    }
  }

  async function fetchModels() {
    setLoadingModels(true);
    setTestResult(null);
    try {
      const list = await listModels({
        apiKey: settings.aiApiKey,
        baseUrl: settings.aiBaseUrl,
        timeoutMs: settings.aiTimeoutMs,
      });
      setModels(list);
      setTestResult({ ok: true, text: `可用模型：${list.join('、') || '（返回为空）'}` });
    } catch (e) {
      setTestResult({
        ok: false,
        text: e instanceof AiError ? describe(e) : e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <div className="drawer-back" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>设置</h3>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        {/* ---------------- AI 语法题 ---------------- */}
        <div className="section-title">AI 语法题</div>

        <div className="field">
          <label>API Key</label>
          <div className="row gap8">
            <input
              type={showKey ? 'text' : 'password'}
              value={settings.aiApiKey}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              onChange={e => void saveAll({ aiApiKey: e.target.value })}
            />
            <button className="ghost small" onClick={() => setShowKey(v => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <div className="desc">
            只保存在本机浏览器的 IndexedDB 里，不会上传到任何第三方。
            <br />
            DeepSeek 的 Key 在 platform.deepseek.com 申请。
          </div>
        </div>

        <div className="field">
          <label>接口地址</label>
          <input
            type="text"
            value={settings.aiBaseUrl}
            placeholder={DEFAULT_AI_CONFIG.baseUrl}
            spellCheck={false}
            onChange={e => void saveAll({ aiBaseUrl: e.target.value })}
          />
          <div className="desc">
            任何 OpenAI 兼容接口都行（DeepSeek / 硅基流动 / OpenRouter / 本地 Ollama）。
          </div>
        </div>

        <div className="field">
          <label>模型名</label>
          <input
            type="text"
            value={settings.aiModel}
            placeholder={DEFAULT_AI_CONFIG.model}
            spellCheck={false}
            onChange={e => void saveAll({ aiModel: e.target.value })}
          />
          <div className="desc">
            DeepSeek 调整过模型名，所以做成可填。也可以点下面的「获取模型列表」自动读取。
          </div>
        </div>

        <div className="row gap8" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <button onClick={() => void runTest()} disabled={testing || !settings.aiApiKey}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button onClick={() => void fetchModels()} disabled={loadingModels || !settings.aiApiKey}>
            {loadingModels ? '获取中…' : '获取模型列表'}
          </button>
        </div>

        {models.length > 0 && (
          <div className="field">
            <label>点选切换模型</label>
            <div className="row gap8" style={{ flexWrap: 'wrap' }}>
              {models.map(m => (
                <button
                  key={m}
                  className={settings.aiModel === m ? 'primary small' : 'small'}
                  onClick={() => void saveAll({ aiModel: m })}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}

        {testResult && (
          <div className={`testresult ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.text}</div>
        )}

        <div className="field" style={{ marginTop: 16 }}>
          <label>每轮题量：{settings.dailyGrammarCount} 道</label>
          <input
            type="range"
            min={5}
            max={30}
            step={5}
            value={settings.dailyGrammarCount}
            onChange={e => void saveAll({ dailyGrammarCount: +e.target.value })}
          />
          <div className="desc">
            题库是批量预生成的：一次调用生成 20 道存到本地，之后做题零延迟、可离线。
          </div>
        </div>

        <div className="field">
          <label>出题难度</label>
          <select
            value={settings.grammarDifficulty}
            onChange={e => void saveAll({ grammarDifficulty: +e.target.value as 1 | 2 | 3 })}
          >
            <option value={1}>基础 —— 单句、结构清晰</option>
            <option value={2}>中等 —— 含一个从句，干扰项有迷惑性</option>
            <option value={3}>进阶 —— 从句嵌套、插入语、易混点</option>
          </select>
        </div>

        <div className="field">
          <label>请求超时：{Math.round(settings.aiTimeoutMs / 1000)} 秒</label>
          <input
            type="range"
            min={30}
            max={180}
            step={10}
            value={settings.aiTimeoutMs / 1000}
            onChange={e => void saveAll({ aiTimeoutMs: +e.target.value * 1000 })}
          />
          <div className="desc">模型响应慢时调大。超时不会丢已生成的题。</div>
        </div>

        <div className="field">
          <button
            className="ghost small"
            onClick={async () => {
              if (!confirm('清空本地题库？已生成的题目会全部删除，错题本不受影响。')) return;
              await clearQuestionBank();
              await refreshGrammarStats();
              setTestResult({ ok: true, text: '题库已清空，下次做题会重新生成。' });
            }}
          >
            清空题库
          </button>
          <div className="desc">调整了难度或 prompt 后，想重新出题时用。</div>
        </div>

        {/* ---------------- 背单词 ---------------- */}
        <div className="section-title">背单词</div>

        <div className="field">
          <label>每日新词上限：{settings.dailyNewLimit} 个</label>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={settings.dailyNewLimit}
            onChange={e => void saveSettings({ dailyNewLimit: +e.target.value })}
          />
          <div className="desc">
            建议 10–20。<b>这是每日新增额度，不是总量。</b>
            新词会挤占复习时间，调太高会让第二天的复习量爆炸。
          </div>
        </div>

        <div className="field">
          <label>每日复习上限（0 = 不限）</label>
          <input
            type="number"
            min={0}
            step={10}
            value={settings.dailyReviewLimit}
            onChange={e => void saveSettings({ dailyReviewLimit: Math.max(0, +e.target.value) })}
          />
          <div className="desc">积压太多时用它限流，避免打开就被劝退。</div>
        </div>

        <div className="field">
          <label>卡片显示义项数：{settings.maxSenses}</label>
          <input
            type="range"
            min={1}
            max={8}
            value={settings.maxSenses}
            onChange={e => void saveSettings({ maxSenses: +e.target.value })}
          />
          <div className="desc">ECDICT 的释义是词典式的，一次显示太多反而记不住。</div>
        </div>

        <div className="field">
          <label>目标记忆保持率：{Math.round(settings.requestRetention * 100)}%</label>
          <input
            type="range"
            min={0.7}
            max={0.97}
            step={0.01}
            value={settings.requestRetention}
            onChange={e => void saveSettings({ requestRetention: +e.target.value })}
          />
          <div className="desc">
            FSRS 的核心参数。调高 → 记得更牢但复习更多；90% 是公认的性价比平衡点。
          </div>
        </div>

        <div className="field">
          <label>发音口音</label>
          <select
            value={settings.accent}
            onChange={e => void saveSettings({ accent: e.target.value as 'en-US' | 'en-GB' })}
          >
            <option value="en-US">美音 en-US</option>
            <option value="en-GB">英音 en-GB</option>
          </select>
        </div>

        <div className="field">
          <label>语速：{settings.speechRate.toFixed(1)}x</label>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.1}
            value={settings.speechRate}
            onChange={e => void saveSettings({ speechRate: +e.target.value })}
          />
          <div className="desc">
            共检测到 {voices.length} 个英文语音
            {voices.length === 0 && '（系统未安装英文语音包，发音可能不生效）'}
          </div>
        </div>

        <div className="row gap8" style={{ marginTop: 6 }}>
          <button
            onClick={() => speak('perceive', { accent: settings.accent, rate: settings.speechRate })}
          >
            🔊 试听
          </button>
        </div>

        {/* ---------------- 数据与备份 ---------------- */}
        <DataPanel
          onDataChanged={async () => {
            await Promise.all([reloadGrammarSettings(), reloadWordSettings(), refreshGrammarStats()]);
          }}
        />

        <div className="divider" />

        <div className="tiny faint" style={{ lineHeight: 1.7 }}>
          词库：{counts.total} 词 · 已学 {counts.learned} 词
          <br />
          数据：ECDICT（MIT License, © Linwei）
          <br />
          本应用全部数据离线存储在你的浏览器 IndexedDB 中，不上传任何信息。
          <br />
          <span style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
            构建版本 {BUILD_ID}
          </span>
          <br />
          <span>
            排查问题时请核对这一行——手机上常见的毛病是缓存停在旧版本，
            本地怎么测都正常。
          </span>
        </div>
      </div>
    </div>
  );
}

function describe(e: AiError): string {
  switch (e.kind) {
    case 'no-key':
      return '还没有填 API Key';
    case 'auth':
      return `API Key 被拒绝\n检查 Key 是否正确、是否过期、以及账户余额。\n${e.detail ?? ''}`;
    case 'rate-limit':
      return '请求太频繁，等十几秒再试';
    case 'timeout':
      return `请求超时\n模型响应慢。可以重试，或把超时时间调大。\n${e.detail ?? ''}`;
    case 'network':
      return `网络不通\n${e.detail ?? '检查网络连接。'}`;
    case 'server':
      return `模型服务出错\n${e.detail ?? '稍后重试。'}`;
    case 'bad-json':
      return `返回内容无法解析\n${e.detail ?? ''}`;
    case 'no-valid-questions':
      return `生成的题目都没通过校验\n${e.detail ?? ''}`;
    default:
      return `${e.message}\n${e.detail ?? ''}`;
  }
}
