import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { requestPersistence } from './db/backup';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// ---------- Service Worker：让 iPhone「添加到主屏幕」后能离线打开 ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // 相对路径注册：部署到 GitHub Pages 子目录时也能正确解析作用域
    navigator.serviceWorker.register('./sw.js').catch(err => {
      // 注册失败不影响主流程（例如非 localhost 的 http 环境）
      console.warn('[词域] Service Worker 注册失败:', err?.message ?? err);
    });
  });
}

// ---------- 申请持久化存储 ----------
// 尽早调用：浏览器通常在用户与站点有交互后才可能授予。
// 失败也不影响使用，但设置页会提示做备份。
requestPersistence()
  .then(ok => {
    if (!ok) console.info('[词域] 未获得持久化存储授权，建议定期导出备份');
  })
  .catch(() => undefined);
