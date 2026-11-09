function request(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error('Database request failed.'));
  });
}

function ordered(records) {
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id));
}

export function createIndexedDbStore({ factory = globalThis.indexedDB, name = 'effort-core' } = {}) {
  if (!factory) throw Error('IndexedDB is unavailable.');
  const opening = new Promise((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('captures', { keyPath: 'id' });
      open.result.createObjectStore('derived', { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || Error('Database could not open.'));
  });
  async function run(store, mode, work) {
    const db = await opening;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || Error('Database transaction failed.'));
      tx.onabort = () => reject(tx.error || Error('Database transaction aborted.'));
      Promise.resolve(work(tx.objectStore(store))).then((result) => { value = result; }, reject);
    });
  }
  return {
    append: (record) => run('captures', 'readwrite', (store) => request(store.add(record))),
    get: (id) => run('captures', 'readonly', (store) => request(store.get(id))),
    list: async () => ordered(await run(
      'captures', 'readonly', (store) => request(store.getAll()),
    )),
    putDerived: (record) => run('derived', 'readwrite', (store) => request(store.put(record))),
    async export() { return JSON.stringify({ captures: await this.list() }); },
    async close() { (await opening).close(); },
  };
}
