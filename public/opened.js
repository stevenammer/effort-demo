import { request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, stableId, same, IntegrityError } from './primitives.js';
import { validateCapture } from './records.js';

export const OPENED_TABLE = 'openedReceipts';
export const OPENED_LIMITS = Object.freeze({ records: 10000, bytes: 2 * 1024 * 1024 });
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
const receiptId = (captureId, captureHash) => stableId(JSON.stringify(['opened', captureId, captureHash]));
export const sameOpenedSource = (a, b) => !!a && !!b && a.id === b.id && a.captureId === b.captureId && a.captureHash === b.captureHash;
async function validateReceipt(row, state) {
  if (!exactKeys(row, ['id', 'captureId', 'captureHash', 'at', 'hash']) || !validId(row.id) || !validId(row.captureId) || !validHash(row.captureHash) || !validDate(row.at) || !validHash(row.hash)) throw new IntegrityError('An opened receipt has an invalid format.');
  const payload = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'hash'));
  if (await sha256(JSON.stringify(payload)) !== row.hash || await receiptId(row.captureId, row.captureHash) !== row.id) throw new IntegrityError('An opened receipt checksum does not match.');
  const capture = state.captures.find(c => c.id === row.captureId);
  if (capture) { await validateCapture(capture); if (capture.hash !== row.captureHash) throw new IntegrityError('An opened receipt no longer matches its source.'); }
  else if (!state.recovery.some(r => r.source === 'capture' && r.recordId === row.captureId)) throw new IntegrityError('An opened receipt is missing its source.');
}
export async function validateOpenedState(state) {
  if (!Array.isArray(state.openedReceipts) || !Array.isArray(state.captures) || !Array.isArray(state.recovery) || state.openedReceipts.length > OPENED_LIMITS.records || state.openedReceipts.some(r => !r || typeof r !== 'object' || Array.isArray(r)) || new Set(state.openedReceipts.map(r => r.id)).size !== state.openedReceipts.length || new TextEncoder().encode(JSON.stringify(state.openedReceipts)).length > OPENED_LIMITS.bytes) throw new IntegrityError('Invalid, duplicate or oversized opened receipts.');
  for (const row of state.openedReceipts) await validateReceipt(row, state);
}
export function deriveOpened({ openedReceipts, captures, recovery }) {
  const byId = new Map(captures.map(c => [c.id, c]));
  const opened = new Set(openedReceipts.filter(r => byId.get(r.captureId)?.hash === r.captureHash).map(r => r.captureId)), unknown = new Set();
  for (const entry of recovery) {
    if (entry.source !== OPENED_TABLE) continue;
    try { const row = JSON.parse(entry.raw); if (validId(row?.captureId) && byId.has(row.captureId) && !opened.has(row.captureId)) unknown.add(row.captureId); } catch {}
  }
  return { opened, unknown };
}
export function createOpened({ db, ready = async () => {}, notify = () => {}, recoveryRecord }) {
  async function snapshot() {
    await ready(); return db.run(['meta', 'captures', 'quarantine', OPENED_TABLE], 'readonly', async tx => ({ epoch: await meta(tx, 'epoch'), captures: await request(tx.objectStore('captures').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()), openedReceipts: await request(tx.objectStore(OPENED_TABLE).getAll()) }));
  }
  async function repair() {
    const state = await snapshot(), bad = [];
    for (const row of state.openedReceipts) {
      try { await validateReceipt(row, state); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; bad.push({ row, reason: error.message }); }
    }
    if (!bad.length) return;
    if (!recoveryRecord) throw new IntegrityError('Opened receipts need recovery.');
    for (const item of bad) item.recovery = await recoveryRecord(OPENED_TABLE, String(item.row?.id ?? 'unknown').slice(0, 128), JSON.stringify(item.row), item.reason);
    await db.run(['meta', 'captures', 'quarantine', OPENED_TABLE], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) return;
      for (const [table, rows] of [['captures', state.captures], ['quarantine', state.recovery], [OPENED_TABLE, state.openedReceipts]]) if (!same(await request(tx.objectStore(table).getAll()), rows)) return;
      for (const item of bad) { await request(tx.objectStore('quarantine').put(item.recovery)); await request(tx.objectStore(OPENED_TABLE).delete(item.row.id)); }
    }); notify();
  }
  async function markOpened({ items }, { expectedEpoch } = {}) {
    if (!Array.isArray(items) || items.length > OPENED_LIMITS.records || items.some(item => !exactKeys(item, ['id', 'hash']) || !validId(item.id) || !validHash(item.hash)) || new Set(items.map(item => item.id)).size !== items.length) throw Error('The opened post list is invalid.');
    items = items.map(({ id, hash }) => ({ id, hash }));
    const state = await snapshot();
    if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Reopen the posts before marking them opened.');
    await validateOpenedState(state);
    const sources = items.map(item => state.captures.find(c => c.id === item.id));
    for (let i = 0; i < items.length; i++) { if (!sources[i]) throw Error('A source post needs recovery before marking it opened.'); await validateCapture(sources[i]); if (sources[i].hash !== items[i].hash) throw Error('A source post changed. Reopen it before marking it opened.'); }
    const proposed = await Promise.all(items.map(async item => {
      const payload = { id: await receiptId(item.id, item.hash), captureId: item.id, captureHash: item.hash, at: new Date().toISOString() };
      return { ...payload, hash: await sha256(JSON.stringify(payload)) };
    }));
    const inserted = await db.run(['meta', 'captures', OPENED_TABLE], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Reopen the posts before marking them opened.');
      for (const source of sources) if (!same(await request(tx.objectStore('captures').get(source.id)), source)) throw Error('A source post changed. Reopen it before marking it opened.');
      const table = tx.objectStore(OPENED_TABLE), all = await request(table.getAll()), result = [], additions = [];
      for (const row of proposed) {
        const existing = all.find(old => old.id === row.id);
        if (existing && !sameOpenedSource(existing, row)) throw Error('An opened receipt ID conflicts. Nothing was changed.');
        result.push(existing ?? row); if (!existing) additions.push(row);
      }
      if (all.length + additions.length > OPENED_LIMITS.records || new TextEncoder().encode(JSON.stringify([...all, ...additions])).length > OPENED_LIMITS.bytes) throw Error('Opened history reached its portable limit.');
      for (const row of additions) await request(table.add(row)); return result;
    });
    try {
      const actual = await db.run([OPENED_TABLE], 'readonly', tx => Promise.all(inserted.map(row => request(tx.objectStore(OPENED_TABLE).get(row.id)))));
      for (let i = 0; i < actual.length; i++) { if (!same(actual[i], inserted[i])) throw Error('A receipt differs from its readback.'); await validateReceipt(actual[i], state); }
      notify(); return actual;
    } catch (error) { notify(); throw Error(`Opened receipts could not be verified: ${error.message} Reopen the posts and retry.`); }
  }
  return { repair, markOpened };
}
