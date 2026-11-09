import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, sha256 } from '../public/store.js';
import { openDatabase, request } from '../public/database.js';
import { sourceRevisionState, createRevisions } from '../public/revisions.js';
import { recoveryRecord } from '../public/records.js';
import { seal } from '../public/intent.js';
globalThis.crypto ??= webcrypto;
async function setup() {
  const options={indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false};
  const store=createStore(options);await store.seed();const before=await store.read(),source=before.captures[0],raw=openDatabase({factory:options.indexedDB});
  const input=(kind,text,expectedLatestId=null,acknowledgedRecovery=[])=>({captureId:source.id,captureHash:source.hash,kind,text,expectedLatestId,acknowledgedRecovery});
  return {store,source,before,raw,input,another:()=>createStore(options),close:async()=>{await raw.close();await store.close();}};
}
test('corrections and supplied transcripts preserve exact originals, independent histories and chosen NOW',async()=>{
  const x=await setup();try{
    const transcript=await x.store.reviseSource(x.input('transcript','  Supplied wording.\r\nKeep it exact.  '));
    let state=await x.store.read();assert.equal(sourceRevisionState(state,x.source.id).effective.id,transcript.id);
    const edit=await x.store.reviseSource(x.input('edit','  An authored correction. 🧠  '),{expectedEffectiveId:transcript.id});
    const later=await x.store.reviseSource(x.input('transcript','A later supplied transcript.',transcript.id));
    state=await x.store.read();const derived=sourceRevisionState(state,x.source.id);assert.equal(derived.effective.id,edit.id);assert.equal(derived.transcript.id,later.id);
    assert.deepEqual(state.captures,x.before.captures);assert.deepEqual(state.now,x.before.now);assert.deepEqual(state.intentEvents,x.before.intentEvents);
    assert.equal(derived.transcriptHistory[0].text,'  Supplied wording.\r\nKeep it exact.  ');
  }finally{await x.close();}
});
test('stale editing and changed projection bases refuse while a separate intentional revision appends',async()=>{
  const x=await setup();try{
    const first=await x.store.reviseSource(x.input('edit','First correction.'));
    await assert.rejects(x.store.reviseSource(x.input('edit','Stale writing.')),/changed in another tab/);
    const second=await x.store.reviseSource(x.input('edit','Second correction.',first.id),{expectedEffectiveId:first.id});
    await assert.rejects(x.store.reviseSource(x.input('edit','Wrong projection base.',second.id),{expectedEffectiveId:first.id}),/changed in another tab/);
    assert.equal((await x.store.read()).sourceRevisions.length,2);
  }finally{await x.close();}
});
test('readback failure keeps accepted bytes and an exact retry returns one canonical revision',async()=>{
  const x=await setup(),get=IDBObjectStore.prototype.get;let failed=false;
  try{IDBObjectStore.prototype.get=function(key){if(this.name==='sourceRevisions'&&this.transaction.mode==='readonly'&&!failed){failed=true;throw Error('Synthetic revision readback failure');}return get.call(this,key);};
    const input=x.input('edit','Retry these exact words.');await assert.rejects(x.store.reviseSource(input),/could not be verified/);
    IDBObjectStore.prototype.get=get;const saved=await x.store.reviseSource(input);assert.equal((await x.store.read()).sourceRevisions.length,1);assert.equal(saved.text,input.text);
  }finally{IDBObjectStore.prototype.get=get;await x.close();}
});
test('portable restore preserves every source revision and semantic retry identity across workspace epochs',async()=>{
  const x=await setup(),target=createStore({indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false});try{
    const saved=await x.store.reviseSource(x.input('edit','Portable correction.')),backup=await x.store.exportData();
    await target.restore(backup);await target.restore(backup);const again=await target.reviseSource(x.input('edit','Portable correction.'));assert.deepEqual(again,saved);
    const state=await target.read();assert.equal(state.version,14);assert.deepEqual(state.sourceRevisions,[saved]);
    const old=structuredClone(JSON.parse(backup).payload);old.version=11;delete old.threadReviews;delete old.helperEvents;delete old.sourceRevisions;await target.restore(JSON.stringify({payload:old,sha256:await sha256(JSON.stringify(old))}));assert.deepEqual((await target.read()).sourceRevisions,[saved]);
  }finally{await target.close();await x.close();}
});
test('divergent source histories refuse atomically instead of selecting a newer-looking branch',async()=>{
  const x=await setup(),other=createStore({indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false});try{
    await other.restore(await x.store.exportData());await x.store.reviseSource(x.input('edit','One branch.'));await other.reviseSource(x.input('edit','Another branch.'));
    const before=await x.store.exportData();await assert.rejects(x.store.restore(await other.exportData()),/unique beginning|conflict/);assert.equal(await x.store.exportData(),before);
  }finally{await other.close();await x.close();}
});
test('corrupt later history and an older restored prefix stay unknown until an explicit new correction',async()=>{
  const x=await setup();try{
    const a=await x.store.reviseSource(x.input('edit','Earlier correction.')),prefix=await x.store.exportData();
    const b=await x.store.reviseSource(x.input('edit','Later correction.',a.id));
    await x.raw.run(['sourceRevisions'],'readwrite',async tx=>request(tx.objectStore('sourceRevisions').put({...b,text:'Damaged exact bytes'})));
    let state=await x.store.read();assert.equal(state.sourceRevisions.length,0);assert.ok(sourceRevisionState(state,x.source.id).uncertain);
    await x.store.restore(prefix);state=await x.store.read();let view=sourceRevisionState(state,x.source.id);assert.ok(view.uncertain);assert.equal(view.text,null);
    await assert.rejects(x.store.reviseSource(x.input('edit','A replacement.',a.id)),/acknowledge/);
    const replacement=await x.store.reviseSource(x.input('edit','A replacement.',a.id,view.editRecovery.map(r=>r.id)));
    state=await x.store.read();view=sourceRevisionState(state,x.source.id);assert.equal(view.effective.id,replacement.id);assert.ok(state.recovery.some(r=>r.raw.includes('Damaged exact bytes')));
    const continued=await x.store.reviseSource(x.input('edit','Continue from the explicit replacement.',replacement.id));assert.equal(sourceRevisionState(await x.store.read(),x.source.id).effective.id,continued.id);
  }finally{await x.close();}
});
test('unavailable optional revision storage leaves capture and NOW usable and refuses an incomplete backup',async()=>{
  const x=await setup();const original=IDBObjectStore.prototype.getAll;try{
    IDBObjectStore.prototype.getAll=function(...args){if(this.name==='sourceRevisions')throw Error('Synthetic optional revision failure');return original.apply(this,args);};
    const state=await x.store.read();assert.match(state.revisionWarning,/unavailable/);assert.deepEqual(state.now,x.before.now);
    await x.store.capture('Capture survives a broken optional history.');await assert.rejects(x.store.exportData(),/complete backup/);
  }finally{IDBObjectStore.prototype.getAll=original;await x.close();}
});
test('reset epochs, wrong source hashes and reused request identities cannot retarget correction writing',async()=>{
  const x=await setup();try{
    const epoch=(await x.store.health()).epoch,input=x.input('edit','Exact source only.'),requestId=crypto.randomUUID();
    await x.store.reviseSource(input,{requestId});await assert.rejects(x.store.reviseSource({...input,text:'Different writing.'},{requestId}),/different source writing/);
    await assert.rejects(x.store.reviseSource({...input,captureHash:'0'.repeat(64)}),/source needs recovery/);
    await x.store.reset();await assert.rejects(x.store.reviseSource(input,{expectedEpoch:epoch}),/workspace changed/);
  }finally{await x.close();}
});

