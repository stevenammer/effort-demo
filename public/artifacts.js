import { request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, stableId, same, IntegrityError } from './primitives.js';
import { validateCapture } from './records.js';

export const ARTIFACT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, records: 500, previewCharacters: 4000 });
const keys = ['id', 'captureId', 'name', 'mime', 'data', 'bytes', 'contentHash', 'at'];
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
const nameValid = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f/\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const mimeValid = value => typeof value === 'string' && value.length <= 127 && /^(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?$/.test(value);
export const sameArtifactFile = (left, right) => ['captureId', 'name', 'mime', 'data', 'bytes', 'contentHash'].every(key => left?.[key] === right?.[key]);
const byReceipt = (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
const encodedSize = rows => new TextEncoder().encode(JSON.stringify(rows)).length;
async function digestBytes(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function encode(bytes) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function artifactBytes(record) {
  if (typeof record?.data !== 'string' || record.data.length > Math.ceil(ARTIFACT_LIMITS.fileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)) throw new IntegrityError('The attachment bytes have invalid encoding.');
  let raw; try { raw = atob(record.data); } catch { throw new IntegrityError('The attachment bytes have invalid encoding.'); }
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (encode(bytes) !== record.data) throw new IntegrityError('The attachment bytes have invalid encoding.');
  return bytes;
}
export function artifactPreview(record) {
  if (record.mime !== 'text/plain') return null;
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(artifactBytes(record)); } catch { return null; }
  const points = Array.from(text), limit = ARTIFACT_LIMITS.previewCharacters;
  return { text: points.slice(0, limit).join(''), truncated: points.length > limit };
}
export function artifactSourceStatus(record, { captures, recovery }) {
  if (captures.some(c => c.id === record.captureId)) return 'verified';
  if (recovery.some(r => r.source === 'capture' && r.recordId === record.captureId)) return 'recovery';
  throw new IntegrityError('An attachment is missing its source post.');
}
export async function validateArtifact(record, state) {
  if (!exactKeys(record, [...keys, 'hash']) || !validId(record.id) || !validId(record.captureId) || !nameValid(record.name) || !mimeValid(record.mime) || !Number.isInteger(record.bytes) || record.bytes < 0 || record.bytes > ARTIFACT_LIMITS.fileBytes || !validHash(record.contentHash) || !validDate(record.at) || !validHash(record.hash)) throw new IntegrityError('An attachment has an invalid format.');
  const payload = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hash'));
  if (await sha256(JSON.stringify(payload)) !== record.hash) throw new IntegrityError('An attachment metadata checksum does not match.');
  const bytes = artifactBytes(record);
  if (bytes.length !== record.bytes || await digestBytes(bytes) !== record.contentHash) throw new IntegrityError('An attachment byte checksum does not match.');
  return artifactSourceStatus(record, state);
}
export async function validateArtifactState(state) {
  if (!Array.isArray(state.artifacts) || !Array.isArray(state.captures) || !Array.isArray(state.recovery) || state.artifacts.length > ARTIFACT_LIMITS.records || state.artifacts.some(row => !row || typeof row !== 'object' || Array.isArray(row)) || new Set(state.artifacts.map(r => r?.id)).size !== state.artifacts.length || encodedSize(state.artifacts) > ARTIFACT_LIMITS.totalBytes) throw new IntegrityError('Invalid, duplicate or oversized attachments.');
  const sources = new Map(state.captures.map(row => [row.id, row])), verified = new Set();
  for (const row of state.artifacts) { if (sources.has(row.captureId) && !verified.has(row.captureId)) { await validateCapture(sources.get(row.captureId)); verified.add(row.captureId); } await validateArtifact(row, state); }
}
export function createArtifacts({ db, ready = async () => {}, notify = () => {}, recoveryRecord }) {
  async function snapshot() {
    await ready(); return db.run(['meta', 'captures', 'quarantine', 'artifacts'], 'readonly', async tx => ({ epoch: await meta(tx, 'epoch'), captures: await request(tx.objectStore('captures').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()), artifacts: await request(tx.objectStore('artifacts').getAll()) }));
  }
  async function repair() {
    const state = await snapshot(), bad = [];
    for (const row of state.artifacts) {
      try { await validateArtifact(row, state); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; bad.push({ row, reason: error.message }); }
    }
    if (!bad.length) return;
    if (!recoveryRecord) throw new IntegrityError('Damaged attachments need recovery.');
    for (const item of bad) item.recovery = await recoveryRecord('artifacts', String(item.row?.id ?? 'unknown').slice(0, 128), JSON.stringify(item.row), item.reason);
    await db.run(['meta', 'captures', 'quarantine', 'artifacts'], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) return;
      for (const [table, expected] of [['captures', state.captures], ['quarantine', state.recovery], ['artifacts', state.artifacts]]) if (!same(await request(tx.objectStore(table).getAll()), expected)) return;
      for (const item of bad) { await request(tx.objectStore('quarantine').put(item.recovery)); await request(tx.objectStore('artifacts').delete(item.row.id)); }
    });
    notify();
  }
  async function attach({ captureId, name, mime, bytes }, { expectedEpoch } = {}) {
    if (!validId(captureId) || !nameValid(name) || !mimeValid(mime) || !(bytes instanceof Uint8Array) || bytes.length > ARTIFACT_LIMITS.fileBytes) throw Error('Choose a file up to 2 MiB with a valid name and type.');
    // Copy immediately, before any await, so the caller cannot change the selected bytes in flight.
    bytes = bytes.slice();
    await repair();
    const state = await snapshot();
    if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Reopen the post before attaching a file.');
    const source = state.captures.find(c => c.id === captureId); if (!source) throw Error('The source post needs recovery before attaching a file.');
    await validateCapture(source);
    const contentHash = await digestBytes(bytes), data = encode(bytes);
    const matches = row => row.captureId === captureId && row.name === name && row.mime === mime && row.bytes === bytes.length && row.contentHash === contentHash && row.data === data;
    const prior = state.artifacts.filter(matches).sort(byReceipt);
    for (const row of prior) await validateArtifact(row, state);
    const id = prior[0]?.id ?? await stableId(JSON.stringify(['artifact', state.epoch ?? null, captureId, name, mime, contentHash]));
    const payload = { id, captureId, name, mime, data, bytes: bytes.length, contentHash, at: new Date().toISOString() }, record = { ...payload, hash: await sha256(JSON.stringify(payload)) };
    const inserted = await db.run(['meta', 'captures', 'artifacts'], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Reopen the post before attaching a file.');
      if (!same(await request(tx.objectStore('captures').get(captureId)), source)) throw Error('The source post changed. Reopen it before attaching a file.');
      const table = tx.objectStore('artifacts'), all = await request(table.getAll()), existing = all.filter(matches).sort(byReceipt);
      if (existing.length) return existing[0];
      if (all.some(row => row.id === id)) throw Error('An attachment ID belongs to different bytes. Nothing was changed.');
      if (all.length >= ARTIFACT_LIMITS.records || encodedSize([...all, record]) > ARTIFACT_LIMITS.totalBytes) throw Error('Attachment storage reached its portable limit.');
      await request(table.add(record)); await request(tx.objectStore('meta').put({ key: 'initialized', value: true })); return record;
    });
    try {
      const actual = await db.run(['artifacts'], 'readonly', tx => request(tx.objectStore('artifacts').get(inserted.id)));
      if (!same(actual, inserted) || !matches(actual)) throw Error('The saved attachment differs from its readback.');
      await validateArtifact(actual, state); notify(); return actual;
    } catch (error) { notify(); throw Error(`The attachment could not be read back exactly: ${error.message} Keep the original file and retry.`); }
  }
  return { attach, repair };
}
