import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, sha256 } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { deriveCommitments } from '../public/intent.js';
const setup = () => { const factory = new IDBFactory(), options = { indexedDB: factory, legacyStorage: null, broadcast: false }; return { store: createStore(options), another: () => createStore(options), raw: openDatabase({ factory }) }; };
const chooseText = async (store, text) => { const c = await store.capture(text); return store.choose(c.id, 0, text.length); };

test('explicit selection is idempotent, keeps prior commitments, and capture never promotes', async () => {
  const { store } = setup(); await store.seed(); const initial = await store.read();
  const next = await store.capture('A new possible step.'); assert.equal((await store.read()).intentEvents.length, initial.intentEvents.length);
  await store.choose(next.id, 0, next.text.length); const chosen = await store.read(), count = chosen.intentEvents.length;
  await store.choose(next.id, 0, next.text.length); assert.equal((await store.read()).intentEvents.length, count);
  const commitments = deriveCommitments(chosen.intentEvents); assert.equal(commitments.filter(c => c.state === 'ACTIVE').length, 1); assert.equal(commitments.filter(c => c.state === 'COMMITTED').length, 1);
  assert.deepEqual(chosen.captures.find(c => c.id === next.id), next);
  await assert.rejects(store.choose(next.id, 0, next.text.length, { dial: 'unhinged' }), /cannot create commitments/); await store.close();
});

test('completion keeps a hash-checked self-reported receipt and chooses no replacement', async () => {
  const { store } = setup(); await store.seed(); const selected = await chooseText(store, 'Review the fictional outline.');
  await store.complete(selected.now, '  I reviewed the outline and kept my notes.  '); const done = await store.read(), items = deriveCommitments(done.intentEvents);
  const completed = items.find(c => c.state === 'COMPLETE'); assert.ok(completed); assert.equal(completed.receipt.receipt, 'self-report'); assert.equal(completed.receipt.note, '  I reviewed the outline and kept my notes.  '); assert.equal(done.now, null);
  assert.ok(items.some(c => c.state === 'COMMITTED')); assert.ok(done.captures.some(c => c.id === completed.choice.captureId));
  const next = setup().store; await next.restore(await store.exportData()); assert.deepEqual((await next.read()).intentEvents, done.intentEvents);
  await store.complete(null); assert.equal((await store.read()).intentEvents.length, done.intentEvents.length); await store.close(); await next.close();
});

test('saved context restores the exact prior NOW and has an idempotent resumption receipt', async () => {
  const { store } = setup(); await store.seed(); const original = (await store.read()).now;
  const place = await store.holdPlace({ summary: 'The opening example is drafted.', nextAction: 'Read the second paragraph.', route: 'span/product%20demo', context: { scrollY: 230, spanSearch: 'opening', sourceExpanded: true }, expected: original });
  assert.deepEqual((await store.read()).now, original); const changed = await chooseText(store, 'Check a different fictional note.');
  const resumed = await store.resumePlace(place.id, changed.now); assert.deepEqual(resumed.state.now, original); assert.equal(resumed.route, 'span/product%20demo'); assert.deepEqual(resumed.place.context, { scrollY: 230, spanSearch: 'opening', sourceExpanded: true }); assert.equal(resumed.state.resumptions.length, 1);
  assert.equal(resumed.state.resumptions[0].kind, 'resumed');
  const otherChoice = await chooseText(store, 'A deliberately later choice.'); const repeat = await store.resumePlace(place.id, otherChoice.now); assert.equal(repeat.alreadyHandled, true);
  assert.deepEqual((await store.read()).now, otherChoice.now, 'replaying resume cannot overwrite a subsequent explicit choice'); await store.close();
});

test('completed work cannot be silently reactivated by a saved place or an old backup', async () => {
  const { store } = setup(); await store.seed(); const selected = (await store.read()).now;
  const place = await store.holdPlace({ summary: 'Keep this return point.', expected: selected }); const old = await store.exportData();
  await store.complete(selected, 'Finished this fictional step.'); await assert.rejects(store.resumePlace(place.id, null), /already complete/);
  await store.restore(old); const state = await store.read(); assert.equal(state.now, null); assert.equal(deriveCommitments(state.intentEvents).filter(c => c.state === 'COMPLETE').length, 1); assert.equal(state.recovery.length, 0);
  await store.resumePlace(place.id, null, { closeOnly: true }); assert.equal((await store.read()).resumptions[0].kind, 'closed'); await store.close();
});

