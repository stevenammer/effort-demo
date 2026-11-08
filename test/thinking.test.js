import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { recoveryRecord } from '../public/records.js';
import { seal } from '../public/intent.js';
import { createThinking, deriveMoves, deriveBranchStatuses, moveSnapshot, validMoveSnapshot, MOVE_SEEDS, validateThinkingState } from '../public/thinking.js';

async function setup() {
  const factory = new IDBFactory(), store = createStore({ indexedDB: factory, legacyStorage: null, broadcast: false }); await store.seed();
  const db = openDatabase({ factory }), thinking = createThinking({ db, recoveryRecord }), state = await store.read();
  const place = await store.holdPlace({ summary: 'Return to the example.', expected: state.now });
  const branch = await store.explore({ sourceId: state.captures[0].id, returnPointId: place.id, dial: 'NORMAL', text: 'A branch.' });
  return { store, db, thinking, branch };
}
async function close(x) { await x.store.close(); await x.db.close(); }
const rows = (x, table) => x.db.run([table], 'readonly', tx => request(tx.objectStore(table).getAll()));

test('neutral branch status preserves history and does not change NOW', async () => {
  const x = await setup(), before = await x.store.read();
  const first = await x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'parked', note: 'Pause here.', expectedLatestId: null });
  const second = await x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'weird_but_alive', note: 'Keep the question.', expectedLatestId: first.id });
  const item = deriveBranchStatuses(await rows(x, 'branchEvents'))[0]; assert.equal(item.latestId, second.id); assert.equal(item.history.length, 2);
  const state = await x.store.read(); assert.deepEqual(state.now, before.now); assert.deepEqual(state.explorations.find(b => b.id === x.branch.id), x.branch);
  await assert.rejects(x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'discarded', expectedLatestId: first.id }), /changed/); await close(x);
});

test('moves are optional, editable and snapshots preserve the old definition', async () => {
  const x = await setup(), seed = MOVE_SEEDS[0], old = moveSnapshot(seed.id, []);
  const revision = await x.thinking.saveMove({ moveId: seed.id, name: 'My wording', prompt: 'My own way of thinking.', enabled: true, expectedLatestId: null });
  const disabled = await x.thinking.saveMove({ moveId: seed.id, name: revision.name, prompt: revision.prompt, enabled: false, expectedLatestId: revision.id });
  const events = await rows(x, 'moveEvents'); assert.equal(validMoveSnapshot(old, events), 'verified');
  assert.equal(validMoveSnapshot({ id: seed.id, revisionId: revision.id, name: revision.name, prompt: revision.prompt }, events), 'verified');
  assert.throws(() => moveSnapshot(seed.id, events), /turned off/); assert.equal(deriveMoves(events).find(m => m.id === seed.id).latestId, disabled.id);
  const custom = await x.thinking.saveMove({ moveId: null, name: 'My move', prompt: 'Look again.', enabled: true, expectedLatestId: null });
  assert.equal(moveSnapshot(custom.moveId, await rows(x, 'moveEvents')).name, 'My move'); await close(x);
});

test('concurrent request retries deduplicate, and mismatched request IDs refuse edits', async () => {
  const x = await setup(), requestId = crypto.randomUUID(), body = { branchId: x.branch.id, status: 'parked', note: 'Keep this.', expectedLatestId: null };
  const saved = await Promise.all(Array.from({ length: 8 }, () => x.thinking.setBranchStatus(body, { requestId })));
  assert.ok(saved.every(r => r.id === saved[0].id)); assert.equal((await rows(x, 'branchEvents')).length, 1);
  await assert.rejects(x.thinking.setBranchStatus({ ...body, note: 'Changed.' }, { requestId }), /different/); await close(x);
});

test('damaged move history is preserved in recovery without changing branch writing', async () => {
  const x = await setup(), seed = MOVE_SEEDS[0];
  const event = await x.thinking.saveMove({ moveId: seed.id, name: 'Edited move', prompt: 'Test this thought.', enabled: true, expectedLatestId: null });
  const snap = { id: seed.id, revisionId: event.id, name: event.name, prompt: event.prompt };
  await x.db.run(['moveEvents'], 'readwrite', tx => request(tx.objectStore('moveEvents').put({ ...event, prompt: 'Damaged.' })));
  await x.thinking.repair(); const state = await x.store.read();
  assert.deepEqual(state.explorations.find(b => b.id === x.branch.id), x.branch);
  const recovery = await x.db.run(['quarantine'], 'readonly', tx => request(tx.objectStore('quarantine').getAll()));
  assert.equal(validMoveSnapshot(snap, [], recovery), 'recovery'); assert.equal(JSON.parse(recovery.find(r => r.source === 'moveEvents').raw).prompt, 'Damaged.');
  await close(x);
});

