/**
 * 静态资源路径解析。
 *
 * 为什么需要它：
 *   直接写 <img src="/art/avatar.png"> 在本地开发时没问题，
 *   但部署到 GitHub Pages 的子目录（/wordrealm/）后，
 *   这个路径会指向域名根目录 https://<user>.github.io/art/avatar.png → 404。
 *   这个 bug 只在生产环境暴露，开发环境永远看不到。真实踩过。
 *
 * 实现要点：base 是相对值 './'，不能简单做字符串拼接，
 *   要用 new URL(相对路径, document.baseURI) 让浏览器按文档位置解析。
 */

const BASE = import.meta.env.BASE_URL || './';

/** 把资源相对路径解析成可用的绝对地址 */
export function asset(relPath: string): string {
  const rel = relPath.replace(/^\/+/, '');
  // 绝对 base（如 '/foo/'）直接用；相对 base 交给 URL 解析
  if (BASE.startsWith('/')) return `${BASE.replace(/\/+$/, '')}/${rel}`;

  const docBase =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined'
        ? location.href
        : 'http://localhost/';
  return new URL(rel, docBase).href;
}

export const ART = {
  avatar: () => asset('art/avatar.png'),
  reading: () => asset('art/reading.png'),
  cheer: () => asset('art/cheer.png'),
} as const;
