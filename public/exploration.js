import { validateRevisionProposal } from './revision-proposals.js';
import { moveSnapshotShape, validMoveSnapshot, validateThinkingState } from './thinking.js';
import { request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, stableId, same, IntegrityError } from './primitives.js';
import { seal, noteAllowed, validatePlace } from './intent.js';
import { validateCapture } from './records.js';
import { spanKey, validSpan } from './spans.js';

export const EXPLORATION_TABLES = Object.freeze(['explorations', 'distillations']);
export const EXPLORATION_DIALS = Object.freeze(['TIGHT', 'NORMAL', 'WILD', 'UNHINGED SANDBOX']);
export const DISTILLATION_TYPES = Object.freeze(['INSIGHT', 'HYPOTHESIS', 'EXPERIMENT', 'DECISION CANDIDATE', 'FUTURE ARCHITECTURE', 'OPEN TENSION', 'WEIRD BUT ALIVE', 'NOISE', 'RECEIPT']);
const LIMIT = 10000;
export const EXPLORATION_BYTES_LIMIT = 4 * 1024 * 1024;
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
async function checkSeal(record, keys) {
  if (!exactKeys(record, [...keys, 'hash']) || !validHash(record.hash)) throw new IntegrityError('An exploration record has an invalid format.');
  const body = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hash'));
  if (await sha256(JSON.stringify(body)) !== record.hash) throw new IntegrityError('An exploration checksum does not match.');
}
async function inspectExplorations(state) {
  for (const key of EXPLORATION_TABLES) {
    const rows = state[key];
    if (!Array.isArray(rows) || rows.length > LIMIT || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)) || new Set(rows.map(r => r.id)).size !== rows.length) throw new IntegrityError('Invalid or duplicate exploration records.');
  }
  if (!Array.isArray(state.captures) || !Array.isArray(state.places)) throw new IntegrityError('Exploration sources are missing.');
  const branches = new Map(state.explorations.map(r => [r.id, r]));
  const captures = new Set(state.captures.map(c => c.id)), places = new Set(state.places.map(p => p.id));
  const errors = new Map(), children = new Map();
  for (const row of state.explorations) {
    try {
      await checkSeal(row, ['id', 'sourceId', 'parentId', 'returnPointId', 'dial', 'text', 'author', 'at', ...(row.move !== undefined ? ['move'] : [])]);
      if (row.move !== undefined && !moveSnapshotShape(row.move)) throw new IntegrityError('An exploration has an invalid saved move.');
      if (!validId(row.id) || !validId(row.sourceId) || !(row.parentId === null || validId(row.parentId)) || !validId(row.returnPointId) || !EXPLORATION_DIALS.includes(row.dial) || !noteAllowed(row.text, true) || row.author !== 'self' || !validDate(row.at) || !captures.has(row.sourceId) || !places.has(row.returnPointId)) throw new IntegrityError('An exploration has invalid provenance or content.');
      if (row.parentId !== null) {
        const parent = branches.get(row.parentId);
        if (!parent || parent.sourceId !== row.sourceId || parent.returnPointId !== row.returnPointId) throw new IntegrityError('An exploration branch has a missing or inconsistent parent.');
      }
    } catch (error) { if (!(error instanceof IntegrityError)) throw error; errors.set(row.id, error.message); }
    if (row.parentId !== null) { const list = children.get(row.parentId) ?? []; list.push(row.id); children.set(row.parentId, list); }
  }
  // Each node is visited once, including cycles and their descendants.
  const visited = new Set();
  for (const row of state.explorations) {
    if (visited.has(row.id)) continue;
    const path = [], pathIds = new Set(); let current = row;
    while (current && !visited.has(current.id) && !pathIds.has(current.id)) {
      path.push(current); pathIds.add(current.id); current = current.parentId === null ? null : branches.get(current.parentId);
    }
    if (current && pathIds.has(current.id)) errors.set(current.id, 'An exploration branch has a cyclic parent.');
    for (const node of path) visited.add(node.id);
  }
  const queue = [...errors.keys()];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) if (!errors.has(child)) { errors.set(child, 'An exploration ancestor needs recovery.'); queue.push(child); }
  const bad = state.explorations.filter(row => errors.has(row.id)).map(row => ({ table: 'explorations', row, reason: errors.get(row.id) }));
  for (const row of state.distillations) {
    try {
      await checkSeal(row, ['id', 'explorationId', 'type', 'text', 'author', 'at']);
      if (!validId(row.id) || !validId(row.explorationId) || !branches.has(row.explorationId) || errors.has(row.explorationId) || !DISTILLATION_TYPES.includes(row.type) || !noteAllowed(row.text, true) || row.author !== 'self' || !validDate(row.at)) throw new IntegrityError('A distillation has invalid provenance or content.');
    } catch (error) { if (!(error instanceof IntegrityError)) throw error; bad.push({ table: 'distillations', row, reason: error.message }); }
  }
  return bad;
}
export async function validateExplorationState(state) {
  if (Array.isArray(state.explorations) && Array.isArray(state.distillations) && new TextEncoder().encode(JSON.stringify([state.explorations, state.distillations])).length > EXPLORATION_BYTES_LIMIT) throw new IntegrityError('Exploration storage exceeds the 4 MB portable limit.');
  const bad = await inspectExplorations(state);
  if (bad.length) throw new IntegrityError(bad[0].reason);
}

