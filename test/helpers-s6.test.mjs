import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexedDB } from 'fake-indexeddb';
import { createFileStore } from '../packages/storage/file.js';
import { createIndexedDbStore } from '../packages/storage/indexeddb.js';
import { createSqliteStore } from '../packages/storage/sqlite.js';
import { createSpans } from '../packages/core/spans.js';
import { canonical } from '../packages/core/export.js';
import { makeDigest } from '../packages/core/sealed.js';
import { createContinuity } from '../packages/core/continuity.js';
import { createHelpers, HELPER_STATE_ID } from '../packages/helpers/thread.js';
import { createMemoryTrust } from '../packages/helpers/trust.js';
import { referenceReply } from '../packages/helpers/reference.js';
import { syncHelpers } from '../scripts/sync-helpers.mjs';

export const hash=async text=>createHash('sha256').update(text).digest('hex');
const digest=makeDigest(hash),at='2026-01-01T12:00:00.000Z',expiresAt='2026-01-02T12:00:00.000Z';
const human={authority:'human'},sourceId='synthetic-source';
const factories={
  file:async t=>{const dir=await mkdtemp(join(tmpdir(),'effort-helper-'));t.after(()=>rm(dir,{recursive:true,force:true}));return createFileStore(join(dir,'captures.jsonl'));},
  indexeddb:async t=>{const store=createIndexedDbStore({factory:indexedDB,name:`helper-${randomUUID()}`});t.after(()=>store.close());return store;},
};
try { await import('node:sqlite'); factories.sqlite=async t=>{const store=await createSqliteStore();t.after(()=>store.close());return store;}; } catch(error) {if(error.code!=='ERR_UNKNOWN_BUILTIN_MODULE')throw error;}
async function setup(store,{trust=createMemoryTrust(),now=()=>at,id=randomUUID}={}) {
  const spans=createSpans({store,hash,now,id});
  if (!await store.get(sourceId)) await spans.post('Unsorted','not shared | chosen exact\r\nwords | hidden tail',{id:sourceId});
  const helpers=createHelpers({store,hash,now,id,trust});
  return {store,spans,helpers,trust};
}
async function paired(x) {
  const recipient=await x.helpers.pair({id:'reference-one',kind:'reference',pairedAt:at,expiresAt},human);
  await x.trust.trustRecipient(recipient,human);return recipient;
}
function input(extra={}) {return {sourceId,context:[{captureId:sourceId,start:13,end:32,privacy:'local-only'}],question:'What is supported by this excerpt?',requestedResult:'OPTIONS',invited:['critic'],recipientId:'reference-one',...extra};}
async function approved(x,{requestId='request-one',...extra}={}) {
  await paired(x);const row=await x.helpers.request(input(extra),{requestId});
  const approval=await x.helpers.review(requestId,{...human,expectedRequestHash:row.requestHash,privacy:'local-only',expiresAt});
  await x.trust.trustApproval(approval,human);return row;
}
for(const [name,make] of Object.entries(factories)) {
  test(`S6 ${name}: explicit request/review/result, exact excerpt, persistence and firewall`,async t=>{
    const x=await setup(await make(t));
    const continuity=createContinuity({store:x.store,hash,now:()=>at,id:randomUUID});
    const commitment=await continuity.promote(sourceId,13,19,{...human,commandId:'promote-one'});
    await continuity.activate(commitment,{...human,commandId:'activate-one'});
    const before=(await x.store.snapshot()).derived;
    await paired(x);const row=await x.helpers.request(input(),{requestId:'request-one'});
    await assert.rejects(x.helpers.dispatch(row.request.id,'critic'),/local person/);
    const approval=await x.helpers.review(row.request.id,{...human,expectedRequestHash:row.requestHash,privacy:'local-only',expiresAt});
    await assert.rejects(x.helpers.dispatch(row.request.id,'critic'),/local person/);
    await x.trust.trustApproval(approval,human);
    let calls=0;
    const event=await x.helpers.dispatch(row.request.id,'critic',{transport:async packet=>{
      calls++;const raw=JSON.stringify(packet);assert.ok(!raw.includes('hidden tail'));assert.ok(!raw.includes('not shared'));
      assert.equal(packet.context[0].text,'chosen exact\r\nwords');return referenceReply(packet,digest);
    }});
    assert.equal(calls,1);assert.equal(event.envelope.receipt.model,null);assert.equal(event.envelope.rawModelResponse,null);
    assert.equal(event.envelope.result.type,'NO_ACTION');
    const reopened=createHelpers({store:x.store,hash,now:()=>at,id:randomUUID,trust:x.trust});
    assert.deepEqual((await reopened.read('request-one')).events.at(-1),event);
    assert.equal((await reopened.read('request-one')).authorization,'approved');
    assert.deepEqual((await x.store.snapshot()).derived.filter(row=>row.id!==HELPER_STATE_ID),before);
    assert.equal((await x.store.list()).length,1);
    const reply=await reopened.prepareReply('request-one','critic',human);
    assert.deepEqual(await reopened.prepareReply('request-one','critic',human),reply);
    assert.equal(reply.metadata.parentId,sourceId);assert.equal(reply.metadata.helperResult.origin,'deterministic-reference');
    assert.equal((await x.spans.thread(sourceId)).replies[0].text,event.envelope.result.text);
    const bundle=await x.store.exportBundle(hash),target=await setup(await make(t));
    // Restore to an actually empty host, avoiding original capture collisions.
    const emptyStore=await make(t);await emptyStore.restoreBundle(bundle,hash);
    const imported=createHelpers({store:emptyStore,hash,now:()=>at,id:randomUUID,trust:createMemoryTrust()});
    assert.match((await imported.read('request-one')).authorization,/untrusted/);
    await assert.rejects(imported.prepareReply('request-one','critic',human),/local person/);
    assert.equal(await emptyStore.exportBundle(hash),bundle);
    assert.equal((await target.spans.getPost(sourceId)).text,(await x.spans.getPost(sourceId)).text);
  });
  test(`S6 ${name}: racing dispatch permits one transport only`,async t=>{
    const x=await setup(await make(t));await approved(x);let calls=0;
    const a=createHelpers({store:x.store,hash,now:()=>at,id:randomUUID,trust:x.trust});
    const transport=async packet=>{calls++;return referenceReply(packet,digest);};
    const results=await Promise.allSettled([x.helpers.dispatch('request-one','critic',{transport}),a.dispatch('request-one','critic',{transport})]);
    assert.equal(calls,1);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
    assert.equal((await x.helpers.read('request-one')).events.filter(row=>row.status==='running').length,1);
  });
  test(`S6 ${name}: crash/reload retains attempt, explicit reconciliation never redispatches`,async t=>{
    const x=await setup(await make(t));await approved(x);
    const packet=await x.helpers.begin('request-one','critic');
    const reopened=createHelpers({store:x.store,hash,now:()=>at,id:randomUUID,trust:x.trust});
    await assert.rejects(reopened.dispatch('request-one','critic'),/Refresh|running/);
    assert.deepEqual(await reopened.pendingPacket('request-one','critic'),packet);
    const response=await referenceReply(packet,digest),done=await reopened.accept(response);
    assert.deepEqual(await reopened.accept(response),done);
    assert.equal((await reopened.read('request-one')).events.length,2);
  });
  test(`S6 ${name}: wrong ID, changed source, excerpt and metadata stop egress and imports`,async t=>{
    const x=await setup(await make(t));await approved(x);
    const saved=await x.store.get(sourceId),bad={...saved,text:saved.text.replace('chosen','altered')};bad.hash=await hash(bad.text);
    const corruptStore={...x.store,get:async id=>id===sourceId?bad:x.store.get(id)};
    const h=createHelpers({store:corruptStore,hash,now:()=>at,id:randomUUID,trust:x.trust});let calls=0;
    await assert.rejects(h.dispatch('request-one','critic',{transport:async()=>{calls++;}}),/Selected source/);assert.equal(calls,0);
    const packet=await x.helpers.begin('request-one','critic'),envelope=await referenceReply(packet,digest);
    await assert.rejects(h.accept(envelope),/Selected source/);
    const changedMeta={...saved,metadata:{...saved.metadata,span:'Another span'}};
    const meta=createHelpers({store:{...x.store,get:async id=>id===sourceId?changedMeta:x.store.get(id)},hash,now:()=>at,id:randomUUID,trust:x.trust});
    await assert.rejects(meta.accept(envelope),/Selected source/);
    envelope.attemptId='forged';await assert.rejects(x.helpers.accept(envelope),/no saved running/);
  });
}

