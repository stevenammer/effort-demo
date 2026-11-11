import { validIsoInstant } from '../core/export.js';
import { spanOf } from '../core/spans.js';
import { exactKeys, safePart, makeDigest, sealRecord, openRecord, same, textAllowed } from '../core/sealed.js';
import { createCapture } from '../core/capture.js';
import { THREAD_RESULTS, HELPER_ROLES, encodedBytes, sourceOrigin } from './contract.js';
import { referenceReply, verifyReferenceReply } from './reference.js';

export const THREAD_PROTOCOL = 'effort-thread/1';
export const HELPER_STATE_ID = 'helper:state';
export const THREAD_LIMITS = Object.freeze({ requests: 1000, recipients: 32, invites: 2, attempts: 20, context: 12, contextBytes: 24000, bytes: 8 * 1024 * 1024 });
const STATE_KEYS = ['id','kind','version','revision','recipients','requests','updatedAt'];
const REQUEST_KEYS = ['protocol','id','sourceId','context','question','requestedResult','invited','recipientId','createdAt'];
const APPROVAL_KEYS = ['requestHash','recipient','privacy','approvedAt','expiresAt'];
const EVENT_KEYS = ['id','role','attempt','status','previousId','at','packetHash','envelope','error'];
const bounded = (value, limit, required=true) => typeof value === 'string' && value.length <= limit && (!required || value.trim()) && textAllowed(value.slice(0, 4000), { required });
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const roleAllowed = role => Object.hasOwn(HELPER_ROLES, role);
const recipientShape = row => exactKeys(row, ['id','kind','pairedAt','expiresAt']) && safePart(row.id) && row.kind === 'reference' && validIsoInstant(row.pairedAt) && validIsoInstant(row.expiresAt) && Date.parse(row.expiresAt) > Date.parse(row.pairedAt);
const unique = rows => new Set(rows.map(row => row.id)).size === rows.length;
const latest = (row, role) => row.events.filter(event => event.role === role).at(-1) ?? null;
const empty = () => ({ id: HELPER_STATE_ID, kind: 'helper-state', version: 1, revision: 0, recipients: [], requests: [], updatedAt: null });

