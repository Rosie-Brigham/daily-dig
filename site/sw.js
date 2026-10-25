// Keeps the app and today's posts (including images) available offline.

const SHELL = 'dd-shell-v2';
const FEED = 'dd-feed';
const IMAGES = 'dd-images';
const FONTS = 'dd-fonts';

const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dd-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname.endsWith('.wikimedia.org')) {
    event.respondWith(cacheFirst(request, IMAGES));
  } else if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request, FONTS));
  } else if (url.origin === location.origin && url.pathname.includes('/feed/')) {
    event.respondWith(networkFirst(request, FEED));
  } else if (url.origin === location.origin) {
    // App files: serve fast from cache, refresh in the background.
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(request, { ignoreSearch: true });
        const fresh = fetch(request).then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        }).catch(() => hit);
        return hit || fresh;
      }),
    );
  }
});

// The page sends today's image URLs: fetch them now so the feed works offline,
// and drop images from older feeds.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'precache-images') return;
  const wanted = new Set(event.data.urls);
  event.waitUntil((async () => {
    if (event.data.feedUrl && !(await caches.match(event.data.feedUrl))) {
      try {
        const res = await fetch(event.data.feedUrl);
        if (res.ok) await (await caches.open(FEED)).put(event.data.feedUrl, res);
      } catch {}
    }
    const cache = await caches.open(IMAGES);
    for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
    for (const url of wanted) {
      if (await cache.match(url)) continue;
      try {
        const res = await fetch(url, { mode: 'no-cors' });
        await cache.put(url, res);
      } catch {}
    }
  })());
});
