/**
 * 数据持久化与备份。
 *
 * ⚠️ 为什么这个模块是必须的，而不是"锦上添花"：
 * iOS Safari 对本地存储有激进的清理策略——网站如果一段时间不被访问，
 * IndexedDB 可能被系统清空。对一个"每天攒学习记录"的应用来说，
 * 数据被清掉等于几个月的进度全没了。所以必须提供：
 *   1. 主动申请持久化存储（persist），降低被清理的概率
 *   2. 手动导出/导入备份，作为最后一道保险
 *   3. 界面上的用量提示，让用户知道数据在哪、有多大
 */

import { db } from './db';
import type { Settings } from './types';

/** 备份文件的格式版本。以后改结构时递增，导入时好做兼容。 */
export const BACKUP_FORMAT = 'wordrealm-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** 各表的记录数，导入前用于核对 */
  counts: Record<string, number>;
  data: {
    cards: unknown[];
    reviews: unknown[];
    dailyStats: unknown[];
    questions: unknown[];
    mistakes: unknown[];
    settings: unknown[];
  };
}

// ---------------------------------------------------------------- 持久化

export interface StorageInfo {
  /** 是否支持 Storage API */
  supported: boolean;
  /** 当前是否是"持久化"状态（不会被自动清理） */
  persisted: boolean;
  /** 已用字节 */
  usage: number;
  /** 配额字节 */
  quota: number;
}

/** 查询当前存储状态 */
export async function getStorageInfo(): Promise<StorageInfo> {
  const out: StorageInfo = { supported: false, persisted: false, usage: 0, quota: 0 };
  if (typeof navigator === 'undefined' || !navigator.storage) return out;
  out.supported = true;
  try {
    if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      out.usage = est.usage ?? 0;
      out.quota = est.quota ?? 0;
    }
  } catch {
    /* 某些浏览器会抛，忽略即可 */
  }
  return out;
}

/**
 * 申请持久化存储。
 * 注意各浏览器行为不同：Chrome 会弹权限提示或按"参与度"自动授予；
 * iOS Safari 通常直接返回 true 但不保证——所以**不能只靠它**，
 * 备份功能仍然必须有。
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 备份

/** 导出全部数据。默认剔除 API Key，避免备份文件泄露密钥。 */
export async function exportBackup(includeApiKey = false): Promise<BackupFile> {
  const [cards, reviews, dailyStats, questions, mistakes, settingsRows] = await Promise.all([
    db.cards.toArray(),
    db.reviews.toArray(),
    db.dailyStats.toArray(),
    db.questions.toArray(),
    db.mistakes.toArray(),
    db.settings.toArray(),
  ]);

  const settings = settingsRows.map(s => {
    if (includeApiKey) return s;
    const { aiApiKey: _drop, ...rest } = s as Settings;
    return { ...rest, aiApiKey: '' };
  });

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      cards: cards.length,
      reviews: reviews.length,
      dailyStats: dailyStats.length,
      questions: questions.length,
      mistakes: mistakes.length,
    },
    data: { cards, reviews, dailyStats, questions, mistakes, settings },
  };
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  counts?: Record<string, number>;
  /** 覆盖模式：设置为 true 时清空原有数据 */
  replaced?: boolean;
}

function isBackup(x: unknown): x is BackupFile {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return o.format === BACKUP_FORMAT && typeof o.version === 'number' && !!o.data;
}

/**
 * 导入备份。
 * 默认用"补齐"而不是"覆盖"：已存在的卡片保留本地进度
 * （本地进度一定比备份新，覆盖会让人白学）。
 */
export async function importBackup(
  raw: string,
  opts: { replace?: boolean } = {},
): Promise<ImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' };
  }

  if (!isBackup(parsed)) {
    return { ok: false, error: '这不是词域的备份文件（缺少 format 标记）' };
  }
  if (parsed.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `备份版本 ${parsed.version} 比当前应用支持的 ${BACKUP_VERSION} 新，请先更新应用`,
    };
  }

  const d = parsed.data;
  const counts = {
    cards: Array.isArray(d.cards) ? d.cards.length : 0,
    reviews: Array.isArray(d.reviews) ? d.reviews.length : 0,
    dailyStats: Array.isArray(d.dailyStats) ? d.dailyStats.length : 0,
    questions: Array.isArray(d.questions) ? d.questions.length : 0,
    mistakes: Array.isArray(d.mistakes) ? d.mistakes.length : 0,
  };

  try {
    await db.transaction(
      'rw',
      [db.cards, db.reviews, db.dailyStats, db.questions, db.mistakes, db.settings],
      async () => {
        if (opts.replace) {
          await Promise.all([
            db.cards.clear(),
            db.reviews.clear(),
            db.dailyStats.clear(),
            db.questions.clear(),
            db.mistakes.clear(),
          ]);
        }

        // bulkPut：主键冲突时"已存在的不动"用 bulkAdd 会抛错，
        // 所以要用 bulkPut + 先读已存在的主键来跳过
        if (counts.cards) {
          const have = new Set(await db.cards.toCollection().primaryKeys());
          const add = (d.cards as { id: string }[]).filter(c => c && !have.has(c.id));
          if (add.length) await db.cards.bulkPut(add as never);
        }
        if (counts.questions) {
          const have = new Set(await db.questions.toCollection().primaryKeys());
          const add = (d.questions as { id: string }[]).filter(q => q && !have.has(q.id));
          if (add.length) await db.questions.bulkPut(add as never);
        }

        // 这几张表用自增主键，直接追加即可
        if (counts.mistakes) await db.mistakes.bulkAdd(d.mistakes as never);
        if (counts.reviews) await db.reviews.bulkAdd(d.reviews as never);

        // 每日统计按日期合并：取较大的计数，避免把已有进度冲小
        if (counts.dailyStats) {
          for (const row of d.dailyStats as Record<string, number>[]) {
            const cur = await db.dailyStats.get(String(row.date));
            if (!cur) await db.dailyStats.put(row as never);
            else {
              await db.dailyStats.put({
                ...cur,
                newLearned: Math.max(cur.newLearned, row.newLearned ?? 0),
                reviewed: Math.max(cur.reviewed, row.reviewed ?? 0),
                grammarTotal: Math.max(cur.grammarTotal ?? 0, row.grammarTotal ?? 0),
                grammarCorrect: Math.max(cur.grammarCorrect ?? 0, row.grammarCorrect ?? 0),
              });
            }
          }
        }

        // 设置：只补空字段，不覆盖已有值（尤其不能覆盖刚填的 API Key）
        if (Array.isArray(d.settings) && d.settings.length > 0) {
          const cur = await db.settings.get('app');
          const inc = d.settings[0] as Record<string, unknown>;
          if (!cur) await db.settings.put(inc as never);
          else {
            const curRec = cur as unknown as Record<string, unknown>;
            const incRec = inc as Record<string, unknown>;
            const merged: Record<string, unknown> = { ...curRec };
            for (const [k, v] of Object.entries(incRec)) {
              const existing = curRec[k];
              // 只在本地为空/未设置时采用备份里的值（不能覆盖刚填的 API Key）
              if (existing === '' || existing === undefined || existing === null) merged[k] = v;
            }
            await db.settings.put(merged as never);
          }
        }
      },
    );
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }

  return { ok: true, counts, replaced: opts.replace };
}

/** 生成备份文件名，带日期便于区分 */
export function backupFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `wordrealm-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/**
 * 触发下载。
 * iOS Safari 对 <a download> 的支持不完整，所以调用方要同时提供
 * "复制到剪贴板"作为兜底路径。
 */
export function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 人类可读的体积 */
export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
