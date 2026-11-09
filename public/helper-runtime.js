import { exactKeys, same } from './primitives.js';
import { companionURL, validReviewRoute, helperState, reviewContextStatus } from './thread-review.js';

export async function readBoundedJSON(response,max=64000) {
  if(!response.ok)throw Error(`Companion returned HTTP ${response.status}.`);
  if(!/application\/json/i.test(response.headers.get('content-type')??''))throw Error('Companion did not return JSON.');
  const reader=response.body?.getReader();if(!reader)throw Error('Companion response has no readable body.');let count=0,raw='';const decoder=new TextDecoder('utf-8',{fatal:true});
  try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>max)throw Error('Companion response exceeded the allowed size.');raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();return JSON.parse(raw);}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
function headers(token){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{24,128}$/.test(token))throw Error('Enter the companion session token. It is kept only in this tab.');return {'Content-Type':'application/json','Authorization':`Bearer ${token}`};}
const options=()=>({credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
export async function checkCompanion(url,token,{fetchImpl=globalThis.fetch,signal}={}) {
  const origin=companionURL(url);if(!origin)throw Error('Use the loopback companion URL, including its port.');
  const status=await readBoundedJSON(await fetchImpl(`${origin}/status`,{...options(),headers:headers(token),signal:signal??AbortSignal.timeout(5000)}));
  if(!exactKeys(status,['protocol','route','available','at'])||status.protocol!=='effort-helper-v1'||!validReviewRoute(status.route)||!status.route||status.route.companion!==origin||status.available!==true||!Number.isFinite(Date.parse(status.at)))throw Error('The companion has not verified its configured model.');return status;
}
export async function stopHelper(store,reviewId,role,{expectedEpoch}={}) {
  const state=await store.read();if(state.reviewWarning)throw Error(state.reviewWarning);const current=helperState(state,reviewId,role);if(current.status!=='running')throw Error('This helper is no longer running. Refresh its status.');
  return store.transitionHelper(reviewId,role,'stopped',{expectedEpoch,expectedLatestId:current.latestId,error:'Stopped by your explicit action. Late replies cannot replace this choice.'});
}
export async function runHelper(store,reviewId,role,{token,fetchImpl=globalThis.fetch,signal,timeoutMs=45000}={}) {
  const initial=await store.read(),expectedEpoch=(await store.health()).epoch;if(initial.reviewWarning)throw Error(initial.reviewWarning);
  const review=initial.threadReviews.find(row=>row.id===reviewId);if(!review||!review.route||reviewContextStatus(review,initial)!=='verified')throw Error('The exact approved context and configured route need recovery.');
  headers(token);const current=helperState(initial,reviewId,role);
  const running=await store.transitionHelper(reviewId,role,'running',{expectedEpoch,expectedLatestId:current.latestId});let received=null;
  try{
    // Readback is mandatory before any egress. A prior accepted running event is never replayed automatically.
    const verified=await store.read();if(verified.reviewWarning||!same(verified.threadReviews.find(row=>row.id===reviewId),review)||helperState(verified,reviewId,role).latestId!==running.id||(await store.health()).epoch!==expectedEpoch||reviewContextStatus(review,verified)!=='verified')throw Error('Approved context changed before dispatch. No call was started.');
    const linked=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
    const result=await readBoundedJSON(await fetchImpl(`${review.route.companion}/reply`,{...options(),method:'POST',headers:headers(token),signal:linked,body:JSON.stringify({protocol:'effort-helper-v1',review,role,attemptId:running.id})}));
    if(!exactKeys(result,['protocol','attemptId','route','text'])||result.protocol!=='effort-helper-v1'||result.attemptId!==running.id||!same(result.route,review.route)||typeof result.text!=='string'||!result.text.trim()||result.text.length>4000)throw Error('The companion reply does not match this approved attempt, route or text limit.');
    received=result;return await store.transitionHelper(reviewId,role,'done',{expectedEpoch,expectedLatestId:running.id,output:result.text,model:result.route.model});
  }catch(error){
    const state=await store.read(),outcome=helperState(state,reviewId,role);if((await store.health()).epoch!==expectedEpoch||state.reviewWarning)throw Error('The workspace changed or helper history is unavailable. Reopen the saved attempt.');
    if(received&&outcome.status==='done'&&outcome.latest?.previousId===running.id&&outcome.latest.output===received.text&&outcome.latest.model===received.route.model)return outcome.latest;
    if(outcome.latestId!==running.id)throw Error('This attempt ended. Its late response was not applied.');
    const status=signal?.aborted?'stopped':'failed',message=signal?.aborted?'Stopped by your explicit action.':error.name==='TimeoutError'?'The helper timed out. Your source and approved request are saved.':String(error.message??'The helper failed.').slice(0,1000);
    return store.transitionHelper(reviewId,role,status,{expectedEpoch,expectedLatestId:running.id,error:message});
  }
}
