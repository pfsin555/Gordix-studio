const CACHE_NAME = 'gordix-studio-v2'; // 更新版本號以觸發 activate 清除舊快取

const ASSETS = [
  './', // 必須快取根目錄
  './index.html',
  './CNC.html',
  './draw.html',
  './Gcodetrans.html',
  './table_conf.html',
  './Laser.html',
  './vc.html',    
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './tailwind.min.css' // 請將 Tailwind 下載至本地，取代外部 CDN
];

// 1. 安裝階段 (Install): 預先下載並快取所有 ASSETS
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 若有單一檔案失敗不中斷整體，但移除 CDN 後失敗率會大幅降低
      return cache.addAll(ASSETS).catch(err => {
        console.warn('部分資源快取失敗:', err);
      });
    })
  );
  self.skipWaiting();
});

// 2. 啟動階段 (Activate): 清理舊版本快取
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. 攔截請求 (Fetch): Stale-While-Revalidate 策略
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 完全離線時直接依賴 cachedResponse，若無快取則回傳 null
        return null;
      });
      
      // 優先回傳快取實現 100% 離線秒開，背景自動執行 fetchPromise 更新快取
      return cachedResponse || fetchPromise;
    })
  );
});
