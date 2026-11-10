import { canonical, createExport, quarantineToAppend, restoreExport, verifyExport } from '../core/export.js';
function request(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error('Database request failed.'));
  });
}
function ordered(records) {
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
export function createIndexedDbStore({ factory = globalThis.indexedDB, name = 'effort-core' } = {}) {
  if (!factory) throw Error('IndexedDB is unavailable.');
  const opening = new Promise((resolve, reject) => {
    const open = factory.open(name, 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('captures')) open.result.createObjectStore('captures', { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains('derived')) open.result.createObjectStore('derived', { keyPath: 'id' });
      open.result.createObjectStore('quarantine', { autoIncrement: true });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || Error('Database could not open.'));
  });
  async function run(stores, mode, work) {
    const db = await opening;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value, workError;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(workError || tx.error || Error('Database transaction failed.'));
      tx.onabort = () => reject(workError || tx.error || Error('Database transaction aborted.'));
      Promise.resolve().then(() => work(tx)).then((result) => {
        value = result;
      }, (error) => {
        workError = error;
        try { tx.abort(); } catch { reject(error); }
      });
    });
  }
  return {
    append: (record) => run('captures', 'readwrite', (tx) => request(tx.objectStore('captures').add(record))),
    get: (id) => run('captures', 'readonly', (tx) => request(tx.objectStore('captures').get(id))),
    list: async () => ordered(await run('captures', 'readonly', (tx) => request(tx.objectStore('captures').getAll()))),
    putDerived: (record) => run('derived', 'readwrite', (tx) => request(tx.objectStore('derived').put(record))),
    async export() { return JSON.stringify({ captures: await this.list() }); },
    exportBundle(hash) { return createExport(this, hash); },
    verifyBundle(input, hash) { return verifyExport(input, hash); },
    restoreBundle(input, hash) { return restoreExport(this, input, hash); },
    snapshot: () => run(['captures', 'derived', 'quarantine'], 'readonly', async (tx) => {
      const [captures, derived, quarantine] = await Promise.all(['captures', 'derived', 'quarantine'].map((name) => request(tx.objectStore(name).getAll())));
      return { captures, derived, quarantine };
    }),
    importSnapshot: (incoming, { sourceQuarantine = [] } = {}) => run(['captures', 'derived', 'quarantine'], 'readwrite', async (tx) => {
      const stores = ['captures', 'derived'];
      const existing = await Promise.all(stores.map((name) => request(tx.objectStore(name).getAll())));
      const captureMap = new Map(existing[0].map((record) => [record.id, canonical(record)]));
      for (const record of incoming.captures) {
        if (captureMap.has(record.id) && captureMap.get(record.id) !== canonical(record)) {
          throw Error('Capture ID collision.');
        }
      }
      const derivedMap = new Map(existing[1].map((record) => [record.id, canonical(record)]));
      const keptExisting = incoming.derived.filter((record) => {
        return derivedMap.has(record.id) && derivedMap.get(record.id) !== canonical(record);
      }).map((record) => record.id);
      for (let i = 0; i < stores.length; i++) {
        const ids = new Set(existing[i].map((record) => record.id));
        for (const record of incoming[stores[i]]) if (!ids.has(record.id)) tx.objectStore(stores[i]).add(record);
      }
      const quarantine = tx.objectStore('quarantine');
      const current = { captures: existing[0], derived: existing[1], quarantine: await request(quarantine.getAll()) };
      for (const record of quarantineToAppend(current, incoming.quarantine ?? [], sourceQuarantine)) quarantine.add(record);
      return { keptExisting };
    }),
    async close() { (await opening).close(); },
  };
}