test('failed readback retry is idempotent and old workspace epoch is fenced', async () => {
  const x = await setup(), requestId = crypto.randomUUID(), epoch = (await x.store.health()).epoch, add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false;
  const body = { branchId: x.branch.id, status: 'distilled', expectedLatestId: null };
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { const result = add.call(this, value, ...args); if (this.name === 'branchEvents') inserted = true; return result; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'branchEvents' && this.transaction.mode === 'readonly' && inserted) throw Error('readback fault'); return get.apply(this, args); };
    await assert.rejects(x.thinking.setBranchStatus(body, { requestId }), /readback fault/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  const saved = await x.thinking.setBranchStatus(body, { requestId }); assert.equal((await rows(x, 'branchEvents')).length, 1); assert.ok(saved.id);
  await x.store.reset(); await assert.rejects(x.thinking.setBranchStatus(body, { expectedEpoch: epoch }), /workspace changed/); await close(x);
});

test('malformed histories cannot enter a backup', async () => {
  await assert.rejects(validateThinkingState({ explorations: [], recovery: [], branchEvents: [null], moveEvents: [] }), /Invalid/);
});

test('status alone is not move evidence and an untagged branch cannot be tagged', async () => {
  const x = await setup();
  const saved = await x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'distilled', expectedLatestId: null });
  assert.equal(saved.evidence, false); assert.equal(deriveBranchStatuses(await rows(x, 'branchEvents'))[0].evidence, false);
  await assert.rejects(x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'distilled', evidence: true, expectedLatestId: saved.id }), /invalid/);
  assert.equal((await rows(x, 'branchEvents')).length, 1); await close(x);
});

test('separate simultaneous edits to the same move cannot silently overwrite each other', async () => {
  const x = await setup(), seed = MOVE_SEEDS[0];
  const outcomes = await Promise.allSettled(['First', 'Second'].map(name => x.thinking.saveMove({ moveId: seed.id, name, prompt: 'My deliberate revision.', enabled: true, expectedLatestId: null })));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1);
  assert.equal((await rows(x, 'moveEvents')).length, 1); await close(x);
});

test('branch status started before reset is fenced during hashing', async () => {
  const x = await setup(), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, entered, blocked = false;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try {
    const pending = x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'parked', expectedLatestId: null }, { requestId: crypto.randomUUID() });
    await started; await x.store.reset(); release(); await assert.rejects(pending, /workspace changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal((await rows(x, 'branchEvents')).length, 0); await close(x);
});

test('evidence is explicitly stored and tied to an actual move-bearing branch', async () => {
  const branchId = crypto.randomUUID(), seed = MOVE_SEEDS[0], snapshot = moveSnapshot(seed.id, []);
  const event = await seal({ id: crypto.randomUUID(), branchId, status: 'active', note: '', evidence: true, previousId: null, at: new Date().toISOString() });
  const state = { branchEvents: [event], moveEvents: [], explorations: [{ id: branchId, move: snapshot }], recovery: [] };
  await validateThinkingState(state); assert.equal(deriveBranchStatuses([event])[0].evidence, true);
  await assert.rejects(validateThinkingState({ ...state, explorations: [{ id: branchId }] }), /invalid/);
  await assert.rejects(validateThinkingState({ ...state, branchEvents: [{ ...event, evidence: false }] }), /checksum/);
});

test('forked or disconnected imported histories are rejected', async () => {
  const branchId = crypto.randomUUID(), at = new Date().toISOString();
  const first = await seal({ id: crypto.randomUUID(), branchId, status: 'parked', note: '', evidence: false, previousId: null, at });
  const left = await seal({ id: crypto.randomUUID(), branchId, status: 'distilled', note: '', evidence: false, previousId: first.id, at });
  const right = await seal({ id: crypto.randomUUID(), branchId, status: 'discarded', note: '', evidence: false, previousId: first.id, at });
  await assert.rejects(validateThinkingState({ branchEvents: [first, left, right], moveEvents: [], explorations: [{ id: branchId }], recovery: [] }), /conflicts/);
});

test('a changed branch checksum cannot be used to add status', async () => {
  const x = await setup();
  await x.db.run(['explorations'], 'readwrite', tx => request(tx.objectStore('explorations').put({ ...x.branch, text: 'Changed without a checksum.' })));
  await assert.rejects(x.thinking.setBranchStatus({ branchId: x.branch.id, status: 'parked', expectedLatestId: null }), /checksum/);
  assert.equal((await rows(x, 'branchEvents')).length, 0); await close(x);
});
