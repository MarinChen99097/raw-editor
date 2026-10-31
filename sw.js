// Service worker for the hosted version (GitHub Pages etc.). Not used when RawEditor.html is opened from local storage (file://).
// Network-first: you always get the latest version when online; the cached copy keeps the editor working offline.
const CACHE = 'raw-editor-v2';
const FILES = ['./', './index.html', './RawEditor.html', './manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES).catch(() => c.add('./RawEditor.html')))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./RawEditor.html'))));
});
