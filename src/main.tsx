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

// ---------- Service Worker ----------
// 让 iPhone「添加到主屏幕」后能离线打开。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // 相对路径注册：部署到 GitHub Pages 子目录时也能正确解析作用域
    navigator.serviceWorker
      .register('./sw.js')
      .then(reg => {
        // ⚠️ 主动检查更新。
        //    手机上很常见的情况是：SW 长期停在旧版本，
        //    于是用户一直吃旧缓存，改了也看不到效果（真实踩过）。
        //    iOS 对后台更新检查不积极，所以每次启动都主动问一次。
        reg.update().catch(() => undefined);

        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          if (!next) return;
          next.addEventListener('statechange', () => {
            // 新版本装好且已有旧版本在跑 -> 提示刷新
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              console.info('[词域] 有新版本，刷新后生效');
              window.dispatchEvent(new CustomEvent('wordrealm:update-ready'));
            }
          });
        });
      })
      .catch(err => {
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
