import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 构建版本号。
 * 显示在设置页底部——排查"手机上是不是旧版"时必须有个可对照的标识。
 * 真实教训：iPhone 上跑着旧缓存，本地怎么测都正常，没有版本号就只能猜。
 * 改了功能就顺手改一下这个值。
 */
const BUILD_ID = '2026-09-17.3';

/**
 * base 用相对路径 './'，它对三种运行环境同时成立：
 *   1. 本地 dev        http://127.0.0.1:5180/
 *   2. 本地 preview     http://localhost:5190/
 *   3. GitHub Pages     https://<user>.github.io/<repo>/
 *
 * 为什么不用绝对路径 '/wordrealm/'：
 *   那样本地 preview 也得挂在 /wordrealm/ 下才正常，
 *   一在根路径打开就全是 404（真实踩过）。
 *   相对路径由浏览器按文档位置解析，三种环境都不需要额外配置。
 *
 * 运行时代码里取资源用 src/systems/assets.ts 的 asset()，
 * 它基于 import.meta.env.BASE_URL，配合 document.baseURI 解析。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
  },
  server: {
    port: 5180,
    strictPort: false,
    open: false,
  },
  build: {
    // 词库是 public/data/seeds.json 静态资源，不打进 JS 包
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'dexie', 'zustand', 'ts-fsrs'],
        },
      },
    },
  },
});
