import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, KEY, sha256 } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { createDraftShelf } from '../public/drafts.js';
import { seal } from '../public/intent.js';
globalThis.crypto ??= webcrypto;
class Storage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
function setup() {
  const factory = new IDBFactory(), localStorage = new Storage(), database = openDatabase({factory});
  const store = createStore({indexedDB:factory, legacyStorage:localStorage, broadcast:false});
  const shelf = () => createDraftShelf({database, localStorage, sessionStorage:new Storage(), locks:null});
  return {store, database, localStorage, shelf};
}
const body = text => ({text, span:'Unsorted'});
const bundle = async payload => JSON.stringify({payload, sha256:await sha256(JSON.stringify(payload))});

test('concurrent retries of one capture request save one original, and mismatched reuse is refused', async () => {
  const {store} = setup(), requestId = crypto.randomUUID();
  const saved = await Promise.all(Array.from({length:8}, () => store.capture('  Exact retry.\r\n😀 ', 'Unsorted', null, {requestId})));
  assert.ok(saved.every(c => JSON.stringify(c) === JSON.stringify(saved[0])));
  assert.equal((await store.read()).captures.length, 1);
  await assert.rejects(store.capture('Different.', 'Unsorted', null, {requestId}), /different text/);
  await store.reset();
  const later = await store.capture(saved[0].text, 'Unsorted', null, {requestId});
  assert.notEqual(later.id, saved[0].id, 'a request from the old workspace cannot reuse an erased source ID');
  await store.close();
});

test('a committed save whose readback fails can be retried without duplicating the original', async () => {
  const {store} = setup(); await store.read(); const requestId = crypto.randomUUID(), get = IDBObjectStore.prototype.get;
  let fail = false; const add = IDBObjectStore.prototype.add;
  try {
    IDBObjectStore.prototype.add = function(value, ...rest) { const result = add.call(this, value, ...rest); if (this.name === 'captures') fail = true; return result; };
    IDBObjectStore.prototype.get = function(key) { if (this.name === 'captures' && this.transaction.mode === 'readonly' && fail) throw Error('Readback temporarily unavailable'); return get.call(this, key); };
    await assert.rejects(store.capture('Accepted before readback.', 'Unsorted', null, {requestId}), /temporarily/);
  } finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.add = add; }
  await store.capture('Accepted before readback.', 'Unsorted', null, {requestId});
  assert.equal((await store.read()).captures.length, 1); await store.close();
});

test('retry repairs an accepted but damaged source while preserving its raw bytes', async () => {
  const {store} = setup(); await store.read(); const requestId = crypto.randomUUID(), add = IDBObjectStore.prototype.add;
  try {
    IDBObjectStore.prototype.add = function(value, ...rest) { return add.call(this, this.name === 'captures' ? {...value, text:'Damaged after acceptance.'} : value, ...rest); };
    await assert.rejects(store.capture('Exact original.', 'Unsorted', null, {requestId}), /verified/);
  } finally { IDBObjectStore.prototype.add = add; }
  const saved = await store.capture('Exact original.', 'Unsorted', null, {requestId}), state = await store.read();
  assert.equal(state.captures.length, 1); assert.equal(state.captures[0].text, saved.text);
  assert.equal(JSON.parse(state.recovery.find(r => r.source === 'capture').raw).text, 'Damaged after acceptance.');
  await store.close();
});

test('backups round trip drafts and retain conflicting revisions exactly once without replacing current writing', async () => {
  const source = setup(), s = source.shelf(); await source.store.read();
  const first = await s.save('capture', body('First draft.'));
  const backup = await source.store.exportData(); const target = setup();
  await target.store.restore(backup); assert.deepEqual((await target.store.read()).drafts, [first]);
  const {hash, ...payload} = first, newer = await seal({...payload, revision:2, body:body('Incoming newer draft.')});
  const incoming = JSON.parse(backup).payload; incoming.drafts = [newer];
  const conflict = await bundle(incoming); await target.store.restore(conflict); await target.store.restore(conflict);
  const drafts = (await target.store.read()).drafts;
  assert.equal(drafts.length, 2); assert.ok(drafts.some(d => d.hash === first.hash));
  assert.ok(drafts.some(d => d.body.text === newer.body.text && d.key !== first.key));
  const cleared = await s.clear('capture', first.body); await source.store.restore(backup);
  assert.deepEqual((await source.store.read()).drafts, [cleared], 'old backups cannot revive a cleared draft');
  await s.close(); await source.store.close(); await target.store.close(); await source.database.close();
});

