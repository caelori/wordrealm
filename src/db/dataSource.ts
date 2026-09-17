import type { SeedsFile } from './types';

/**
 * 词库种子数据的加载入口。
 *
 * ⚠️ 这里踩过一个只在生产环境暴露的坑，改动前请先读完：
 *
 * 最初用的是 `import(url, { with: { type: 'json' } })`。开发环境好好的，
 * 但打包后 Vite 把 import attribute 剥掉了，浏览器按「普通模块脚本」去加载
 * 一个 application/json 文件，触发严格 MIME 检查：
 *   "Expected a JavaScript-or-Wasm module script but the server responded
 *    with a MIME type of application/json"
 * 结果是线上直接报「Failed to fetch dynamically imported module」，应用起不来。
 *
 * 所以现在统一用 fetch —— 开发和生产走**同一条代码路径**，
 * 不会再出现"dev 正常、线上白屏"这类差异。
 *
 * 词库位置：public/data/seeds.json（由 tools/etl.mjs 生成，作为静态资源提供）
 */

declare global {
  // eslint-disable-next-line no-var
  var __WORDREALM_SEEDS__: SeedsFile | undefined;
}

let loaded: SeedsFile | null = null;

export async function loadSeeds(): Promise<SeedsFile> {
  if (loaded) return loaded;

  // 测试脚本会预先注入，省去起服务器
  const injected = globalThis.__WORDREALM_SEEDS__;
  if (injected) {
    loaded = injected;
    return loaded;
  }

  // BASE_URL 保证部署到 GitHub Pages 子目录时也能取对
  const { asset } = await import('../systems/assets');
  const url = asset('data/seeds.json');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载词库失败（HTTP ${res.status}）：${url}`);
  loaded = (await res.json()) as SeedsFile;
  return loaded;
}
