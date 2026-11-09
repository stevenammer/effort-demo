import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, sha256 } from '../public/store.js';

test('unavailable attachment storage leaves capture/NOW usable and refuses an incomplete backup', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await store.seed();
  const before = await store.read(), original = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function(...args) { if (this.name === 'artifacts') throw Error('File table unavailable fixture'); return original.apply(this, args); };
  try {
    const captured = await store.capture('A thought kept while file storage is unavailable.');
    const state = await store.read({ includeDrafts: false }); assert.ok(state.captures.some(c => c.id === captured.id)); assert.deepEqual(state.now, before.now); assert.match(state.fileWarning, /unavailable/);
    await assert.rejects(store.exportData(), /files|attachment/i);
    await store.choose(captured.id, 0, captured.text.length); assert.equal((await store.read({ includeDrafts: false })).now.captureId, captured.id);
  } finally { IDBObjectStore.prototype.getAll = original; }
  const healthy = await store.read(); assert.equal(healthy.fileWarning, undefined); await store.exportData(); await store.close();
});


test('version 7 backups migrate without files and never remove files from the current workspace', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await store.seed();
  const payload = await store.read(); payload.version = 7;delete payload.threadReviews;delete payload.helperEvents; delete payload.sourceRevisions; delete payload.personEvents; delete payload.contactReceipts; delete payload.openedReceipts; delete payload.artifacts; delete payload.branchEvents; delete payload.moveEvents;
  const raw = JSON.stringify({ payload, sha256: await sha256(JSON.stringify(payload)) });
  const file = await store.attach({ captureId: payload.captures[0].id, name: 'retained.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Keep this file across an older restore.') });
  await store.restore(raw); assert.deepEqual((await store.read()).artifacts, [file]);
  const fresh = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await fresh.restore(raw);
  const upgraded = await fresh.read(); assert.equal(upgraded.version, 18); assert.deepEqual(upgraded.artifacts, []); assert.deepEqual(upgraded.captures, (await store.read()).captures);
  await fresh.close(); await store.close();
});


test('a committed file restore with failed readback reports failure and retries without duplication', async () => {
  const source = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await source.seed();
  const before = await source.read(); const file = await source.attach({ captureId: before.captures[0].id, name: 'restore-retry.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Exact restored bytes.') }); const backup = await source.exportData();
  const target = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false });
  const add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false, failed = false;
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { const result = add.call(this, value, ...args); if (this.name === 'artifacts') inserted = true; return result; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'artifacts' && this.transaction.mode === 'readonly' && inserted && !failed) { failed = true; throw Error('artifact restore readback fixture'); } return get.apply(this, args); };
    await assert.rejects(target.restore(backup), /File restore could not be verified/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  assert.deepEqual((await target.read()).artifacts, [file]); await target.restore(backup); assert.deepEqual((await target.read()).artifacts, [file]); await source.close(); await target.close();
});


test('a file changed between recovery and the final snapshot is never returned as verified', async () => {
  const store = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await store.seed();
  const source = (await store.read()).captures[0]; const file = await store.attach({ captureId: source.id, name: 'snapshot.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Verified snapshot bytes.') });
  const original = IDBObjectStore.prototype.getAll; let reads = 0;
  try {
    IDBObjectStore.prototype.getAll = function(...args) { const request = original.apply(this, args); if (this.name === 'artifacts' && ++reads === 2) request.addEventListener('success', () => { const altered = structuredClone(request.result); altered[0].name = 'Changed during snapshot.txt'; Object.defineProperty(request, 'result', { configurable: true, get: () => altered }); }, { once: true }); return request; };
    const state = await store.read({ includeDrafts: false }); assert.match(state.fileWarning, /checksum/); assert.deepEqual(state.artifacts, []); assert.ok(state.captures.some(row => row.id === source.id));
  } finally { IDBObjectStore.prototype.getAll = original; }
  assert.deepEqual((await store.read()).artifacts, [file]); await store.close();
});


test('independent backups of the same exact file merge despite different attachment timestamps', async () => {
  const first = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await first.seed(); const base = await first.exportData(); const parent = (await first.read()).captures[0].id;
  const second = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await second.restore(base);
  const input = { captureId: parent, name: 'shared.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Same exact file from independent workspaces.') };
  const a = await first.attach(input), OriginalDate = globalThis.Date, fixed = Date.parse(a.at) + 10000; let b;
  try { globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [fixed])); } }; b = await second.attach(input); } finally { globalThis.Date = OriginalDate; }
  assert.equal(a.id, b.id); assert.notEqual(a.at, b.at); await first.restore(await second.exportData()); assert.deepEqual((await first.read()).artifacts, [a]);
  await first.close(); await second.close();
});

test('distinct restored permalinks for identical files remain usable without blocking another retry', async () => {
  const first = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await first.seed(); const base = await first.exportData(); const parent = (await first.read()).captures[0].id;
  const second = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await second.reset(); await second.restore(base);
  const input = { captureId: parent, name: 'two-permalinks.txt', mime: 'text/plain', bytes: new TextEncoder().encode('Both original links should remain valid.') };
  const a = await first.attach(input), b = await second.attach(input); assert.notEqual(a.id, b.id);
  await first.restore(await second.exportData()); const before = (await first.read()).artifacts; assert.equal(before.length, 2); assert.ok(before.some(row => row.id === a.id)); assert.ok(before.some(row => row.id === b.id));
  const retried = await first.attach(input); assert.ok([a.id, b.id].includes(retried.id)); assert.deepEqual((await first.read()).artifacts, before); await first.close(); await second.close();
});
