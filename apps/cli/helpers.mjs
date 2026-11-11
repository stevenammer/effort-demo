import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHelpers } from '../../packages/helpers/thread.js';
import { createMemoryTrust } from '../../packages/helpers/trust.js';
import { referenceReply } from '../../packages/helpers/reference.js';
import { makeDigest } from '../../packages/core/sealed.js';

async function readJSON(path, limit=262144) {
  const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW||0));
  try {
    const info=await handle.stat();
    if (!info.isFile() || info.size>limit) throw Error('Helper input must be a bounded regular file.');
    const buffer=Buffer.alloc(limit+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if (bytesRead>limit) throw Error('Helper input exceeds its limit.');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead)));
  } finally { await handle.close(); }
}
async function privateJSON(path, value) {
  const temporary=`${path}.${randomUUID()}.tmp`;
  const handle=await open(temporary,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(temporary,path); }
  finally { await handle.close(); await rm(temporary,{force:true}); }
}

/** Administrative local reference workflow; no browser settings or model transport. */
export async function runHelperCommand(words,{store,hash,home,output}) {
  await mkdir(home,{recursive:true,mode:0o700});
  const trustPath=join(home,'helper-trust.json');
  let initial;
  try { initial=await readJSON(trustPath,2*1024*1024); } catch (error) { if (error.code!=='ENOENT') throw Error('The host-local helper trust store needs recovery.'); }
  const trust=createMemoryTrust(initial),now=()=>new Date().toISOString(),helpers=createHelpers({store,hash,now,id:randomUUID,trust});
  const [command,...args]=words;
  const human={authority:'human'};
  if (command==='pair-reference' && args.length===2) {
    const prior=(await helpers.read()).recipients.find(row=>row.id===args[0]);
    const recipient=await helpers.pair(prior&&prior.expiresAt===args[1]?prior:{id:args[0],kind:'reference',pairedAt:now(),expiresAt:args[1]},human);
    await trust.trustRecipient(recipient,human); await privateJSON(trustPath,trust.snapshot());
    output(`PAIRED ${recipient.id} (deterministic local reference, no model)`); return;
  }
  if (command==='request' && args[0]==='--local-only' && args.length>=8) {
    const [,sourceId,start,end,recipientId,role,requestedResult,...question]=args;
    const row=await helpers.request({sourceId,context:[{captureId:sourceId,start:Number(start),end:Number(end),privacy:'local-only'}],recipientId,invited:[role],requestedResult,question:question.join(' ')});
    output(`REQUESTED ${row.request.id} ${row.requestHash}`); return;
  }
  if (command==='show' && args.length===1) { output(JSON.stringify(await helpers.read(args[0]),null,2)); return; }
  if (command==='list' && !args.length) {
    for (const row of (await helpers.read()).requests) output(`${row.request.id}\t${row.requestHash}\t${row.request.sourceId}`);
    return;
  }
  if (command==='review' && args[0]==='--local-only' && args.length===4) {
    const approval=await helpers.review(args[1],{...human,privacy:'local-only',expectedRequestHash:args[2],expiresAt:args[3]});
    await trust.trustApproval(approval,human); await privateJSON(trustPath,trust.snapshot());
    output(`APPROVED ${args[1]} ${approval.checksum}`); return;
  }
  if ((command==='dispatch' && args.length===2) || (command==='retry' && args.length===4 && args[3]==='--acknowledge-uncertain')) {
    try {
      const event=await helpers.dispatch(args[0],args[1],command==='retry'?{retry:true,acknowledgeUncertain:true,expectedLatestId:args[2]}:{});
      output(`RESULT ${event.id} (deterministic reference writing, no model call)`);
    } catch (error) {
      if (error.received!==undefined) {
        const path=join(home,`helper-result-${error.attemptId}.json`);
        await privateJSON(path,error.received); output(`RETAINED ${path}`);
      }
      throw error;
    }
    return;
  }
  if (command==='reconcile' && args.length===2) {
    const packet=await helpers.pendingPacket(args[0],args[1]);
    const event=await helpers.accept(await referenceReply(packet,makeDigest(hash)));
    output(`RESULT ${event.id} (reconciled the same deterministic attempt without dispatching again)`); return;
  }
  if (command==='accept' && args.length===1) {
    const event=await helpers.accept(await readJSON(args[0])); output(`RESULT ${event.id}`); return;
  }
  if (['uncertain','stop'].includes(command) && args.length===3) {
    const event=await helpers.end(args[0],args[1],{expectedLatestId:args[2],status:command==='stop'?'stopped':'uncertain'});
    output(`${event.status.toUpperCase()} ${event.id}`); return;
  }
  if (command==='prepare-reply' && args.length===2) {
    const capture=await helpers.prepareReply(args[0],args[1],human);
    output(`PREPARED ${capture.id} (reference writing, no commitment)`); return;
  }
  throw Error('Usage: effort helper pair-reference <recipient> <expiry> | request --local-only <sourceId> <start> <end> <recipient> <critic|starter> <resultType> <question> | show <requestId> | list | review --local-only <requestId> <requestHash> <expiry> | dispatch <requestId> <role> | reconcile <requestId> <role> | accept <resultFile> | uncertain <requestId> <role> <latestId> | stop <requestId> <role> <latestId> | retry <requestId> <role> <latestId> --acknowledge-uncertain | prepare-reply <requestId> <role>');
}
