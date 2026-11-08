import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, KEY, LIMITS, sha256 } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
globalThis.crypto ??= webcrypto;
function memory() { const data = new Map(); return { getItem:k=>data.get(k)??null, setItem:(k,v)=>data.set(k,v), removeItem:k=>data.delete(k) }; }
function setup({ legacy = memory(), factory = new IDBFactory() } = {}) {
  const options = { legacyStorage: legacy, indexedDB: factory, broadcast: false };
  return { store:createStore(options), another:()=>createStore(options), raw:openDatabase({factory}), legacy, factory };
}
async function v1Fixture() {
  const {store}=setup(); await store.seed(); const current=await store.read(); await store.close();
  return { version:1, kind:current.kind, captures:current.captures, now:current.now };
}

test('capture verifies exact originals, preserves NOW and requires an explicit choice', async()=>{
  const {store}=setup(); await store.seed(); const chosen=(await store.read()).now;
  const text='  Maybe build an exercise.\r\nI\'ll review the outline. 🧠  ';
  const c=await store.capture(text,'Learning'); assert.equal(c.text,text); assert.equal(c.hash,await sha256(text));
  assert.deepEqual((await store.read()).now,chosen);
  await store.choose(c.id,2,26); const state=await store.read(); assert.equal(state.now.quote,text.slice(2,26));
  await store.complete(state.now); assert.equal((await store.read()).now,null);
  assert.equal((await store.read()).captures.find(x=>x.id===c.id).text,text); await store.close();
});
test('v1 migration preserves exact text, chosen step and original browser bytes',async()=>{
  const fixture=await v1Fixture(); const legacy=memory(); const original=JSON.stringify(fixture);legacy.setItem(KEY,original);
  const {store,another}=setup({legacy}); await store.seed(); const got=await store.read();
  assert.deepEqual(got.captures.map(x=>x.id).sort(),fixture.captures.map(x=>x.id).sort()); assert.deepEqual(got.now,fixture.now);
  assert.equal(legacy.getItem(KEY),original); const second=another(); await second.seed(); assert.equal((await second.read()).captures.length,2);
  await store.close();await second.close();
});
test('one corrupt legacy record is quarantined without losing good records or blocking new capture',async()=>{
  const fixture=await v1Fixture(), legacy=memory();const bad=fixture.captures.find(c=>c.id===fixture.now.captureId);
  bad.hash='0'.repeat(64);const raw=JSON.stringify(fixture);legacy.setItem(KEY,raw);
  const {store}=setup({legacy});await store.seed();const c=await store.capture('A new unrelated thought.');const state=await store.read();
  assert.equal(state.captures.length,2);assert.ok(state.captures.some(x=>x.id===c.id));assert.equal(state.now,null);
  assert.equal((await store.health()).heldNow,true);assert.equal(state.recovery.filter(x=>x.source==='capture').length,1);
  assert.equal(JSON.parse(state.recovery.find(x=>x.source==='capture').raw).hash,bad.hash);assert.equal(legacy.getItem(KEY),raw);await store.close();
});
test('unparseable previous state is kept byte-for-byte and capture remains available',async()=>{
  const legacy=memory();const old='{broken original copy';legacy.setItem(KEY,old);const {store}=setup({legacy});
  await store.seed();assert.equal((await store.read()).captures.length,0);await store.capture('Fresh thought survives.');
  const state=await store.read();assert.equal(state.captures.length,1);assert.equal(state.recovery[0].raw,old);assert.equal(legacy.getItem(KEY),old);
  const bundle=JSON.parse(await store.exportData());assert.equal(bundle.payload.recovery[0].raw,old);await store.close();
});
test('a corrupt IndexedDB capture is preserved in recovery while unrelated captures continue',async()=>{
  const {store,raw}=setup();await store.seed();const original=(await store.read()).captures[0];
  await raw.run(['captures'],'readwrite',tx=>request(tx.objectStore('captures').put({...original,text:'Changed without updating its hash.'})));
  const next=await store.capture('New capture must not depend on the damaged record.');const state=await store.read();
  assert.ok(state.captures.some(c=>c.id===next.id));assert.equal(state.captures.length,2);
  assert.equal(state.recovery.find(r=>r.source==='capture').recordId,original.id);
  assert.equal((await store.read()).recovery.length,state.recovery.length,'repeat recovery is idempotent');await store.close();await raw.close();
});
test('failed database writes abort and never claim the new original was saved',async()=>{
  const {store}=setup();await store.seed();const original=IDBObjectStore.prototype.add;
  try {
    IDBObjectStore.prototype.add=function(value,...rest){ if(this.name==='captures'&&value.text==='Simulate a quota failure.')throw Error('Quota failure');return original.call(this,value,...rest); };
    await assert.rejects(store.capture('Simulate a quota failure.'),/Quota failure/);assert.equal((await store.read()).captures.length,2);
  }finally{IDBObjectStore.prototype.add=original;await store.close();}
});
test('save readback detects accepted-but-altered bytes',async()=>{
  const {store}=setup();await store.seed();const original=IDBObjectStore.prototype.add;
  try{
    IDBObjectStore.prototype.add=function(value,...rest){return original.call(this,this.name==='captures'&&value.text==='Exact new text.'?{...value,text:'Changed text.'}:value,...rest);};
    await assert.rejects(store.capture('Exact new text.'),/could not be verified/);
    const recovered=await store.read();assert.equal(recovered.captures.length,2);assert.ok(recovered.recovery.length>=1);
  }finally{IDBObjectStore.prototype.add=original;await store.close();}
});
test('independent database connections serialize concurrent captures without lost writes',async()=>{
  const {store,another}=setup();await store.seed();const second=another();
  await Promise.all(Array.from({length:20},(_,i)=>(i%2?store:second).capture(`Fictional concurrent thought ${i}.`)));
  assert.equal((await store.read()).captures.length,22);await store.close();await second.close();
});
test('backup v2 round trips recovery and originals; repeated restore adds no duplicates',async()=>{
  const {store,raw}=setup();await store.seed();const first=(await store.read()).captures[0];
  await raw.run(['captures'],'readwrite',tx=>request(tx.objectStore('captures').put({...first,hash:'0'.repeat(64)})));
  await store.capture('A good new record.');const before=await store.read(), backup=await store.exportData();const other=setup().store;
  assert.equal(await other.restore(backup),2);const after=await other.read();assert.deepEqual(after.captures,before.captures);assert.deepEqual(after.recovery,before.recovery);
  assert.equal(await other.restore(backup),0);await store.close();await other.close();await raw.close();
});
test('v1 exported backups still restore without requiring a browser migration',async()=>{
  const fixture=await v1Fixture();const backup=JSON.stringify({payload:fixture,sha256:await sha256(JSON.stringify(fixture))});
  const {store}=setup();assert.equal(await store.restore(backup),2);assert.deepEqual((await store.read()).now,fixture.now);await store.close();
});
test('tampering, wrong source links and duplicate IDs fail before writing',async()=>{
  const {store}=setup();await store.seed();const original=await store.exportData();let bundle=JSON.parse(original);
  bundle.payload.captures[0].text='Wrong';await assert.rejects(store.restore(JSON.stringify(bundle)),/checksum mismatch/);
  bundle=JSON.parse(original);bundle.payload.now.quote='Invented';bundle.sha256=await sha256(JSON.stringify(bundle.payload));await assert.rejects(store.restore(JSON.stringify(bundle)),/does not match/);
  bundle=JSON.parse(original);bundle.payload.captures.push(bundle.payload.captures[0]);bundle.sha256=await sha256(JSON.stringify(bundle.payload));await assert.rejects(store.restore(JSON.stringify(bundle)),/duplicate capture/);
  assert.equal(await store.exportData(),original);await store.close();
});
test('conflicting IDs cannot overwrite an existing original or partially restore',async()=>{
  const {store}=setup();await store.seed();const before=await store.exportData(),bundle=JSON.parse(before);
  const changed=bundle.payload.captures.find(c=>c.id!==bundle.payload.now.captureId);changed.text='Different verified text.';changed.hash=await sha256(changed.text);bundle.payload.now=null;
  bundle.sha256=await sha256(JSON.stringify(bundle.payload));await assert.rejects(store.restore(JSON.stringify(bundle)),/same ID differs/);assert.equal(await store.exportData(),before);await store.close();
});
test('explicit clear keeps unrelated browser storage and cannot remigrate erased data',async()=>{
  const legacy=memory();legacy.setItem(KEY,JSON.stringify(await v1Fixture()));legacy.setItem('unrelated','keep');
  const {store,another}=setup({legacy});await store.seed();await store.reset();await store.seed();assert.equal((await store.read()).captures.length,0);
  assert.equal(legacy.getItem('unrelated'),'keep');assert.equal(legacy.getItem(KEY),null);
  const second=another();await second.seed();assert.equal((await second.read()).captures.length,0);await store.seed(true);assert.equal((await store.read()).captures.length,2);await store.close();await second.close();
});
test('stale completion cannot clear work chosen through a second connection',async()=>{
  const {store,another}=setup();await store.seed();const previous=(await store.read()).now,second=another();
  const next=await second.capture("I'll try another outline.");await second.choose(next.id,0,next.text.length);await assert.rejects(store.complete(previous),/changed in another tab/);
  assert.equal((await store.read()).now.quote,next.text);await store.close();await second.close();
});
test('a broken view listener cannot turn a verified save into a failure',async()=>{
  const {store}=setup();await store.seed();store.subscribe(()=>{throw Error('View failed');});
  const capture=await store.capture('Still saved.');assert.ok((await store.read()).captures.some(c=>c.id===capture.id));await store.close();
});
test('bounded input and native-format backups are refused without mutation',async()=>{
  const {store}=setup();await store.seed();const before=await store.exportData();
  await assert.rejects(store.capture('x'.repeat(LIMITS.text+1)),/4,000/);
  await assert.rejects(store.restore('x'.repeat(LIMITS.backupBytes+1)),/32 MB/);
  const payload={version:2,kind:'native-phone-backup',captures:[],now:null,recovery:[]};await assert.rejects(store.restore(JSON.stringify({payload,sha256:await sha256(JSON.stringify(payload))})),/not a supported/);
  assert.equal(await store.exportData(),before);await store.close();
});

