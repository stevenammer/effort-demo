import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createStore, sha256 } from '../public/store.js';
import { validateCapture as checkCapture } from '../public/records.js';
import { openDatabase, request } from '../public/database.js';
import { revisionProposalId, validateRevisionProposal } from '../public/revision-proposals.js';
globalThis.crypto ??= webcrypto;
async function setup(){const options={indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false},store=createStore(options);await store.seed();const before=await store.read(),source=before.captures[0],revision=await store.reviseSource({captureId:source.id,captureHash:source.hash,kind:'edit',text:"  🧠 I'll consider this corrected detail.\r\nNo automatic choice.  ",expectedLatestId:null,acknowledgedRecovery:[]});return{store,source,revision,before,raw:openDatabase({factory:options.indexedDB}),another:()=>createStore(options),input:{revisionId:revision.id,revisionHash:revision.hash},close:async()=>store.close()};}
test('revision preparation copies exact bytes and provenance; only choosing the new proposal changes NOW',async()=>{
 const x=await setup();try{const p=await x.store.prepareRevisionProposal(x.input),st=await x.store.read();assert.equal(p.text,x.revision.text);assert.equal(p.parentId,x.source.id);assert.equal(p.sourceRevisionId,x.revision.id);assert.equal(p.sourceRevisionHash,x.revision.hash);assert.equal(p.id,await revisionProposalId(x.revision.id,x.revision.hash));assert.equal(validateRevisionProposal(p,st),'verified');assert.deepEqual(st.now,x.before.now);assert.deepEqual(st.intentEvents,x.before.intentEvents);assert.deepEqual(st.captures.find(c=>c.id===x.source.id),x.source);
 const start=p.text.indexOf("I'll"),end=p.text.indexOf('\r\n');await x.store.choose(p.id,start,end);const chosen=await x.store.read();assert.equal(chosen.now.captureId,p.id);assert.equal(chosen.now.quote,p.text.slice(start,end));assert.notEqual(chosen.now.captureId,x.source.id);
 }finally{await x.raw.close();await x.close();}
});
test('concurrent preparation and a restored retry reuse the same sealed proposal across workspace epochs',async()=>{
 const x=await setup(),other=x.another(),target=createStore({indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false});try{const[a,b]=await Promise.all([x.store.prepareRevisionProposal(x.input),other.prepareRevisionProposal(x.input)]);assert.deepEqual(a,b);await target.restore(await x.store.exportData());assert.deepEqual(await target.prepareRevisionProposal(x.input),a);assert.equal((await target.read()).captures.filter(c=>c.sourceRevisionId===x.revision.id).length,1);}finally{await other.close();await target.close();await x.raw.close();await x.close();}
});
test('an accepted proposal with failed readback can be checked again without another capture',async()=>{
 const x=await setup(),get=IDBObjectStore.prototype.get,id=await revisionProposalId(x.revision.id,x.revision.hash);let fail=true;try{IDBObjectStore.prototype.get=function(key){if(this.name==='captures'&&key===id&&this.transaction.mode==='readonly'&&fail){fail=false;throw Error('Synthetic proposal readback failure');}return get.call(this,key);};await assert.rejects(x.store.prepareRevisionProposal(x.input),/could not be verified/);IDBObjectStore.prototype.get=get;const p=await x.store.prepareRevisionProposal(x.input);assert.equal(p.id,id);assert.equal((await x.store.read()).captures.filter(c=>c.sourceRevisionId===x.revision.id).length,1);}finally{IDBObjectStore.prototype.get=get;await x.raw.close();await x.close();}
});
test('bad revision lineage never removes an intact prepared proposal or retargets its chosen quote',async()=>{
 const x=await setup();try{const p=await x.store.prepareRevisionProposal(x.input);await x.store.choose(p.id,0,p.text.length);await x.raw.run(['sourceRevisions'],'readwrite',tx=>request(tx.objectStore('sourceRevisions').put({...x.revision,text:'Damaged revision bytes.'})));const st=await x.store.read();assert.deepEqual(st.captures.find(c=>c.id===p.id),p);assert.equal(validateRevisionProposal(p,st),'recovery');assert.equal(st.now.captureId,p.id);assert.equal(st.now.quote,p.text);await assert.rejects(x.store.prepareRevisionProposal(x.input),/need recovery/);await x.store.capture('New capture still works after lineage damage.');}finally{await x.raw.close();await x.close();}
});
test('a deleted lineage record is preserved as a derivation recovery claim and travels in backup',async()=>{
 const x=await setup(),target=createStore({indexedDB:new IDBFactory(),legacyStorage:null,broadcast:false});try{const p=await x.store.prepareRevisionProposal(x.input);await x.raw.run(['sourceRevisions'],'readwrite',tx=>request(tx.objectStore('sourceRevisions').delete(x.revision.id)));const st=await x.store.read();assert.equal(validateRevisionProposal(p,st),'recovery');assert.ok(st.recovery.some(r=>r.source==='derivation'&&r.recordId===p.id));await target.restore(await x.store.exportData());assert.equal(validateRevisionProposal(p,await target.read()),'recovery');assert.deepEqual((await target.read()).captures.find(c=>c.id===p.id),p);}finally{await target.close();await x.raw.close();await x.close();}
});
test('unknown optional revision storage keeps primary proposal bytes usable without inventing damage records',async()=>{
 const x=await setup(),all=IDBObjectStore.prototype.getAll;try{const p=await x.store.prepareRevisionProposal(x.input);IDBObjectStore.prototype.getAll=function(...args){if(this.name==='sourceRevisions')throw Error('Synthetic revision outage');return all.apply(this,args);};const st=await x.store.read();assert.equal(validateRevisionProposal(p,st),'recovery');assert.deepEqual(st.captures.find(c=>c.id===p.id),p);assert.ok(!st.recovery.some(r=>r.source==='derivation'&&r.recordId===p.id));await x.store.capture('Capture survives unavailable proposal ancestry.');await assert.rejects(x.store.exportData(),/complete backup/);}finally{IDBObjectStore.prototype.getAll=all;await x.raw.close();await x.close();}
});
test('altered revision hash or metadata is refused atomically even when a replacement checksum is supplied',async()=>{
 const x=await setup();try{const p=await x.store.prepareRevisionProposal(x.input),before=await x.store.exportData(),payload=JSON.parse(before).payload,bad=payload.captures.find(c=>c.id===p.id);bad.sourceRevisionHash='0'.repeat(64);bad.id=await revisionProposalId(bad.sourceRevisionId,bad.sourceRevisionHash);const{derivedHash,...body}=bad;bad.derivedHash=await sha256(JSON.stringify(body));await checkCapture(bad);await assert.rejects(x.store.restore(JSON.stringify({payload,sha256:await sha256(JSON.stringify(payload))})),/does not match/);assert.equal(await x.store.exportData(),before);}finally{await x.raw.close();await x.close();}
});
test('a workspace reset or wrong selected revision checksum cannot prepare from stale context',async()=>{
 const x=await setup();try{const epoch=(await x.store.health()).epoch;await assert.rejects(x.store.prepareRevisionProposal({...x.input,revisionHash:'0'.repeat(64)}),/need recovery/);await x.store.reset();await assert.rejects(x.store.prepareRevisionProposal(x.input,{expectedEpoch:epoch}),/workspace changed/);assert.equal((await x.store.read()).captures.length,0);}finally{await x.raw.close();await x.close();}
});

