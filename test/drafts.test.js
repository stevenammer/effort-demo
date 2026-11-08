import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { openDatabase } from '../public/database.js';
import { createDraftShelf, validateDraft } from '../public/drafts.js';
globalThis.crypto ??= webcrypto;
class Storage { constructor() { this.m = new Map(); } get length() { return this.m.size; } key(i) { return [...this.m.keys()][i] ?? null; } getItem(k) { return this.m.get(k) ?? null; } setItem(k,v) { this.m.set(k,String(v)); } removeItem(k) { this.m.delete(k); } }
const body = text => ({ text, span: 'Unsorted' });
function setup(options = {}) { const localStorage = new Storage(), sessionStorage = new Storage(), database = openDatabase({ factory: indexedDB, name: crypto.randomUUID() }); const make = extra => createDraftShelf({ database, localStorage, sessionStorage, ...options, ...extra }); return { make, localStorage, sessionStorage, database }; }
function locks() { const active = new Set(); return { request(name, opts, callback) { if (active.has(name)) return callback(null); active.add(name); return Promise.resolve(callback({ name })).finally(() => active.delete(name)); } }; }
test('isolated shelves and cloned session do not overwrite; readback preserves exact text', async () => {
 const l = locks(), { make } = setup({ locks: l }), a = make(), b = make(); await a.ready; await b.ready;
 const first = await a.save('capture', body('  exact\n\n😀  ')), second = await b.save('capture', body('other'));
 assert.notEqual(first.tabId, second.tabId); assert.equal((await a.load('capture')).body.text, '  exact\n\n😀  '); assert.equal((await b.list()).records.length, 2); await validateDraft(first); await a.close(); await b.close();
});
test('lease resumes identity after close; no-lock fallback forks', async () => {
 const l = locks(), { make } = setup({ locks: l }), a = make(); await a.ready; const first = await a.save('capture', body('one')); await a.close(); const b = make(); assert.equal((await b.ready), first.tabId); assert.equal((await b.load('capture')).body.text, 'one'); await b.close();
 const c = make({ locks: null }); assert.notEqual(await c.ready, first.tabId); assert.equal((await c.load('capture')).body.text, 'one'); await c.close();
});
test('failed database write retains synchronous mirror and recovery imports without deleting source', async () => {
 const { make, localStorage, database } = setup(), bad = make({ database: { run: async () => { throw Error('quota'); } } }); const pending = bad.save('capture', body('unsaved')); assert.equal(localStorage.length, 1); await assert.rejects(pending, /quota/); await bad.close();
 const good = make({ database }); const item = (await good.recover()).damaged.find(x => x.reason.includes('mirror')); assert.ok(item.raw.includes('unsaved')); const recovered = await good.recover(item.source); assert.equal(recovered.body.text, 'unsaved'); assert.ok(localStorage.getItem(item.source)); await good.close();
});
test('legacy migration retains original bytes and damaged records are visible', async () => {
 const { make, localStorage, database } = setup(); const key = 'effort-public-demo-v1-draft', raw = JSON.stringify(body('legacy')); localStorage.setItem(key, raw); localStorage.setItem('effort-public-demo-v1-reply-bad', '{broken');
 await database.run(['drafts'], 'readwrite', tx => new Promise((resolve,reject) => { const req = tx.objectStore('drafts').put({key: 'damaged', body: 'raw'}); req.onsuccess = resolve; req.onerror = reject; }));
 const shelf = make(), report = await shelf.recover(); assert.ok(report.damaged.some(x => x.source === 'database:damaged')); assert.ok(report.damaged.some(x => x.raw === '{broken')); assert.equal((await shelf.recover(key)).body.text, 'legacy'); assert.equal(localStorage.getItem(key), raw); await shelf.close();
});
test('serial saves and clear use revisions, refuse changed body', async () => {
 const { make } = setup(), s = make(); const [a,b] = await Promise.all([s.save('capture', body('a')),s.save('capture', body('b'))]); assert.equal(b.revision, a.revision + 1); await assert.rejects(s.clear('capture', body('a')), /changed/); const c = await s.clear('capture', body('b')); assert.equal(c.revision, 3); assert.equal(c.body.text, ''); await s.close();
});
test('invalid and oversized input rejected without touching existing data', async () => {
 const { make } = setup(), s = make(); await s.save('capture', body('keep')); await assert.rejects(s.save('capture', body('x'.repeat(4001))), /Invalid/); assert.equal((await s.load('capture')).body.text, 'keep'); await s.close();
});
test('compare and swap rejects stale writer and keeps emergency copy', async () => {
 const { make, database, localStorage } = setup(), s = make(); const original = await s.save('capture', body('first')); await s.load('capture');
 await database.run(['drafts'], 'readwrite', tx => new Promise((resolve,reject) => { const req = tx.objectStore('drafts').put({ ...original, revision: 99 }); req.onsuccess = resolve; req.onerror = reject; }));
 const fork = await s.save('capture', body('second')); assert.notEqual(fork.key, original.key); assert.equal((await s.list()).damaged.some(x => x.source === `database:${original.key}`), true); assert.ok(s.health().warnings.some(x => x.includes('conflicting'))); await s.close();
});
test('readback failure keeps the mirror even when transaction committed', async () => {
 const { make, database, localStorage } = setup(); let failRead = false;
 const wrapper = { run(tables, mode, work) { if (mode === 'readonly' && failRead) return Promise.reject(Error('readback unavailable')); const result = database.run(tables, mode, work); if (mode === 'readwrite') result.then(() => { failRead = true; }); return result; } };
 const s = make({ database: wrapper }); await assert.rejects(s.save('capture', body('retained')), /readback/); assert.ok([...localStorage.m.values()].some(raw => raw.includes('retained'))); await s.close();
});
test('unavailable emergency storage still permits verified database save', async () => {
 const bad = { get length() { throw Error('denied'); }, setItem() { throw Error('denied'); } }; const { make } = setup(); const s = make({ localStorage: bad }); const r = await s.save('capture', body('database')); assert.equal(r.body.text, 'database'); assert.ok(s.health().warnings.some(x => x.includes('Emergency'))); await s.close();
});
test('latest failed mirror is automatically restored after reload', async () => {
 const l = locks(), { make, database } = setup({ locks: l }), s = make(); await s.ready; const initial = await s.save('capture', body('old')); await s.close();
 const broken = make({ database: { run: (t, m, w) => m === 'readwrite' ? Promise.reject(Error('offline')) : database.run(t, m, w) } }); await broken.ready; await assert.rejects(broken.save('capture', body('newest')), /offline/); await broken.close();
 const resumed = make(); const recovered = await resumed.load('capture'); assert.equal(recovered.body.text, 'newest'); assert.notEqual(recovered.key, initial.key); await resumed.close();
});
test('damaged active record does not block new writes', async () => {
 const { make, database } = setup(), s = make(); const a = await s.save('capture', body('old')); await database.run(['drafts'], 'readwrite', tx => new Promise(resolve => { const r = tx.objectStore('drafts').put({...a, hash: 'bad'}); r.onsuccess = resolve; })); const b = await s.save('capture', body('new')); assert.notEqual(a.key, b.key); assert.equal((await s.list()).damaged.some(x => x.source === `database:${a.key}`), true); await s.close();
});
test('recovery uses attempt order even when timestamps move backward', async () => {
 const { make, localStorage, database } = setup(), bad = make({ database: { run: (t,m,w) => m === 'readwrite' ? Promise.reject(Error('offline')) : database.run(t,m,w) } }); await bad.ready;
 await assert.rejects(bad.save('capture', body('first'))); await assert.rejects(bad.save('capture', body('second'))); await bad.close();
 const entries = [...localStorage.m.entries()].filter(([k]) => k.includes('pending-')); const first = JSON.parse(entries[0][1]), second = JSON.parse(entries[1][1]); first.at = '2099-01-01T00:00:00.000Z'; second.at = '2000-01-01T00:00:00.000Z'; localStorage.setItem(entries[0][0], JSON.stringify(first)); localStorage.setItem(entries[1][0], JSON.stringify(second));
 const resumed = make(); assert.equal((await resumed.load('capture')).body.text, 'second'); await resumed.close();
});
test('failed attempts followed by a verified clear do not resurrect', async () => {
 const { make, database } = setup(); let fail = false; const wrapper = { run(t, mode, work) { return fail && mode === 'readwrite' ? Promise.reject(Error('offline')) : database.run(t, mode, work); } }; const s = make({ database: wrapper }); await s.ready; await s.save('capture', body('saved')); fail = true; await assert.rejects(s.save('capture', body('attempt one'))); await assert.rejects(s.save('capture', body('attempt two'))); fail = false; await s.clear('capture', body('attempt two')); await s.close(); const next = make(); assert.equal((await next.load('capture')).body.text, ''); await next.close();
});
test('mirror written before lease settles is recoverable after fallback reload', async () => {
 const { make, localStorage } = setup(); localStorage.setItem('effort-public-demo-v1-draft-reset-marker', 'initial'); const stalled = make({ locks: { request() { return new Promise(() => {}); } } }); stalled.save('capture', body('before ready')); assert.ok([...localStorage.m.values()].some(x => x.includes('before ready'))); const next = make({ locks: null }); assert.equal((await next.load('capture')).body.text, 'before ready'); await next.close();
});
test('record count and aggregate limits retain existing rows and emergency copy', async () => {
 const { make, database, localStorage } = setup(); await database.run(['drafts'], 'readwrite', tx => { const store = tx.objectStore('drafts'); for (let i = 0; i < 1000; i++) store.put({ key: `damaged-${i}`, value: 'x' }); }); const s = make(); await assert.rejects(s.save('capture', body('over count')), /full/); assert.equal((await database.run(['drafts'], 'readonly', tx => new Promise(resolve => { const r = tx.objectStore('drafts').count(); r.onsuccess = () => resolve(r.result); }))), 1000); assert.ok([...localStorage.m.values()].some(x => x.includes('over count'))); await s.close();
 const other = setup(); await other.database.run(['drafts'], 'readwrite', tx => { tx.objectStore('drafts').put({ key: 'large', value: 'x'.repeat(4000000) }); }); const shelf = other.make(); await assert.rejects(shelf.save('capture', body('over total')), /full/); assert.equal((await shelf.list()).damaged[0].raw.length > 4000000, true); await shelf.close();
});
test('recovery response bounds valid mirrors as well as damaged bytes', async () => {
 const { make, localStorage } = setup(); localStorage.setItem('effort-public-demo-v1-reply-broken', 'x'.repeat(8000001)); const s = make(); const entry = (await s.list()).damaged[0]; assert.equal(entry.raw, null); assert.ok(localStorage.getItem(entry.source).length > 8000000); await s.close();
});
test('epoch fences delayed save and prevents automatic recovery after reset', async () => {
 const { make, database } = setup(), s = make(); await s.ready;
 const original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, started; const entered = new Promise(r => { started = r; }); const gate = new Promise(r => { release = r; });
 Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { started(); await gate; return original.subtle.digest(...args); } } } });
 try {
   const pending = s.save('capture', body('before reset')); await entered;
   await database.run(['drafts', 'meta'], 'readwrite', async tx => { tx.objectStore('drafts').clear(); tx.objectStore('meta').put({ key: 'epoch', value: crypto.randomUUID() }); });
   release(); await assert.rejects(pending, /reset/);
 } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
 await s.close(); const next = make(); assert.equal(await next.load('capture'), null); assert.equal((await next.list()).records.length, 0); assert.ok((await next.recover()).damaged.some(x => x.raw?.includes('before reset'))); await next.close();
});
test('throwing storage getters do not block database writes', async () => {
 const descriptors = ['localStorage', 'sessionStorage'].map(k => Object.getOwnPropertyDescriptor(globalThis, k));
 try { for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, k, { configurable: true, get() { throw Error('denied'); } }); const database = openDatabase({ factory: indexedDB, name: crypto.randomUUID() }); const s = createDraftShelf({ database, locks: null }); await s.ready; assert.equal((await s.save('capture', body('works'))).body.text, 'works'); await s.close(); }
 finally { ['localStorage', 'sessionStorage'].forEach((k,i) => descriptors[i] ? Object.defineProperty(globalThis,k,descriptors[i]) : delete globalThis[k]); }
});

