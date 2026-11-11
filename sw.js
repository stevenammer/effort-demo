import { SHELL_VERSION, SHELL_ASSETS } from './shell-manifest.js';

// Each successful install owns a complete, immutable cache. On activation the
// worker keeps one verified cache for its release and evicts every retired
// shell. A user-approved activation has no clients controlled by the old
// worker, so retired shells are safe to reclaim. The one-shell budget keeps
// regenerable Cache Storage bounded without touching IndexedDB or the active
// offline shell.
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
async function verifiedReleaseCache(name) {
  const cache = await caches.open(name);
  const response = await cache.match(marker);
  return response?.ok && await response.text() === SHELL_VERSION ? cache : null;
}
async function releaseCache() {
  for (const name of await caches.keys()) if (name.startsWith(ownPrefix)) {
    const cache = await verifiedReleaseCache(name);
    if (cache) return cache;
  }
  throw Error('Offline shell is unavailable.');
}
async function enforceShellBudget() {
  let keep = null;
  for (const name of await caches.keys()) if (name.startsWith(ownPrefix) && await verifiedReleaseCache(name)) { keep = name; break; }
  if (!keep) throw Error('Offline shell is unavailable.');
  let removed = 0;
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== keep && await caches.delete(name)) removed++;
  return { keep, removed };
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
self.addEventListener('activate', event => { event.waitUntil(enforceShellBudget().then(() => self.clients.claim())); });
self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_UPDATE') event.waitUntil(self.skipWaiting());
  else if (event.data?.type === 'CLAIM_CLIENTS') event.waitUntil(releaseCache().then(() => self.clients.claim()));
  else if (event.data?.type === 'SHELL_STATUS') event.waitUntil(releaseCache().then(() => event.ports?.[0]?.postMessage({ready:true, version:SHELL_VERSION})).catch(() => event.ports?.[0]?.postMessage({ready:false})));
  else if (event.data?.type === 'CLEAR_REGENERABLE_CACHES') event.waitUntil((async () => {
    try { const { removed } = await enforceShellBudget(); event.ports?.[0]?.postMessage({ ok: true, removed }); }
    catch (error) { event.ports?.[0]?.postMessage({ ok: false, error: error.message }); }
  })());
});
self.addEventListener('fetch', event => {
  // Share Target posts become a same-origin capture URL. The page owns the
  // actual local save, so a closed or failed page cannot create a capture.
  if (event.request.method === 'POST' && new URL(event.request.url).pathname === `${scope.pathname}public/`) {
    event.respondWith((async () => {
      const data = await event.request.formData();
      const text = [data.get('title'), data.get('text'), data.get('url')].filter(value => typeof value === 'string' && value.trim()).join('\n\n');
      return Response.redirect(new URL(`public/?share=${encodeURIComponent(text.slice(0, 4000))}`, scope), 303);
    })());
    return;
  }
  const url = assetUrl(event.request); if (!url) return;
  event.respondWith((async () => {
    const response = await (await releaseCache()).match(url);
    if (!response) throw Error('Offline shell is incomplete.');
    return response;
  })());
});
