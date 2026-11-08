export const KEY = 'effort-public-demo-v1';
export const LIMITS = Object.freeze({ captures: 1000, text: 4000, total: 2000000, backupBytes: 32000000, recoveryBytes: 8000000 });
export const SPANS = Object.freeze(['Product demo', 'Learning', 'Unsorted']);
export const clone = value => structuredClone(value);
export const blank = () => ({ version: 2, kind: 'effort-browser-demo', captures: [], now: null, recovery: [] });
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...keys].sort().join(',');
export const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export class IntegrityError extends Error {}
export async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function textAllowed(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= LIMITS.text &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}
export async function validateCapture(c) {
  if (!exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample']) || !validId(c.id) || !textAllowed(c.text) ||
      !validHash(c.hash) || !SPANS.includes(c.span) || typeof c.sample !== 'boolean' || !validDate(c.createdAt)) {
    throw new IntegrityError('The saved record has an invalid capture format.');
  }
  if (await sha256(c.text) !== c.hash) throw new IntegrityError('The original text could not be verified.');
  return c;
}
export function validChoice(choice, captures) {
  if (!exactKeys(choice, ['captureId', 'start', 'end', 'quote', 'origin'])) return false;
  const source = captures.find(c => c.id === choice.captureId);
  return !!source && Number.isInteger(choice.start) && Number.isInteger(choice.end) && choice.start >= 0 &&
    choice.end > choice.start && choice.end <= source.text.length && typeof choice.quote === 'string' &&
    source.text.slice(choice.start, choice.end) === choice.quote && ['sample', 'chosen'].includes(choice.origin);
}
export async function recoveryRecord(source, recordId, raw, reason) {
  return { id: await sha256(`${source}\n${recordId}\n${raw}`), source, recordId, raw, reason, at: new Date().toISOString() };
}
export async function validateRecovery(r) {
  if (!exactKeys(r, ['id', 'source', 'recordId', 'raw', 'reason', 'at']) || !validHash(r.id) ||
      !['legacy-state', 'capture', 'now'].includes(r.source) || typeof r.recordId !== 'string' || r.recordId.length > 128 ||
      typeof r.raw !== 'string' || new TextEncoder().encode(r.raw).length > LIMITS.recoveryBytes ||
      typeof r.reason !== 'string' || r.reason.length > 500 || !validDate(r.at) ||
      (await recoveryRecord(r.source, r.recordId, r.raw, r.reason)).id !== r.id) {
    throw Error('The backup contains an invalid recovery record. Nothing was changed.');
  }
}
export async function validateState(state) {
  const v1 = state?.version === 1;
  if (!exactKeys(state, v1 ? ['version', 'kind', 'captures', 'now'] : ['version', 'kind', 'captures', 'now', 'recovery']) ||
      ![1, 2].includes(state.version) || state.kind !== 'effort-browser-demo' || !Array.isArray(state.captures) || state.captures.length > LIMITS.captures) {
    throw Error('This is not a supported EFFORT browser-demo backup.');
  }
  const ids = new Set(); let bytes = 0;
  for (const c of state.captures) {
    await validateCapture(c);
    if (ids.has(c.id)) throw Error('The backup contains duplicate capture IDs. Nothing was changed.');
    ids.add(c.id); bytes += c.text.length;
  }
  if (bytes > LIMITS.total) throw Error('The backup exceeds the safe capture limit.');
  if (state.now !== null && !validChoice(state.now, state.captures)) throw Error('The next step does not match its original text.');
  if (!v1) {
    if (!Array.isArray(state.recovery) || state.recovery.length > LIMITS.captures + 100) throw Error('Too many recovery records.');
    const ids = new Set();
    for (const r of state.recovery) { await validateRecovery(r); if (ids.has(r.id)) throw Error('Duplicate recovery record.'); ids.add(r.id); }
  }
  return v1 ? { ...state, version: 2, recovery: [] } : state;
}