test('legacy capture and reply migrate once globally while preserving exact source bytes', async () => {
 const { make, localStorage } = setup(), thread = crypto.randomUUID(), parent = crypto.randomUUID();
 const captureKey = 'effort-public-demo-v1-draft', replyKey = `effort-public-demo-v1-reply-${thread}`;
 const captureRaw = JSON.stringify(body('  legacy\n😀  ')), replyRaw = JSON.stringify({ text: ' reply\n', parentId: parent });
 localStorage.setItem(captureKey, captureRaw); localStorage.setItem(replyKey, replyRaw);
 const first = make({ sessionStorage: new Storage() }), second = make({ sessionStorage: new Storage() });
 assert.equal((await first.migrateLegacy('capture')).body.text, '  legacy\n😀  ');
 assert.equal((await first.migrateLegacy(`reply:${thread}`)).body.parentId, parent);
 assert.equal(await second.migrateLegacy('capture'), null); assert.equal(await second.migrateLegacy(`reply:${thread}`), null);
 assert.equal((await first.list()).records.length, 2); assert.equal(localStorage.getItem(captureKey), captureRaw); assert.equal(localStorage.getItem(replyKey), replyRaw);
 await first.close(); await second.close();
});

test('clearing a migrated draft and reloading never resurrects legacy text', async () => {
 const sharedLocks = locks(), { make, localStorage } = setup({ locks: sharedLocks });
 const raw = JSON.stringify(body('old writing')); localStorage.setItem('effort-public-demo-v1-draft', raw);
 const first = make(); await first.ready; const migrated = await first.migrateLegacy('capture');
 await first.clear('capture', migrated.body); await first.close();
 const reload = make(); const after = await reload.migrateLegacy('capture'); assert.equal(after.body.text, '');
 const otherTab = make({ sessionStorage: new Storage() }); assert.equal(await otherTab.migrateLegacy('capture'), null);
 assert.equal(localStorage.getItem('effort-public-demo-v1-draft'), raw); assert.equal((await reload.list()).records.length, 1);
 await reload.close(); await otherTab.close();
});

