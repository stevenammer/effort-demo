import { request } from './database.js';
import { validId, validHash, stableId, sha256, same, IntegrityError } from './primitives.js';
import { validateCapture } from './records.js';
import { validateReviewState, helperState, reviewContextStatus, REVIEW_TABLES } from './thread-review.js';
import { spanKey, validSpan } from './spans.js';

export const helperProposalId=(id,hash)=>stableId(JSON.stringify(['helper-proposal',id,hash]));
export function validateHelperProposal(capture,state,{checkSources=true}={}) {
  if(capture.helperEventId===undefined)return null;
  if(state.reviewWarning)return 'recovery';
  const recorded=()=>state.recovery.some(r=>r.source==='derivation'&&r.recordId===capture.id&&r.raw===JSON.stringify(capture));
  const fail=message=>{if(recorded())return 'recovery';throw new IntegrityError(message);};
  const event=(state.helperEvents??[]).find(e=>e.id===capture.helperEventId);
  if(!event){if(state.recovery.some(r=>r.source==='helperEvents'&&r.recordId===capture.helperEventId))return 'recovery';return fail('A helper proposal is missing its exact saved answer.');}
  if(event.hash!==capture.helperEventHash||event.status!=='done'||event.output!==capture.text)return fail('A helper proposal does not match its sealed answer.');
  const review=(state.threadReviews??[]).find(r=>r.id===event.reviewId);
  if(!review){if(state.recovery.some(r=>r.source==='threadReviews'&&r.recordId===event.reviewId))return 'recovery';return fail('A helper proposal is missing its approved context.');}
  if(event.reviewHash!==review.hash||review.sourceId!==capture.parentId||!review.invited.includes(event.role))return fail('A helper proposal differs from its approved review.');
  if(helperState(state,review.id,event.role).status==='recovery')return 'recovery';
  if(review.context.some(ctx=>!state.captures.some(c=>c.id===ctx.captureId)&&!state.recovery.some(r=>r.source==='capture'&&r.recordId===ctx.captureId)))return fail('A helper proposal is missing a selected source.');
  if(checkSources){
    const original=state.captures.find(c=>c.id===capture.parentId);
    if(!original){if(state.recovery.some(r=>r.source==='capture'&&r.recordId===capture.parentId))return 'recovery';return fail('A helper proposal is missing its original source.');}
    if(spanKey(original.span)!==spanKey(capture.span))return fail('A helper proposal no longer matches its source Attention Span.');
    if(reviewContextStatus(review,state)!=='verified'){
      if(review.context.some(c=>!state.captures.some(row=>row.id===c.captureId)&&state.recovery.some(r=>r.source==='capture'&&r.recordId===c.captureId)))return 'recovery';
      return fail('A helper proposal context no longer matches its selected originals.');
    }
  }
  return 'verified';
}
export function createHelperProposals({db,ready=async()=>{},notify=()=>{},recoveryRecord,ensureCapacity}) {
  const meta=(tx,key)=>request(tx.objectStore('meta').get(key)).then(r=>r?.value);
  async function snapshot(){await ready();return db.run(['meta','captures','quarantine',...REVIEW_TABLES],'readonly',async tx=>({epoch:await meta(tx,'epoch'),captures:await request(tx.objectStore('captures').getAll()),recovery:await request(tx.objectStore('quarantine').getAll()),threadReviews:await request(tx.objectStore('threadReviews').getAll()),helperEvents:await request(tx.objectStore('helperEvents').getAll())}));}
  async function repair(){const state=await snapshot();if(!state.captures.some(c=>c.helperEventId))return;await validateReviewState(state);const bad=[];
    for(const capture of state.captures.filter(c=>c.helperEventId)){await validateCapture(capture);try{validateHelperProposal(capture,state,{checkSources:false});}catch(error){if(!(error instanceof IntegrityError))throw error;bad.push(await recoveryRecord('derivation',capture.id,JSON.stringify(capture),error.message));}}
    if(!bad.length)return;await db.run(['meta','captures','quarantine',...REVIEW_TABLES],'readwrite',async tx=>{if(await meta(tx,'epoch')!==state.epoch)return;for(const[t,rows]of [['captures',state.captures],['quarantine',state.recovery],...REVIEW_TABLES.map(t=>[t,state[t]])])if(!same(await request(tx.objectStore(t).getAll()),rows))return;for(const row of bad)await request(tx.objectStore('quarantine').put(row));});notify();
  }
  async function prepare({eventId,eventHash},{expectedEpoch}={}) {
    if(!validId(eventId)||!validHash(eventHash))throw Error('Choose an exact saved helper answer before preparing it.');
    const state=await snapshot();if(expectedEpoch!==undefined&&expectedEpoch!==(state.epoch??null))throw Error('The workspace changed. Reopen this answer before preparing it.');await validateReviewState(state);
    const event=state.helperEvents.find(e=>e.id===eventId&&e.hash===eventHash),review=event&&state.threadReviews.find(r=>r.id===event.reviewId),source=review&&state.captures.find(c=>c.id===review.sourceId);
    if(!event||event.status!=='done'||!review||!source||helperState(state,review.id,event.role).status!=='done'||reviewContextStatus(review,state)!=='verified')throw Error('The exact answer, approved review and selected sources need recovery before preparation.');
    for(const ctx of review.context)await validateCapture(state.captures.find(c=>c.id===ctx.captureId));
    const id=await helperProposalId(event.id,event.hash),payload={id,text:event.output,hash:await sha256(event.output),createdAt:new Date().toISOString(),span:source.span,sample:false,parentId:source.id,helperEventId:event.id,helperEventHash:event.hash},record={...payload,derivedHash:await sha256(JSON.stringify(payload))};
    const matches=row=>row.id===id&&row.text===record.text&&row.hash===record.hash&&row.span===record.span&&row.sample===false&&row.parentId===source.id&&row.helperEventId===event.id&&row.helperEventHash===event.hash;
    const previous=state.captures.find(c=>c.id===id);if(previous){await validateCapture(previous);if(!matches(previous)||validateHelperProposal(previous,state)!=='verified')throw Error('The earlier helper proposal needs source recovery.');}
    const actual=await db.run(['meta','captures','quarantine','spans',...REVIEW_TABLES],'readwrite',async tx=>{
      if(await meta(tx,'epoch')!==state.epoch)throw Error('The workspace changed. Your saved answer is kept.');
      for(const[t,rows]of [['quarantine',state.recovery],...REVIEW_TABLES.map(t=>[t,state[t]])])if(!same(await request(tx.objectStore(t).getAll()),rows))throw Error('Helper source evidence changed. Refresh before preparation.');
      for(const ctx of review.context)if(!same(await request(tx.objectStore('captures').get(ctx.captureId)),state.captures.find(c=>c.id===ctx.captureId)))throw Error('Selected source evidence changed. Refresh before preparation.');
      const table=tx.objectStore('captures'),prior=await request(table.get(id));if(prior){if(!matches(prior))throw Error('This helper proposal ID conflicts with different writing.');return prior;}
      if(!same(await request(table.getAll()),state.captures))throw Error('The workspace changed during preparation. Your saved answer is kept. Retry.');
      if(!validSpan(await request(tx.objectStore('spans').get(spanKey(source.span)))))throw Error('The source Attention Span needs recovery.');
      ensureCapacity(state.captures,[record]);await request(table.add(record));await request(tx.objectStore('meta').put({key:'initialized',value:true}));return record;
    });
    try{const verified=await db.run(['meta','captures',...REVIEW_TABLES],'readonly',async tx=>{if(await meta(tx,'epoch')!==state.epoch)throw Error('The workspace changed.');return{capture:await request(tx.objectStore('captures').get(id)),event:await request(tx.objectStore('helperEvents').get(event.id)),review:await request(tx.objectStore('threadReviews').get(review.id)),sources:await Promise.all(review.context.map(ctx=>request(tx.objectStore('captures').get(ctx.captureId))))};});await validateCapture(verified.capture);
      if(!same(verified.capture,actual)||!matches(verified.capture)||!same(verified.event,event)||!same(verified.review,review)||verified.sources.some((c,i)=>!same(c,state.captures.find(row=>row.id===review.context[i].captureId))))throw Error('Saved proposal or source differs from readback.');notify();return verified.capture;
    }catch(error){notify();throw Error(`The helper proposal could not be verified: ${error.message} Keep the saved answer and retry the same preparation.`);}
  }
  return{prepare,repair};
}
