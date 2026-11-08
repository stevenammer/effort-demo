import { request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, stableId, same, IntegrityError } from './primitives.js';
import { noteAllowed, seal } from './intent.js';

export const THINKING_TABLES = Object.freeze(['branchEvents', 'moveEvents']);
export const BRANCH_STATUSES = Object.freeze(['active', 'parked', 'distilled', 'discarded', 'weird_but_alive']);
export const MOVE_SEEDS = Object.freeze([
  ['TACIT TO EXPLICIT', 'Take something experienced people just know and make the hidden process visible.'],
  ['FRICTION TO TOOL', 'Notice recurring real-world friction and make the smallest useful artifact that changes the experience.'],
  ['CROSS-DOMAIN TRANSFER', 'Take a mechanism that works in one domain and ask where else it applies.'],
  ['HUMAN UNDERNEATH SYSTEM', 'Ignore the official workflow for a moment. What is the person actually trying to accomplish?'],
  ['COMPRESSION', 'Find the sentence, visual, interaction, or loop that keeps most of the useful complexity.'],
  ['FUTURE ARCHITECTURE', 'If this primitive works, what larger system does it naturally become part of?'],
  ['INVERT THE METRIC', 'What if the KPI is optimizing the wrong thing?'],
  ['FOLLOW THE USER', 'Where does real behavior depart from the written process?'],
  ['SMALL PROOF', 'What is the cheapest artifact that could falsify or validate the interesting part?'],
].map(([name, prompt], i) => Object.freeze({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, name, prompt, enabled: true })));
export const THINKING_LIMITS = Object.freeze({ records: 10000, bytes: 2 * 1024 * 1024 });
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(r => r?.value);
const nameAllowed = s => noteAllowed(s, true) && s.length <= 120;
const promptAllowed = s => noteAllowed(s, true) && s.length <= 2000;
async function checkSeal(row, keys) {
  if (!exactKeys(row, [...keys, 'hash']) || !validHash(row.hash)) throw new IntegrityError('A thinking record has an invalid format.');
  const body = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'hash'));
  if (await sha256(JSON.stringify(body)) !== row.hash) throw new IntegrityError('A thinking record checksum does not match.');
}
function chain(rows, key) {
  const ids = new Map(rows.map(r => [r.id, r])), roots = rows.filter(r => r.previousId === null);
  if (ids.size !== rows.length || roots.length !== 1) throw new IntegrityError('A thinking history has no unique start.');
  const next = new Map();
  for (const row of rows) if (row.previousId !== null) {
    if (!ids.has(row.previousId) || next.has(row.previousId) || ids.get(row.previousId)[key] !== row[key]) throw new IntegrityError('A thinking history conflicts or is disconnected.');
    next.set(row.previousId, row);
  }
  const history = [roots[0]]; let current = roots[0];
  while (next.has(current.id)) { current = next.get(current.id); history.push(current); if (history.length > rows.length) throw new IntegrityError('A thinking history contains a cycle.'); }
  if (history.length !== rows.length) throw new IntegrityError('A thinking history is disconnected.');
  return history;
}
function groups(events, key) {
  const result = new Map(); for (const event of events) { const a = result.get(event[key]) ?? []; a.push(event); result.set(event[key], a); } return result;
}
function unresolvedHistory(history, receipts) {
  if (!receipts.length) return false;
  if (!history.length) return true;
  const ids = new Set(history.map(row => row.id)), recoveredIds = new Set(receipts.map(r => r.recordId));
  // A new explicit event after recovery supersedes the uncertain prior history.
  if (!recoveredIds.has(history.at(-1).id)) return false;
  return [...recoveredIds].some(id => !ids.has(id));
}
function recoveryGroups(recovery, source, key) {
  const grouped = new Map();
  for (const entry of recovery.filter(r => r.source === source)) {
    try { const row = JSON.parse(entry.raw); if (!validId(row[key])) continue; const entries = grouped.get(row[key]) ?? []; entries.push(entry); grouped.set(row[key], entries); } catch {}
  }
  return grouped;
}
export function deriveBranchStatuses(events, recovery = []) {
  const histories = groups(events, 'branchId'), recovered = recoveryGroups(recovery, 'branchEvents', 'branchId'), result = [];
  for (const id of new Set([...histories.keys(), ...recovered.keys()])) {
    const history = histories.has(id) ? chain(histories.get(id), 'branchId') : [], last = history.at(-1);
    if (unresolvedHistory(history, recovered.get(id) ?? [])) result.push({ branchId: id, status: null, note: '', evidence: false, latestId: last?.id ?? null, history, recovery: true });
    else if (last) result.push({ branchId: id, status: last.status, note: last.note, evidence: last.evidence, latestId: last.id, history });
  }
  return result;
}
export function deriveMoves(events, recovery = []) {
  const result = new Map(MOVE_SEEDS.map(seed => [seed.id, { ...seed, latestId: null, history: [] }]));
  const histories = groups(events, 'moveId'), recovered = recoveryGroups(recovery, 'moveEvents', 'moveId');
  for (const id of new Set([...histories.keys(), ...recovered.keys()])) {
    const history = histories.has(id) ? chain(histories.get(id), 'moveId') : [], last = history.at(-1), seed = result.get(id);
    if (unresolvedHistory(history, recovered.get(id) ?? [])) result.set(id, { ...(last ? { id, name: last.name, prompt: last.prompt, history } : seed ?? { id, name: 'Move definition needs recovery', prompt: '', history: [] }), latestId: last?.id ?? null, enabled: false, recovery: true });
    else if (last) result.set(id, { id, name: last.name, prompt: last.prompt, enabled: last.enabled, latestId: last.id, history });
  }
  return [...result.values()];
}

