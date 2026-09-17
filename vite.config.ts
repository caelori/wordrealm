import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 的项目站点部署在 https://<user>.github.io/<repo>/ 这个子路径下。
// 用绝对 base 而不是 './' 更稳：Service Worker 作用域、动态 import 的资源解析
// 都不依赖当前文档的层级，避免出现"部署后白屏"。
// 本地 dev 不受 base 影响；本地预览构建产物请用 npm run preview。
const REPO = 'wordrealm';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? `/${REPO}/` : '/',
  server: {
    port: 5180,
    strictPort: false,
    open: false,
  },
  build: {
    // seeds.json 2.5MB，Vite 会为它单独产出一个 .json 资源，不会进主包
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'dexie', 'zustand', 'ts-fsrs'],
        },
      },
    },
  },
}));
