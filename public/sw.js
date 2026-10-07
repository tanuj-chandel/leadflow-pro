// Service Worker for AI AutomationHubs Mobile App (PWA)
const CACHE_NAME = 'ai-autohubs-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first strategy for live dynamic dashboard
self.addEventListener('fetch', (event) => {
  // Let all API calls and live data bypass cache completely
  if (event.request.url.includes('/api/') || event.request.method !== 'GET') {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
