/* 词域 Service Worker
 *
 * 目标：让 iPhone「添加到主屏幕」后能离线打开。
 *
 * ⚠️ 改动静态资源或缓存策略后，**必须把 VERSION 加一**，
 *    否则用户会一直吃旧缓存，改了也看不到效果。
 *
 * 历史：
 *   v1  初版。词库当时是被打包的 JS 模块，不在预缓存列表里。
 *   v2  词库改为 public/data/seeds.json；立绘改为 base 感知路径。
 *   v3  修 iPhone 上的 504：加固取失败时的兜底，并保证错误响应的类型正确。
 *       —— 手机上曾出现「加载词库失败（HTTP 504）」，
 *          因为网络取失败时返回了一个 text/html 的空响应，
 *          fetch().json() 解析它必然失败，用户只看到一片红。
 *          现在：JSON 请求失败会重试一次；仍然失败则返回**可解析的 JSON**，
 *          让应用能给出"网络不通，请重试"这种有意义的提示。
 */

const VERSION = 'v3';
const CACHE = `wordrealm-${VERSION}`;

/** 安装时就预缓存的少量关键资源 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './data/seeds.json',
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
      // 逐个 add：某一个失败不该让整次安装失败
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

/** 同一个请求重试一次，第二次绕过 HTTP 缓存 */
async function fetchWithRetry(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) return fresh;
    if (fresh) return fresh;
  } catch {
    /* 落到重试 */
  }
  try {
    const url = new URL(req.url);
    url.searchParams.set('_r', String(Date.now() % 100000));
    return await fetch(new Request(url.href, { cache: 'reload', credentials: 'same-origin' }));
  } catch {
    return null;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET；跨域请求一律放行（例如 AI 接口）
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ---------- 导航请求：network-first，失败回落缓存的 index.html ----------
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE);
            cache.put('./index.html', fresh.clone()).catch(() => undefined);
            return fresh;
          }
        } catch {
          /* 回落 */
        }
        const cache = await caches.open(CACHE);
        const hit = (await cache.match('./index.html')) || (await cache.match('./'));
        if (hit) return hit;
        return new Response('离线且没有缓存，请联网后重试。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })(),
    );
    return;
  }

  // ---------- 图标 / 立绘：cache-first ----------
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const fresh = await fetchWithRetry(req);
        if (fresh && fresh.ok) {
          cache.put(req, fresh.clone()).catch(() => undefined);
          return fresh;
        }
        // 返回一个透明 1x1 PNG，而不是带 HTML 错误页的 404，
        // 避免 <img> 拿到非图片内容
        return new Response(
          Uint8Array.from(
            atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
            (c) => c.charCodeAt(0),
          ),
          { status: 200, headers: { 'Content-Type': 'image/png' } },
        );
      })(),
    );
    return;
  }

  // ---------- 其他（JS/CSS/JSON）：stale-while-revalidate ----------
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);

      // 命中缓存：立即返回，同时后台更新
      if (hit) {
        const updating = fetch(req)
          .then((fresh) => {
            if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => undefined);
          })
          .catch(() => undefined);
        event.waitUntil(updating);
        return hit;
      }

      // 未命中：走网络（带一次重试）
      const fresh = await fetchWithRetry(req);
      if (fresh && fresh.ok) {
        cache.put(req, fresh.clone()).catch(() => undefined);
        return fresh;
      }

      // ⚠️ 关键修复：这里以前返回 `new Response('', { status: 504 })`，
      //    默认 Content-Type 是 text/html。fetch(url).json() 解析它必然抛错，
      //    用户在手机上只看到「加载词库失败（HTTP 504）」。
      //    现在按请求类型返回**内容正确**的兜底响应。
      const wantsJson = /\.json($|\?)/i.test(url.pathname) || /application\/json/.test(req.headers.get('accept') || '');
      if (wantsJson) {
        return new Response(JSON.stringify({ __offline: true, error: '网络不可用，词库未缓存' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      return new Response('/* 离线，资源未缓存 */', {
        status: 503,
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    })(),
  );
});

// 允许页面主动触发更新
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
