import { validChoice } from './choices.js';
export { validChoice } from './choices.js';
import { legacyIntent, validateIntentState } from './intent.js';
import { validSpanName, validSpan, initialSpans, spanKey, validateThreadLinks } from './spans.js';
export const KEY = 'effort-public-demo-v1';
export const LIMITS = Object.freeze({ captures: 1000, text: 4000, total: 2000000, backupBytes: 32000000, recoveryBytes: 8000000 });
export const SPANS = Object.freeze(['Product demo', 'Learning', 'Unsorted']);
import { clone, same, exactKeys, validDate, validHash, validId, IntegrityError, sha256 } from './primitives.js';
export { clone, same, exactKeys, validDate, validHash, validId, IntegrityError, sha256 } from './primitives.js';
export const blank = () => ({ version: 4, kind: 'effort-browser-demo', captures: [], now: null, recovery: [], spans: initialSpans(), intentEvents: [], places: [], resumptions: [] });
export function textAllowed(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= LIMITS.text &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}
export async function validateCapture(c) {
  if (!(exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample']) || exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample', 'parentId'])) || !validId(c.id) || !textAllowed(c.text) ||
      !validHash(c.hash) || !validSpanName(c.span) || (c.parentId !== undefined && (!validId(c.parentId) || c.parentId === c.id)) || typeof c.sample !== 'boolean' || !validDate(c.createdAt)) {
    throw new IntegrityError('The saved record has an invalid capture format.');
  }
  if (await sha256(c.text) !== c.hash) throw new IntegrityError('The original text could not be verified.');
  return c;
}
export async function recoveryRecord(source, recordId, raw, reason) {
  return { id: await sha256(`${source}\n${recordId}\n${raw}`), source, recordId, raw, reason, at: new Date().toISOString() };
}
export async function validateRecovery(r) {
  if (!exactKeys(r, ['id', 'source', 'recordId', 'raw', 'reason', 'at']) || !validHash(r.id) ||
      !['legacy-state', 'capture', 'now', 'span', 'intentEvents', 'places', 'resumptions'].includes(r.source) || typeof r.recordId !== 'string' || r.recordId.length > 128 ||
      typeof r.raw !== 'string' || new TextEncoder().encode(r.raw).length > LIMITS.recoveryBytes ||
      typeof r.reason !== 'string' || r.reason.length > 500 || !validDate(r.at) ||
      (await recoveryRecord(r.source, r.recordId, r.raw, r.reason)).id !== r.id) {
    throw Error('The backup contains an invalid recovery record. Nothing was changed.');
  }
}
export async function validateState(state) {
  const v1 = state?.version === 1, v3 = state?.version >= 3, v4 = state?.version === 4;
  if (!exactKeys(state, v1 ? ['version', 'kind', 'captures', 'now'] : v4 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions'] : v3 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans'] : ['version', 'kind', 'captures', 'now', 'recovery']) ||
      ![1, 2, 3, 4].includes(state.version) || state.kind !== 'effort-browser-demo' || !Array.isArray(state.captures) || state.captures.length > LIMITS.captures) {
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
    if (!Array.isArray(state.recovery) || state.recovery.length > 30000) throw Error('Too many recovery records.');
    const ids = new Set();
    for (const r of state.recovery) { await validateRecovery(r); if (ids.has(r.id)) throw Error('Duplicate recovery record.'); ids.add(r.id); }
  }
  const recovery = v1 ? [] : state.recovery;
  const spans = v3 ? state.spans : initialSpans(state.captures);
  if (!Array.isArray(spans) || spans.length > 100 || spans.some(span => !validSpan(span)) || new Set(spans.map(span => span.id)).size !== spans.length) throw Error('The backup contains an invalid Attention Span directory.');
  if (state.captures.some(c => !spans.some(span => span.id === spanKey(c.span)))) throw Error('A saved post is missing its Attention Span.');
  validateThreadLinks(state.captures, recovery);
  const result = { ...state, version: 4, recovery, spans, intentEvents: v4 ? state.intentEvents : await legacyIntent(state.now), places: v4 ? state.places : [], resumptions: v4 ? state.resumptions : [] };
  await validateIntentState(result); return result;
}
