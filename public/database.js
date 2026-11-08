export const DB_NAME = 'effort-public-demo';
export const DB_VERSION = 3;
export const TABLES = Object.freeze(['captures', 'meta', 'quarantine', 'drafts', 'spans', 'intentEvents', 'places', 'resumptions']);

export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || Error('Browser database request failed.'));
  });
}

export function openDatabase({ factory = globalThis.indexedDB, name = DB_NAME } = {}) {
  let opening;
  function connect() {
    if (!factory) return Promise.reject(Error('This browser cannot open its local database. Keep your draft and use a supported browser.'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const req = factory.open(name, DB_VERSION); let settled = false;
      req.onupgradeneeded = () => {
        for (const table of TABLES) if (!req.result.objectStoreNames.contains(table)) {
          req.result.createObjectStore(table, { keyPath: table === 'meta' || table === 'drafts' ? 'key' : 'id' });
        }
      };
      req.onblocked = () => { settled = true; opening = null; reject(Error('Another EFFORT tab needs to close before the local database can upgrade. Your existing data is unchanged.')); };
      req.onerror = () => { opening = null; reject(req.error?.name === 'VersionError' ? Error('This tab is older than the saved EFFORT workspace. Reload to use the newer version. Your data is unchanged.') : req.error || Error('The local database could not open.')); };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
    });
    return opening;
  }
  async function run(tables, mode, work) {
    const db = await connect(); const tx = db.transaction(tables, mode);
    const finished = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || Error('The local database transaction was interrupted.'));
      tx.onerror = () => { /* The abort event supplies the final transaction outcome. */ };
    });
    // Register rejection handling immediately, including when a request fails before work returns.
    finished.catch(() => {});
    let value;
    try { value = await work(tx); }
    catch (error) { try { tx.abort(); } catch {} await finished.catch(() => {}); throw error; }
    await finished; return value;
  }
  return {
    run, name,
    async close() { if (opening) { (await opening).close(); opening = null; } },
  };
}