test('oversized incoming history refuses without pruning any saved revision or changing original work',async()=>{
  const x=await setup();try{
    const first=await x.store.reviseSource(x.input('edit','Keep the earlier evidence.')),before=await x.store.exportData(),payload=JSON.parse(before).payload;
    const {hash,...body}=first,ids=Array.from({length:600},()=>crypto.randomUUID()),text='🧠'.repeat(2000);
    const rows=await Promise.all(ids.map((id,n)=>seal({...body,id,previousId:n?ids[n-1]:first.id,text})));
    payload.sourceRevisions.push(...rows);const raw=JSON.stringify({payload,sha256:await sha256(JSON.stringify(payload))});
    await assert.rejects(x.store.restore(raw),/oversized source revision history/);assert.equal(await x.store.exportData(),before);
  }finally{await x.close();}
});

test('an intact correction remains readable and portable when its original needs recovery',async()=>{
  const x=await setup();try{
    const saved=await x.store.reviseSource(x.input('edit','Preserve this independent correction.'));
    await x.raw.run(['captures'],'readwrite',tx=>request(tx.objectStore('captures').put({...x.source,text:'Damaged original bytes.'})));
    const state=await x.store.read();assert.deepEqual(state.sourceRevisions,[saved]);assert.ok(!state.captures.some(c=>c.id===x.source.id));assert.ok(state.recovery.some(r=>r.source==='capture'&&r.recordId===x.source.id));
    const target=createStore({indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false});try{await target.restore(await x.store.exportData());assert.deepEqual((await target.read()).sourceRevisions,[saved]);}finally{await target.close();}
  }finally{await x.close();}
});

test('revision repair cannot quarantine intact writing when primary damage arrives between recovery stages',async()=>{
  const x=await setup();try{
    const saved=await x.store.reviseSource(x.input('edit','Keep the intact correction through the race.'));
    await x.raw.run(['captures'],'readwrite',tx=>request(tx.objectStore('captures').put({...x.source,text:'Damage arriving after primary repair.'})));
    const revisions=createRevisions({db:x.raw,recoveryRecord});await revisions.repair();
    const state=await x.store.read();assert.deepEqual(state.sourceRevisions,[saved]);assert.equal(state.recovery.filter(r=>r.source==='sourceRevisions').length,0);
  }finally{await x.close();}
});
