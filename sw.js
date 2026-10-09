// sw.js ( Service Worker แบบพื้นฐานเพื่อให้ PWA ติดตั้งบน Android ได้ )
const CACHE_NAME = 'dwallet-v34';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // ดึงข้อมูลผ่าน Network ตามปกติอย่างถูกต้อง
  event.respondWith(
    fetch(event.request).catch(() => {
      // กรณี Offline หรือ Fetch ล้มเหลว
      return caches.match(event.request);
    })
  );
});
