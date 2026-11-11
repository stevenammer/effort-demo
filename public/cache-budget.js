const PREFIX = 'effort-offline-shell-v1-';
const bytes = value => `${(value / 1024).toFixed(value < 1024 * 1024 ? 1 : 0)} ${value < 1024 * 1024 ? 'KB' : 'MB'}`;

/** Reports only Cache Storage. IndexedDB originals are intentionally excluded. */
export async function cacheBudget({ cacheStorage = globalThis.caches } = {}) {
  if (!cacheStorage?.keys) return { supported: false, count: 0, bytes: 0, bytesLabel: 'Unknown' };
  const names = (await cacheStorage.keys()).filter(name => name.startsWith(PREFIX));
  let total = 0;
  for (const name of names) { const cache = await cacheStorage.open(name); for (const request of await cache.keys()) { const response = await cache.match(request); total += Number(response?.headers?.get('content-length')) || 0; } }
  return { supported: true, count: names.length, bytes: total, bytesLabel: bytes(total) };
}

/** Deletes only public shell caches. It has no access to IndexedDB. */
export async function clearRegenerableCaches({ worker = globalThis.navigator?.serviceWorker?.controller, messageChannel = globalThis.MessageChannel } = {}) {
  if (!worker) throw Error('The installed offline shell is not controlling this page yet. Reload once, then retry.');
  if (!messageChannel) throw Error('This browser cannot request offline cache cleanup. Saved writing was not touched.');
  const channel = new messageChannel();
  const result = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Offline cache cleanup did not answer. Saved writing was not touched.')), 5000); channel.port1.onmessage = event => { clearTimeout(timeout); event.data?.ok ? resolve(event.data.removed) : reject(Error(event.data?.error || 'Offline cache cleanup failed.')); }; });
  worker.postMessage({ type: 'CLEAR_REGENERABLE_CACHES' }, [channel.port2]);
  return result;
}