// A missing derivation is tolerated only when its raw record was preserved for recovery.
export function validateProposalProvenance(capture, state) {
  if (capture.sourceRevisionId !== undefined) return validateRevisionProposal(capture,state);
  const { captures, explorations, distillations, recovery } = state;
  if (capture.derivedFromId === undefined) return null;
  const recorded = () => recovery.some(row => row.source === 'derivation' && row.recordId === capture.id && row.raw === JSON.stringify(capture));
  const fail = message => { if (recorded()) return 'recovery'; throw new IntegrityError(message); };
  if (!validId(capture.derivedFromId) || !validId(capture.parentId) || capture.sample !== false) return fail('A proposal has an invalid provenance link.');
  const distillation = distillations.find(row => row.id === capture.derivedFromId);
  if (!distillation) {
    if (recovery.some(row => row.source === 'distillations' && row.recordId === capture.derivedFromId)) return 'recovery';
    return fail('A proposal is missing its distillation provenance.');
  }
  const branch = explorations.find(row => row.id === distillation.explorationId);
  if (!branch || branch.dial === 'UNHINGED SANDBOX' || branch.sourceId !== capture.parentId || capture.text !== distillation.text) return fail('A proposal does not match its distillation provenance.');
  const source = captures.find(row => row.id === capture.parentId);
  if (source && spanKey(source.span) !== spanKey(capture.span)) return fail('A proposal must remain in its source Attention Span.');
  if (!source) {
    if (recovery.some(row => row.source === 'capture' && row.recordId === capture.parentId)) return 'recovery';
    return fail('A proposal is missing its source.');
  }
  return 'verified';
}

