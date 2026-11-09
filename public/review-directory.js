import { renderHelperMetadata, helperPendingKey } from './helper-reading.js';
import { HELPER_ROLES, helperState, reviewContextStatus } from './thread-review.js';
import { renderReading } from './reading.js';

export function createReviewDirectory({engine,getState,refreshed,prepareProposal,isPreparing,openThread,element,displayTitle,downloadText,notice}) {
  const panel=element('details',undefined,'panel review-directory');panel.id='review-directory';
  const summary=element('summary','Kept THREAD requests and helper answers'),label=element('label','Find a request, source ID or answer'),query=element('input');query.type='search';query.id='review-directory-search';query.maxLength=4000;label.htmlFor=query.id;
  const count=element('p',undefined,'small'),rows=element('div'),more=element('button','Show older requests','quiet'),refresh=element('button','Refresh kept requests','text-button');count.setAttribute('role','status');rows.id='review-directory-items';
  panel.append(summary,element('p','Saved requests and answers remain reachable when an original needs recovery. Source links and model claims are separate from verified saved bytes. Opening this directory never starts a helper.','small'),label,query,refresh,count,rows,more);engine.append(panel);
  let limit=50,rendered=null;
  function update(force=false){if(!panel.open)return;const state=getState();if(!state)return;
    const search=query.value.toLocaleLowerCase(),all=[...(state.threadReviews??[])].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
    const matches=all.filter(review=>!search||JSON.stringify([review.id,review.sourceId,review.question,review.context,...(state.helperEvents??[]).filter(e=>e.reviewId===review.id)]).toLocaleLowerCase().includes(search)),shown=matches.slice(0,limit);
    const signature=JSON.stringify([query.value,limit,shown.map(r=>[r.hash,reviewContextStatus(r,state),r.invited.map(role=>{const h=helperState(state,r.id,role);return[h.status,h.latestId,helperPendingKey(h.latest,isPreparing)];})]),state.reviewWarning]);if(!force&&signature===rendered)return;rendered=signature;
    count.textContent=state.reviewWarning??`${shown.length} of ${matches.length} matching kept requests. Exact source IDs stay separate from titles.`;more.hidden=shown.length===matches.length||!!state.reviewWarning;
    const old=new Map([...rows.children].map(node=>[node.dataset.reviewId,node])),nodes=[];
    for(const review of shown){const key=JSON.stringify([review.hash,reviewContextStatus(review,state),review.invited.map(role=>{const h=helperState(state,review.id,role);return[h.status,h.latestId,helperPendingKey(h.latest,isPreparing)];}),state.reviewWarning]),prior=old.get(review.id);if(prior?.dataset.renderKey===key){nodes.push(prior);continue;}
      const box=element('details');box.dataset.reviewId=review.id;box.dataset.renderKey=key;box.open=prior?.open??false;box.append(element('summary',`${review.state} · ${review.requestedResult.replaceAll('_',' ')} · ${displayTitle(review.question,100)}`),element('p',`Review ${review.id} · Source ${review.sourceId} · Source links: ${reviewContextStatus(review,state)}`,'small'),element('pre',review.question,'raw'));
      const source=getState().captures.find(c=>c.id===review.sourceId);if(source){const link=element('button','Open exact source thread','text-button');link.onclick=()=>openThread(review.sourceId);box.append(link);}else box.append(element('p','The original source needs recovery. The saved approval and answers remain below.','small'));
      const exact=element('details');exact.append(element('summary','Read exact approved context and route'),element('pre',JSON.stringify(review,null,2),'raw'));const download=element('button','Download exact approved review','text-button');download.onclick=()=>downloadText(JSON.stringify(review,null,2),`effort-thread-review-${review.id}.json`);exact.append(download);box.append(exact);
      if(!review.invited.length)box.append(element('p','No helpers invited. No model call.','small'));
      for(const role of review.invited){const h=helperState(state,review.id,role),reply=element('article',undefined,'helper-directory-answer');reply.append(element('h4',`${HELPER_ROLES[role].label} · ${h.status.toUpperCase()}`),element('p',`Model route: ${review.route.model}. Tools: none. Attempt ${h.attempt}.`,'small'));
        if(h.latest?.output){reply.append(renderReading(h.latest.output),element('p','Exact saved model output. Its factual claims and confidence are unverified.','small'));const details=element('details');details.append(element('summary','Exact answer and attempt history'),element('pre',JSON.stringify(h.history,null,2),'raw'));const dl=element('button','Download exact helper reply','text-button');dl.onclick=()=>downloadText(h.latest.output,`effort-helper-${h.latest.id}.txt`,'text/plain');details.append(dl);reply.append(details,renderHelperMetadata(h.latest,review,{element,downloadText,prepareProposal,isPreparing,canPrepare:h.status==='done'&&!state.reviewWarning&&reviewContextStatus(review,state)==='verified'}));const prepare=element('button','Prepare this exact answer…','quiet');prepare.disabled=!!state.reviewWarning||h.status!=='done'||reviewContextStatus(review,state)!=='verified'||isPreparing(h.latest.id,h.latest.hash);prepare.onclick=()=>prepareProposal({eventId:h.latest.id,eventHash:h.latest.hash});reply.append(prepare);}
        if(h.latest?.error)reply.append(element('p',h.latest.error,'small'));if(h.status==='recovery')reply.append(element('p','Attempt history needs recovery. Raw damaged copies remain in Engine Room recovery.','small'));box.append(reply);
      }nodes.push(box);
    }
    for(const node of [...rows.children])if(!nodes.includes(node))node.remove();for(let i=0;i<nodes.length;i++)if(rows.children[i]!==nodes[i])rows.insertBefore(nodes[i],rows.children[i]??null);
  }
  query.oninput=()=>{limit=50;update(true);};more.onclick=()=>{limit+=50;update(true);};refresh.onclick=async()=>{refresh.disabled=true;try{await refreshed();update(true);}catch(e){notice(e.message);}finally{refresh.disabled=false;}};
  panel.addEventListener('toggle',async()=>{if(!panel.open)return;try{await refreshed();if(panel.open)update(true);}catch(e){notice(e.message);}});
  return {update,reset(){panel.open=false;query.value='';rows.replaceChildren();count.textContent='';limit=50;rendered=null;}};
}