test('malformed legacy bytes remain available for recovery and can migrate after repair', async () => {
 const { make, localStorage } = setup(), key = 'effort-public-demo-v1-draft'; localStorage.setItem(key, '{broken');
 const s = make(); assert.equal(await s.migrateLegacy('capture'), null); assert.equal(localStorage.getItem(key), '{broken');
 assert.ok((await s.recover()).damaged.some(x => x.source === key && x.raw === '{broken'));
 localStorage.setItem(key, JSON.stringify(body('repaired'))); assert.equal((await s.migrateLegacy('capture')).body.text, 'repaired'); await s.close();
});

test('simultaneous legacy migrations across separate tabs create at most one record', async () => {
 const { make, localStorage } = setup(), raw = JSON.stringify(body('single import')); localStorage.setItem('effort-public-demo-v1-draft', raw);
 const a = make({ sessionStorage: new Storage() }), b = make({ sessionStorage: new Storage() });
 const results = await Promise.all([a.migrateLegacy('capture'), b.migrateLegacy('capture')]);
 assert.equal(results.filter(Boolean).length, 1); assert.equal((await a.list()).records.filter(r => r.context === 'capture').length, 1);
 assert.equal(localStorage.getItem('effort-public-demo-v1-draft'), raw); await a.close(); await b.close();
});