test('damaged drafts are quarantined without blocking original capture or losing emergency bytes in backup', async () => {
  const {store, database} = setup(); await store.read();
  const damaged = {key:crypto.randomUUID(), text:'Unverified draft bytes.'};
  await database.run(['drafts'], 'readwrite', tx => request(tx.objectStore('drafts').put(damaged)));
  await store.capture('Fresh original still works.'); const state = await store.read();
  assert.equal(state.drafts.length, 0); assert.equal(state.captures.length, 1);
  assert.deepEqual(JSON.parse(state.recovery.find(r => r.source === 'draft').raw), damaged);
  const backup = JSON.parse(await store.exportData({draftCopies:[{source:KEY+'-draft', raw:'{broken legacy', reason:'Legacy recovery'}]}));
  assert.ok(backup.payload.recovery.some(r => r.raw === '{broken legacy'));
  const other = setup(); await other.store.restore(JSON.stringify(backup));
  assert.ok((await other.store.read()).recovery.some(r => r.raw === '{broken legacy'));
  await store.close(); await database.close(); await other.store.close();
});

test('explicit workspace reset fences automatic legacy migration even if localStorage cleanup fails', async () => {
  const {store, shelf, localStorage, database} = setup(); await store.read();
  localStorage.setItem(KEY+'-draft', JSON.stringify(body('Old workspace draft.')));
  const s = shelf(); assert.equal((await s.migrateLegacy('capture')).body.text, 'Old workspace draft.'); await s.close();
  await store.reset(); const resumed = shelf(); assert.equal(await resumed.migrateLegacy('capture'), null);
  assert.ok((await resumed.list()).damaged.some(r => r.raw?.includes('Old workspace draft.')));
  await resumed.close(); await store.close(); await database.close();
});

test('draft-table failure does not block primary reads, saves or commitment actions', async () => {
  const {store} = setup(); await store.seed(); const getAll = IDBObjectStore.prototype.getAll;
  try {
    IDBObjectStore.prototype.getAll = function(...args) { if(this.name === 'drafts') throw Error('Draft system unavailable'); return getAll.apply(this,args); };
    const before = await store.read({includeDrafts:false}); assert.ok(before.now);
    const source = await store.capture('Save without draft services.');
    const chosen = await store.choose(source.id,0,source.text.length); assert.equal(chosen.now.quote, source.text);
    await assert.rejects(store.exportData(), /Draft system unavailable/, 'backups must not silently omit inaccessible draft data');
  } finally { IDBObjectStore.prototype.getAll = getAll; await store.close(); }
});

test('the database upgrade retains pre-draft originals, spans and intent history', async () => {
  const fixture = setup(); await fixture.store.seed(); const old = await fixture.store.read(); await fixture.store.close();
  const factory = new IDBFactory();
  const db = await new Promise((resolve,reject) => {
    const open = factory.open('effort-public-demo',3);
    open.onupgradeneeded = () => { for (const table of ['captures','meta','quarantine','drafts','spans','intentEvents','places','resumptions']) open.result.createObjectStore(table,{keyPath:table==='meta'||table==='drafts'?'key':'id'}); };
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  await new Promise((resolve,reject) => {
    const tx = db.transaction(['captures','meta','spans','intentEvents'],'readwrite');
    for(const c of old.captures) tx.objectStore('captures').add(c);
    for(const s of old.spans) tx.objectStore('spans').add(s);
    for(const e of old.intentEvents) tx.objectStore('intentEvents').add(e);
    for(const [key,value] of Object.entries({legacyChecked:true,intentInitialized:true,initialized:true,now:old.now})) tx.objectStore('meta').put({key,value});
    tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
  }); db.close();
  const upgraded = createStore({indexedDB:factory, legacyStorage:null, broadcast:false});
  const state = await upgraded.read(); assert.equal(state.version,11);
  assert.deepEqual(state.captures, old.captures); assert.deepEqual(state.intentEvents,old.intentEvents); assert.deepEqual(state.now,old.now); assert.equal(state.spans.length,old.spans.length);
  await upgraded.close();
});

test('thinking and status draft tombstones preserve context without reviving old editing bases', async () => {
  const x = setup(); await x.store.read(); const shelf = x.shelf(), id = crypto.randomUUID();
  const move = { moveId: null, name: 'My tool', prompt: 'Exact unfinished prompt.', enabled: false, expectedLatestId: null };
  await shelf.save('move', move); assert.deepEqual((await shelf.load('move')).body, move); await shelf.clear('move', move);
  assert.deepEqual((await shelf.load('move')).body, { ...move, name: '', prompt: '' });
  const branch = { branchId: id, status: 'parked', note: 'Exact unfinished note.', evidence: true, expectedLatestId: crypto.randomUUID() };
  await shelf.save(`branch:${id}`, branch); assert.deepEqual((await shelf.load(`branch:${id}`)).body, branch); await shelf.clear(`branch:${id}`, branch);
  assert.deepEqual((await shelf.load(`branch:${id}`)).body, { ...branch, status: '', note: '', evidence: false }); await shelf.close(); await x.database.close(); await x.store.close();
});
