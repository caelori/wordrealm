/* 词域 Service Worker
 *
 * 目标：让 iPhone 上"添加到主屏幕"后能离线打开。
 *
 * 策略（故意保持简单，避免更新卡死）：
 *   - 导航请求：network-first，失败回落到缓存的 index.html
 *   - 静态资源（图片/图标/字体）：cache-first（内容带 hash 或很少变）
 *   - 其余（含 /assets/*.js）：stale-while-revalidate
 *   - 跨域请求（DeepSeek API 等）：一概不碰，直接放行
 *
 * ⚠️ 改动静态资源后必须把 VERSION 加一，否则用户会一直吃旧缓存。
 */

const VERSION = 'v1';
const CACHE = `wordrealm-${VERSION}`;

/** 安装时就预缓存的少量关键资源 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './art/avatar.png',
  './art/reading.png',
  './art/cheer.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个 add：某一个失败不应该让整次安装失败
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/** 图片/图标这类几乎不变的资源 */
function isStaticAsset(url) {
  return /\.(png|jpg|jpeg|webp|svg|gif|ico|woff2?|ttf|otf)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET；跨域请求一律放行（例如 AI 接口）
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航：优先走网络，拿不到就用缓存的 index.html，保证离线可开
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('./index.html', fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('离线且没有缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
          );
        }
      })(),
    );
    return;
  }

  // 图标/立绘：cache-first
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          return new Response('', { status: 504 });
        }
      })(),
    );
    return;
  }

  // 其余（JS/CSS/JSON 词库）：stale-while-revalidate
  // 先给缓存的（快），同时后台更新，下次打开就是新的
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const fetching = fetch(req)
        .then((fresh) => {
          if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => undefined);
          return fresh;
        })
        .catch(() => undefined);

      if (hit) {
        // 不 await 后台更新，直接返回缓存
        event.waitUntil(fetching);
        return hit;
      }
      const fresh = await fetching;
      return fresh || new Response('', { status: 504 });
    })(),
  );
});

// 允许页面主动触发更新
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