test('an identical emergency pagehide mirror reuses the verified row on reload', async () => {
 const { make, database } = setup({ locks: locks() });
 const first = make(); await first.ready; const saved = await first.save('capture', body('Already verified.')); await first.close();
 const interrupted = make({ database: { run(t, mode, work) { return mode === 'readwrite' ? Promise.reject(Error('pagehide interrupted')) : database.run(t, mode, work); } } });
 await interrupted.load('capture'); await assert.rejects(interrupted.save('capture', saved.body), /interrupted/); await interrupted.close();
 const reopened = make(); assert.deepEqual(await reopened.load('capture'), saved); assert.equal((await reopened.list()).records.length,1); await reopened.close();
});

test('recovery cannot overwrite a draft whose database write is still pending', async () => {
 const { make, database } = setup(); let release, entered;
 const gate = new Promise(r=>{release=r;}), started = new Promise(r=>{entered=r;}); let stall = false;
 const wrapper = {run(t, mode, work) { if (stall && mode === 'readwrite' && t.includes('drafts')) { entered(); return gate.then(()=>database.run(t,mode,work)); } return database.run(t,mode,work); }};
 const foreign = make(); const copy = await foreign.save('capture', body('Recovery copy.')); await foreign.close();
 const current = make({sessionStorage:new Storage(), database:wrapper}); await current.load('capture'); stall=true;
 const pending = current.save('capture', body('Newer writing still saving.')); await started;
 const recovering = current.recoverRecord(copy); release(); await pending;
 await assert.rejects(recovering,/different draft/); assert.equal((await current.load('capture')).body.text,'Newer writing still saving.'); await current.close();
});

test('flush keeps reporting the latest failed write until a later save succeeds', async () => {
 const {make, database} = setup(); let fail = true;
 const s = make({database:{run(t,m,w){return fail && m==='readwrite' ? Promise.reject(Error('persistent failure')) : database.run(t,m,w);}}});
 await assert.rejects(s.save('capture',body('Keep this.')),/persistent failure/);
 await assert.rejects(s.flush(),/persistent failure/);
 fail=false; await s.save('capture',body('Keep this.')); await s.flush(); await s.close();
});