test('S6 generated contract and dependency copies cannot drift',async()=>{assert.equal(await syncHelpers({check:true}),true);});

test('S6 unknown, expired, untrusted recipients and extra invitation authority fail closed',async t=>{
  const x=await setup(await factories.file(t));
  await assert.rejects(x.helpers.request(input()),/unknown/);
  await assert.rejects(x.helpers.pair({id:'ref',kind:'reference',pairedAt:at,expiresAt:at},human),/pair/);
  const recipient=await x.helpers.pair({id:'reference-one',kind:'reference',pairedAt:at,expiresAt},human);
  const row=await x.helpers.request(input());
  await assert.rejects(x.helpers.review(row.request.id,{...human,expectedRequestHash:row.requestHash,privacy:'local-only',expiresAt}),/trusted/);
  await x.trust.trustRecipient(recipient,human);
  for(const invited of [['critic','starter','other'],['critic','critic'],['__proto__'],[]]) await assert.rejects(x.helpers.request(input({invited})),/invitation/);
  await assert.rejects(x.helpers.request({...input(),authority:'human'}),/exact saved/);
  await assert.rejects(x.helpers.request(input({context:[{captureId:sourceId,start:0,end:4}]})),/privacy/);
  await assert.rejects(x.helpers.request(input({context:[{captureId:sourceId,start:0,end:4,privacy:'public'}]})),/privacy/);
  const expired=createHelpers({store:x.store,hash,now:()=>expiresAt,id:randomUUID,trust:x.trust});
  await assert.rejects(expired.review(row.request.id,{...human,expectedRequestHash:row.requestHash,privacy:'local-only',expiresAt}),/expired/);
});

