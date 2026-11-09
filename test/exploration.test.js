import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore } from '../public/store.js';
import { createExploration, validateExplorationState, DISTILLATION_TYPES } from '../public/exploration.js';
import { openDatabase, request } from '../public/database.js';
import { recoveryRecord, sha256 } from '../public/records.js';
import { seal } from '../public/intent.js';
import { createDraftShelf } from '../public/drafts.js';

async function setup() {
  const factory = new IDBFactory(), opts = { indexedDB: factory, legacyStorage: null, broadcast: false };
  const store = createStore(opts); await store.seed();
  const db = openDatabase({ factory });
  const exploration = createExploration({ db, recoveryRecord });
  const state = await store.read(), place = await store.holdPlace({ summary: 'Return to the example.', expected: state.now });
  return { store, db, exploration, sourceId: state.captures[0].id, returnPointId: place.id };
}

test('nested branches preserve provenance and self-authored distillation without changing NOW', async () => {
  const x = await setup(), before = await x.store.read();
  const root = await x.exploration.explore({ sourceId: x.sourceId, returnPointId: x.returnPointId, dial: 'UNHINGED SANDBOX', text: 'Try the strange idea.' });
  const child = await x.exploration.explore({ sourceId: x.sourceId, parentId: root.id, returnPointId: x.returnPointId, dial: 'NORMAL', text: 'Consider it carefully.' });
  for (const type of DISTILLATION_TYPES) {
    const d = await x.exploration.distill({ explorationId: child.id, type, text: `My ${type}` }); assert.equal(d.author, 'self');
  }
  assert.equal(root.author, 'self'); assert.equal(child.parentId, root.id);
  assert.deepEqual((await x.store.read()).now, before.now);
  await assert.rejects(x.exploration.explore({ sourceId: x.sourceId, parentId: root.id, returnPointId: crypto.randomUUID(), dial: 'WILD', text: 'Broken provenance.' }), /provenance|parent/);
  await x.store.close(); await x.db.close();
});

test('request retries are idempotent, conflicts refused and bad types rejected', async () => {
  const x = await setup(), id = crypto.randomUUID(), input = { sourceId: x.sourceId, returnPointId: x.returnPointId, dial: 'TIGHT', text: 'One branch.' };
  const first = await x.exploration.explore(input, { requestId: id }); assert.deepEqual(await x.exploration.explore(input, { requestId: id }), first);
  await assert.rejects(x.exploration.explore({ ...input, text: 'Different.' }, { requestId: id }), /different/);
  await assert.rejects(x.exploration.distill({ explorationId: first.id, type: 'COMMITMENT', text: 'No automatic action.' }), /invalid/);
  await x.store.close(); await x.db.close();
});

test('altered branch and dependent distillation are quarantined intact', async () => {
  const x = await setup(); const branch = await x.exploration.explore({ sourceId: x.sourceId, returnPointId: x.returnPointId, dial: 'WILD', text: 'Original text.' });
  await x.exploration.distill({ explorationId: branch.id, type: 'INSIGHT', text: 'A thought.' });
  await x.db.run(['explorations'], 'readwrite', tx => request(tx.objectStore('explorations').put({ ...branch, text: 'Tampered.' })));
  await x.exploration.repair();
  const rows = await x.db.run(['explorations', 'distillations', 'quarantine'], 'readonly', async tx => Promise.all(['explorations', 'distillations', 'quarantine'].map(t => request(tx.objectStore(t).getAll()))));
  assert.equal(rows[0].length, 0); assert.equal(rows[1].length, 0); assert.equal(rows[2].length, 2); assert.match(rows[2][0].raw, /Tampered|thought/);
  await x.store.close(); await x.db.close();
});

test('malformed imports and cyclic or changed provenance are rejected', async () => {
  await assert.rejects(validateExplorationState({ captures: [], places: [], explorations: [null], distillations: [] }), /Invalid/);
  await assert.rejects(validateExplorationState({ captures: [], places: [], explorations: [], distillations: [{}] }), /invalid format/);
});

