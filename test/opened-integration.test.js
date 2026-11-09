import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore, IDBDatabase } from 'fake-indexeddb';
import { createStore } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { deriveOpened } from '../public/opened.js';
import { sha256 } from '../public/primitives.js';
const options = () => ({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false });
const item = c => ({ id: c.id, hash: c.hash });
test('opened receipts integrate with unchanged NOW and backup10; restoring backup9 does not erase them', async () => {
  const store = createStore(options()); await store.seed(); const before = await store.read(), source = before.captures[0];
  const old = structuredClone(before); old.version = 9;delete old.threadReviews;delete old.helperEvents; delete old.sourceRevisions; delete old.personEvents; delete old.contactReceipts; delete old.openedReceipts; const oldBackup = JSON.stringify({ payload: old, sha256: await sha256(JSON.stringify(old)) });
  const receipts = await store.markOpened({ items: [item(source)] }); await store.restore(oldBackup); assert.deepEqual((await store.read()).openedReceipts, receipts);
  const target = createStore(options()), backup = await store.exportData(); await target.restore(backup); await target.restore(backup);
  const restored = await target.read(); assert.equal(restored.version, 14); assert.deepEqual(restored.openedReceipts, receipts); assert.deepEqual(restored.now, before.now); assert.deepEqual(restored.captures, before.captures);
  const oldTarget = createStore(options()); await oldTarget.restore(oldBackup); assert.deepEqual((await oldTarget.read()).openedReceipts, []); await oldTarget.close(); await target.close(); await store.close();
});
test('independent opening timestamps merge without duplicating or replacing existing receipts', async () => {
  const a = createStore(options()); await a.seed(); const base = await a.exportData(), b = createStore(options()); await b.restore(base); const source = (await a.read()).captures[0];
  const first = await a.markOpened({ items: [item(source)] }); await b.markOpened({ items: [item(source)] }); await a.restore(await b.exportData()); assert.deepEqual((await a.read()).openedReceipts, first); await a.close(); await b.close();
});
test('unavailable optional opening history preserves capture and NOW and refuses incomplete backups', async () => {
  const store = createStore(options()); await store.seed(); const before = await store.read(), getAll = IDBObjectStore.prototype.getAll;
  try { IDBObjectStore.prototype.getAll = function(...args) { if (this.name === 'openedReceipts') throw Error('Opening storage unavailable'); return getAll.apply(this, args); };
    const state = await store.read(); assert.match(state.openedWarning, /Opening storage unavailable/); assert.deepEqual(state.now, before.now); assert.deepEqual(state.captures, before.captures);
    await store.capture('Keep saving when optional opening state fails.', 'Unsorted'); await assert.rejects(store.exportData(), /complete backup cannot/);
  } finally { IDBObjectStore.prototype.getAll = getAll; } assert.equal((await store.read()).captures.length, before.captures.length + 1); await store.close();
});
test('all three optional stores may fail together without hiding primary writing', async () => {
  const store = createStore(options()); await store.seed(); const before = await store.read(), getAll = IDBObjectStore.prototype.getAll;
  try { IDBObjectStore.prototype.getAll = function(...args) { if (['openedReceipts', 'artifacts', 'moveEvents'].includes(this.name)) throw Error('Optional storage fixture'); return getAll.apply(this, args); };
    const state = await store.read(); assert.ok(state.openedWarning); assert.ok(state.fileWarning); assert.ok(state.thinkingWarning); assert.deepEqual(state.captures, before.captures); assert.deepEqual(state.now, before.now);
  } finally { IDBObjectStore.prototype.getAll = getAll; } await store.close();
});
test('damaged receipt yields unknown status and raw recovery until exact opening is recorded again', async () => {
  const opts = options(), store = createStore(opts), db = openDatabase({ factory: opts.indexedDB }); await store.seed(); const source = (await store.read()).captures[0], [row] = await store.markOpened({ items: [item(source)] });
  await db.run(['openedReceipts'], 'readwrite', tx => request(tx.objectStore('openedReceipts').put({ ...row, at: '2020-01-01T00:00:00.000Z' })));
  const damaged = await store.read(); assert.equal(damaged.openedReceipts.length, 0); assert.ok(deriveOpened(damaged).unknown.has(source.id)); assert.ok(damaged.recovery.some(r => r.source === 'openedReceipts' && r.raw.includes(row.id)));
  await store.markOpened({ items: [item(source)] }); const repaired = await store.read(); assert.ok(deriveOpened(repaired).opened.has(source.id)); assert.ok(!deriveOpened(repaired).unknown.has(source.id)); assert.equal(repaired.recovery.length, damaged.recovery.length); await db.close(); await store.close();
});
test('restore readback failure keeps committed opening receipts and retries without duplicates', async () => {
  const source = createStore(options()); await source.seed(); const capture = (await source.read()).captures[0], rows = await source.markOpened({ items: [item(capture)] }), backup = await source.exportData(), target = createStore(options());
  const add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false, failed = false;
  try { IDBObjectStore.prototype.add = function(value, ...args) { const req = add.call(this, value, ...args); if (this.name === 'openedReceipts') inserted = true; return req; }; IDBObjectStore.prototype.get = function(...args) { if (this.name === 'openedReceipts' && this.transaction.mode === 'readonly' && inserted && !failed) { failed = true; throw Error('Opening readback fault'); } return get.apply(this, args); }; await assert.rejects(target.restore(backup), /Opening restore could not be verified/); }
  finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  await target.restore(backup); assert.deepEqual((await target.read()).openedReceipts, rows); await source.close(); await target.close();
});


test('a failed combined optional transaction degrades only after a primary snapshot succeeds', async () => {
  const store = createStore(options()); await store.seed(); const before = await store.read(), transaction = IDBDatabase.prototype.transaction;
  try { IDBDatabase.prototype.transaction = function(tables, ...args) { if (Array.from(tables).includes('openedReceipts') && Array.from(tables).includes('spans')) throw Error('Combined opening transaction unavailable'); return transaction.call(this, tables, ...args); };
    const state = await store.read(); assert.match(state.openedWarning, /Combined opening transaction unavailable/); assert.deepEqual(state.captures, before.captures); assert.deepEqual(state.now, before.now); await assert.rejects(store.exportData(), /complete backup cannot/);
  } finally { IDBDatabase.prototype.transaction = transaction; } await store.close();
});
test('an actual primary snapshot failure is never presented as an optional-store warning', async () => {
  const store = createStore(options()); await store.seed(); const transaction = IDBDatabase.prototype.transaction;
  try { IDBDatabase.prototype.transaction = function(tables, ...args) { if (Array.from(tables).includes('spans') && Array.from(tables).includes('intentEvents')) throw Error('Primary snapshot unavailable'); return transaction.call(this, tables, ...args); };
    await assert.rejects(store.read(), /Primary snapshot unavailable/);
  } finally { IDBDatabase.prototype.transaction = transaction; } await store.close();
});
