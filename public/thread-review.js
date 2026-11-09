import { request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, same, IntegrityError } from './primitives.js';
import { seal, noteAllowed } from './intent.js';

export const REVIEW_TABLES = Object.freeze(['threadReviews', 'helperEvents']);
import { THREAD_RESULTS, HELPER_ROLES, sourceOrigin, validSourceOrigin, validateHelperEnvelope, HELPER_OUTCOME_RESERVE } from './helper-contract.js';
export { THREAD_RESULTS, HELPER_ROLES } from './helper-contract.js';
export const REVIEW_LIMITS = Object.freeze({reviews:1000, events:10000, bytes:8*1024*1024, context:12, text:4000, contextBytes:24000});
export function companionURL(value) {
  try { const u=new URL(value); return value.length<=512 && !u.username && !u.password && !u.search && !u.hash && u.pathname==='/' && (u.protocol==='https:' || u.protocol==='http:' && ['127.0.0.1','localhost'].includes(u.hostname) && u.port) ? u.origin : null; } catch { return null; }
}
export function privateBackendURL(value) {
  try {
    const u=new URL(value);if(u.protocol!=='http:'||!u.port||u.username||u.password||u.search||u.hash||u.pathname!=='/')return null;
    const parts=u.hostname.split('.').map(Number),numeric=parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
    const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname)||numeric&&(parts[0]===10||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31||parts[0]===100&&parts[1]>=64&&parts[1]<=127);
    return local?u.origin:null;
  }catch{return null;}
}
export function validReviewRoute(route) {
  return route===null || exactKeys(route,['companion','backend','model']) && typeof route.companion==='string' && typeof route.backend==='string' && companionURL(route.companion)===route.companion && privateBackendURL(route.backend)===route.backend && typeof route.model==='string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(route.model) && !/(?:^|[-/:])cloud(?:$|[-/:])/i.test(route.model);
}
const meta=(tx,key)=>request(tx.objectStore('meta').get(key)).then(r=>r?.value);
const size=value=>new TextEncoder().encode(JSON.stringify(value)).length;
async function checkSeal(row,keys) {
  if(!exactKeys(row,[...keys,'hash']) || !validHash(row.hash) || await sha256(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k])=>k!=='hash'))))!==row.hash) throw new IntegrityError('A THREAD record has invalid metadata or checksum.');
}
export async function validateReview(row) {
  await checkSeal(row,['id','sourceId','context','question','requestedResult','invited','route','state','at']);
  if(!validId(row.id)||!validId(row.sourceId)||!noteAllowed(row.question,true)||row.question.length>2000||!THREAD_RESULTS.includes(row.requestedResult)||!['CANDIDATE','REVIEW'].includes(row.state)||!validDate(row.at)||!validReviewRoute(row.route)||!Array.isArray(row.invited)||row.invited.length>2||new Set(row.invited).size!==row.invited.length||row.invited.some(id=>!Object.hasOwn(HELPER_ROLES,id))||row.invited.length&&!row.route||!Array.isArray(row.context)||!row.context.length||row.context.length>REVIEW_LIMITS.context||new Set(row.context.map(c=>c?.captureId)).size!==row.context.length||row.context[0]?.captureId!==row.sourceId||size(row.context)>REVIEW_LIMITS.contextBytes) throw new IntegrityError('A THREAD review has invalid content, context or authority.');
  for(const c of row.context) if(!(exactKeys(c,['captureId','captureHash','text'])||exactKeys(c,['captureId','captureHash','text','origin'])&&validSourceOrigin(c.origin))||!validId(c.captureId)||!validHash(c.captureHash)||!noteAllowed(c.text,true)||c.text.length>4000||await sha256(c.text)!==c.captureHash) throw new IntegrityError('A THREAD context snapshot cannot be verified.');
}
function history(events,reviewId,role) {
  const rows=events.filter(e=>e.reviewId===reviewId&&e.role===role);if(!rows.length)return [];
  const starts=rows.filter(e=>e.previousId===null),byId=new Map(rows.map(e=>[e.id,e])),next=new Map();if(starts.length!==1||byId.size!==rows.length)throw new IntegrityError('Helper history has no unique start.');
  for(const e of rows)if(e.previousId!==null){if(!byId.has(e.previousId)||next.has(e.previousId))throw new IntegrityError('Helper history conflicts.');next.set(e.previousId,e);}
  const out=[starts[0]];while(next.has(out.at(-1).id)){out.push(next.get(out.at(-1).id));if(out.length>rows.length)throw new IntegrityError('Helper history contains a cycle.');}if(out.length!==rows.length)throw new IntegrityError('Helper history is disconnected.');
  let last=null;for(const e of out){if(!last){if(e.status!=='running'||e.attempt!==1)throw new IntegrityError('Helper history must begin with an explicit first attempt.');}else if(e.status==='running'){if(!['failed','stopped'].includes(last.status)||e.attempt!==last.attempt+1)throw new IntegrityError('A helper needs an explicit retry after failure or stop.');}else if(last.status!=='running'||e.attempt!==last.attempt)throw new IntegrityError('A helper outcome has no matching running attempt.');last=e;}
  return out;
}
export function helperState(state,reviewId,role) {
  const rows=history(state.helperEvents??[],reviewId,role),ids=new Set(rows.map(e=>e.id));
  const unknown=(state.recovery??[]).some(r=>{if(r.source!=='helperEvents'&&r.source!=='threadReviews')return false;try{const x=JSON.parse(r.raw);return r.source==='threadReviews'?x.id===reviewId&&!(state.threadReviews??[]).some(review=>review.id===reviewId):x.reviewId===reviewId&&x.role===role&&!ids.has(x.id);}catch{return false;}});
  return {status:unknown?'recovery':rows.at(-1)?.status??'queued',latestId:rows.at(-1)?.id??null,attempt:rows.at(-1)?.attempt??0,history:rows,latest:rows.at(-1)??null};
}
export function reviewContextStatus(review,state) {
  return review.context.every(c=>state.captures.some(row=>row.id===c.captureId&&row.hash===c.captureHash&&row.text===c.text&&(!Object.hasOwn(c,'origin')||same(c.origin,sourceOrigin(row)))))?'verified':'recovery';
}
async function validateEvent(row,reviews,recovery=[]) {
  if(!row||typeof row!=='object'||Array.isArray(row))throw new IntegrityError('A helper event has an invalid record shape.');
  const keys=['id','reviewId','reviewHash','role','previousId','attempt','status','output','error','model','at'];const structured=Object.hasOwn(row,'result')||Object.hasOwn(row,'rawResponse')||Object.hasOwn(row,'receipt');
  await checkSeal(row,structured?[...keys,'result','rawResponse','receipt']:keys);
  if(!validId(row.id)||!validId(row.reviewId)||!validHash(row.reviewHash)||!Object.hasOwn(HELPER_ROLES,row.role)||!(row.previousId===null||validId(row.previousId))||!Number.isSafeInteger(row.attempt)||row.attempt<1||row.attempt>20||!['running','done','failed','stopped'].includes(row.status)||!noteAllowed(row.output)||row.output.length>4000||!noteAllowed(row.error)||row.error.length>1000||typeof row.model!=='string'||row.model.length>120||!validDate(row.at))throw new IntegrityError('A helper event has invalid content.');
  if(row.status==='done'? !row.output.trim()||row.error!==''||!row.model : row.output!==''||row.model!==''||(['failed','stopped'].includes(row.status)?!row.error.trim():row.error!==''))throw new IntegrityError('A helper status does not match its result.');
  const review=reviews.find(r=>r.id===row.reviewId);if(structured){if(row.status!=='done'&&(row.result!==null||row.rawResponse!==''||row.receipt!==null))throw new IntegrityError('An unfinished helper cannot claim a result receipt.');await validateHelperEnvelope(row,review??null,row.role);if(row.result!==null&&row.result.text!==row.output)throw new IntegrityError('Helper answer differs from its structured result.');}if(!review){if(!recovery.some(r=>r.source==='threadReviews'&&r.recordId===row.reviewId))throw new IntegrityError('A helper has no approved review.');}else if(row.reviewHash!==review.hash)throw new IntegrityError('A helper result belongs to a different approved review.');else if(row.status==='done'&&row.model!==review.route?.model)throw new IntegrityError('A helper result claims a different model.');else if(!review.invited.includes(row.role))throw new IntegrityError('An uninvited role cannot reply.');
}
export async function validateReviewState(state) {
  for(const [table,max]of [['threadReviews',REVIEW_LIMITS.reviews],['helperEvents',REVIEW_LIMITS.events]])if(!Array.isArray(state[table])||state[table].length>max||new Set(state[table].map(e=>e?.id)).size!==state[table].length)throw new IntegrityError('Invalid or oversized THREAD history.');
  if(size(REVIEW_TABLES.map(t=>state[t]))>REVIEW_LIMITS.bytes)throw new IntegrityError('THREAD history exceeds its portable limit.');
  for(const row of state.threadReviews)await validateReview(row);
  for(const row of state.helperEvents)await validateEvent(row,state.threadReviews,state.recovery);
  for(const reviewId of new Set(state.helperEvents.map(e=>e.reviewId)))for(const role of Object.keys(HELPER_ROLES))history(state.helperEvents,reviewId,role);
}
function ensureAnswerRoom(state) {const running=state.helperEvents.filter(e=>e.status==='running'&&helperState(state,e.reviewId,e.role).latestId===e.id).length;if(size(REVIEW_TABLES.map(t=>state[t]))+running*HELPER_OUTCOME_RESERVE>REVIEW_LIMITS.bytes)throw Error('THREAD history needs room for a verified answer before inference. Download a backup; no call was started.');}
export function createThreadReview({db,ready=async()=>{},notify=()=>{},recoveryRecord,validateCapture}) {
  async function snapshot(){await ready();return db.run(['meta','captures','quarantine',...REVIEW_TABLES],'readonly',async tx=>({epoch:await meta(tx,'epoch'),captures:await request(tx.objectStore('captures').getAll()),recovery:await request(tx.objectStore('quarantine').getAll()),threadReviews:await request(tx.objectStore('threadReviews').getAll()),helperEvents:await request(tx.objectStore('helperEvents').getAll())}));}
  async function fence(tx,state,checkCaptures=true){if(await meta(tx,'epoch')!==state.epoch)throw Error('The workspace changed. Reopen THREAD before continuing.');for(const [t,rows]of [...(checkCaptures?[['captures',state.captures]]:[]),['quarantine',state.recovery],...REVIEW_TABLES.map(t=>[t,state[t]])])if(!same(await request(tx.objectStore(t).getAll()),rows))throw Error('THREAD changed in another tab. Refresh before continuing.');}
  async function verified(table,record,state){try{const actual=await db.run(['meta',table],'readonly',async tx=>{if(await meta(tx,'epoch')!==state.epoch)throw Error('The workspace changed.');return request(tx.objectStore(table).get(record.id));});if(!same(actual,record))throw Error('Saved bytes differ.');if(table==='threadReviews')await validateReview(actual);else await validateEvent(actual,state.threadReviews,state.recovery);notify();return actual;}catch(error){notify();throw Error(`THREAD readback could not be verified: ${error.message} Keep the saved request; refresh before retrying. No helper call is authorized by this result.`);}}
  async function create(input,{requestId=crypto.randomUUID(),expectedEpoch}={}) {
    const state=await snapshot();if(expectedEpoch!==undefined&&expectedEpoch!==(state.epoch??null))throw Error('The workspace changed. Reopen THREAD.');await validateReviewState(state);
    if(!validId(requestId)||!Array.isArray(input.contextIds)||new Set(input.contextIds).size!==input.contextIds.length)throw Error('Choose exact saved context for THREAD.');
    const context=[];for(const id of input.contextIds){const c=state.captures.find(row=>row.id===id);if(!c)throw Error('Selected context needs source recovery.');await validateCapture(c);context.push({captureId:c.id,captureHash:c.hash,text:c.text,origin:sourceOrigin(c)});}
    const record=await seal({id:requestId,sourceId:input.sourceId,context,question:input.question,requestedResult:input.requestedResult,invited:input.invited,route:input.route,state:input.state??'REVIEW',at:new Date().toISOString()});await validateReview(record);
    const prior=state.threadReviews.find(row=>row.id===record.id);if(prior){const strip=({at,hash,...rest})=>rest;const compared={...record,context:record.context.map((c,i)=>{if(!Object.hasOwn(prior.context[i]??{},'origin')){const{origin,...legacy}=c;return legacy;}return c;})};if(!same(strip(prior),strip(compared)))throw Error('This request ID already belongs to different approved context.');return verified('threadReviews',prior,state);}
    const proposed={...state,threadReviews:[...state.threadReviews,record]};await validateReviewState(proposed);ensureAnswerRoom(proposed);await db.run(['meta','captures','quarantine',...REVIEW_TABLES],'readwrite',async tx=>{await fence(tx,state);await request(tx.objectStore('threadReviews').add(record));await request(tx.objectStore('meta').put({key:'initialized',value:true}));});return verified('threadReviews',record,state);
  }
  async function transition(reviewId,role,status,{expectedLatestId=null,output='',error='',model='',result=null,rawResponse='',receipt=null,expectedEpoch}={}) {
    const state=await snapshot();if(expectedEpoch!==undefined&&expectedEpoch!==(state.epoch??null))throw Error('The workspace changed. Reopen THREAD.');await validateReviewState(state);
    const review=state.threadReviews.find(row=>row.id===reviewId);if(!review||!review.invited.includes(role))throw Error('This role has no approved THREAD invitation.');const current=helperState(state,reviewId,role);
    if(current.status==='recovery')throw Error('Helper history needs recovery. No call was started.');if(current.latestId!==expectedLatestId)throw Error('The helper attempt changed. Refresh before continuing.');
    if(status==='running'){
      if(!['queued','failed','stopped'].includes(current.status)||current.attempt>=20)throw Error('This helper cannot be started again. Keep its prior answer or review new evidence.');
      if(reviewContextStatus(review,state)!=='verified')throw Error('Approved context needs recovery before it can leave this browser.');for(const c of review.context)await validateCapture(state.captures.find(row=>row.id===c.captureId));
      if(state.helperEvents.some(e=>e.status==='running'&&helperState(state,e.reviewId,e.role).latestId===e.id))throw Error('Another helper is running. Stop or finish that attempt first.');
    }else if(current.status!=='running')throw Error('Only a running attempt can receive an outcome.');
    const record=await seal({id:crypto.randomUUID(),reviewId,reviewHash:review.hash,role,previousId:current.latestId,attempt:current.attempt+(status==='running'?1:0),status,output,error,model,result,rawResponse,receipt,at:new Date().toISOString()});const proposed={...state,helperEvents:[...state.helperEvents,record]};await validateReviewState(proposed);if(status==='running')ensureAnswerRoom(proposed);
    await db.run(['meta','captures','quarantine',...REVIEW_TABLES],'readwrite',async tx=>{await fence(tx,state,status==='running');await request(tx.objectStore('helperEvents').add(record));});return verified('helperEvents',record,state);
  }
  async function repair(){const state=await snapshot(),bad=[];for(const row of state.threadReviews){try{await validateReview(row);}catch(error){if(!(error instanceof IntegrityError))throw error;bad.push({table:'threadReviews',row,reason:error.message});}}
    const valid=state.threadReviews.filter(row=>!bad.some(b=>b.row===row)),recovery=[...state.recovery];for(const item of bad)recovery.push(await recoveryRecord(item.table,String(item.row?.id??'unknown').slice(0,128),JSON.stringify(item.row),item.reason));
    const grouped=new Map();for(const row of state.helperEvents){const key=JSON.stringify([row?.reviewId,row?.role]);const rows=grouped.get(key)??[];rows.push(row);grouped.set(key,rows);}for(const rows of grouped.values()){try{for(const row of rows)await validateEvent(row,valid,recovery);history(rows,rows[0].reviewId,rows[0].role);}catch(error){if(!(error instanceof IntegrityError))throw error;for(const row of rows)bad.push({table:'helperEvents',row,reason:error.message});}}
    if(!bad.length)return;for(const item of bad)item.recovery=await recoveryRecord(item.table,String(item.row?.id??'unknown').slice(0,128),JSON.stringify(item.row),item.reason);await db.run(['meta','captures','quarantine',...REVIEW_TABLES],'readwrite',async tx=>{await fence(tx,state);for(const item of bad){await request(tx.objectStore('quarantine').put(item.recovery));await request(tx.objectStore(item.table).delete(item.row.id));}});notify();
  }
  return {create,transition,repair,snapshot};
}
