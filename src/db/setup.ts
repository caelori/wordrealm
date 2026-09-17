/**
 * 一次性配置引导。
 *
 * 用途：把 API 配置通过 URL 参数传进来，打开即自动填好，省去手输长 Key。
 * 用法：http://127.0.0.1:5180/?setup=<base64url(JSON)>
 *
 * ⚠️ 安全边界：
 *  - 只接受本机页面（hostname 为 localhost / 127.0.0.1），避免把 Key 带给外部站点
 *  - 读取后立刻用 history.replaceState 抹掉地址栏，不留在浏览器历史里
 *  - 只写进本地 IndexedDB，不发往任何第三方
 */

import { getSettings, updateSettings } from './db';
import type { Settings } from './types';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalPage(): boolean {
  if (typeof location === 'undefined') return false;
  return LOCAL_HOSTS.has(location.hostname);
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  // base64 里可能含中文，必须按 UTF-8 解，不能直接用 atob 的结果
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface SetupPayload {
  key?: string;
  baseUrl?: string;
  model?: string;
}

export interface SetupResult {
  applied: boolean;
  /** 实际写入了哪些字段 */
  fields: string[];
  error?: string;
}

/** 检查 URL 里有没有 setup 参数，有就应用并清理地址栏 */
export async function consumeSetupParam(): Promise<SetupResult> {
  const empty: SetupResult = { applied: false, fields: [] };
  if (typeof location === 'undefined') return empty;

  const raw = new URLSearchParams(location.search).get('setup');
  if (!raw) return empty;

  const cleanupUrl = () => {
    // 抹掉地址栏，避免 Key 留在历史记录/书签里
    try {
      const u = new URL(location.href);
      u.searchParams.delete('setup');
      const next = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : '') + u.hash;
      history.replaceState(null, '', next);
    } catch {
      /* 清理失败不影响功能 */
    }
  };

  if (!isLocalPage()) {
    cleanupUrl();
    return { applied: false, fields: [], error: '出于安全考虑，配置引导只在 localhost 下生效' };
  }

  let payload: SetupPayload;
  try {
    payload = JSON.parse(decodeBase64Url(raw)) as SetupPayload;
  } catch {
    cleanupUrl();
    return { applied: false, fields: [], error: 'setup 参数不是合法的 base64 JSON' };
  }

  const patch: Partial<Omit<Settings, 'id'>> = {};
  const fields: string[] = [];

  if (typeof payload.key === 'string' && payload.key.trim()) {
    patch.aiApiKey = payload.key.trim();
    fields.push('API Key');
  }
  if (typeof payload.baseUrl === 'string' && payload.baseUrl.trim()) {
    patch.aiBaseUrl = payload.baseUrl.trim();
    fields.push('接口地址');
  }
  if (typeof payload.model === 'string' && payload.model.trim()) {
    patch.aiModel = payload.model.trim();
    fields.push('模型名');
  }

  if (fields.length === 0) {
    cleanupUrl();
    return { applied: false, fields: [], error: 'setup 参数里没有可用的字段' };
  }

  // 确保 settings 行存在（首次打开时可能还没建）
  await getSettings();
  await updateSettings(patch);
  cleanupUrl();

  return { applied: true, fields };
}

/** 给设置页用的：把当前配置编码成一次性链接 */
export function buildSetupLink(origin: string, payload: SetupPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${origin}/?setup=${b64}`;
}
