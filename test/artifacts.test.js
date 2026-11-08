import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { createArtifacts, artifactBytes, artifactPreview, artifactSourceStatus, validateArtifactState } from '../public/artifacts.js';
import { recoveryRecord } from '../public/records.js';

async function setup() {
  const factory = new IDBFactory(), store = createStore({ indexedDB: factory, legacyStorage: null, broadcast: false });
  await store.seed(); const db = openDatabase({ factory }), artifact = createArtifacts({ db, recoveryRecord });
  const capture = (await store.read()).captures[0]; return { store, db, artifact, capture };
}
async function close(x) { await x.store.close(); await x.db.close(); }
const input = x => ({ captureId: x.capture.id, name: 'sample.txt', mime: 'text/plain', bytes: new TextEncoder().encode('  Exact <script>text</script>\n😀  ') });

test('exact bytes and safe plain text preview survive concurrent retry without changing NOW', async () => {
  const x = await setup(), before = await x.store.read(), data = input(x);
  const all = await Promise.all(Array.from({ length: 8 }, () => x.artifact.attach(data)));
  assert.ok(all.every(a => a.id === all[0].id)); assert.deepEqual(artifactBytes(all[0]), data.bytes);
  assert.deepEqual(artifactPreview(all[0]), { text: '  Exact <script>text</script>\n😀  ', truncated: false });
  assert.deepEqual((await x.store.read()).now, before.now);
  const rows = await x.db.run(['artifacts'], 'readonly', tx => request(tx.objectStore('artifacts').getAll())); assert.equal(rows.length, 1);
  await close(x);
});

test('preview rejects unsafe types and invalid UTF-8 and identifies truncation', async () => {
  const x = await setup();
  const html = await x.artifact.attach({ ...input(x), name: 'a.html', mime: 'text/html' }); assert.equal(artifactPreview(html), null);
  const bad = await x.artifact.attach({ ...input(x), name: 'bad.txt', bytes: new Uint8Array([255]) }); assert.equal(artifactPreview(bad), null);
  const long = await x.artifact.attach({ ...input(x), name: 'long.txt', bytes: new TextEncoder().encode('😀'.repeat(4001)) });
  assert.equal(Array.from(artifactPreview(long).text).length, 4000); assert.equal(artifactPreview(long).truncated, true); await close(x);
});

test('readback failure retries without duplicate, and reset epoch fences stale form', async () => {
  const x = await setup(), data = input(x), old = (await x.store.health()).epoch, add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false;
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { const r = add.call(this, value, ...args); if (this.name === 'artifacts') inserted = true; return r; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'artifacts' && this.transaction.mode === 'readonly' && inserted) throw Error('readback fault'); return get.apply(this, args); };
    await assert.rejects(x.artifact.attach(data), /readback fault/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  const saved = await x.artifact.attach(data); assert.ok(saved.id);
  await x.store.reset(); const fresh = await x.store.capture('A new source.');
  await assert.rejects(x.artifact.attach({ ...data, captureId: fresh.id }, { expectedEpoch: old }), /workspace changed/); await close(x);
});

test('tampered attachment is quarantined intact; missing source with raw recovery stays accessible', async () => {
  const x = await setup(), row = await x.artifact.attach(input(x));
  await x.db.run(['artifacts'], 'readwrite', tx => request(tx.objectStore('artifacts').put({ ...row, data: 'AAAA' })));
  await x.artifact.repair(); const r = await x.db.run(['artifacts', 'quarantine'], 'readonly', async tx => [await request(tx.objectStore('artifacts').getAll()), await request(tx.objectStore('quarantine').getAll())]);
  assert.equal(r[0].length, 0); assert.equal(JSON.parse(r[1].find(q => q.source === 'artifacts').raw).data, 'AAAA');
  const recovery = await recoveryRecord('capture', x.capture.id, JSON.stringify(x.capture), 'Source needs recovery.');
  await validateArtifactState({ artifacts: [row], captures: [], recovery: [recovery] }); assert.equal(artifactSourceStatus(row, { captures: [], recovery: [recovery] }), 'recovery');
  await assert.rejects(validateArtifactState({ artifacts: [row], captures: [], recovery: [] }), /missing its source/); await close(x);
});

