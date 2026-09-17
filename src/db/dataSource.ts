import { asset } from '../systems/assets';
import type { SeedsFile } from './types';

/**
 * 词库种子数据的加载入口。
 *
 * ⚠️ 这个文件踩过两次只在生产/移动端暴露的坑，改动前请先读完：
 *
 * 1. 最初用 `import(url, { with: { type: 'json' } })`。开发环境好好的，
 *    但打包后 Vite 把 import attribute 剥掉了，浏览器按「普通模块脚本」
 *    加载 application/json，触发严格 MIME 校验而失败，线上直接白屏。
 *    → 改为 fetch，开发和生产走同一条代码路径。
 *
 * 2. iPhone 上出现「加载词库失败（HTTP 504）」。那是 Service Worker
 *    在网络不可用且没缓存时返回的兜底响应。
 *    → 现在会识别离线响应并自动重试（带 cache-busting），
 *      失败时给出面向用户的提示，而不是抛一个 HTTP 状态码。
 *
 * 词库位置：public/data/seeds.json（由 tools/etl.mjs 生成，作为静态资源提供）
 */

declare global {
  // eslint-disable-next-line no-var
  var __WORDREALM_SEEDS__: SeedsFile | undefined;
}

let loaded: SeedsFile | null = null;

/** 判断返回的是不是 Service Worker 的离线兜底，而不是真正的词库 */
function isOfflineStub(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    '__offline' in (data as Record<string, unknown>) &&
    !Array.isArray((data as { words?: unknown }).words)
  );
}

async function fetchSeedsOnce(url: string, bust: boolean): Promise<Response | null> {
  const target = bust ? `${url}${url.includes('?') ? '&' : '?'}_r=${Date.now()}` : url;
  try {
    return await fetch(target, bust ? { cache: 'reload' } : undefined);
  } catch {
    return null;
  }
}

export async function loadSeeds(): Promise<SeedsFile> {
  if (loaded) return loaded;

  // 测试脚本会预先注入，省去起服务器
  const injected = globalThis.__WORDREALM_SEEDS__;
  if (injected) {
    loaded = injected;
    return loaded;
  }

  const url = asset('data/seeds.json');

  // 第一次正常取；失败则绕开 HTTP 缓存重试一次。
  // 手机上网络刚恢复时，第一次请求经常是坏的，重试基本都能成。
  for (const bust of [false, true]) {
    const res = await fetchSeedsOnce(url, bust);
    if (!res || !res.ok) continue;

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // 拿到的不是 JSON（可能是 SW 的错误页），重试
      continue;
    }

    if (isOfflineStub(data)) continue;
    const seeds = data as SeedsFile;
    if (!Array.isArray(seeds.words) || seeds.words.length === 0) continue;

    loaded = seeds;
    return loaded;
  }

  // 两次都失败：给用户看得懂的提示，而不是 HTTP 状态码
  throw new Error(
    '词库没能加载。如果正在离线或网络不稳定，请连上网后点「重试」；' +
      '若反复失败，在设置里清空缓存后重新打开。',
  );
}

/** 供设置页显示用：词库是否已加载、多少个词 */
export function seedsLoadedCount(): number | null {
  return loaded ? loaded.words.length : null;
}