test('a branch started before reset cannot enter the new workspace', async () => {
  const x = await setup(), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; }); let blocked = false;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try {
    const pending = x.exploration.explore({ sourceId: x.sourceId, returnPointId: x.returnPointId, dial: 'NORMAL', text: 'Old workspace.' }, { requestId: crypto.randomUUID() });
    await started; await x.store.reset(); release(); await assert.rejects(pending, /changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  const rows = await x.db.run(['explorations'], 'readonly', tx => request(tx.objectStore('explorations').getAll())); assert.equal(rows.length, 0);
  await x.store.close(); await x.db.close();
});

class Storage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
const bundle = async payload => JSON.stringify({ payload, sha256: await sha256(JSON.stringify(payload)) });
async function close(x) { await x.store.close(); await x.db.close(); }

test('version 9 backup restores nested branches, typed distillation and drafts idempotently', async () => {
  const a = await setup(), state = await a.store.read();
  const branch = await a.store.explore({ sourceId: a.sourceId, returnPointId: a.returnPointId, dial: 'WILD', text: 'First branch.' });
  const child = await a.store.explore({ sourceId: a.sourceId, parentId: branch.id, returnPointId: a.returnPointId, dial: 'TIGHT', text: 'A child branch.' });
  await a.store.distill({ explorationId: child.id, type: 'OPEN TENSION', text: 'My question remains open.' });
  const shelf = createDraftShelf({ database: a.db, localStorage: new Storage(), sessionStorage: new Storage(), locks: null });
  const draft = await shelf.save(`distill:${child.id}`, { explorationId: child.id, type: 'HYPOTHESIS', text: 'Unfinished thought.' });
  const backup = await a.store.exportData(); assert.equal(JSON.parse(backup).payload.version, 11);
  const b = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false });
  await b.restore(backup); await b.restore(backup); const restored = await b.read();
  assert.deepEqual(restored.explorations, (await a.store.read()).explorations); assert.deepEqual(restored.distillations, (await a.store.read()).distillations);
  assert.deepEqual(restored.drafts, [draft]); assert.deepEqual(restored.now, state.now);
  await shelf.close(); await close(a); await b.close();
});

test('valid but conflicting exploration backup is refused atomically', async () => {
  const a = await setup(), branch = await a.store.explore({ sourceId: a.sourceId, returnPointId: a.returnPointId, dial: 'NORMAL', text: 'Original branch.' });
  const before = await a.store.exportData(), incoming = JSON.parse(before).payload, { hash, ...body } = branch;
  incoming.explorations[0] = await seal({ ...body, text: 'Different legitimate branch bytes.' });
  await assert.rejects(a.store.restore(await bundle(incoming)), /same ID differs/); assert.equal(await a.store.exportData(), before);
  await close(a);
});

test('damaged source and dependent exploration remain recoverable while new capture works', async () => {
  const a = await setup(), branch = await a.store.explore({ sourceId: a.sourceId, returnPointId: a.returnPointId, dial: 'NORMAL', text: 'Dependent thought.' });
  const original = (await a.store.read()).captures.find(c => c.id === a.sourceId);
  await a.db.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').put({ ...original, text: 'Corrupted source bytes.' })));
  const newCapture = await a.store.capture('New safe original.'); const state = await a.store.read();
  assert.ok(state.captures.some(c => c.id === newCapture.id));
  assert.ok(state.recovery.some(r => r.source === 'capture' && JSON.parse(r.raw).text === 'Corrupted source bytes.'));
  assert.ok(state.recovery.some(r => r.source === 'explorations' && JSON.parse(r.raw).id === branch.id));
  await a.store.exportData(); await close(a);
});

