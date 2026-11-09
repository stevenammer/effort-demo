import { request } from './database.js';
import { exactKeys, validId, validHash, validDate, sha256, same, stableId, IntegrityError } from './primitives.js';
import { seal } from './intent.js';
import { textAllowed, validateCapture } from './records.js';

export const REVISION_TABLE = 'sourceRevisions';
export const REVISION_LIMITS = Object.freeze({ records: 4000, bytes: 4 * 1024 * 1024 });
const kinds = ['edit', 'transcript'];
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
function groups(rows) {
  const map = new Map();
  for (const row of rows) { const key = `${row.captureId}:${row.kind}`, group = map.get(key) ?? []; group.push(row); map.set(key, group); }
  return map;
}
function chain(rows) {
  if (!rows.length) return [];
  const byId = new Map(rows.map(row => [row.id, row])), roots = rows.filter(row => row.previousId === null), next = new Map();
  if (byId.size !== rows.length || roots.length !== 1) throw new IntegrityError('A source revision history has no unique beginning.');
  for (const row of rows) if (row.previousId !== null) {
    if (!byId.has(row.previousId) || next.has(row.previousId)) throw new IntegrityError('Source revision histories conflict or are disconnected.');
    next.set(row.previousId, row);
  }
  const result = [roots[0]]; while (next.has(result.at(-1).id)) { result.push(next.get(result.at(-1).id)); if (result.length > rows.length) throw new IntegrityError('A source revision history contains a cycle.'); }
  if (result.length !== rows.length) throw new IntegrityError('A source revision history is disconnected.');
  return result;
}
export function revisionRecovery(recovery, captureId, kind) {
  return recovery.filter(entry => {
    if (entry.source !== REVISION_TABLE) return false;
    try { const row = JSON.parse(entry.raw); return !validId(row?.captureId) || !kinds.includes(row?.kind) || row.captureId === captureId && row.kind === kind; }
    catch { return true; }
  });
}
export function sourceRevisionState(state, captureId) {
  const source = state.captures.find(c => c.id === captureId), result = { source, edit: null, transcript: null, editHistory: [], transcriptHistory: [], editRecovery: [], transcriptRecovery: [] };
  for (const kind of kinds) {
    const history = chain((state.sourceRevisions ?? []).filter(row => row.captureId === captureId && row.kind === kind)), latest = history.at(-1);
    const present = new Set(history.map(row => row.id)), acknowledged = new Set(history.flatMap(row => row.acknowledgedRecovery));
    const missing = revisionRecovery(state.recovery ?? [], captureId, kind).filter(entry => !present.has(entry.recordId) && !acknowledged.has(entry.id));
    result[`${kind}History`] = history; result[`${kind}Recovery`] = missing;
    if (!missing.length) result[kind] = latest ?? null;
  }
  result.uncertain = !!state.revisionWarning || !!result.editRecovery.length || !result.edit && !!result.transcriptRecovery.length;
  result.effective = result.uncertain ? null : result.edit ?? result.transcript;
  result.text = result.uncertain ? null : result.effective?.text ?? source?.text ?? null;
  return result;
}
async function validateRow(row, state) {
  if (!exactKeys(row, ['id', 'captureId', 'captureHash', 'kind', 'previousId', 'text', 'acknowledgedRecovery', 'at', 'hash']) || !validId(row.id) || !validId(row.captureId) || !validHash(row.captureHash) || !kinds.includes(row.kind) || !(row.previousId === null || validId(row.previousId)) || !textAllowed(row.text) || !validDate(row.at) || !validHash(row.hash) || !Array.isArray(row.acknowledgedRecovery) || row.acknowledgedRecovery.length > REVISION_LIMITS.records || row.acknowledgedRecovery.some(id => !validHash(id)) || new Set(row.acknowledgedRecovery).size !== row.acknowledgedRecovery.length) throw new IntegrityError('A source revision has invalid content.');
  const { hash, ...body } = row;
  if (await sha256(JSON.stringify(body)) !== hash) throw new IntegrityError('A source revision checksum does not match.');
  const source = state.captures.find(c => c.id === row.captureId);
  if (source && source.hash !== row.captureHash) {
    // Primary corruption must not quarantine an independently intact revision. Closed workspace reads repair and verify originals separately.
    try { await validateCapture(source); } catch { throw Error('The original needs recovery; its separate revision is kept unchanged.'); }
    throw new IntegrityError('A source revision no longer matches its verified original.');
  }
  if (!source && !state.recovery.some(entry => entry.source === 'capture' && entry.recordId === row.captureId)) throw new IntegrityError('A source revision is missing its original.');
  const available = new Set(revisionRecovery(state.recovery, row.captureId, row.kind).map(entry => entry.id));
  if (row.acknowledgedRecovery.some(id => !available.has(id))) throw new IntegrityError('A source revision recovery acknowledgement has no raw evidence.');
}
export async function validateRevisionState(state) {
  if (!Array.isArray(state.captures) || !Array.isArray(state.recovery) || !Array.isArray(state.sourceRevisions) || state.sourceRevisions.length > REVISION_LIMITS.records || state.sourceRevisions.some(row => !row || typeof row !== 'object' || Array.isArray(row)) || new Set(state.sourceRevisions.map(row => row.id)).size !== state.sourceRevisions.length || new TextEncoder().encode(JSON.stringify(state.sourceRevisions)).length > REVISION_LIMITS.bytes) throw new IntegrityError('Invalid, duplicate or oversized source revision history.');
  for (const row of state.sourceRevisions) await validateRow(row, state);
  for (const rows of groups(state.sourceRevisions).values()) chain(rows);
}
export function createRevisions({ db, ready = async () => {}, notify = () => {}, recoveryRecord }) {
  async function snapshot() {
    await ready(); return db.run(['meta', 'captures', 'quarantine', REVISION_TABLE], 'readonly', async tx => ({ epoch: await meta(tx, 'epoch'), captures: await request(tx.objectStore('captures').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()), sourceRevisions: await request(tx.objectStore(REVISION_TABLE).getAll()) }));
  }
  async function repair() {
    const state = await snapshot(), bad = [];
    for (const rows of groups(state.sourceRevisions).values()) {
      try { for (const row of rows) await validateRow(row, state); chain(rows); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; for (const row of rows) bad.push({ row, reason: error.message }); }
    }
    if (!bad.length) return;
    if (!recoveryRecord) throw new IntegrityError('Source revisions need recovery.');
    for (const item of bad) item.recovery = await recoveryRecord(REVISION_TABLE, String(item.row?.id ?? 'unknown').slice(0, 128), JSON.stringify(item.row), item.reason);
    await db.run(['meta', 'captures', 'quarantine', REVISION_TABLE], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) return;
      for (const [table, expected] of [['captures', state.captures], ['quarantine', state.recovery], [REVISION_TABLE, state.sourceRevisions]]) if (!same(await request(tx.objectStore(table).getAll()), expected)) return;
      for (const item of bad) { await request(tx.objectStore('quarantine').put(item.recovery)); await request(tx.objectStore(REVISION_TABLE).delete(item.row.id)); }
    }); notify();
  }
  async function revise(input, { requestId, expectedEpoch, expectedEffectiveId } = {}) {
    if (!exactKeys(input, ['captureId', 'captureHash', 'kind', 'text', 'expectedLatestId', 'acknowledgedRecovery']) || !validId(input.captureId) || !validHash(input.captureHash) || !kinds.includes(input.kind) || !textAllowed(input.text) || !(input.expectedLatestId === null || validId(input.expectedLatestId)) || !Array.isArray(input.acknowledgedRecovery) || input.acknowledgedRecovery.some(id => !validHash(id)) || new Set(input.acknowledgedRecovery).size !== input.acknowledgedRecovery.length || requestId !== undefined && !validId(requestId) || expectedEffectiveId !== undefined && expectedEffectiveId !== null && !validId(expectedEffectiveId)) throw Error('Check the exact source, revision kind and nonblank writing.');
    input = structuredClone(input); input.acknowledgedRecovery.sort();
    const state = await snapshot(); await validateRevisionState(state);
    if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Reopen the correction with your writing kept.');
    const current = sourceRevisionState(state, input.captureId), source = current.source;
    if (!source || source.hash !== input.captureHash) throw Error('The original source needs recovery before saving another revision.');
    await validateCapture(source);
    const { expectedLatestId, ...content } = input;
    const id = requestId ? await stableId(JSON.stringify([REVISION_TABLE, requestId])) : crypto.randomUUID();
    const matches = row => row.previousId === expectedLatestId && Object.entries(content).every(([key, value]) => same(row[key], value));
    const prior = state.sourceRevisions.find(row => row.id === id);
    if (prior && !matches(prior)) throw Error('This request ID belongs to different source writing.');
    const existing = prior ?? state.sourceRevisions.find(matches);
    if (!existing) {
      if ((current[`${input.kind}History`].at(-1)?.id ?? null) !== expectedLatestId || expectedEffectiveId !== undefined && (current.effective?.id ?? null) !== expectedEffectiveId) throw Error('The source projection changed in another tab. Review the current base before saving.');
      const required = current[`${input.kind}Recovery`].map(entry => entry.id).sort();
      if (!same(required, input.acknowledgedRecovery)) throw Error('Review and explicitly acknowledge the current raw recovery before saving a replacement revision.');
    }
    const record = existing ?? await seal({ id, ...content, previousId: expectedLatestId, at: new Date().toISOString() });
    if (!existing) await validateRevisionState({ ...state, sourceRevisions: [...state.sourceRevisions, record] });
    const saved = await db.run(['meta', 'captures', 'quarantine', REVISION_TABLE], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Your writing is kept.');
      for (const [table, expected] of [['captures', state.captures], ['quarantine', state.recovery]]) if (!same(await request(tx.objectStore(table).getAll()), expected)) throw Error('Source evidence changed. Review the current base.');
      const all = await request(tx.objectStore(REVISION_TABLE).getAll()), retry = all.find(row => row.id === id) ?? all.find(matches);
      if (retry) { if (!matches(retry)) throw Error('This revision request conflicts.'); return retry; }
      if (existing || !same(all, state.sourceRevisions)) throw Error('Source revisions changed in another tab. Your writing is kept.');
      await request(tx.objectStore(REVISION_TABLE).add(record)); return record;
    });
    try { const actual = await db.run([REVISION_TABLE], 'readonly', tx => request(tx.objectStore(REVISION_TABLE).get(saved.id))); if (!same(actual, saved)) throw Error('The revision differs from its readback.'); await validateRow(actual, state); notify(); return actual; }
    catch (error) { notify(); throw Error(`The source revision could not be verified: ${error.message} Keep your writing and retry.`); }
  }
  return { repair, revise };
}