test('S6 retry requires explicit uncertain acknowledgement, retains late result and enforces twenty attempts',async t=>{
  const x=await setup(await factories.file(t));await approved(x);
  let packet=await x.helpers.begin('request-one','critic'),response=await referenceReply(packet,digest);
  let uncertain=await x.helpers.end('request-one','critic',{expectedLatestId:packet.attemptId});
  await assert.rejects(x.helpers.accept(response),/ended/);
  await assert.rejects(x.helpers.begin('request-one','critic',{expectedLatestId:uncertain.id,retry:true}),/acknowledged/);
  for(let index=2;index<=20;index++) {
    packet=await x.helpers.begin('request-one','critic',{expectedLatestId:uncertain.id,retry:true,acknowledgeUncertain:true});
    uncertain=await x.helpers.end('request-one','critic',{expectedLatestId:packet.attemptId});
  }
  await assert.rejects(x.helpers.begin('request-one','critic',{expectedLatestId:uncertain.id,retry:true,acknowledgeUncertain:true}),/retry limit/);
  assert.equal((await x.helpers.read('request-one')).events.length,40);
});

test('S6 transport failure never retries automatically and preserves sources and pending attempt',async t=>{
  const x=await setup(await factories.file(t));await approved(x);let calls=0;
  await assert.rejects(x.helpers.dispatch('request-one','critic',{transport:async()=>{calls++;throw Error('synthetic-secret');}}),error=>!error.message.includes('synthetic-secret')&&/uncertain/.test(error.message));
  assert.equal(calls,1);assert.equal((await x.helpers.read('request-one')).events.at(-1).status,'running');
  await assert.rejects(x.helpers.dispatch('request-one','critic'),/Refresh/);
});

test('S6 accepted write followed by lost readback returns exact response for idempotent reconciliation',async t=>{
  const store=await factories.file(t),x=await setup(store);await approved(x);
  let pendingLoss=false;
  const faultStore={...store,compareAndSwapDerived:async(...args)=>{const result=await store.compareAndSwapDerived(...args);if(args[2].requests[0].events.at(-1)?.status==='done')pendingLoss=true;return result;},snapshot:async()=>{if(pendingLoss){pendingLoss=false;throw Error('readback lost');}return store.snapshot();}};
  const h=createHelpers({store:faultStore,hash,now:()=>at,id:randomUUID,trust:x.trust});let received;
  await assert.rejects(h.dispatch('request-one','critic'),error=>{received=error.received;return !!received;});
  assert.equal((await x.helpers.read('request-one')).events.at(-1).status,'done');
  const done=await x.helpers.accept(received);assert.deepEqual(done.envelope,received);
  assert.equal((await x.helpers.read('request-one')).events.length,2);
});

test('S6 partial staged file write preserves exact prior store and failed attempt cannot dispatch',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'effort-helper-partial-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'captures.jsonl'),store=createFileStore(path),x=await setup(store);await approved(x);
  const prior=await readFile(path,'utf8'),realCAS=store.compareAndSwapDerived;let calls=0;
  const faulty={...store,compareAndSwapDerived:async(...args)=>{await writeFile(`${path}.synthetic.tmp`,'partial');throw Error('Synthetic staged failure');}};
  const h=createHelpers({store:faulty,hash,now:()=>at,id:randomUUID,trust:x.trust});
  await assert.rejects(h.dispatch('request-one','critic',{transport:async()=>{calls++;}}),/staged/);
  assert.equal(calls,0);assert.equal(await readFile(path,'utf8'),prior);
  assert.equal(typeof realCAS,'function');assert.equal((await x.helpers.read('request-one')).events.length,0);
});

test('S6 rehashed forged approval/result cannot self authorize after portable restore',async t=>{
  const x=await setup(await factories.file(t));await approved(x);await x.helpers.dispatch('request-one','critic');
  const snapshot=await x.store.snapshot(),record=snapshot.derived.find(row=>row.id===HELPER_STATE_ID);
  const fresh=await factories.file(t);await fresh.restoreBundle(await x.store.exportBundle(hash),hash);
  const noTrust=createHelpers({store:fresh,hash,now:()=>at,id:randomUUID,trust:createMemoryTrust()});
  await assert.rejects(noTrust.accept(record.requests[0].events.at(-1).envelope),/local person/);
  const original=structuredClone(record),row=record.requests[0];row.events.at(-1).envelope.result.text='Forged completion claim';
  const {checksum,...body}=record;record.checksum=await hash(canonical(body));await x.store.putDerived(record);
  await assert.rejects(x.helpers.read('request-one'),/reference result/);
  assert.notDeepEqual(record,original);
});