test('rejects invalid names, malformed encodings and files above per-file limit', async () => {
  const x = await setup();
  await assert.rejects(x.artifact.attach({ ...input(x), name: '../file' }), /valid name/);
  await assert.rejects(x.artifact.attach({ ...input(x), bytes: new Uint8Array(2 * 1024 * 1024 + 1) }), /2 MiB/);
  assert.throws(() => artifactBytes({ data: 'AB==' }), /encoding/); await close(x);
});

test('portable capacity rejects the next large file while retaining the earlier exact files', async () => {
  const x = await setup(), bytes = new Uint8Array(2 * 1024 * 1024); bytes[0] = 71; bytes[bytes.length - 1] = 127;
  const first = await x.artifact.attach({ ...input(x), name: 'one.bin', mime: 'application/octet-stream', bytes });
  const second = await x.artifact.attach({ ...input(x), name: 'two.bin', mime: 'application/octet-stream', bytes });
  await assert.rejects(x.artifact.attach({ ...input(x), name: 'three.bin', mime: 'application/octet-stream', bytes }), /portable limit/);
  const rows = await x.db.run(['artifacts'], 'readonly', tx => request(tx.objectStore('artifacts').getAll()));
  assert.equal(rows.length, 2); assert.deepEqual(artifactBytes(rows.find(r => r.id === first.id)), bytes); assert.deepEqual(artifactBytes(rows.find(r => r.id === second.id)), bytes); await close(x);
});

test('failed storage keeps the post and permits a clean retry', async () => {
  const x = await setup(), add = IDBObjectStore.prototype.add;
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { if (this.name === 'artifacts') throw Error('attachment write unavailable'); return add.call(this, value, ...args); };
    await assert.rejects(x.artifact.attach(input(x)), /write unavailable/);
  } finally { IDBObjectStore.prototype.add = add; }
  const state = await x.store.read(); assert.ok(state.captures.some(c => c.id === x.capture.id));
  const row = await x.artifact.attach(input(x)); assert.deepEqual(artifactBytes(row), input(x).bytes); await close(x);
});

test('binary bytes including NUL survive an exact decode', async () => {
  const x = await setup(), bytes = new Uint8Array([0, 255, 128, 0, 10, 13, 32, 0, 1]);
  const row = await x.artifact.attach({ ...input(x), name: 'binary.dat', mime: 'application/octet-stream', bytes });
  assert.deepEqual(artifactBytes(row), bytes); assert.equal(artifactPreview(row), null); await close(x);
});

test('malformed current row is quarantined without blocking capture', async () => {
  const x = await setup(), bad = { id: crypto.randomUUID(), data: '{broken raw attachment' };
  await x.db.run(['artifacts'], 'readwrite', tx => request(tx.objectStore('artifacts').put(bad))); await x.artifact.repair();
  const captured = await x.store.capture('Fresh original after damage.'); assert.ok(captured.id);
  const recovery = await x.db.run(['quarantine'], 'readonly', tx => request(tx.objectStore('quarantine').getAll()));
  assert.deepEqual(JSON.parse(recovery.find(r => r.source === 'artifacts').raw), bad); await close(x);
});

test('a reset while attachment hashing is pending cannot write into the new workspace', async () => {
  const x = await setup(), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, entered, blocked = false;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try {
    const pending = x.artifact.attach(input(x)); await started; await x.store.reset(); release();
    await assert.rejects(pending, /workspace changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  const rows = await x.db.run(['artifacts'], 'readonly', tx => request(tx.objectStore('artifacts').getAll())); assert.equal(rows.length, 0); await close(x);
});

test('source mutation while hashing cannot attach to changed bytes', async () => {
  const x = await setup(), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, entered, blocked = false;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try {
    const pending = x.artifact.attach(input(x)); await started;
    await x.db.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').put({ ...x.capture, text: 'Changed while saving.' })));
    release(); await assert.rejects(pending, /source post changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  const rows = await x.db.run(['artifacts'], 'readonly', tx => request(tx.objectStore('artifacts').getAll())); assert.equal(rows.length, 0); await close(x);
});

test('backup restore after reset reuses the exact matching file across epochs', async () => {
  const x = await setup(), data = input(x), saved = await x.artifact.attach(data), backup = await x.store.exportData();
  await x.store.reset(); await x.store.restore(backup);
  const restored = (await x.store.read()).artifacts; assert.deepEqual(restored, [saved]);
  const retried = await x.store.attach(data); assert.deepEqual(retried, saved); assert.equal((await x.store.read()).artifacts.length, 1); await close(x);
});
