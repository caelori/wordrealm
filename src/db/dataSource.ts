import type { SeedsFile } from './types';

/**
 * 词库种子数据的加载入口。
 *
 * 为什么要单独抽一个文件：
 *  - 浏览器侧用 Vite 的 import attributes 直接吃 JSON（静态打包）
 *  - Node 侧（测试脚本）会通过 globalThis.__WORDREALM_SEEDS__ 预注入，
 *    因为 Node 的模块系统不会解析 Vite 的 JSON 导入
 */
declare global {
  // eslint-disable-next-line no-var
  var __WORDREALM_SEEDS__: SeedsFile | undefined;
}

let loaded: SeedsFile | null = null;

export async function loadSeeds(): Promise<SeedsFile> {
  if (loaded) return loaded;

  const injected = globalThis.__WORDREALM_SEEDS__;
  if (injected) {
    loaded = injected;
    return loaded;
  }

  const url = new URL('../data/seeds.json', import.meta.url).href;
  const mod = await import(/* @vite-ignore */ url, { with: { type: 'json' } });
  loaded = (mod.default ?? mod) as unknown as SeedsFile;
  return loaded;
}
