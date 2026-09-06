'use strict';

const CACHE_PREFIX = 'cad-fieldbook-offline-';
// Increment this value whenever the web application is published.
// Static files are served cache-first, so reusing an old value would keep an
// older main.dart.js even after a new build has been deployed.
const CACHE_NAME = `${CACHE_PREFIX}20260906-iphone-tap-info199`;
const CORE_FILES = [
  './',
  'index.html',
  'flutter.js',
  'flutter_bootstrap.js',
  'main.dart.js',
  'manifest.json',
  'favicon.png',
  'icons/Icon-192.png',
  'icons/Icon-512.png',
  'icons/Icon-maskable-192.png',
  'icons/Icon-maskable-512.png',
];

async function addInBatches(cache, urls) {
  const batchSize = 20;
  for (let index = 0; index < urls.length; index += batchSize) {
    await cache.addAll(urls.slice(index, index + batchSize));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const manifestResponse = await fetch('offline-assets.json', {cache: 'no-store'});
    if (!manifestResponse.ok) throw new Error('offline-assets.json unavailable');
    const extraFiles = await manifestResponse.json();
    await addInBatches(cache, [...new Set([...CORE_FILES, ...extraFiles])]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('index.html', response.clone());
        return response;
      } catch (_) {
        return (await caches.match('index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(event.request, response.clone());
    }
    return response;
  })());
});
