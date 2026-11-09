import { revisionProposalId } from './revision-proposals.js';
import { validateRevisionState } from './revisions.js';
import { validatePeopleState } from './people.js';
import { validateOpenedState } from './opened.js';
import { validateThinkingState } from './thinking.js';
import { validateArtifactState } from './artifacts.js';
import { validateExplorationState, validateProposalProvenance } from './exploration.js';
import { validateDraft, DRAFT_LIMITS } from './drafts.js';
import { KEY, LIMITS, SPANS } from './constants.js';
export { KEY, LIMITS, SPANS } from './constants.js';
import { validChoice } from './choices.js';
export { validChoice } from './choices.js';
import { legacyIntent, validateIntentState } from './intent.js';
import { validSpanName, validSpan, initialSpans, spanKey, validateThreadLinks } from './spans.js';
import { clone, same, exactKeys, validDate, validHash, validId, IntegrityError, sha256 } from './primitives.js';
export { clone, same, exactKeys, validDate, validHash, validId, IntegrityError, sha256 } from './primitives.js';
export const blank = () => ({ version: 13, kind: 'effort-browser-demo', captures: [], now: null, recovery: [], spans: initialSpans(), intentEvents: [], places: [], resumptions: [], drafts: [], explorations: [], distillations: [], artifacts: [], branchEvents: [], moveEvents: [], openedReceipts: [], personEvents: [], contactReceipts: [], sourceRevisions: [] });
export function textAllowed(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= LIMITS.text &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}
export async function validateCapture(c) {
  if (!(exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample']) || exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample', 'parentId']) || exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample', 'parentId', 'derivedFromId', 'derivedHash']) || exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample', 'parentId', 'sourceRevisionId', 'sourceRevisionHash', 'derivedHash'])) || !validId(c.id) || !textAllowed(c.text) ||
      !validHash(c.hash) || !validSpanName(c.span) || (c.parentId !== undefined && (!validId(c.parentId) || c.parentId === c.id)) || (c.derivedFromId !== undefined && (!validId(c.derivedFromId) || !validId(c.parentId) || c.sample !== false)) || typeof c.sample !== 'boolean' || !validDate(c.createdAt)) {
    throw new IntegrityError('The saved record has an invalid capture format.');
  }
  if (await sha256(c.text) !== c.hash) throw new IntegrityError('The original text could not be verified.');
  if (c.sourceRevisionId !== undefined && (!validId(c.sourceRevisionId) || !validHash(c.sourceRevisionHash) || !validId(c.parentId) || c.sample !== false || await revisionProposalId(c.sourceRevisionId,c.sourceRevisionHash) !== c.id)) throw new IntegrityError('The exact revision proposal identity could not be verified.');
  if ((c.derivedFromId || c.sourceRevisionId) && (!validHash(c.derivedHash) || await sha256(JSON.stringify(Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'derivedHash')))) !== c.derivedHash)) throw new IntegrityError('The proposal metadata could not be verified.');
  return c;
}
export async function recoveryRecord(source, recordId, raw, reason) {
  return { id: await sha256(`${source}\n${recordId}\n${raw}`), source, recordId, raw, reason, at: new Date().toISOString() };
}
export async function validateRecovery(r) {
  if (!exactKeys(r, ['id', 'source', 'recordId', 'raw', 'reason', 'at']) || !validHash(r.id) ||
      !['legacy-state', 'capture', 'now', 'span', 'intentEvents', 'places', 'resumptions', 'draft', 'explorations', 'distillations', 'derivation', 'artifacts', 'branchEvents', 'moveEvents', 'openedReceipts', 'personEvents', 'contactReceipts', 'sourceRevisions'].includes(r.source) || typeof r.recordId !== 'string' || r.recordId.length > 128 ||
      typeof r.raw !== 'string' || new TextEncoder().encode(r.raw).length > LIMITS.recoveryBytes ||
      typeof r.reason !== 'string' || r.reason.length > 500 || !validDate(r.at) ||
      (await recoveryRecord(r.source, r.recordId, r.raw, r.reason)).id !== r.id) {
    throw Error('The backup contains an invalid recovery record. Nothing was changed.');
  }
}
export async function validateState(state) {
  const v1 = state?.version === 1, v3 = state?.version >= 3, v4 = state?.version >= 4, v5 = state?.version >= 5, v6 = state?.version >= 6, v8 = state?.version >= 8, v9 = state?.version >= 9, v10 = state?.version >= 10, v11 = state?.version >= 11, v12 = state?.version >= 12;
  if (!exactKeys(state, v1 ? ['version', 'kind', 'captures', 'now'] : v12 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts', 'explorations', 'distillations', 'artifacts', 'branchEvents', 'moveEvents', 'openedReceipts', 'personEvents', 'contactReceipts', 'sourceRevisions'] : v11 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts', 'explorations', 'distillations', 'artifacts', 'branchEvents', 'moveEvents', 'openedReceipts', 'personEvents', 'contactReceipts'] : v10 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts', 'explorations', 'distillations', 'artifacts', 'branchEvents', 'moveEvents', 'openedReceipts'] : v9 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts', 'explorations', 'distillations', 'artifacts', 'branchEvents', 'moveEvents'] : v8 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts', 'explorations', 'distillations', 'artifacts'] : v6 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts', 'explorations', 'distillations'] : v5 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions', 'drafts'] : v4 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans', 'intentEvents', 'places', 'resumptions'] : v3 ? ['version', 'kind', 'captures', 'now', 'recovery', 'spans'] : ['version', 'kind', 'captures', 'now', 'recovery']) ||
      ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(state.version) || state.kind !== 'effort-browser-demo' || !Array.isArray(state.captures) || state.captures.length > LIMITS.captures) {
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
  const result = { ...state, version: 13, recovery, spans, intentEvents: v4 ? state.intentEvents : await legacyIntent(state.now), places: v4 ? state.places : [], resumptions: v4 ? state.resumptions : [], drafts: v5 ? state.drafts : [], explorations: v6 ? state.explorations : [], distillations: v6 ? state.distillations : [], artifacts: v8 ? state.artifacts : [], branchEvents: v9 ? state.branchEvents : [], moveEvents: v9 ? state.moveEvents : [], openedReceipts: v10 ? state.openedReceipts : [], personEvents: v11 ? state.personEvents : [], contactReceipts: v11 ? state.contactReceipts : [], sourceRevisions: v12 ? state.sourceRevisions : [] };
  if (!Array.isArray(result.drafts) || result.drafts.length > DRAFT_LIMITS.records || new Set(result.drafts.map(row => row?.key)).size !== result.drafts.length || JSON.stringify(result.drafts).length > DRAFT_LIMITS.total) throw Error('Invalid or oversized draft backup.');
  for (const draft of result.drafts) await validateDraft(draft);
  await validateIntentState(result); await validateExplorationState(result); await validateThinkingState(result); await validateOpenedState(result); await validatePeopleState(result); await validateRevisionState(result); await validateArtifactState(result); for (const capture of result.captures) await validateProposalProvenance(capture, result); return result;
}