export function createExploration({ db, ready = async () => {}, notify = () => {}, recoveryRecord, ensureCapacity }) {
  async function snapshot(includeMoves = false) {
    await ready();
    return db.run(['meta', 'captures', 'places', 'quarantine', ...EXPLORATION_TABLES, ...(includeMoves ? ['moveEvents'] : [])], 'readonly', async tx => ({
      epoch: await meta(tx, 'epoch'), captures: await request(tx.objectStore('captures').getAll()), places: await request(tx.objectStore('places').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()),
      moveEvents: includeMoves ? await request(tx.objectStore('moveEvents').getAll()) : [], explorations: await request(tx.objectStore('explorations').getAll()), distillations: await request(tx.objectStore('distillations').getAll()),
    }));
  }
  async function repair() {
    const state = await snapshot(), bad = await inspectExplorations(state);
    if (!bad.length) return;
    if (!recoveryRecord) throw new IntegrityError('Damaged exploration records need recovery.');
    for (const item of bad) item.recovery = await recoveryRecord(item.table, String(item.row?.id ?? 'unknown').slice(0, 128), JSON.stringify(item.row), item.reason);
    await db.run(['meta', 'quarantine', 'captures', 'places', ...EXPLORATION_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) return;
      for (const name of ['captures', 'places', ...EXPLORATION_TABLES]) if (!same(await request(tx.objectStore(name).getAll()), state[name])) return;
      for (const item of bad) {
        const table = tx.objectStore(item.table);
        if (!same(await request(table.get(item.row.id)), item.row)) continue;
        await request(tx.objectStore('quarantine').put(item.recovery)); await request(table.delete(item.row.id));
      }
    });
    notify();
  }
  async function save(table, input, requestId, expectedEpoch) {
    if (requestId !== undefined && !validId(requestId)) throw Error('The exploration request ID is invalid.');
    const state = await snapshot(!!input.move);
    if (input.move) { await validateThinkingState({ ...state, branchEvents: [] }); if (validMoveSnapshot(input.move, state.moveEvents, state.recovery) !== 'verified') throw Error('This move definition needs recovery. Your branch text is still yours to keep.'); }
    if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Keep your exploration and reopen it.');
    await validateExplorationState(state);
    const id = requestId ? await stableId(JSON.stringify([table, state.epoch ?? null, requestId])) : crypto.randomUUID();
    const prior = state[table].find(r => r.id === id);
    const matches = row => Object.entries(input).every(([key, value]) => same(row[key], value));
    if (prior && !matches(prior)) throw Error('This request ID already belongs to a different exploration record.');
    const branch = table === 'explorations' ? input : state.explorations.find(row => row.id === input.explorationId);
    if (!branch) throw Error('This exploration needs recovery before distilling.');
    const source = state.captures.find(c => c.id === branch.sourceId), place = state.places.find(p => p.id === branch.returnPointId);
    if (!source || !place) throw Error('The exploration provenance needs recovery.');
    await validateCapture(source); await validatePlace(place, state.captures, state.recovery);
    if (prior) return prior;
    const record = await seal({ id, ...input, author: 'self', at: new Date().toISOString() });
    await validateExplorationState({ ...state, [table]: [...state[table], record] });
    const inserted = await db.run(['meta', 'captures', 'places', ...EXPLORATION_TABLES, ...(input.move ? ['moveEvents'] : [])], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Keep your exploration and retry.');
      if (input.move?.revisionId && !same(await request(tx.objectStore('moveEvents').get(input.move.revisionId)), state.moveEvents.find(row => row.id === input.move.revisionId))) throw Error('The saved move changed. Reopen it before branching.');
      const target = tx.objectStore(table), existing = await request(target.get(id));
      if (existing) return existing;
      if (await request(target.count()) >= LIMIT) throw Error('The exploration storage limit was reached.');
      for (const name of ['captures', 'places', ...EXPLORATION_TABLES]) {
        if (!same(await request(tx.objectStore(name).getAll()), state[name])) throw Error('Exploration sources changed in another tab. Refresh and retry.');
      }
      await request(target.add(record)); return record;
    });
    if (!matches(inserted)) throw Error('This request ID already belongs to a different exploration record.');
    const actual = await db.run([table], 'readonly', tx => request(tx.objectStore(table).get(id)));
    if (!same(actual, inserted)) throw Error('The exploration could not be read back exactly. Keep your text and retry.');
    notify(); return actual;
  }
  async function explore({ sourceId, parentId = null, returnPointId, dial, text, move = null }, { requestId, expectedEpoch } = {}) {
    return save('explorations', { sourceId, parentId, returnPointId, dial, text, ...(move ? { move } : {}) }, requestId, expectedEpoch);
  }
  async function distill({ explorationId, type, text }, { requestId, expectedEpoch } = {}) {
    return save('distillations', { explorationId, type, text }, requestId, expectedEpoch);
  }
  async function prepareProposal({ distillationId }, { expectedEpoch } = {}) {
    if (!validId(distillationId)) throw Error('The distillation ID is invalid.');
    const state = await snapshot();
    if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Reopen the distillation before preparing a proposal.');
    await validateExplorationState(state);
    const distillation = state.distillations.find(row => row.id === distillationId);
    const branch = state.explorations.find(row => row.id === distillation?.explorationId);
    if (!branch || !distillation) throw Error('The distillation needs recovery before preparing a proposal.');
    if (branch.dial === 'UNHINGED SANDBOX') throw Error('Leave the sandbox by creating a branch with another dial before preparing a proposal.');
    const source = state.captures.find(row => row.id === branch.sourceId), place = state.places.find(row => row.id === branch.returnPointId);
    if (!source || !place) throw Error('The exploration provenance needs recovery.');
    await validateCapture(source); await validatePlace(place, state.captures, state.recovery);
    const previous = state.captures.filter(c => c.derivedFromId === distillationId);
    if (previous.length > 1) throw Error('Multiple proposal copies need review in source recovery before preparing another.');
    if (previous[0]) { await validateCapture(previous[0]); if (validateProposalProvenance(previous[0], state) !== 'verified') throw Error('The earlier proposal needs source recovery before preparing it again.'); }
    const id = previous[0]?.id ?? await stableId(JSON.stringify(['proposal', state.epoch ?? null, distillationId]));
    const payload = { id, text: distillation.text, hash: await sha256(distillation.text), createdAt: new Date().toISOString(), span: source.span, sample: false, parentId: source.id, derivedFromId: distillationId };
    const record = { ...payload, derivedHash: await sha256(JSON.stringify(payload)) };
    const matches = row => row.id === id && row.text === record.text && row.hash === record.hash && row.span === record.span && row.sample === false && row.parentId === record.parentId && row.derivedFromId === distillationId;
    const actual = await db.run(['meta', 'captures', 'places', 'spans', ...EXPLORATION_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Reopen the distillation before preparing a proposal.');
      const captures = tx.objectStore('captures'), prior = await request(captures.get(id));
      for (const [table, row] of [['captures', source], ['places', place], ['explorations', branch], ['distillations', distillation]]) if (!same(await request(tx.objectStore(table).get(row.id)), row)) throw Error('The proposal source changed. Reopen the distillation before preparing it.');
      if (prior) { if (!matches(prior)) throw Error('This proposal ID belongs to different saved writing. Nothing was changed.'); return prior; }
      for (const name of ['captures', 'places', ...EXPLORATION_TABLES]) if (!same(await request(tx.objectStore(name).getAll()), state[name])) throw Error('The exploration changed. Refresh before preparing a proposal.');
      if (!validSpan(await request(tx.objectStore('spans').get(spanKey(source.span))))) throw Error('The source Attention Span needs recovery.');
      if (!ensureCapacity) throw Error('Proposal storage capacity is unavailable.');
      ensureCapacity(state.captures, [record]);
      await request(captures.add(record)); await request(tx.objectStore('meta').put({ key: 'initialized', value: true })); return record;
    });
    let verified;
    try {
      verified = await db.run(['captures'], 'readonly', tx => request(tx.objectStore('captures').get(id)));
      await validateCapture(verified);
      if (!same(verified, actual) || !matches(verified)) throw Error('The saved proposal differs from its readback.');
    } catch (error) { notify(); throw Error(`The proposal could not be read back exactly: ${error.message} Your distillation is kept. Retry to check the saved proposal.`); }
    notify(); return verified;
  }
  return { explore, distill, repair, prepareProposal };
}