test('merging independent backups preserves the current NOW and keeps restored commitments', async () => {
  const a = setup().store, b = setup().store; await a.seed(); await b.seed(); const before = (await a.read()).now;
  await a.restore(await b.exportData()); const merged = await a.read(), commitments = deriveCommitments(merged.intentEvents);
  assert.deepEqual(merged.now, before); assert.equal(commitments.filter(c => c.state === 'ACTIVE').length, 1); assert.equal(commitments.filter(c => c.state === 'COMMITTED').length, 1); assert.equal(merged.recovery.length, 0);
  await a.restore(await b.exportData()); assert.equal((await a.read()).intentEvents.length, merged.intentEvents.length); await a.close(); await b.close();
});

test('a failed receipt transaction cannot clear NOW or fabricate completion', async () => {
  const { store } = setup(); await store.seed(); const state = await store.read(), add = IDBObjectStore.prototype.add;
  try {
    IDBObjectStore.prototype.add = function(value, ...rest) { if (this.name === 'intentEvents' && value.state === 'COMPLETE') throw Error('Receipt storage unavailable'); return add.call(this, value, ...rest); };
    await assert.rejects(store.complete(state.now), /storage unavailable/); const after = await store.read(); assert.deepEqual(after.now, state.now); assert.equal(after.intentEvents.length, state.intentEvents.length);
  } finally { IDBObjectStore.prototype.add = add; await store.close(); }
});

test('dropping keeps a rationale and requires a fresh version of the commitment', async () => {
  const { store } = setup(); await store.seed(); const item = deriveCommitments((await store.read()).intentEvents)[0];
  await assert.rejects(store.dropCommitment(item.id, 'Changed priorities.', crypto.randomUUID()), /changed/);
  await store.dropCommitment(item.id, '  Changed priorities, keeping the thought.  ', item.latestId);
  const state = await store.read(), dropped = deriveCommitments(state.intentEvents)[0]; assert.equal(state.now, null); assert.equal(dropped.state, 'DROPPED'); assert.equal(dropped.history.find(e => e.state === 'DROPPED').note, '  Changed priorities, keeping the thought.  '); assert.equal(state.captures.length, 2); await store.close();
});

test('damaged commitment history is isolated while source capture remains available', async () => {
  const { store, raw } = setup(); await store.seed(); const before = await store.read(), event = before.intentEvents[0];
  await raw.run(['intentEvents'], 'readwrite', tx => request(tx.objectStore('intentEvents').put({ ...event, note: 'Changed without a matching checksum.' })));
  const fresh = await store.capture('Another thought still saves.'); const state = await store.read(); assert.ok(state.captures.some(c => c.id === fresh.id)); assert.equal(state.now, null); assert.equal((await store.health()).heldNow, true); assert.ok(state.recovery.some(r => r.source === 'intentEvents'));
  await store.choose(fresh.id, 0, fresh.text.length, { makeNow: false });
  assert.equal((await store.health()).heldNow, true, 'an unrelated commitment does not resolve the damaged prior NOW');
  const kept = deriveCommitments((await store.read()).intentEvents).find(c => c.choice.captureId === fresh.id);
  await store.dropCommitment(kept.id, 'Keep the thought without this commitment.', kept.latestId);
  assert.equal((await store.health()).heldNow, true, 'dropping unrelated work also preserves the recovery state');
  await store.exportData(); await store.close(); await raw.close();
});

test('outer backup checksums cannot hide an altered completion receipt', async () => {
  const { store } = setup(); await store.seed(); await store.complete((await store.read()).now); const before = await store.exportData(), bundle = JSON.parse(before);
  bundle.payload.intentEvents.find(e => e.state === 'COMPLETE').note = 'A fabricated replacement receipt.'; bundle.sha256 = await sha256(JSON.stringify(bundle.payload));
  await assert.rejects(store.restore(JSON.stringify(bundle)), /checksum does not match/); assert.equal(await store.exportData(), before); await store.close();
});

