import { useEffect, useRef, useState } from 'react';
import {
  backupFilename,
  downloadJson,
  exportBackup,
  fmtBytes,
  getStorageInfo,
  importBackup,
  requestPersistence,
  type StorageInfo,
} from '../db/backup';

/**
 * 数据与备份。
 *
 * 这一块不是可选项：iOS Safari 会清理本地存储，
 * 而学习进度是攒出来的——被清掉等于白学。所以必须有导出/导入。
 */
export default function DataPanel({ onDataChanged }: { onDataChanged?: () => void }) {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [includeKey, setIncludeKey] = useState(false);
  const [replaceOnImport, setReplaceOnImport] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => void getStorageInfo().then(setInfo);
  useEffect(refresh, []);

  async function doExport() {
    setBusy('export');
    setMsg(null);
    try {
      const backup = await exportBackup(includeKey);
      const text = JSON.stringify(backup);
      const name = backupFilename();

      // iOS Safari 对 <a download> 支持不完整，所以两条路都给：
      // 先尝试下载，同时把内容放进剪贴板作为兜底
      downloadJson(text, name);

      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        /* 剪贴板可能被拒（非用户手势 / 权限），忽略 */
      }

      setMsg({
        ok: true,
        text:
          `已导出备份：${backup.counts.cards} 个词、${backup.counts.mistakes} 条错题、` +
          `${backup.counts.questions} 道题（共 ${fmtBytes(text.length)}）。\n` +
          (copied
            ? '内容也已复制到剪贴板——如果 iPhone 上没弹出保存对话框，可以直接粘贴到「备忘录」里存着。'
            : 'iPhone 上如果没弹出保存对话框，请用下面的「粘贴导入」反向操作，或换到电脑上导出。'),
      });
    } catch (e) {
      setMsg({ ok: false, text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy('');
    }
  }

  async function doImportFromText(text: string, label: string) {
    setBusy('import');
    setMsg(null);
    try {
      const r = await importBackup(text, { replace: replaceOnImport });
      if (!r.ok) {
        setMsg({ ok: false, text: `导入失败：${r.error}` });
        return;
      }
      setMsg({
        ok: true,
        text:
          `已从${label}导入：${r.counts?.cards ?? 0} 个词、` +
          `${r.counts?.mistakes ?? 0} 条错题、${r.counts?.questions ?? 0} 道题。\n` +
          (replaceOnImport
            ? '⚠️ 使用了「覆盖」模式，原有数据已被替换。'
            : '已存在的词保留了本地进度（不会被旧备份覆盖）。') +
          '\n刷新页面即可看到最新数据。',
      });
      refresh();
      onDataChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: `导入失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy('');
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => void doImportFromText(String(reader.result ?? ''), `文件 ${f.name}`);
    reader.onerror = () => setMsg({ ok: false, text: '读取文件失败' });
    reader.readAsText(f);
    e.target.value = '';
  }

  const usedPct =
    info && info.quota > 0 ? Math.min(100, Math.round((info.usage / info.quota) * 100)) : 0;

  return (
    <>
      <div className="section-title">数据与备份</div>

      <div className="field">
        <label>本机存储</label>
        <div className="small muted" style={{ lineHeight: 1.75 }}>
          {info === null ? (
            '正在读取…'
          ) : info.supported ? (
            <>
              已用 <b>{fmtBytes(info.usage)}</b>
              {info.quota > 0 && (
                <>
                  {' / '}
                  配额 {fmtBytes(info.quota)}
                  <span className="faint">（{usedPct}%）</span>
                </>
              )}
              <br />
              持久化状态：
              {info.persisted ? (
                <span style={{ color: 'var(--good)' }}>已开启，不会被自动清理</span>
              ) : (
                <span style={{ color: '#d18b1f' }}>未开启，浏览器可能在空间紧张时清理</span>
              )}
            </>
          ) : (
            '当前浏览器不支持存储用量查询'
          )}
        </div>

        {info && info.supported && !info.persisted && (
          <button
            className="small"
            style={{ marginTop: 8 }}
            disabled={busy !== ''}
            onClick={async () => {
              const ok = await requestPersistence();
              setMsg(
                ok
                  ? { ok: true, text: '已获得持久化存储授权。' }
                  : {
                      ok: false,
                      text:
                        '浏览器没有授予持久化权限。这不影响使用，但请定期用下面的「导出备份」。',
                    },
              );
              refresh();
            }}
          >
            申请持久化存储
          </button>
        )}
      </div>

      <div className="field">
        <label>导出备份</label>
        <div className="row gap8" style={{ flexWrap: 'wrap' }}>
          <button onClick={() => void doExport()} disabled={busy !== ''}>
            {busy === 'export' ? '导出中…' : '导出 JSON'}
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={busy !== ''}>
            {busy === 'import' ? '导入中…' : '从文件导入'}
          </button>
          <button className="ghost small" onClick={() => setShowPaste(v => !v)}>
            {showPaste ? '收起粘贴导入' : '粘贴导入'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
        <div className="desc">
          备份包含：学习进度、复习记录、语法题库、错题本。
          <br />
          <b>建议每隔一段时间导出一次</b>——尤其换设备或清理浏览器数据之前。
        </div>
      </div>

      {showPaste && (
        <div className="field">
          <label>粘贴备份内容</label>
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder='把导出的 JSON 粘贴到这里，然后点下面的「导入」'
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 110,
              fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
              fontSize: 12,
              padding: '9px 11px',
              borderRadius: 10,
              border: '1px solid var(--line-strong)',
              background: 'var(--card-2)',
              color: 'var(--ink)',
              resize: 'vertical',
            }}
          />
          <button
            className="primary small"
            style={{ marginTop: 8 }}
            disabled={busy !== '' || pasteText.trim().length < 10}
            onClick={() => void doImportFromText(pasteText, '粘贴内容')}
          >
            导入
          </button>
          <div className="desc">
            iPhone 上如果导出没弹出保存对话框，可以改用这条路径：
            在电脑上导出的 JSON 复制过来粘贴，或者直接粘贴之前存到备忘录里的内容。
          </div>
        </div>
      )}

      <div className="field">
        <label className="row gap8" style={{ cursor: 'pointer', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={includeKey}
            onChange={e => setIncludeKey(e.target.checked)}
          />
          <span className="small">备份里包含 API Key</span>
        </label>
        <div className="desc" style={{ color: includeKey ? '#d18b1f' : undefined }}>
          {includeKey
            ? '⚠️ 备份文件里会含明文密钥。只在你自己保管的文件里这样做，不要分享给别人。'
            : '默认不含 API Key，备份文件即使被别人拿到也安全。'}
        </div>
      </div>

      <div className="field">
        <label className="row gap8" style={{ cursor: 'pointer', fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={replaceOnImport}
            onChange={e => setReplaceOnImport(e.target.checked)}
          />
          <span className="small">导入时覆盖原有数据</span>
        </label>
        <div className="desc" style={{ color: replaceOnImport ? '#c25050' : undefined }}>
          {replaceOnImport
            ? '⚠️ 会先清空本机所有学习记录再导入。只在换设备、想把新设备变成旧设备的副本时用。'
            : '默认「补齐」：已存在的词保留本机进度，只补缺失的部分。'}
        </div>
      </div>

      {msg && (
        <div className={`testresult ${msg.ok ? 'ok' : 'bad'}`} style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </div>
      )}
    </>
  );
}
