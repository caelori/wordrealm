/**
 * 解析钩子：给无扩展名的相对导入补上 .ts / .tsx / .json。
 * 由 tools/ts-loader.mjs 通过 module.register() 注册。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对导入，裸模块名交给 Node 默认解析
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const parent = context.parentURL;
    if (parent) {
      let base;
      try {
        base = new URL(specifier, parent);
      } catch {
        base = null;
      }
      if (base && base.protocol === 'file:') {
        const p = fileURLToPath(base);
        // 已经带扩展名且文件存在，直接放行
        if (existsSync(p)) {
          return nextResolve(specifier, context);
        }
        // 逐个试候选扩展名
        for (const ext of CANDIDATES) {
          const candidate = p + ext;
          if (existsSync(candidate)) {
            return { url: new URL(`file://${candidate.replace(/\\/g, '/')}`).href, shortCircuit: true };
          }
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
