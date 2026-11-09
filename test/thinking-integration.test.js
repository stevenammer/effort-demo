import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { deriveMoves, deriveBranchStatuses, moveSnapshot, MOVE_SEEDS } from '../public/thinking.js';
import { sha256 } from '../public/primitives.js';
async function setup() {
  const factory = new IDBFactory(), store = createStore({ indexedDB: factory, legacyStorage: null, broadcast: false }); await store.seed();
  const db = openDatabase({ factory }), state = await store.read();
  const place = await store.holdPlace({ summary: 'Return here.', expected: state.now });
  const input = { sourceId: state.captures[0].id, returnPointId: place.id, dial: 'NORMAL', text: 'My exact thinking.', move: moveSnapshot(MOVE_SEEDS[0].id, []) };
  const branch = await store.explore(input); return { factory, store, db, state, branch, input };
}
async function close(x) { await x.db.close(); await x.store.close(); }
test('store integrates exact move snapshots, explicit evidence and portable immutable histories', async () => {
  const x = await setup();
  const revision = await x.store.saveMove({ moveId: MOVE_SEEDS[0].id, name: 'Reworded', prompt: 'A new prompt.', enabled: false, expectedLatestId: null });
  const event = await x.store.setBranchStatus({ branchId: x.branch.id, status: 'weird_but_alive', note: 'Still open.', evidence: true, expectedLatestId: null });
  const state = await x.store.read(); assert.deepEqual(state.now, x.state.now); assert.deepEqual(state.explorations[0].move, x.input.move);
  assert.equal(deriveMoves(state.moveEvents)[0].enabled, false); assert.equal(deriveBranchStatuses(state.branchEvents)[0].evidence, true);
  const backup = await x.store.exportData(), target = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false });
  await target.restore(backup); await target.restore(backup); const restored = await target.read();
  assert.equal(restored.version, 17); assert.deepEqual(restored.moveEvents, [revision]); assert.deepEqual(restored.branchEvents, [event]); assert.deepEqual(restored.explorations, state.explorations);
  const legacy = structuredClone(JSON.parse(backup).payload); legacy.version = 8;delete legacy.threadReviews;delete legacy.helperEvents; delete legacy.sourceRevisions; delete legacy.personEvents; delete legacy.contactReceipts; delete legacy.openedReceipts; delete legacy.branchEvents; delete legacy.moveEvents; legacy.explorations = []; legacy.distillations = [];
  const oldTarget = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await oldTarget.restore(JSON.stringify({ payload: legacy, sha256: await sha256(JSON.stringify(legacy)) }));
  assert.deepEqual((await oldTarget.read()).moveEvents, []); await oldTarget.close(); await target.close(); await close(x);
});
test('damaged overrides and statuses stay visibly unknown without changing original writing', async () => {
  const x = await setup();
  const move = await x.store.saveMove({ moveId: MOVE_SEEDS[0].id, name: 'Disabled tool', prompt: 'Keep this private wording.', enabled: false, expectedLatestId: null });
  const event = await x.store.setBranchStatus({ branchId: x.branch.id, status: 'parked', expectedLatestId: null });
  await x.db.run(['moveEvents', 'branchEvents'], 'readwrite', async tx => { await request(tx.objectStore('moveEvents').put({ ...move, name: 'Damaged' })); await request(tx.objectStore('branchEvents').put({ ...event, status: 'active' })); });
  const state = await x.store.read(), definition = deriveMoves(state.moveEvents, state.recovery).find(m => m.id === move.moveId), status = deriveBranchStatuses(state.branchEvents, state.recovery)[0];
  assert.equal(definition.enabled, false); assert.equal(definition.recovery, true); assert.equal(status.status, null); assert.equal(status.recovery, true);
  assert.deepEqual(state.explorations[0], x.branch); assert.deepEqual(state.now, x.state.now); assert.equal(state.recovery.filter(r => ['moveEvents', 'branchEvents'].includes(r.source)).length, 2); await close(x);
});
test('unreadable optional thinking history preserves primary saving and refuses incomplete backups', async () => {
  const x = await setup(), getAll = IDBObjectStore.prototype.getAll;
  try {
    IDBObjectStore.prototype.getAll = function(...args) { if (this.name === 'moveEvents') throw Error('Unavailable thinking fixture'); return getAll.apply(this, args); };
    const state = await x.store.read(); assert.match(state.thinkingWarning, /Unavailable thinking fixture/); assert.deepEqual(state.now, x.state.now); assert.deepEqual(state.captures, x.state.captures);
    await x.store.explore({ ...x.input, move: null, text: 'Writing with no move.' });
    await assert.rejects(x.store.exportData(), /complete backup cannot/);
  } finally { IDBObjectStore.prototype.getAll = getAll; }
  assert.equal((await x.store.read()).explorations.length, 2); await close(x);
});
test('source changed only in a final snapshot is never returned as verified writing', async () => {
  const x = await setup(), getAll = IDBObjectStore.prototype.getAll; let injected = false;
  try {
    IDBObjectStore.prototype.getAll = function(...args) { const req = getAll.apply(this, args); if (!injected && this.name === 'captures' && this.transaction.objectStoreNames.contains('spans') && this.transaction.objectStoreNames.contains('intentEvents')) { injected = true; req.addEventListener('success', () => { const altered = structuredClone(req.result); altered[0].text = 'Unverified race fixture'; Object.defineProperty(req, 'result', { configurable: true, get: () => altered }); }, { once: true }); } return req; };
    assert.deepEqual((await x.store.read()).captures, x.state.captures); assert.equal(injected, true);
  } finally { IDBObjectStore.prototype.getAll = getAll; }
  await close(x);
});

test('restoring a divergent thinking history refuses atomically', async () => {
  const x = await setup(), first = await x.store.setBranchStatus({ branchId: x.branch.id, status: 'active', expectedLatestId: null }), base = await x.store.exportData();
  const other = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await other.restore(base);
  await x.store.setBranchStatus({ branchId: x.branch.id, status: 'parked', expectedLatestId: first.id });
  await other.setBranchStatus({ branchId: x.branch.id, status: 'distilled', expectedLatestId: first.id });
  const before = await other.read(); await assert.rejects(other.restore(await x.store.exportData()), /conflicts/); assert.deepEqual(await other.read(), before); await other.close(); await close(x);
});
test('thinking restore readback failure preserves committed history and allows exact retry', async () => {
  const x = await setup(), row = await x.store.saveMove({ moveId: null, name: 'Restored tool', prompt: 'Exact restored definition.', enabled: true, expectedLatestId: null }), backup = await x.store.exportData();
  const target = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }), add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false, failed = false;
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { const result = add.call(this, value, ...args); if (this.name === 'moveEvents') inserted = true; return result; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'moveEvents' && this.transaction.mode === 'readonly' && inserted && !failed) { failed = true; throw Error('Thinking restore readback fault'); } return get.apply(this, args); };
    await assert.rejects(target.restore(backup), /Thinking restore could not be verified/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  await target.restore(backup); assert.deepEqual((await target.read()).moveEvents, [row]); await target.close(); await close(x);
});