test('a capture delayed before commit cannot resurrect data after an explicit reset', async () => {
  const { store } = setup(); await store.seed();
  const original = crypto.subtle.digest.bind(crypto.subtle); let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  crypto.subtle.digest = async function(algorithm, data) { if (new TextDecoder().decode(data) === 'Delayed before reset.') { entered(); await gate; } return original(algorithm, data); };
  try {
    const pending = store.capture('Delayed before reset.'); await reached; await store.reset(); release();
    await assert.rejects(pending, /reset while saving/); assert.equal((await store.read()).captures.length, 0);
  } finally { release(); crypto.subtle.digest = original; await store.close(); }
});

test('a restore delayed during verification cannot undo a later explicit reset', async () => {
  const { store } = setup(); await store.seed(); const backup = await store.exportData(), payload = JSON.stringify(JSON.parse(backup).payload);
  const original = crypto.subtle.digest.bind(crypto.subtle); let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  crypto.subtle.digest = async function(algorithm, data) { if (new TextDecoder().decode(data) === payload) { entered(); await gate; } return original(algorithm, data); };
  try {
    const pending = store.restore(backup); await reached; await store.reset(); release();
    await assert.rejects(pending, /reset during restore/); assert.equal((await store.read()).captures.length, 0);
  } finally { release(); crypto.subtle.digest = original; await store.close(); }
});
