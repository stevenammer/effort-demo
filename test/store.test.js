import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createStore, KEY, LIMITS, sha256 } from '../public/store.js';
globalThis.crypto ??= webcrypto;
function memory() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; }

test('capture verifies the exact original and does not promote an inferred task', async () => {
  const store = createStore(memory(), null); await store.seed(); const chosen = (await store.read()).now;
  const text = '  Maybe try a workshop exercise.\r\nI\'ll write the outline tomorrow. 🧠  ';
  const capture = await store.capture(text, 'Learning');
  assert.equal(capture.text, text); assert.equal(capture.hash, await sha256(text));
  assert.deepEqual((await store.read()).now, chosen);
  await store.choose(capture.id, 2, 31); const state = await store.read();
  assert.equal(state.now.quote, text.slice(2, 31)); assert.equal(state.captures.at(-1).text, text);
  await store.complete(); assert.equal((await store.read()).now, null); assert.equal((await store.read()).captures.at(-1).text, text);
});
test('unreadable or failed persistence is never reported as a successful save', async () => {
  const storage = memory(); const store = createStore(storage, null); await store.seed();
  storage.setItem = () => { throw Error('No browser storage'); };
  await assert.rejects(store.capture('Keep the draft.'), /No browser storage/);
  assert.equal((await store.read()).captures.length, 2);
});
test('readback detects altered text even if storage accepted the write', async () => {
  const storage = memory(); const store = createStore(storage, null); await store.seed();
  const set = storage.setItem;
  storage.setItem = (key, raw) => { const s = JSON.parse(raw); s.captures.at(-1).text += ' changed'; set(key, JSON.stringify(s)); };
  await assert.rejects(store.capture('An exact source.'), /could not be verified/);
});
test('concurrent captures survive without losing prior originals', async () => {
  const storage = memory(); const a = createStore(storage, null), b = createStore(storage, null);
  await a.seed(); await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).capture(`Fictional thought ${i}.`)));
  const state = await a.read(); assert.equal(state.captures.length, 10); assert.equal(new Set(state.captures.map(c => c.id)).size, 10);
});
test('a checksum-checked backup restores additively and repeat restore adds no duplicates', async () => {
  const a = createStore(memory(), null); await a.seed(); await a.capture('Keep these exact words.'); const original = await a.read();
  const raw = await a.exportData(), b = createStore(memory(), null);
  assert.equal(await b.restore(raw), 3); assert.deepEqual(await b.read(), original); assert.equal(await b.restore(raw), 0);
  await b.capture('A newer local thought.'); assert.equal(await b.restore(raw), 0); assert.equal((await b.read()).captures.length, 4);
});
test('tampered backups, broken source links and duplicate IDs fail before writing', async () => {
  const store = createStore(memory(), null); await store.seed(); const before = await store.exportData();
  let bundle = JSON.parse(before); bundle.payload.captures[0].text = 'Different original';
  await assert.rejects(store.restore(JSON.stringify(bundle)), /checksum mismatch/);
  bundle = JSON.parse(before); bundle.payload.now.quote = 'Invented next step'; bundle.sha256 = await sha256(JSON.stringify(bundle.payload));
  await assert.rejects(store.restore(JSON.stringify(bundle)), /does not match/);
  bundle = JSON.parse(before); bundle.payload.captures.push(bundle.payload.captures[0]); bundle.sha256 = await sha256(JSON.stringify(bundle.payload));
  await assert.rejects(store.restore(JSON.stringify(bundle)), /invalid capture/);
  assert.equal(await store.exportData(), before);
});
test('conflicting IDs never overwrite an existing original or partially restore earlier records', async () => {
  const source = createStore(memory(), null); await source.seed(); const raw = await source.exportData();
  const target = createStore(memory(), null); await target.restore(raw); const before = await target.exportData();
  const bundle = JSON.parse(raw); bundle.payload.captures.reverse(); bundle.payload.captures[1].text = 'Different valid text.';
  bundle.payload.captures[1].hash = await sha256(bundle.payload.captures[1].text); bundle.payload.now = null;
  bundle.sha256 = await sha256(JSON.stringify(bundle.payload));
  await assert.rejects(target.restore(JSON.stringify(bundle)), /same ID differs/); assert.equal(await target.exportData(), before);
});
test('bounded storage, malformed states and prototype-shaped JSON are rejected safely', async () => {
  const storage = memory(); const store = createStore(storage, null);
  await assert.rejects(store.capture('x'.repeat(LIMITS.text + 1)), /4,000/);
  await assert.rejects(store.restore('x'.repeat(LIMITS.backupBytes + 1)), /512 KB/);
  storage.setItem(KEY, '{broken'); await assert.rejects(store.read());
  storage.setItem(KEY, '{"version":1,"kind":"effort-browser-demo","captures":[],"now":null,"__proto__":{"polluted":true}}');
  await assert.rejects(store.read(), /not a supported/);
  assert.equal({}.polluted, undefined);
  await store.reset(); assert.equal((await store.read()).captures.length, 0);
});
test('clearing demo data does not reseed without an explicit sample request', async () => {
  const storage = memory(), store = createStore(storage, null); await store.seed(); await store.reset(); await store.seed();
  assert.equal((await store.read()).captures.length, 0); await store.seed(true); assert.equal((await store.read()).captures.length, 2);
  storage.setItem('unrelated-app-data', 'keep'); await store.reset(); assert.equal(storage.getItem('unrelated-app-data'), 'keep');
});
test('a stale Done action cannot clear a newly chosen step', async () => {
  const store = createStore(memory(), null); await store.seed(); const previous = (await store.read()).now;
  const next = await store.capture("I'll test a different outline."); await store.choose(next.id, 0, next.text.length);
  await assert.rejects(store.complete(previous), /changed in another tab/);
  assert.equal((await store.read()).now.quote, next.text);
});
test('capture-count admission remains bounded under concurrent attempts', async () => {
  const store = createStore(memory(), null); await store.seed();
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => store.capture(`Fictional entry ${i}.`)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, LIMITS.captures - 2);
  assert.equal((await store.read()).captures.length, LIMITS.captures);
});