test('concurrent branch and distillation retries deduplicate and readback failure can be retried', async () => {
  const a = await setup(), requestId = crypto.randomUUID(), input = { sourceId: a.sourceId, returnPointId: a.returnPointId, dial: 'NORMAL', text: 'Concurrent branch.' };
  const branches = await Promise.all(Array.from({ length: 8 }, () => a.store.explore(input, { requestId })));
  assert.ok(branches.every(b => b.id === branches[0].id));
  const did = crypto.randomUUID(), data = { explorationId: branches[0].id, type: 'INSIGHT', text: 'Readback retry.' };
  const add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let failed = false;
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { const result = add.call(this, value, ...args); if (this.name === 'distillations') failed = true; return result; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'distillations' && this.transaction.mode === 'readonly' && failed) throw Error('readback fault'); return get.apply(this, args); };
    await assert.rejects(a.store.distill(data, { requestId: did }), /readback fault/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  const d = await a.store.distill(data, { requestId: did }); assert.equal((await a.store.read()).distillations.filter(r => r.id === d.id).length, 1);
  const secondId = crypto.randomUUID(), second = { ...data, text: 'Concurrent distillation.' };
  const copies = await Promise.all(Array.from({ length: 8 }, () => a.store.distill(second, { requestId: secondId })));
  assert.ok(copies.every(item => item.id === copies[0].id)); assert.equal((await a.store.read()).distillations.length, 2);
  await close(a);
});

test('a version 5 backup migrates with empty exploration arrays', async () => {
  const a = await setup(), payload = JSON.parse(await a.store.exportData()).payload;
  payload.version = 5; delete payload.explorations; delete payload.distillations; delete payload.personEvents; delete payload.contactReceipts; delete payload.openedReceipts; delete payload.artifacts; delete payload.branchEvents; delete payload.moveEvents;
  const b = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await b.restore(await bundle(payload));
  const state = await b.read(); assert.deepEqual(state.explorations, []); assert.deepEqual(state.distillations, []); assert.deepEqual(state.captures, payload.captures);
  await close(a); await b.close();
});

test('database version 4 upgrades while retaining exact original bytes', async () => {
  const a = await setup(), before = await a.store.read(), factory = new IDBFactory();
  const req = factory.open('effort-public-demo', 4);
  await new Promise((resolve, reject) => { req.onupgradeneeded = () => { for (const table of ['captures', 'meta', 'quarantine', 'drafts', 'spans', 'intentEvents', 'places', 'resumptions']) req.result.createObjectStore(table, { keyPath: ['meta', 'drafts'].includes(table) ? 'key' : 'id' }); }; req.onsuccess = resolve; req.onerror = () => reject(req.error); });
  const old = req.result, tx = old.transaction(['captures'], 'readwrite'); for (const c of before.captures) tx.objectStore('captures').put(c);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); old.close();
  const upgraded = createStore({ indexedDB: factory, legacyStorage: null, broadcast: false });
  const state = await upgraded.read(); assert.deepEqual(state.captures, before.captures); assert.deepEqual(state.explorations, []); assert.deepEqual(state.distillations, []);
  await close(a); await upgraded.close();
});

test('old form epoch is refused after reset, while callers omitting it still work', async () => {
  const x = await setup(), oldEpoch = (await x.store.health()).epoch;
  await x.store.reset(); const source = await x.store.capture('New workspace source.');
  const place = await x.store.holdPlace({ summary: 'New workspace return point.' });
  const input = { sourceId: source.id, returnPointId: place.id, dial: 'NORMAL', text: 'New workspace thought.' };
  await assert.rejects(x.store.explore(input, { expectedEpoch: oldEpoch }), /workspace changed/);
  const branch = await x.store.explore(input);
  const data = { explorationId: branch.id, type: 'INSIGHT', text: 'My interpretation.' };
  await assert.rejects(x.store.distill(data, { expectedEpoch: oldEpoch }), /workspace changed/);
  await x.store.distill(data);
  const state = await x.store.read(); assert.equal(state.explorations.length, 1); assert.equal(state.distillations.length, 1);
  await close(x);
});