/** Only helper:state may be written. No commitment, NOW, capture or ranking API is called. */
export function createHelpers({ store, hash, now, id, trust }) {
  if (!store?.snapshot || !store?.get || !store?.compareAndSwapDerived || typeof now !== 'function' || typeof id !== 'function' ||
      typeof trust?.allowRecipient !== 'function' || typeof trust?.allowApproval !== 'function') throw Error('Helpers need storage, time, IDs, hashing and separate host-local trust.');
  const digest = makeDigest(hash);
  const instant = () => { const value = now(); if (!validIsoInstant(value)) throw Error('Invalid current time.'); return value; };
  const freshId = () => { const value = id(); if (!safePart(value)) throw Error('Invalid generated ID.'); return value; };
  const activeRecipient = (state, recipientId) => {
    const recipient = state.recipients.find(row => row.id === recipientId);
    if (!recipient || Date.parse(recipient.expiresAt) <= Date.parse(instant())) throw Error('This recipient is unknown, expired or unpaired.');
    return recipient;
  };
  function packetFor(row, event) {
    return { protocol: THREAD_PROTOCOL, requestId: row.request.id, requestHash: row.requestHash, approvalHash: row.approval.checksum,
      attemptId: event.id, role: event.role, recipient: { id: row.approval.recipient.id, kind: row.approval.recipient.kind },
      question: row.request.question, requestedResult: row.request.requestedResult,
      context: row.request.context.map(({ captureId, captureHash, text, origin }) => ({ captureId, captureHash, text, origin })) };
  }
  async function validateRequest(row) {
    if (!exactKeys(row, ['request','requestHash','approval','events']) || !exactKeys(row.request, REQUEST_KEYS) || await digest(row.request) !== row.requestHash) throw Error('A saved helper request failed its check.');
    const request = row.request;
    if (request.protocol !== THREAD_PROTOCOL || !safePart(request.id) || !safePart(request.sourceId) || !safePart(request.recipientId) || !validIsoInstant(request.createdAt) ||
        !bounded(request.question, 2000) || !THREAD_RESULTS.includes(request.requestedResult) || !Array.isArray(request.invited) || request.invited.length < 1 || request.invited.length > THREAD_LIMITS.invites ||
        new Set(request.invited).size !== request.invited.length || request.invited.some(role => !roleAllowed(role)) || !Array.isArray(request.context) || !request.context.length || request.context.length > THREAD_LIMITS.context ||
        new Set(request.context.map(source => source?.captureId)).size !== request.context.length || request.context[0]?.captureId !== request.sourceId || encodedBytes(request.context) > THREAD_LIMITS.contextBytes) throw Error('Invalid saved helper selection or invitation.');
    for (const source of request.context) {
      if (!exactKeys(source, ['captureId','captureHash','sourceDigest','start','end','text','privacy','origin']) || !safePart(source.captureId) || !validHash(source.captureHash) || !validHash(source.sourceDigest) ||
          !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || source.start < 0 || source.end <= source.start || source.end - source.start !== source.text?.length ||
          !textAllowed(source.text) || source.privacy !== 'local-only' || !exactKeys(source.origin, ['kind','recordId','recordHash','metadataHash'])) throw Error('Invalid saved helper excerpt.');
    }
    if (row.approval !== null) {
      const approval = await openRecord(row.approval, APPROVAL_KEYS, digest);
      if (approval.requestHash !== row.requestHash || !recipientShape(approval.recipient) || approval.recipient.id !== request.recipientId || approval.privacy !== 'local-only' ||
          !validIsoInstant(approval.approvedAt) || !validIsoInstant(approval.expiresAt) || Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt) ||
          Date.parse(approval.expiresAt) > Date.parse(approval.recipient.expiresAt)) throw Error('Invalid saved helper approval.');
    }
    if (!Array.isArray(row.events) || row.events.length > THREAD_LIMITS.invites * THREAD_LIMITS.attempts * 3 || !unique(row.events)) throw Error('Invalid helper attempt history.');
    const prev = new Map();
    for (const event of row.events) {
      if (!exactKeys(event, EVENT_KEYS) || !safePart(event.id) || !request.invited.includes(event.role) || !validIsoInstant(event.at) || !Number.isSafeInteger(event.attempt) || event.attempt < 1 || event.attempt > THREAD_LIMITS.attempts ||
          !['running','uncertain','done','stopped'].includes(event.status) || !bounded(event.error,1000,false) || !validHash(event.packetHash) || !row.approval) throw Error('Invalid helper attempt.');
      const prior = prev.get(event.role);
      if (event.previousId !== (prior?.id ?? null)) throw Error('Helper attempt history conflicts.');
      if (event.status === 'running') {
        if (prior && !['uncertain','stopped'].includes(prior.status) || event.attempt !== (prior?.attempt ?? 0) + 1 || event.envelope !== null || event.error !== '' || await digest(packetFor(row,event)) !== event.packetHash) throw Error('A helper retry needs a separate explicit choice.');
      } else {
        if (!prior || prior.status !== 'running' || event.attempt !== prior.attempt || event.packetHash !== prior.packetHash) throw Error('A helper outcome has no matching attempt.');
        if (event.status === 'done') { if (event.error !== '') throw Error('A completed result cannot contain an error.'); await verifyReferenceReply(event.envelope,packetFor(row,prior),digest); }
        else if (event.envelope !== null || !event.error.trim()) throw Error('An unfinished attempt cannot claim a result.');
      }
      prev.set(event.role,event);
    }
  }
  async function validateState(record) {
    const body = await openRecord(record, STATE_KEYS, digest);
    if (body.id !== HELPER_STATE_ID || body.kind !== 'helper-state' || body.version !== 1 || !Number.isSafeInteger(body.revision) || body.revision < 1 || !validIsoInstant(body.updatedAt) ||
        !Array.isArray(body.recipients) || body.recipients.length > THREAD_LIMITS.recipients || body.recipients.some(row => !recipientShape(row)) || !unique(body.recipients) ||
        !Array.isArray(body.requests) || body.requests.length > THREAD_LIMITS.requests || new Set(body.requests.map(row=>row?.request?.id)).size !== body.requests.length || encodedBytes(record) > THREAD_LIMITS.bytes) throw Error('Invalid or oversized helper state.');
    for (const row of body.requests) await validateRequest(row);
    const running = body.requests.flatMap(row => row.request.invited.map(role => latest(row,role))).filter(event => event?.status === 'running');
    if (running.length > 1) throw Error('Conflicting active helper attempts.');
    return body;
  }
  async function load() {
    const snapshot = await store.snapshot();
    const record = snapshot.derived.find(row => row.id === HELPER_STATE_ID) ?? null;
    return { record, state: record ? structuredClone(await validateState(record)) : empty(), snapshot };
  }
  async function save(before, state) {
    const next = await sealRecord({ ...state, revision: state.revision + 1, updatedAt: instant() }, digest);
    await validateState(next);
    if (!await store.compareAndSwapDerived(HELPER_STATE_ID, before.record, next)) throw Error('Helper state changed elsewhere. Refresh before continuing.');
    const actual = (await load()).record;
    if (!same(actual,next)) throw Error('Helper save is uncertain. Keep the request and refresh; no automatic dispatch or retry.');
    return next;
  }
  function find(state, requestId) { const row = state.requests.find(row => row.request.id === requestId); if (!row) throw Error('Unknown helper request.'); return row; }
  async function verifySources(row) {
    for (const selected of row.request.context) {
      const source = await store.get(selected.captureId);
      await verifyOrigin(source);
      if (!source || !textAllowed(source.text) || await digest(source.text) !== source.hash || source.hash !== selected.captureHash || await digest(source) !== selected.sourceDigest ||
          source.text.slice(selected.start,selected.end) !== selected.text || !same(originFor(source),selected.origin)) throw Error('Selected source or excerpt changed. Review a new request before dispatch or result acceptance.');
    }
  }
  async function verifyOrigin(source) {
    if (!source?.metadata?.helperResult) return;
    const link=source.metadata.helperResult,{state}=await load(),row=find(state,link.requestId);
    const event=row.events.find(event=>event.id===link.attemptId && event.status==='done');
    if (!exactKeys(link,['requestId','resultHash','approvalHash','attemptId','origin']) || link.origin!=='deterministic-reference' ||
        !event || event.envelope.result.text!==source.text || await digest(event.envelope)!==link.resultHash || row.approval?.checksum!==link.approvalHash ||
        source.metadata.parentId!==row.request.sourceId) throw Error('Helper-derived source provenance cannot be verified.');
  }
  function originFor(source) {
    // S5 posts never assert human authorship. Known derived writing remains identified.
    if (source.metadata?.helperResult) return { kind: 'reference-writing', recordId: source.metadata.helperResult.attemptId, recordHash: source.metadata.helperResult.resultHash, metadataHash: source.metadata.helperResult.approvalHash };
    return sourceOrigin({ ...source, derivedFromId: source.metadata?.derivedFromId });
  }
  async function allowed(state,row) {
    const recipient = activeRecipient(state,row.request.recipientId);
    if (!row.approval || Date.parse(row.approval.expiresAt) <= Date.parse(instant()) || !same(recipient,row.approval.recipient) ||
        !await trust.allowRecipient(recipient) || !await trust.allowApproval(row.approval)) throw Error('A local person must trust this recipient and approve these exact excerpts. Imported approvals are untrusted.');
    await verifySources(row); return recipient;
  }
  async function pair(recipient, { authority } = {}) {
    if (authority !== 'human' || !recipientShape(recipient) || Date.parse(recipient.expiresAt) <= Date.parse(instant())) throw Error('Explicitly pair a current local reference recipient.');
    recipient = structuredClone(recipient);
    const before = await load(), prior = before.state.recipients.find(row => row.id === recipient.id);
    if (prior) { if (!same(prior,recipient)) throw Error('This recipient ID already has a different grant.'); return prior; }
    await save(before,{ ...before.state,recipients:[...before.state.recipients,recipient] }); return recipient;
  }
  async function request(input, { requestId = freshId() } = {}) {
    input = structuredClone(input);
    if (!safePart(requestId) || !exactKeys(input, ['sourceId','context','question','requestedResult','invited','recipientId']) || !Array.isArray(input.context) || input.context.length > THREAD_LIMITS.context) throw Error('Choose exact saved excerpts for the request.');
    const before = await load(); activeRecipient(before.state,input.recipientId);
    const context=[];
    for (const selection of input.context) {
      if (!exactKeys(selection, ['captureId','start','end','privacy']) || selection.privacy !== 'local-only') throw Error('Every selected excerpt needs an explicit local-only privacy choice.');
      const source = await store.get(selection.captureId);
      await verifyOrigin(source);
      if (!source || !textAllowed(source.text) || await digest(source.text) !== source.hash || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) || selection.start < 0 || selection.end > source.text.length || selection.end <= selection.start) throw Error('Selected saved excerpt cannot be verified.');
      context.push({ captureId:source.id,captureHash:source.hash,sourceDigest:await digest(source),start:selection.start,end:selection.end,text:source.text.slice(selection.start,selection.end),privacy:selection.privacy,origin:originFor(source) });
    }
    const body = { protocol:THREAD_PROTOCOL,id:requestId,sourceId:input.sourceId,context,question:input.question,requestedResult:input.requestedResult,invited:input.invited,recipientId:input.recipientId,createdAt:instant() };
    const row = { request:body,requestHash:await digest(body),approval:null,events:[] }; await validateRequest(row);
    const prior = before.state.requests.find(row=>row.request.id===requestId);
    if (prior) {
      const strip = ({createdAt,...rest})=>rest;
      if (!same(strip(prior.request),strip(body))) throw Error('This request ID already belongs to different writing.');
      return structuredClone(prior);
    }
    await save(before,{ ...before.state,requests:[...before.state.requests,row] }); return structuredClone(row);
  }
  async function review(requestId, { authority, expectedRequestHash, privacy, expiresAt } = {}) {
    const before=await load(),row=find(before.state,requestId),recipient=activeRecipient(before.state,row.request.recipientId);
    if (authority !== 'human' || expectedRequestHash !== row.requestHash || privacy !== 'local-only' || !validIsoInstant(expiresAt) || Date.parse(expiresAt) <= Date.parse(instant()) || Date.parse(expiresAt) > Date.parse(recipient.expiresAt) || !await trust.allowRecipient(recipient)) throw Error('Review the exact request hash, local privacy and trusted recipient expiry.');
    await verifySources(row);
    if (row.approval) { if (row.approval.expiresAt !== expiresAt) throw Error('The existing approval has a different expiry.'); return structuredClone(row.approval); }
    if (row.events.length) throw Error('This request already has attempt history. Keep its approval and saved outcomes.');
    const approval=await sealRecord({ requestHash:row.requestHash,recipient,privacy,approvedAt:instant(),expiresAt },digest);
    row.approval=approval; await save(before,before.state); return structuredClone(approval);
  }
  async function begin(requestId,role,{ expectedLatestId=null, retry=false, acknowledgeUncertain=false }={}) {
    const before=await load(),row=find(before.state,requestId); await allowed(before.state,row);
    if (!row.request.invited.includes(role)) throw Error('This helper role was not invited.');
    const prior=latest(row,role);
    if ((prior?.id??null)!==expectedLatestId || prior && (!['uncertain','stopped'].includes(prior.status) || !retry || prior.status==='uncertain'&&!acknowledgeUncertain)) throw Error('Refresh the saved attempt. An uncertain result requires an explicit acknowledged retry.');
    if ((prior?.attempt??0)>=THREAD_LIMITS.attempts) throw Error('The helper retry limit has been reached.');
    if (before.state.requests.some(item=>item.request.invited.some(role=>latest(item,role)?.status==='running'))) throw Error('A helper attempt is running or awaiting reconciliation. No second dispatch is allowed.');
    const event={ id:freshId(),role,attempt:(prior?.attempt??0)+1,status:'running',previousId:prior?.id??null,at:instant(),packetHash:'',envelope:null,error:'' };
    event.packetHash=await digest(packetFor(row,event)); row.events.push(event);
    // Reserve a complete result before dispatch. No inference is attempted if storage is full.
    if (encodedBytes(before.state)+196608>THREAD_LIMITS.bytes) throw Error('There is no reserved room for a helper outcome.');
    await save(before,before.state);
    // Mandatory persisted readback plus trust and source recheck immediately before handing data to transport.
    const after=await load(),saved=find(after.state,requestId);
    if (!same(latest(saved,role),event)) throw Error('The attempt changed before dispatch. No call was started.');
    await allowed(after.state,saved);
    return packetFor(saved,event);
  }
  async function accept(envelope) {
    envelope=structuredClone(envelope);
    const before=await load(),row=find(before.state,envelope?.requestId); await allowed(before.state,row);
    const running=row.events.find(event=>event.id===envelope.attemptId&&event.status==='running');
    if (!running) throw Error('The result has no saved running attempt.');
    const prior=latest(row,running.role);
    if (prior?.status==='done' && prior.previousId===running.id) { if (!same(prior.envelope,envelope)) throw Error('A different outcome is already saved.'); return structuredClone(prior); }
    if (prior?.id!==running.id) throw Error('This attempt ended. A late result cannot replace the explicit choice.');
    await verifyReferenceReply(envelope,packetFor(row,running),digest);
    const event={ ...running,id:freshId(),status:'done',previousId:running.id,at:instant(),envelope,error:'' };
    row.events.push(event); await save(before,before.state); return structuredClone(event);
  }
  async function end(requestId,role,{ expectedLatestId,status='uncertain' }={}) {
    if (!['uncertain','stopped'].includes(status)) throw Error('Choose uncertain or stopped.');
    const before=await load(),row=find(before.state,requestId),prior=latest(row,role);
    if (!prior || prior.status!=='running' || prior.id!==expectedLatestId) throw Error('The running attempt changed.');
    const event={ ...prior,id:freshId(),status,previousId:prior.id,at:instant(),envelope:null,error:status==='uncertain'?'Dispatch or result persistence is uncertain. No automatic retry.':'Stopped explicitly. Late results cannot replace this choice.' };
    row.events.push(event); await save(before,before.state); return structuredClone(event);
  }
  async function dispatch(requestId,role,options={}) {
    const packet=await begin(requestId,role,options);
    let received;
    try { received=await (options.transport??(packet=>referenceReply(packet,digest)))(structuredClone(packet)); return await accept(received); }
    catch (error) {
      // A returned response is retained for manual reconciliation if persistence fails. Never resend here.
      const failure=Error('Helper dispatch or persistence is uncertain. Keep the saved attempt; do not automatically retry.');
      failure.attemptId=packet.attemptId;
      if (received!==undefined) failure.received=structuredClone(received);
      throw failure;
    }
  }
  async function pendingPacket(requestId,role) {
    const {state}=await load(),row=find(state,requestId); await allowed(state,row);
    const running=latest(row,role);
    if (running?.status!=='running') throw Error('There is no pending attempt to reconcile.');
    return packetFor(row,running);
  }
  async function prepareReply(requestId,role,{authority}={}) {
    if (authority!=='human') throw Error('Preparing helper writing needs an explicit human choice.');
    const {state}=await load(),row=find(state,requestId); await allowed(state,row);
    const event=latest(row,role);
    if (event?.status!=='done') throw Error('There is no verified saved answer to prepare.');
    const source=await store.get(row.request.sourceId),resultHash=await digest(event.envelope);
    const record=await createCapture({id:`helper-result-${event.id}`,text:event.envelope.result.text,createdAt:event.at,
      metadata:{span:spanOf(source),parentId:source.id,helperResult:{requestId,resultHash,approvalHash:row.approval.checksum,attemptId:event.id,origin:'deterministic-reference'}}},hash);
    const prior=await store.get(record.id);
    if (prior) { if (!same(prior,record)) throw Error('An existing reply conflicts with this exact result.'); return prior; }
    await store.append(record);
    if (!same(await store.get(record.id),record)) throw Error('Prepared reply readback is uncertain. Retry the same preparation.');
    return record;
  }
  async function read(requestId) {
    const {state}=await load();
    if (requestId===undefined) return structuredClone(state);
    const row=find(state,requestId); let authorization='approved';
    try { await allowed(state,row); } catch { authorization='untrusted, expired or changed source'; }
    return { ...structuredClone(row),authorization,outputKind:'deterministic reference writing, never human testimony or completed work' };
  }
  return { pair,request,review,begin,accept,end,dispatch,pendingPacket,prepareReply,read };
}
