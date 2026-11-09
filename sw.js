import { SHELL_VERSION, SHELL_ASSETS } from './shell-manifest.js';

// Each successful install owns a complete, immutable cache. Prior versions are
// intentionally retained: a tab still controlled by an older worker needs its
// own shell. This cache contains only the release's fixed public files.
const PREFIX = 'effort-offline-shell-v1-';
const ownPrefix = `${PREFIX}${SHELL_VERSION}-`;
const scope = new URL(self.registration.scope);
const marker = new URL('__effort_shell_ready__', scope).href;
const assets = new Map(SHELL_ASSETS.map(item => [new URL(item.path, scope).href, item.sha256]));
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

async function installShell() {
  const name = `${ownPrefix}${crypto.randomUUID()}`;
  try {
    const cache = await caches.open(name);
    for (const [url, expected] of assets) {
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.ok || response.redirected || response.type === 'opaque') throw Error('Offline shell asset could not be fetched.');
      if (hex(await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer())) !== expected) throw Error('Offline shell asset did not match its release.');
      await cache.put(url, response);
    }
    await cache.put(marker, new Response(SHELL_VERSION));
  } catch (error) { await caches.delete(name); throw error; }
}
async function releaseCache() {
  for (const name of await caches.keys()) if (name.startsWith(ownPrefix)) {
    const cache = await caches.open(name);
    if ((await cache.match(marker))?.ok) return cache;
  }
  throw Error('Offline shell is unavailable.');
}
function assetUrl(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || url.search || !url.pathname.startsWith(scope.pathname)) return null;
  url.hash = '';
  if (url.pathname === scope.pathname) url.pathname += 'index.html';
  else if (url.pathname === `${scope.pathname}public/`) url.pathname += 'index.html';
  return assets.has(url.href) ? url.href : null;
}
self.addEventListener('install', event => { event.waitUntil(installShell()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_UPDATE') event.waitUntil(self.skipWaiting());
  else if (event.data?.type === 'CLAIM_CLIENTS') event.waitUntil(releaseCache().then(() => self.clients.claim()));
  else if (event.data?.type === 'SHELL_STATUS') event.waitUntil(releaseCache().then(() => event.ports?.[0]?.postMessage({ready:true, version:SHELL_VERSION})).catch(() => event.ports?.[0]?.postMessage({ready:false})));
});
self.addEventListener('fetch', event => {
  const url = assetUrl(event.request); if (!url) return;
  event.respondWith((async () => {
    const response = await (await releaseCache()).match(url);
    if (!response) throw Error('Offline shell is incomplete.');
    return response;
  })());
});