export function moveSnapshot(moveId, events, recovery = []) {
  const move = deriveMoves(events, recovery).find(item => item.id === moveId);
  if (!move || !move.enabled) throw Error('This thinking move is unavailable or turned off.');
  return { id: move.id, revisionId: move.latestId, name: move.name, prompt: move.prompt };
}
export function moveSnapshotShape(snapshot) { return snapshot === null || exactKeys(snapshot, ['id', 'revisionId', 'name', 'prompt']) && validId(snapshot.id) && (snapshot.revisionId === null || validId(snapshot.revisionId)) && nameAllowed(snapshot.name) && promptAllowed(snapshot.prompt); }
export function validMoveSnapshot(snapshot, events, recovery = []) {
  if (snapshot === null) return 'verified';
  if (!exactKeys(snapshot, ['id', 'revisionId', 'name', 'prompt']) || !validId(snapshot.id) || !(snapshot.revisionId === null || validId(snapshot.revisionId)) || !nameAllowed(snapshot.name) || !promptAllowed(snapshot.prompt)) return false;
  const row = snapshot.revisionId === null ? MOVE_SEEDS.find(m => m.id === snapshot.id) : events.find(e => e.id === snapshot.revisionId && e.moveId === snapshot.id);
  if (!row) return snapshot.revisionId !== null && recovery.some(r => r.source === 'moveEvents' && r.recordId === snapshot.revisionId) ? 'recovery' : false;
  return row.name === snapshot.name && row.prompt === snapshot.prompt && row.enabled === true ? 'verified' : false;
}
async function validateRow(row, table, state) {
  if (table === 'branchEvents') {
    await checkSeal(row, ['id', 'branchId', 'previousId', 'status', 'note', 'evidence', 'at']);
    if (!validId(row.id) || !validId(row.branchId) || !(row.previousId === null || validId(row.previousId)) || !BRANCH_STATUSES.includes(row.status) || !noteAllowed(row.note) || typeof row.evidence !== 'boolean' || (row.evidence && state.explorations.some(b => b.id === row.branchId) && !state.explorations.some(b => b.id === row.branchId && b.move)) || !validDate(row.at) || !state.explorations.some(b => b.id === row.branchId) && !state.recovery.some(r => r.source === 'explorations' && r.recordId === row.branchId)) throw new IntegrityError('A branch status has invalid content or source.');
  } else {
    await checkSeal(row, ['id', 'moveId', 'previousId', 'name', 'prompt', 'enabled', 'at']);
    if (!validId(row.id) || !validId(row.moveId) || !(row.previousId === null || validId(row.previousId)) || !nameAllowed(row.name) || !promptAllowed(row.prompt) || typeof row.enabled !== 'boolean' || !validDate(row.at)) throw new IntegrityError('A thinking move has an invalid definition.');
  }
}
export async function validateThinkingState(state) {
  if (!Array.isArray(state.explorations) || !Array.isArray(state.recovery)) throw new IntegrityError('Thinking sources are missing.');
  for (const table of THINKING_TABLES) {
    const rows = state[table];
    if (!Array.isArray(rows) || rows.length > THINKING_LIMITS.records || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)) || new Set(rows.map(r => r.id)).size !== rows.length) throw new IntegrityError('Invalid or duplicate thinking records.');
    for (const row of rows) await validateRow(row, table, state);
  }
  if (new TextEncoder().encode(JSON.stringify(THINKING_TABLES.map(key => state[key]))).length > THINKING_LIMITS.bytes) throw new IntegrityError('Thinking history exceeds the portable storage limit.');
  deriveBranchStatuses(state.branchEvents); deriveMoves(state.moveEvents);
}
export function createThinking({ db, ready = async () => {}, notify = () => {}, recoveryRecord }) {
  async function snapshot() {
    await ready(); return db.run(['meta', 'quarantine', 'explorations', ...THINKING_TABLES], 'readonly', async tx => ({ epoch: await meta(tx, 'epoch'), recovery: await request(tx.objectStore('quarantine').getAll()), explorations: await request(tx.objectStore('explorations').getAll()), branchEvents: await request(tx.objectStore('branchEvents').getAll()), moveEvents: await request(tx.objectStore('moveEvents').getAll()) }));
  }
  async function repair() {
    const state = await snapshot(), bad = [];
    for (const [table, key] of [['branchEvents', 'branchId'], ['moveEvents', 'moveId']]) for (const rows of groups(state[table], key).values()) {
      try { for (const row of rows) await validateRow(row, table, state); chain(rows, key); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; for (const row of rows) bad.push({ table, row, reason: error.message }); }
    }
    if (!bad.length) return;
    if (!recoveryRecord) throw new IntegrityError('Thinking history needs recovery.');
    for (const item of bad) item.recovery = await recoveryRecord(item.table, String(item.row?.id ?? 'unknown').slice(0, 128), JSON.stringify(item.row), item.reason);
    await db.run(['meta', 'quarantine', 'explorations', ...THINKING_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) return;
      for (const [table, expected] of [['quarantine', state.recovery], ['explorations', state.explorations], ...THINKING_TABLES.map(table => [table, state[table]])]) if (!same(await request(tx.objectStore(table).getAll()), expected)) return;
      for (const item of bad) { await request(tx.objectStore('quarantine').put(item.recovery)); await request(tx.objectStore(item.table).delete(item.row.id)); }
    }); notify();
  }
  async function save(table, input, { requestId, expectedEpoch } = {}) {
    if (requestId !== undefined && !validId(requestId)) throw Error('The thinking request ID is invalid.');
    const state = await snapshot();
    if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Reopen this thinking before saving.');
    await validateThinkingState(state);
    if (table === 'branchEvents') {
      const branch = state.explorations.find(row => row.id === input.branchId);
      if (!branch) throw Error('The branch needs recovery before changing its status.');
      await checkSeal(branch, Object.keys(branch).filter(key => key !== 'hash'));
    }
    const key = table === 'branchEvents' ? 'branchId' : 'moveId';
    if (table === 'moveEvents' && input.moveId === null) input = { ...input, moveId: requestId ? await stableId(JSON.stringify(['custom-move', state.epoch ?? null, requestId])) : crypto.randomUUID() };
    const id = requestId ? await stableId(JSON.stringify([table, state.epoch ?? null, requestId])) : crypto.randomUUID();
    const { expectedLatestId, ...content } = input;
    const matches = row => row.previousId === expectedLatestId && Object.entries(content).every(([k, v]) => same(row[k], v));
    const prior = state[table].find(row => row.id === id);
    if (prior) {
      if (!matches(prior)) throw Error('This request ID belongs to different thinking.');
      await db.run(['meta', 'explorations', table], 'readonly', async tx => {
        if (await meta(tx, 'epoch') !== state.epoch || !same(await request(tx.objectStore(table).get(id)), prior)) throw Error('The workspace changed. Reopen this thinking before saving.');
        if (table === 'branchEvents' && !same(await request(tx.objectStore('explorations').get(input.branchId)), state.explorations.find(row => row.id === input.branchId))) throw Error('The branch changed. Reopen it before saving.');
      });
      return prior;
    }
    const current = table === 'branchEvents' ? deriveBranchStatuses(state.branchEvents, state.recovery).find(row => row.branchId === input.branchId) : deriveMoves(state.moveEvents, state.recovery).find(row => row.id === input.moveId);
    if ((current?.latestId ?? null) !== expectedLatestId) throw Error('This thinking changed in another tab. Refresh before saving.');
    const record = await seal({ id, ...content, previousId: expectedLatestId, at: new Date().toISOString() });
    await validateThinkingState({ ...state, [table]: [...state[table], record] });
    const inserted = await db.run(['meta', 'quarantine', 'explorations', ...THINKING_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Reopen this thinking before saving.');
      const target = tx.objectStore(table), existing = await request(target.get(id));
      if (existing) { if (!matches(existing)) throw Error('This request ID belongs to different thinking.'); return existing; }
      for (const name of ['explorations', ...THINKING_TABLES]) if (!same(await request(tx.objectStore(name).getAll()), state[name])) throw Error('This thinking changed in another tab. Refresh before saving.');
      if (!same(await request(tx.objectStore('quarantine').getAll()), state.recovery)) throw Error('Thinking recovery changed in another tab. Refresh before saving.');
      await request(target.add(record)); return record;
    });
    try { const actual = await db.run([table], 'readonly', tx => request(tx.objectStore(table).get(id))); if (!same(actual, inserted) || !matches(actual)) throw Error('The saved thinking differs from its readback.'); await validateRow(actual, table, state); notify(); return actual; }
    catch (error) { notify(); throw Error(`The thinking could not be read back exactly: ${error.message} Keep your writing and retry.`); }
  }
  return {
    repair,
    setBranchStatus: ({ branchId, status, note = '', evidence = false, expectedLatestId }, options) => save('branchEvents', { branchId, status, note, evidence, expectedLatestId }, options),
    saveMove: ({ moveId = null, name, prompt, enabled, expectedLatestId }, options) => save('moveEvents', { moveId, name, prompt, enabled, expectedLatestId }, options),
  };
}