test('pre-upgrade backups cannot create a second promotion for an already completed source', async () => {
  const { store } = setup(); await store.seed(); const before = await store.read(); await store.complete(before.now); const count = (await store.read()).intentEvents.length;
  for (const version of [1, 2, 3]) {
    const payload = { version, kind: before.kind, captures: before.captures, now: before.now, ...(version >= 2 ? { recovery: before.recovery } : {}), ...(version >= 3 ? { spans: before.spans } : {}) };
    await store.restore(JSON.stringify({ payload, sha256: await sha256(JSON.stringify(payload)) }));
    const state = await store.read(); assert.equal(state.now, null); assert.equal(state.intentEvents.length, count); assert.equal(state.recovery.length, 0);
  }
  await store.close();
});

test('accepted but altered completion bytes never produce a verified success receipt', async () => {
  const { store } = setup(); await store.seed(); const state = await store.read(), add = IDBObjectStore.prototype.add;
  try {
    IDBObjectStore.prototype.add = function(value, ...rest) { return add.call(this, this.name === 'intentEvents' && value.state === 'COMPLETE' ? { ...value, note: 'Unexpected altered bytes.' } : value, ...rest); };
    await assert.rejects(store.complete(state.now, 'The exact completion note.'), /could not be verified/);
    const after = await store.read(); assert.equal(deriveCommitments(after.intentEvents).some(c => c.state === 'COMPLETE'), false); assert.ok(after.recovery.some(r => r.source === 'intentEvents' && JSON.parse(r.raw).note === 'Unexpected altered bytes.'));
  } finally { IDBObjectStore.prototype.add = add; await store.close(); }
});

test('concurrent promotion of the same exact source produces one commitment', async () => {
  const { store, another } = setup(); await store.seed(); const source = await store.capture('One deliberate choice.'); const other = another();
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? store : other).choose(source.id, 0, source.text.length)));
  const state = await store.read(); assert.equal(deriveCommitments(state.intentEvents).filter(c => c.choice.captureId === source.id).length, 1); assert.equal(deriveCommitments(state.intentEvents).filter(c => c.state === 'ACTIVE').length, 1);
  await store.close(); await other.close();
});

test('hold request retries and concurrent tabs reuse exact return point after NOW changes', async () => {
 const { store, another } = setup(), other = another(); await store.seed(); const original = (await store.read()).now, requestId = crypto.randomUUID();
 const input = { summary: 'A saved place', nextAction: 'Resume here', expected: original };
 const [a,b] = await Promise.all([store.holdPlace(input, { requestId }), other.holdPlace(input, { requestId })]); assert.deepEqual(a,b);
 assert.equal((await store.read()).places.length, 1); const changed = await chooseText(store, 'Choose something else.');
 assert.deepEqual(await store.holdPlace(input, { requestId }), a); assert.deepEqual((await store.read()).now, changed.now);
 await assert.rejects(store.holdPlace({ ...input, summary: 'Different' }, { requestId }), /different return point/);
 await assert.rejects(store.holdPlace(input, { requestId: 'invalid' }), /invalid/); await store.close(); await other.close();
});

test('hold readback failure retries without adding a duplicate', async () => {
 const { store } = setup(); await store.seed(); const input = { summary: 'Retry after readback', expected: (await store.read()).now }, requestId = crypto.randomUUID();
 const original = IDBObjectStore.prototype.get; let calls = 0;
 IDBObjectStore.prototype.get = function (...args) { if (this.name === 'places' && ++calls === 2) throw Error('readback fault'); return original.apply(this, args); };
 try { await assert.rejects(store.holdPlace(input, { requestId }), /readback fault/); } finally { IDBObjectStore.prototype.get = original; }
 const retry = await store.holdPlace(input, { requestId }); assert.equal((await store.read()).places.length, 1); assert.equal((await store.read()).places[0].id, retry.id); await store.close();
});

test('hold in flight across reset cannot write into the new workspace', async () => {
 const { store } = setup(); await store.seed(); const expected = (await store.read()).now, requestId = crypto.randomUUID();
 const original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, started; const gate = new Promise(r => { release = r; }), entered = new Promise(r => { started = r; }); let blocked = false;
 Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; started(); await gate; } return original.subtle.digest(...args); } } } });
 try { const pending = store.holdPlace({ summary: 'Old workspace', expected }, { requestId }); await entered; await store.reset(); release(); await assert.rejects(pending, /changed/); }
 finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
 assert.equal((await store.read()).places.length, 0); await store.close();
});