test('supplied transcript proposals preserve their distinct exact source even when corrections take precedence',async()=>{
 const x=await setup();try{const t=await x.store.reviseSource({captureId:x.source.id,captureHash:x.source.hash,kind:'transcript',text:'  Supplied transcript only.\r\nNo audio claim.  ',expectedLatestId:null,acknowledgedRecovery:[]});const p=await x.store.prepareRevisionProposal({revisionId:t.id,revisionHash:t.hash});assert.equal(p.text,t.text);assert.equal(p.sourceRevisionHash,t.hash);assert.equal(validateRevisionProposal(p,await x.store.read()),'verified');assert.deepEqual((await x.store.read()).now,x.before.now);}finally{await x.raw.close();await x.close();}
});

test('proposal capacity refusal preserves all existing originals and revision writing without truncation',async()=>{
 const x=await setup();try{await x.raw.run(['captures'],'readwrite',async tx=>{const table=tx.objectStore('captures'),rows=await request(table.getAll());for(let n=rows.length;n<1000;n++)await request(table.add({...x.source,id:crypto.randomUUID()}));});const before=await x.store.exportData();await assert.rejects(x.store.prepareRevisionProposal(x.input),/capture limit/);assert.equal(await x.store.exportData(),before);}finally{await x.raw.close();await x.close();}
});

test('structured storage cannot disguise missing provenance as an ordinary capture with undefined fields',async()=>{
 const x=await setup();try{const p=await x.store.prepareRevisionProposal(x.input);
  await assert.rejects(checkCapture({...p,sourceRevisionId:undefined}),/proposal identity/);
  await assert.rejects(checkCapture({...x.source,parentId:undefined}),/capture format/);
  await assert.rejects(checkCapture({id:crypto.randomUUID(),text:p.text,hash:p.hash,createdAt:p.createdAt,span:p.span,sample:false,parentId:x.source.id,derivedFromId:undefined,derivedHash:'0'.repeat(64)}),/capture format/);
  await x.store.choose(p.id,0,p.text.length);await x.raw.run(['captures'],'readwrite',tx=>request(tx.objectStore('captures').put({...p,sourceRevisionId:undefined})));
  const st=await x.store.read();assert.ok(!st.captures.some(c=>c.id===p.id));assert.ok(st.recovery.some(r=>r.source==='capture'&&r.recordId===p.id&&r.raw.includes(p.text.slice(2,10))));assert.equal((await x.store.health()).heldNow,true);
 }finally{await x.raw.close();await x.close();}
});