test('combined UTF-8 exploration budget rejects overflow without changing saved work', async () => {
  const x = await setup();
  const root = await x.store.explore({ sourceId: x.sourceId, returnPointId: x.returnPointId, dial: 'NORMAL', text: 'Preserved root.' });
  const originals = [];
  for (let i = 0; i < 1015; i++) originals.push(await seal({ id: crypto.randomUUID(), explorationId: root.id, type: 'INSIGHT', text: '😀'.repeat(970), author: 'self', at: new Date().toISOString() }));
  await x.db.run(['distillations'], 'readwrite', async tx => { for (const row of originals) await request(tx.objectStore('distillations').add(row)); });
  const before = await x.db.run(['distillations'], 'readonly', tx => request(tx.objectStore('distillations').getAll()));
  await validateExplorationState(await x.store.read());
  await assert.rejects(x.store.distill({ explorationId: root.id, type: 'INSIGHT', text: 'More than the remaining budget. '.repeat(120) }), /4 MB portable limit/);
  const after = await x.db.run(['distillations'], 'readonly', tx => request(tx.objectStore('distillations').getAll()));
  assert.deepEqual(after, before); assert.equal((await x.store.read()).explorations[0].id, root.id);
  await close(x);
});

async function proposalSetup(dial = 'NORMAL') {
  const x = await setup();
  const branch = await x.store.explore({ sourceId: x.sourceId, returnPointId: x.returnPointId, dial, text: 'Explore the possibility.' });
  const distillation = await x.store.distill({ explorationId: branch.id, type: 'HYPOTHESIS', text: '  A derived idea.\nKeep exact spacing.  ' });
  return { ...x, branch, distillation };
}

test('preparing a proposal preserves exact derived writing, never selects NOW, and retries across tabs deduplicate', async () => {
  const x = await proposalSetup(), before = await x.store.read(), data = { distillationId: x.distillation.id };
  const copies = await Promise.all(Array.from({ length: 8 }, () => x.store.prepareProposal(data)));
  assert.ok(copies.every(row => row.id === copies[0].id)); const proposal = copies[0];
  assert.equal(proposal.text, x.distillation.text); assert.equal(proposal.parentId, x.sourceId); assert.equal(proposal.derivedFromId, x.distillation.id);
  const after = await x.store.read(); assert.deepEqual(after.now, before.now); assert.equal(after.captures.filter(c => c.id === proposal.id).length, 1);
  const other = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false });
  await other.restore(await x.store.exportData()); const restored = await other.read(); assert.deepEqual(restored.captures.find(c => c.id === proposal.id), proposal);
  await x.store.choose(proposal.id, 0, proposal.text.length); assert.equal((await x.store.read()).now.quote, proposal.text);
  await other.close(); await close(x);
});

test('sandbox distillation cannot become a proposal until a non-sandbox child is explicitly created', async () => {
  const x = await proposalSetup('UNHINGED SANDBOX');
  await assert.rejects(x.store.prepareProposal({ distillationId: x.distillation.id }), /sandbox/);
  const child = await x.store.explore({ sourceId: x.sourceId, parentId: x.branch.id, returnPointId: x.returnPointId, dial: 'NORMAL', text: 'Consider carefully.' });
  const d = await x.store.distill({ explorationId: child.id, type: 'DECISION CANDIDATE', text: 'A thought to review.' });
  assert.equal((await x.store.prepareProposal({ distillationId: d.id })).text, d.text); await close(x);
});

test('proposal readback failure is retryable without duplicate capture', async () => {
  const x = await proposalSetup(), add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false;
  try {
    IDBObjectStore.prototype.add = function(value, ...args) { const result = add.call(this, value, ...args); if (this.name === 'captures' && value.derivedFromId) inserted = true; return result; };
    IDBObjectStore.prototype.get = function(...args) { if (this.name === 'captures' && this.transaction.mode === 'readonly' && inserted) throw Error('proposal readback fault'); return get.apply(this, args); };
    await assert.rejects(x.store.prepareProposal({ distillationId: x.distillation.id }), /readback fault/);
  } finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  const proposal = await x.store.prepareProposal({ distillationId: x.distillation.id }); assert.equal((await x.store.read()).captures.filter(c => c.id === proposal.id).length, 1);
  await close(x);
});

