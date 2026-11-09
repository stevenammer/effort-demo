import { request } from './database.js';
import { validId, validHash, stableId, sha256, same, IntegrityError } from './primitives.js';
import { validateCapture } from './records.js';
import { validateRevisionState, REVISION_TABLE } from './revisions.js';
import { spanKey, validSpan } from './spans.js';

export const revisionProposalId = (id, hash) => stableId(JSON.stringify(['revision-proposal', id, hash]));
export function validateRevisionProposal(capture, state) {
  if (capture.sourceRevisionId === undefined) return null;
  if (state.revisionWarning) return 'recovery';
  const recorded = () => state.recovery.some(row => row.source === 'derivation' && row.recordId === capture.id && row.raw === JSON.stringify(capture));
  const fail = message => { if (recorded()) return 'recovery'; throw new IntegrityError(message); };
  if (!validId(capture.sourceRevisionId) || !validHash(capture.sourceRevisionHash) || !validId(capture.parentId) || capture.sample !== false) return fail('A revision proposal has invalid source references.');
  const revision = (state.sourceRevisions ?? []).find(row => row.id === capture.sourceRevisionId);
  if (!revision) {
    if (state.recovery.some(row => row.source === REVISION_TABLE && row.recordId === capture.sourceRevisionId)) return 'recovery';
    return fail('A revision proposal is missing its exact revision source.');
  }
  if (revision.hash !== capture.sourceRevisionHash || revision.captureId !== capture.parentId || revision.text !== capture.text) return fail('A revision proposal does not match its sealed source revision.');
  const original = state.captures.find(row => row.id === capture.parentId);
  if (!original) {
    if (state.recovery.some(row => row.source === 'capture' && row.recordId === capture.parentId)) return 'recovery';
    return fail('A revision proposal is missing its original source.');
  }
  if (original.hash !== revision.captureHash || spanKey(original.span) !== spanKey(capture.span)) return fail('A revision proposal no longer matches its original source context.');
  return 'verified';
}
export function createRevisionProposals({ db, ready = async () => {}, notify = () => {}, recoveryRecord, ensureCapacity }) {
  const meta = (tx,key) => request(tx.objectStore('meta').get(key)).then(row=>row?.value);
  async function snapshot() {
    await ready(); return db.run(['meta','captures','quarantine',REVISION_TABLE], 'readonly', async tx => ({epoch:await meta(tx,'epoch'),captures:await request(tx.objectStore('captures').getAll()),recovery:await request(tx.objectStore('quarantine').getAll()),sourceRevisions:await request(tx.objectStore(REVISION_TABLE).getAll())}));
  }
  async function repair() {
    const state=await snapshot();if(!state.captures.some(row=>row.sourceRevisionId))return;await validateRevisionState(state);const bad=[];
    for(const capture of state.captures.filter(row=>row.sourceRevisionId)) {
      await validateCapture(capture);
      try{validateRevisionProposal(capture,state);}catch(error){if(!(error instanceof IntegrityError))throw error;bad.push(await recoveryRecord('derivation',capture.id,JSON.stringify(capture),error.message));}
    }
    if(!bad.length)return;
    await db.run(['meta','captures','quarantine',REVISION_TABLE],'readwrite',async tx=>{
      if(await meta(tx,'epoch')!==state.epoch)return;
      for(const[table,expected]of[['captures',state.captures],['quarantine',state.recovery],[REVISION_TABLE,state.sourceRevisions]])if(!same(await request(tx.objectStore(table).getAll()),expected))return;
      for(const row of bad)await request(tx.objectStore('quarantine').put(row));
    });notify();
  }
  async function prepare({ revisionId, revisionHash }, { expectedEpoch } = {}) {
    if(!validId(revisionId)||!validHash(revisionHash))throw Error('Choose an exact saved revision before preparing a proposal.');
    const state=await snapshot();if(expectedEpoch!==undefined&&expectedEpoch!==(state.epoch??null))throw Error('The workspace changed. Reopen the revision before preparing it.');
    await validateRevisionState(state);
    const revision=state.sourceRevisions.find(row=>row.id===revisionId&&row.hash===revisionHash),source=revision&&state.captures.find(row=>row.id===revision.captureId);
    if(!revision||!source||source.hash!==revision.captureHash)throw Error('The exact revision and original need recovery before preparing a new proposal.');
    await validateCapture(source);
    const id=await revisionProposalId(revision.id,revision.hash);
    const payload={id,text:revision.text,hash:await sha256(revision.text),createdAt:new Date().toISOString(),span:source.span,sample:false,parentId:source.id,sourceRevisionId:revision.id,sourceRevisionHash:revision.hash};
    const record={...payload,derivedHash:await sha256(JSON.stringify(payload))};
    const matches=row=>row.id===id&&row.text===record.text&&row.hash===record.hash&&row.span===record.span&&row.sample===false&&row.parentId===source.id&&row.sourceRevisionId===revision.id&&row.sourceRevisionHash===revision.hash;
    const previous=state.captures.find(row=>row.id===id);if(previous){await validateCapture(previous);if(!matches(previous)||validateRevisionProposal(previous,state)!=='verified')throw Error('The earlier revision proposal needs source recovery.');}
    const actual=await db.run(['meta','captures','quarantine','spans',REVISION_TABLE],'readwrite',async tx=>{
      if(await meta(tx,'epoch')!==state.epoch)throw Error('The workspace changed. Your revision remains saved.');
      if(!same(await request(tx.objectStore('captures').get(source.id)),source)||!same(await request(tx.objectStore(REVISION_TABLE).get(revision.id)),revision)||!same(await request(tx.objectStore('quarantine').getAll()),state.recovery))throw Error('Revision source evidence changed. Refresh before preparing it.');
      const table=tx.objectStore('captures'),prior=await request(table.get(id));if(prior){if(!matches(prior))throw Error('This proposal ID conflicts with different saved writing.');return prior;}
      for(const[tableName,expected]of[['captures',state.captures],[REVISION_TABLE,state.sourceRevisions]])if(!same(await request(tx.objectStore(tableName).getAll()),expected))throw Error('The workspace changed during preparation. Your revision is kept. Retry.');
      if(!validSpan(await request(tx.objectStore('spans').get(spanKey(source.span)))))throw Error('The source Attention Span needs recovery.');
      if(!ensureCapacity)throw Error('Proposal capacity could not be verified.');ensureCapacity(state.captures,[record]);await request(table.add(record));await request(tx.objectStore('meta').put({key:'initialized',value:true}));return record;
    });
    try{
      const verified=await db.run(['captures',REVISION_TABLE],'readonly',async tx=>({capture:await request(tx.objectStore('captures').get(id)),revision:await request(tx.objectStore(REVISION_TABLE).get(revision.id)),source:await request(tx.objectStore('captures').get(source.id))}));
      await validateCapture(verified.capture);if(!same(verified.capture,actual)||!matches(verified.capture)||!same(verified.revision,revision)||!same(verified.source,source))throw Error('Saved proposal or its source differs from readback.');notify();return verified.capture;
    }catch(error){notify();throw Error(`The revision proposal could not be verified: ${error.message} Keep the revision and retry the same preparation.`);}
  }
  return {prepare,repair};
}
