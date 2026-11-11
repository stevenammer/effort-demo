import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { request } from '../public/database.js';
import { sha256 } from '../public/primitives.js';
import { recoveryRecord } from '../public/records.js';
import { createOpened, deriveOpened, deriveSpanUnread, validateOpenedState, sameOpenedSource } from '../public/opened.js';

async function setup() {
  const factory = new IDBFactory(), opening = factory.open('opened-test', 1);
  opening.onupgradeneeded = () => { for (const name of ['meta', 'captures', 'quarantine', 'openedReceipts']) opening.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' }); };
  const native = await request(opening);
  const db = { async run(tables, mode, work) { const tx = native.transaction(tables, mode), done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); done.catch(() => {}); let out; try { out = await work(tx); } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; } await done; return out; } };
  const opened = createOpened({ db, recoveryRecord });
  async function capture(text, at = '2026-01-01T00:00:00.000Z') { const row = { id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: at, span: 'Unsorted', sample: false }; await db.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').add(row))); return row; }
  const state = () => db.run(['captures', 'quarantine', 'openedReceipts'], 'readonly', async tx => ({ captures: await request(tx.objectStore('captures').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()), openedReceipts: await request(tx.objectStore('openedReceipts').getAll()) }));
  return { db, opened, capture, state, close: () => native.close() };
}

test('concurrent exact-source marks use one portable canonical receipt and preserve source bytes', async () => {
  const x = await setup(), c = await x.capture('Exact post.'), data = { items: [{ id: c.id, hash: c.hash }] };
  const copies = await Promise.all(Array.from({ length: 8 }, () => x.opened.markOpened(data)));
  assert.ok(copies.every(r => sameOpenedSource(r[0], copies[0][0]))); const state = await x.state(); assert.equal(state.openedReceipts.length, 1); assert.deepEqual(state.captures, [c]); assert.ok(deriveOpened(state).opened.has(c.id)); await validateOpenedState(state); x.close();
});

test('per-span unread state is derived from portable exact opening receipts', async () => {
  const x = await setup(), a = await x.capture('Read post.'), b = await x.capture('Unread post.');
  await x.opened.markOpened({ items: [{ id: a.id, hash: a.hash }] });
  const status = deriveSpanUnread(await x.state(), 'Unsorted');
  assert.deepEqual(status, { total: 2, unread: 1, read: 1, unknown: 0 });
  // The derived state has no write path and cannot make later capture fail.
  const c = await x.capture('Capture remains available.');
  assert.equal(deriveSpanUnread(await x.state(), 'Unsorted').unread, 2);
  assert.equal(c.text, 'Capture remains available.'); x.close();
});

test('opening an older snapshot never marks a later or backdated reply', async () => {
  const x = await setup(), a = await x.capture('First.', '2026-04-01T00:00:00.000Z'), selection = [{ id: a.id, hash: a.hash }];
  const b = await x.capture('Later but backdated.', '2020-01-01T00:00:00.000Z'); await x.opened.markOpened({ items: selection });
  const seen = deriveOpened(await x.state()); assert.ok(seen.opened.has(a.id)); assert.ok(!seen.opened.has(b.id)); x.close();
});

test('readback failure retries without duplicate receipts', async () => {
  const x = await setup(), c = await x.capture('Retry.'), add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let saved = false;
  try { IDBObjectStore.prototype.add = function(value, ...args) { const out = add.call(this, value, ...args); if (this.name === 'openedReceipts') saved = true; return out; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'openedReceipts' && this.transaction.mode === 'readonly' && saved) throw Error('readback fault'); return get.apply(this, args); };
    await assert.rejects(x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] }), /readback fault/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  await x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] }); assert.equal((await x.state()).openedReceipts.length, 1); x.close();
});

test('corrupt receipt is preserved and makes live source unknown until explicitly reopened', async () => {
  const x = await setup(), c = await x.capture('A thought.'), [row] = await x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] });
  await x.db.run(['openedReceipts'], 'readwrite', tx => request(tx.objectStore('openedReceipts').put({ ...row, at: 'corrupt' })));
  await x.opened.repair(); let state = await x.state(), seen = deriveOpened(state); assert.ok(seen.unknown.has(c.id)); assert.ok(!seen.opened.has(c.id));
  assert.equal(JSON.parse(state.recovery[0].raw).at, 'corrupt'); await x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] }); state = await x.state(); seen = deriveOpened(state);
  assert.ok(seen.opened.has(c.id)); assert.ok(!seen.unknown.has(c.id)); x.close();
});

test('rejects malformed, duplicate and mismatched items without partial writes', async () => {
  const x = await setup(), c = await x.capture('A thought.'), item = { id: c.id, hash: c.hash };
  await assert.rejects(x.opened.markOpened({ items: [item, item] }), /invalid/); await assert.rejects(x.opened.markOpened({ items: [{ ...item, hash: 'a'.repeat(64) }] }), /changed/);
  await assert.rejects(x.opened.markOpened({ items: [{ ...item, extra: true }] }), /invalid/); assert.equal((await x.state()).openedReceipts.length, 0); x.close();
});

test('reset during hashing fences even previously valid requested sources', async () => {
  const x = await setup(), c = await x.capture('Before reset.'), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, entered, blocked = false;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try { const pending = x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] }); await started;
    await x.db.run(['meta', 'captures', 'openedReceipts'], 'readwrite', async tx => { await request(tx.objectStore('captures').clear()); await request(tx.objectStore('openedReceipts').clear()); await request(tx.objectStore('meta').put({ key: 'epoch', value: crypto.randomUUID() })); });
    release(); await assert.rejects(pending, /workspace changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal((await x.state()).openedReceipts.length, 0); x.close();
});

test('empty input still checks epoch', async () => {
  const x = await setup(); await x.db.run(['meta'], 'readwrite', tx => request(tx.objectStore('meta').put({ key: 'epoch', value: crypto.randomUUID() })));
  await assert.rejects(x.opened.markOpened({ items: [] }, { expectedEpoch: null }), /workspace changed/); assert.deepEqual(await x.opened.markOpened({ items: [] }), []); x.close();
});

test('a changed source during hashing refuses the entire batch', async () => {
  const x = await setup(), c = await x.capture('Before change.'), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, entered, blocked = false;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try { const pending = x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] }); await started;
    await x.db.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').put({ ...c, text: 'Changed during save.' })));
    release(); await assert.rejects(pending, /source post changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal((await x.state()).openedReceipts.length, 0); x.close();
});

test('missing source requires a matching raw capture recovery entry', async () => {
  const x = await setup(), c = await x.capture('Preserve this.'), [row] = await x.opened.markOpened({ items: [{ id: c.id, hash: c.hash }] });
  const recovered = await recoveryRecord('capture', c.id, JSON.stringify(c), 'Needs recovery.');
  await validateOpenedState({ openedReceipts: [row], captures: [], recovery: [recovered] });
  await assert.rejects(validateOpenedState({ openedReceipts: [row], captures: [], recovery: [] }), /missing its source/);
  await assert.rejects(validateOpenedState({ openedReceipts: [{ ...row, at: '2024-01-01T00:00:00.000Z' }], captures: [c], recovery: [] }), /checksum/); x.close();
});
