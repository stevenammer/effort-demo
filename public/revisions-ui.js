import { sourceRevisionState } from './revisions.js';

export function createRevisionsUI({ getState, getStore, getEpoch, getGeneration, saveDraft, loadContext, clearDraft, refreshed, element, organized, downloadText, notice, onSaved, prepareProposal, isPreparing }) {
  const $ = id => document.getElementById(id);
  let editing = null, loading = false, saving = false, accepted = null;
  const title = kind => kind === 'edit' ? 'Authored correction' : 'Supplied transcript (not verified audio)';
  const context = () => `${editing.kind === 'edit' ? 'correction' : 'transcript'}:${editing.captureId}`;
  const body = () => ({ captureId: editing.captureId, captureHash: editing.captureHash, kind: editing.kind, text: editing.text, expectedLatestId: editing.base, expectedEffectiveId: editing.effectiveId, acknowledgedRecovery: editing.acknowledgedRecovery, requestId: editing.requestId });
  const controls = disabled => { for (const id of ['revision-text', 'revision-save', 'revision-base', 'revision-ack']) $(id).disabled = disabled || !!accepted && id !== 'revision-text'; };
  function buttons() { for (const button of document.querySelectorAll('[data-revision-action]')) button.disabled = loading || saving || !!getState().revisionWarning || !getState().captures.some(c => c.id === button.dataset.revisionAction); }
  function baseDisplay() {
    if (!editing) return;
    const view = sourceRevisionState(getState(), editing.captureId), recovery = view[`${editing.kind}Recovery`];
    $('revision-current').textContent = view.uncertain ? 'The current projection is uncertain. Exact originals and raw recovery remain separate.' : view.text ?? 'The original needs recovery.';
    $('revision-recovery-note').textContent = recovery.length ? `${recovery.length} raw recovery record(s) affect this history. A replacement is a new statement; it does not verify the damaged writing.` : 'No unresolved raw recovery in this history.';
    $('revision-ack-label').hidden = !recovery.length;
    const raw=$('revision-raw-recovery');raw.replaceChildren();for(const entry of recovery.slice(0,20)){const item=element('details');item.append(element('summary',`${entry.recordId}: ${entry.reason}`),element('pre',entry.raw.slice(0,8000),'raw'));raw.append(item);}if(recovery.length){const download=element('button','Download all raw recovery for this history','text-button');download.type='button';download.onclick=()=>downloadText(JSON.stringify(recovery,null,2),`effort-revision-recovery-${editing.captureId}.json`);raw.append(element('p','Up to20 raw records shown, with8000 characters per preview. Download preserves every complete raw record.','small'),download);}
  }
  async function persist() { if (editing && !loading && !saving && !accepted) await saveDraft(context(), body(), 'revision-error', true); }
  $('revision-text').oninput = () => { if (!editing || accepted) return; editing.text = $('revision-text').value; persist(); };
  $('revision-ack').onchange = () => { if (!editing || accepted) return; editing.acknowledgedRecovery = $('revision-ack').checked ? sourceRevisionState(getState(), editing.captureId)[`${editing.kind}Recovery`].map(r => r.id).sort() : []; persist(); };
  async function open(captureId, kind) {
    if (loading || saving || getState().revisionWarning) return;
    const generation=getGeneration();loading=true;buttons();try{await refreshed();}catch(error){notice(`Could not refresh source history: ${error.message}`,true);return;}finally{loading=false;buttons();}if(generation!==getGeneration())return;
    const source = getState().captures.find(c => c.id === captureId); if (!source) return;
    const view = sourceRevisionState(getState(), captureId), current = { captureId, captureHash: source.hash, kind, text: kind === 'edit' ? view.text ?? source.text : '', base: view[`${kind}History`].at(-1)?.id ?? null, effectiveId: view.effective?.id ?? null, acknowledgedRecovery: [], requestId: crypto.randomUUID(), epoch: getEpoch(), generation: getGeneration() };
    editing = current; accepted = null; loading = true; buttons(); controls(true); $('revision-text').readOnly = false;
    $('revision-heading').textContent = kind === 'edit' ? 'Keep a correction, preserve the original.' : 'Keep a supplied transcript separately.';
    $('revision-kind').textContent = `${title(kind)}. No provider runs, no audio is verified and NOW stays chosen.`;
    $('revision-error').textContent = ''; $('revision-text').value = current.text; $('revision-ack').checked = false; $('revision-cleanup').hidden = true;
    if ($('source-dialog').open) $('source-dialog').close();
    $('revision-dialog').showModal();
    try { const draft = await loadContext(context()); if (editing !== current || current.generation !== getGeneration()) return; if (draft?.body.text) { const b = draft.body; Object.assign(current, {text:b.text,base:b.expectedLatestId,effectiveId:b.expectedEffectiveId,acknowledgedRecovery:b.acknowledgedRecovery,requestId:b.requestId,captureHash:b.captureHash}); $('revision-text').value = current.text; $('revision-ack').checked = !!current.acknowledgedRecovery.length; $('revision-error').textContent = 'Draft restored with its original editing base. Review the current source before rebasing.'; } }
    catch (error) { if (editing === current) $('revision-error').textContent = `${error.message} Copy your writing before leaving.`; }
    finally { if (editing === current) { loading = false; controls(false); baseDisplay(); buttons(); if ($('revision-dialog').open) $('revision-text').focus(); } }
  }
  $('revision-base').onclick = async () => {
    if (!editing || loading || saving || accepted) return;
    const current = editing; loading = true; controls(true); buttons();
    try { await refreshed(); if (editing !== current || current.generation !== getGeneration()) return; const view = sourceRevisionState(getState(), current.captureId); if (!view.source) throw Error('The original needs recovery. Your wording is kept.'); current.captureHash = view.source.hash; current.base = view[`${current.kind}History`].at(-1)?.id ?? null; current.effectiveId = view.effective?.id ?? null; current.acknowledgedRecovery = []; current.requestId = crypto.randomUUID(); current.epoch = getEpoch(); $('revision-ack').checked = false; baseDisplay(); $('revision-error').textContent = 'Your wording is kept. The current source is the new base; review any recovery separately.'; }
    catch (error) { $('revision-error').textContent = error.message; }
    finally { loading = false; controls(false); buttons(); await persist(); }
  };
  async function cleanup() {
    const current = editing, saved = accepted; if (!current || !saved) return;
    await clearDraft(context(), saved.body);
    if (editing !== current || current.generation !== getGeneration()) return;
    const stillOpen = $('revision-dialog').open;
    accepted = null; editing = null; $('revision-text').value = ''; $('revision-text').readOnly = false; $('revision-cleanup').hidden = true;
    if (stillOpen) { $('revision-dialog').close(); onSaved?.(current.captureId); }
  }
  $('revision-cleanup').onclick = async () => { if (saving || loading || !accepted) return; saving = true; controls(true); try { await cleanup(); } catch (error) { $('revision-error').textContent = `Revision saved; cleanup is still incomplete: ${error.message}`; } finally { saving = false; controls(false); buttons(); } };
  $('revision-form').onsubmit = async event => {
    event.preventDefault(); if (!editing || loading || saving || accepted) return;
    const current = editing, submitted = body(), ctx = context(); saving = true; controls(true); buttons();
    try {
      await saveDraft(ctx, submitted, 'revision-error', true);
      const {expectedEffectiveId,requestId,...input} = submitted;
      await getStore().reviseSource(input, {requestId,expectedEpoch:current.epoch,expectedEffectiveId});
      if (editing !== current || current.generation !== getGeneration()) return;
      accepted = {body:submitted}; $('revision-text').readOnly = true;
      await refreshed(); notice(`${title(current.kind)} saved and read back exactly. Original writing and NOW are unchanged.`);
      try { await cleanup(); } catch (error) { $('revision-cleanup').hidden = false; $('revision-error').textContent = `Revision saved; draft cleanup failed: ${error.message} Retry cleanup before writing another revision.`; }
    } catch (error) { if (editing === current) $('revision-error').textContent = `${error.message} Your wording is kept.`; }
    finally { saving = false; controls(false); buttons(); }
  };
  function action(captureId, kind) { const button = element('button', kind === 'edit' ? 'Correct wording…' : 'Add supplied transcript…', 'text-button'); button.type = 'button'; button.dataset.revisionAction = captureId; button.disabled = loading || saving || !!getState().revisionWarning || !getState().captures.some(c=>c.id===captureId); button.onclick = () => open(captureId,kind); return button; }
  function proposalButton(row) { const button=element('button','Prepare this exact revision…','text-button');button.type='button';button.dataset.prepareRevision=row.id;button.dataset.revisionHash=row.hash;button.dataset.revisionSource=row.captureId;button.onclick=()=>prepareProposal({revisionId:row.id,revisionHash:row.hash});button.disabled=!!getState().revisionWarning||!getState().captures.some(c=>c.id===row.captureId)||isPreparing(row.id,row.hash);return button; }
  function panel(captureId) {
    const state = getState(), view = sourceRevisionState(state,captureId), box = element('section',undefined,'source-revision-panel'); box.dataset.sourceRevisions = captureId; box.dataset.revisionSignature = signature(state,captureId); box.append(element('h3','Corrections and supplied transcripts'));
    if (state.revisionWarning) { box.append(element('p',state.revisionWarning,'small')); return box; }
    if (!view.source) box.append(element('p','Revision records are preserved; the original source needs recovery.','small'));
    if (view.uncertain) box.append(element('p','The current projection needs recovery. An older prefix is not presented as current.','small'));
    for (const kind of ['edit','transcript']) {
      const rows = view[`${kind}History`], history = element('details'); history.append(element('summary',`${title(kind)} history (${rows.length})`));
      const all=rows.slice().reverse(),more=element('button','Show earlier revisions','text-button');more.type='button';let shown=0;const append=()=>{for(const row of all.slice(shown,shown+10)){const item=element('article',undefined,'revision-history-row');item.dataset.revisionId=row.id;item.append(element('p',`${title(kind)} · ${new Date(row.at).toLocaleString()} · ${row.id}`,'small'),element('pre',row.text,'raw'),proposalButton(row));history.insertBefore(item,more);}shown+=10;more.hidden=shown>=all.length;};more.onclick=append;history.append(more);append();
      const download=element('button',`Download ${kind === 'edit' ? 'correction' : 'transcript'} history`,'text-button');download.type='button';download.onclick=()=>downloadText(JSON.stringify(rows,null,2),`effort-${kind}-${captureId}.json`);history.append(download);box.append(history);
    }
    const raw=element('details');raw.append(element('summary','Raw revision recovery evidence'));
    const entries=[...new Map([...view.editRecovery,...view.transcriptRecovery].map(r=>[r.id,r])).values()];for(const entry of entries)raw.append(element('p',entry.reason,'small'),element('pre',entry.raw,'raw'));box.append(raw);
    const actions=element('div',undefined,'post-actions');actions.append(action(captureId,'edit'),action(captureId,'transcript'));box.append(actions);
    return box;
  }
  function projection(capture, state = getState()) {
    const view = sourceRevisionState(state,capture.id), host=element('div',undefined,'revision-projection');host.dataset.revisionId=view.effective?.id??'';
    if (view.uncertain) {host.append(element('p','EF projection needs recovery. The exact original remains below.','small'));return host;}
    host.append(element('p',view.effective ? `EF organized from ${title(view.effective.kind).toLowerCase()}. Original wording is preserved separately.` : 'EF organized from original.','small'),organized({...capture,text:view.text??capture.text},false));if(view.effective)host.append(proposalButton(view.effective));return host;
  }
  const signature = (state,id) => JSON.stringify([(state.sourceRevisions??[]).filter(r=>r.captureId===id).map(r=>[r.id,r.hash]),(state.recovery??[]).filter(r=>r.source==='sourceRevisions').map(r=>r.id),state.revisionWarning]);
  function update() { buttons();for(const button of document.querySelectorAll('[data-prepare-revision]')){button.disabled=!!getState().revisionWarning||!getState().captures.some(c=>c.id===button.dataset.revisionSource)||isPreparing(button.dataset.prepareRevision,button.dataset.revisionHash);button.textContent=isPreparing(button.dataset.prepareRevision,button.dataset.revisionHash)?'Preparing exact revision…':'Prepare this exact revision…';} for (const box of document.querySelectorAll('[data-source-revisions]')) { const id=box.dataset.sourceRevisions; if (signature(getState(),id)!==box.dataset.revisionSignature && !box.querySelector('.revision-change-notice')) {const note=element('p','This source history changed or needs recovery. Refresh it to see current evidence.','small revision-change-notice'),refresh=element('button','Refresh this history','text-button');refresh.type='button';refresh.onclick=async()=>{refresh.disabled=true;try{await refreshed();if(box.isConnected)box.replaceWith(panel(id));}catch(error){notice(error.message,true);}finally{refresh.disabled=false;}};note.append(refresh);box.prepend(note);} } }
  function disclosure(id) { const node=element('details',undefined,'revision-disclosure');node.append(element('summary','Corrections and supplied transcripts'));node.addEventListener('toggle',()=>{if(node.open&&!node.querySelector('.source-revision-panel'))node.append(panel(id));});return node; }
  function directory() {
    const host=$('revision-directory-items');host.replaceChildren();const refresh=element('button','Refresh source directory','text-button');refresh.type='button';refresh.onclick=async()=>{refresh.disabled=true;try{await refreshed();if(host.isConnected)directory();}catch(error){notice(error.message,true);}finally{refresh.disabled=false;}};host.append(refresh,element('p','Reading snapshot. Refresh to include changed or newly added histories.','small'));
    if(getState().revisionWarning){host.append(element('p',getState().revisionWarning));return;}
    const ids=[...new Set((getState().sourceRevisions??[]).map(row=>row.captureId))];
    let offset=0;const more=element('button','Show more source histories','quiet');more.type='button';const append=()=>{for(const id of ids.slice(offset,offset+50)){const item=element('details');item.append(element('summary',`Source ${id}`));item.addEventListener('toggle',()=>{if(item.open&&!item.querySelector('.source-revision-panel'))item.append(panel(id));});host.insertBefore(item,more);}offset+=50;more.hidden=offset>=ids.length;};more.onclick=append;host.append(more);append();
    if(!ids.length)host.append(element('p','No separate corrections or supplied transcripts yet.','small'));
  }
  return {open,panel,projection,action,directory,disclosure,update,busy:()=>loading||saving,pendingDrafts:()=>editing?[{context:context(),body:body()}]:[],reset(){editing=null;accepted=null;loading=false;if($('revision-dialog').open)$('revision-dialog').close();$('revision-text').value='';$('revision-text').readOnly=false;$('revision-directory-items').replaceChildren();$('revision-raw-recovery').replaceChildren();$('revision-current').textContent='';$('revision-recovery-note').textContent='';$('revision-cleanup').hidden=true;controls(false);},};
}
