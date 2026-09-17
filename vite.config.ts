import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
 * 运行时代码里取资源用 import.meta.env.BASE_URL（见 src/systems/assets.ts），
 * Vite 会把它替换成 './'，配合 new URL(..., document.baseURI) 解析。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
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
