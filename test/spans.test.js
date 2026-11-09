import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, sha256 } from '../public/store.js';
import { spanKey, threadRoot } from '../public/spans.js';
import { openDatabase, request } from '../public/database.js';
const setup = () => { const factory = new IDBFactory(); const options = { indexedDB: factory, legacyStorage: null, broadcast: false }; return { factory, store: createStore(options), second: () => createStore(options) }; };

test('custom named spans are durable, case-insensitive and created once across connections', async () => {
  const { store, second } = setup(); await store.seed(); const other = second();
  const [a, b] = await Promise.all([store.createSpan('  Practice   room  '), other.createSpan('practice room')]);
  assert.equal(a.id, b.id); assert.equal(a.name, 'Practice room');
  assert.equal((await other.read()).spans.filter(s => s.id === a.id).length, 1);
  const saved = await store.capture('A thought with its own context.', a.name);
  assert.equal(saved.span, 'Practice room'); assert.equal((await other.read()).captures.find(c => c.id === saved.id).text, saved.text);
  await assert.rejects(store.createSpan('x'), /between 2 and 40/);
  await assert.rejects(store.capture('Do not invent a destination.', 'Missing Attention Span'), /Create the Attention Span/);
  await store.close(); await other.close();
});

test('nested replies preserve exact parent/source links without promoting work', async () => {
  const { store } = setup(); await store.seed(); const before = await store.read();
  const span = await store.createSpan('Workshop'); const root = await store.capture('Should the exercise come first?', span.name);
  const reply = await store.capture('  Try it with one fictional participant.\r\nKeep the notes.  ', span.name, root.id);
  const nested = await store.capture('What would success look like?', span.name, reply.id);
  const state = await store.read(); assert.deepEqual(state.now, before.now);
  assert.equal(reply.hash, await sha256(reply.text)); assert.equal(nested.parentId, reply.id);
  assert.equal(threadRoot(nested, state.captures).id, root.id);
  await assert.rejects(store.capture('Wrong destination.', 'Learning', root.id), /original Attention Span/);
  const next = setup().store; await next.restore(await store.exportData());
  const restored = await next.read(); assert.deepEqual(restored.captures, state.captures);
  assert.equal(threadRoot(restored.captures.find(c => c.id === nested.id), restored.captures).id, root.id);
  assert.ok(restored.spans.some(s => s.id === spanKey('Workshop'))); await store.close(); await next.close();
});

test('v2 database upgrades preserve old originals and synthesize the span directory', async () => {
  const { factory, store } = setup(); const text = 'An original from the earlier browser release.';
  const capture = { id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: '2026-01-01T00:00:00.000Z', span: 'Learning', sample: false };
  const legacy = await new Promise((resolve, reject) => { const req = factory.open('effort-public-demo', 1); req.onupgradeneeded = () => { for (const table of ['captures', 'meta', 'quarantine', 'drafts']) req.result.createObjectStore(table, { keyPath: ['meta', 'drafts'].includes(table) ? 'key' : 'id' }); }; req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  await new Promise((resolve, reject) => { const tx = legacy.transaction(['captures', 'meta'], 'readwrite'); tx.objectStore('captures').put(capture); tx.objectStore('meta').put({ key: 'initialized', value: true }); tx.oncomplete = resolve; tx.onabort = reject; }); legacy.close();
  await store.seed(); const state = await store.read(); assert.deepEqual(state.captures, [capture]); assert.equal(state.version, 13); assert.ok(state.spans.some(s => s.name === 'Learning'));
  await store.close();
});

test('missing parents, cross-span replies and cycles are refused before restoring any records', async () => {
  const { store } = setup(); await store.seed(); const root = await store.capture('Root.'); const reply = await store.capture('Reply.', 'Unsorted', root.id);
  const original = await store.exportData();
  for (const change of [
    state => { state.captures.find(c => c.id === reply.id).parentId = crypto.randomUUID(); },
    state => { state.captures.find(c => c.id === reply.id).span = 'Learning'; },
    state => { state.captures.find(c => c.id === root.id).parentId = reply.id; },
  ]) {
    const bundle = JSON.parse(original); change(bundle.payload); bundle.sha256 = await sha256(JSON.stringify(bundle.payload));
    await assert.rejects(store.restore(JSON.stringify(bundle)), /parent|cycle|Attention Span/); assert.equal(await store.exportData(), original);
  }
  await store.close();
});

test('damaged parent recovery keeps its replies and permits portable backup', async () => {
  const { factory, store } = setup(); await store.seed(); const root = await store.capture('Parent original.'); const reply = await store.capture('A reply with independent original text.', 'Unsorted', root.id);
  const raw = openDatabase({ factory }); await raw.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').put({ ...root, hash: '0'.repeat(64) })));
  const state = await store.read(); assert.ok(state.captures.some(c => c.id === reply.id)); assert.ok(state.recovery.some(r => r.recordId === root.id));
  const other = setup().store; await other.restore(await store.exportData()); assert.ok((await other.read()).captures.some(c => c.id === reply.id));
  await store.close(); await raw.close(); await other.close();
});

test('damaged live reply cycles are isolated without blocking capture or losing raw copies', async () => {
  const { factory, store } = setup(); await store.seed(); const root = await store.capture('A root original.'); const reply = await store.capture('A reply original.', 'Unsorted', root.id);
  const raw = openDatabase({ factory }); await raw.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').put({ ...root, parentId: reply.id })));
  const newCapture = await store.capture('Capture still works despite damaged thread metadata.'); const state = await store.read();
  assert.ok(state.captures.some(c => c.id === newCapture.id)); assert.equal(state.recovery.filter(r => [root.id, reply.id].includes(r.recordId)).length, 2);
  assert.equal(JSON.parse(state.recovery.find(r => r.recordId === root.id).raw).text, root.text);
  await store.exportData(); await store.close(); await raw.close();
});

test('corrupt span metadata is preserved and reconstructed from valid source records', async () => {
  const { factory, store } = setup(); await store.seed(); const raw = openDatabase({ factory });
  await raw.run(['spans'], 'readwrite', tx => request(tx.objectStore('spans').put({ id: 'learning', name: 42 })));
  const state = await store.read(); assert.ok(state.spans.some(s => s.id === 'learning' && s.name === 'Learning'));
  assert.ok(state.recovery.some(r => r.source === 'span' && r.recordId === 'learning'));
  await store.exportData(); await store.close(); await raw.close();
});