test('proposal requires the current workspace epoch and valid source provenance', async () => {
  const x = await proposalSetup(), oldEpoch = (await x.store.health()).epoch;
  await x.store.reset(); await assert.rejects(x.store.prepareProposal({ distillationId: x.distillation.id }, { expectedEpoch: oldEpoch }), /workspace changed/);
  const state = await x.store.read(); assert.deepEqual(state.captures, []); assert.equal(state.now, null); await close(x);
});

test('damaged distillation preserves proposal text and marks provenance for recovery', async () => {
  const x = await proposalSetup(), proposal = await x.store.prepareProposal({ distillationId: x.distillation.id });
  await x.db.run(['distillations'], 'readwrite', tx => request(tx.objectStore('distillations').put({ ...x.distillation, text: 'Altered bytes.' })));
  const state = await x.store.read(); assert.deepEqual(state.captures.find(c => c.id === proposal.id), proposal);
  assert.ok(state.recovery.some(r => r.source === 'distillations' && r.recordId === x.distillation.id));
  const other = createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false }); await other.restore(await x.store.exportData());
  assert.deepEqual((await other.read()).captures.find(c => c.id === proposal.id), proposal);
  await other.close(); await close(x);
});

test('proposal metadata edits are detected and the raw altered record remains recoverable', async () => {
  const x = await proposalSetup(), proposal = await x.store.prepareProposal({ distillationId: x.distillation.id });
  const tampered = { ...proposal, derivedFromId: crypto.randomUUID() };
  await x.db.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').put(tampered)));
  const state = await x.store.read(); assert.ok(!state.captures.some(c => c.id === proposal.id));
  assert.deepEqual(JSON.parse(state.recovery.find(r => r.source === 'capture' && r.recordId === proposal.id).raw), tampered);
  await close(x);
});


test('preparing an imported proposal reuses its exact saved capture across workspace epochs', async () => {
  const x = await proposalSetup(), proposal = await x.store.prepareProposal({ distillationId: x.distillation.id });
  const backup = await x.store.exportData(); await x.store.reset(); await x.store.restore(backup);
  const again = await x.store.prepareProposal({ distillationId: x.distillation.id });
  assert.deepEqual(again, proposal); assert.equal((await x.store.read()).captures.filter(c => c.derivedFromId === x.distillation.id).length, 1);
  await close(x);
});

test('a proposal hashed before a reset cannot resurrect its old writing', async () => {
  const x = await proposalSetup(), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; }); let blocked = false;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try {
    const pending = x.store.prepareProposal({ distillationId: x.distillation.id });
    await started; await x.store.reset(); release(); await assert.rejects(pending, /workspace changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  const state = await x.store.read(); assert.deepEqual(state.captures, []); assert.equal(state.now, null); await close(x);
});

test('retry refuses source changes while the saved proposal is being verified', async () => {
  const x = await proposalSetup(), proposal = await x.store.prepareProposal({ distillationId: x.distillation.id });
  const original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; }); let blocked = false;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try {
    const pending = x.store.prepareProposal({ distillationId: x.distillation.id });
    await started;
    await x.db.run(['captures'], 'readwrite', async tx => { const table = tx.objectStore('captures'), source = await request(table.get(x.sourceId)); await request(table.put({ ...source, text: 'Changed without its checksum.' })); });
    release(); await assert.rejects(pending, /source changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  const state = await x.store.read(); assert.deepEqual(state.captures.find(c => c.id === proposal.id), proposal); assert.ok(state.recovery.some(row => row.source === 'capture' && row.recordId === x.sourceId));
  await x.store.exportData(); await close(x);
});
