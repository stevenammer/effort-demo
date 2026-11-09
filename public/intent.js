import { spanKey } from './spans.js';
import { exactKeys, validId, validDate, validHash, sha256, IntegrityError, same } from './primitives.js';
import { choiceShape, validChoice, sourceKey } from './choices.js';
export const INTENT_TABLES = Object.freeze(['intentEvents', 'places', 'resumptions']);
export const INTENT_LIMIT = 10000;
export const STATES = Object.freeze(['COMMITTED', 'ACTIVE', 'COMPLETE', 'DROPPED']);
const transitions = { COMMITTED: ['ACTIVE', 'COMPLETE', 'DROPPED'], ACTIVE: ['ACTIVE', 'COMMITTED', 'COMPLETE', 'DROPPED'], COMPLETE: [], DROPPED: [] };
export const noteAllowed = (value, required = false) => typeof value === 'string' && value.length <= 4000 && (!required || value.trim().length > 0) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
export async function seal(record) { return { ...record, hash: await sha256(JSON.stringify(record)) }; }
async function checkSeal(record, keys) {
  if (!exactKeys(record, [...keys, 'hash']) || !validHash(record.hash)) throw new IntegrityError('A continuity record has an invalid format.');
  const payload = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'hash'));
  if (await sha256(JSON.stringify(payload)) !== record.hash) throw new IntegrityError('A continuity record checksum does not match.');
}
export function sourceIsKnown(choice, captures, recovery) {
  if (!choiceShape(choice)) return false;
  return captures.some(c => c.id === choice.captureId) ? validChoice(choice, captures) : recovery.some(r => r.source === 'capture' && r.recordId === choice.captureId);
}
export async function validateEvent(event, captures, recovery) {
  await checkSeal(event, ['id', 'commitmentId', 'previousId', 'state', 'choice', 'at', 'note', 'receipt']);
  if (!validId(event.id) || !validId(event.commitmentId) || !(event.previousId === null || validId(event.previousId)) ||
      !STATES.includes(event.state) || !validDate(event.at) || !noteAllowed(event.note, ['COMPLETE', 'DROPPED'].includes(event.state)) ||
      event.receipt !== (event.state === 'COMPLETE' ? 'self-report' : null) || !sourceIsKnown(event.choice, captures, recovery)) {
    throw new IntegrityError('A commitment or receipt no longer matches its saved source.');
  }
}
export function deriveCommitment(events) {
  const ids = new Map(events.map(event => [event.id, event])), roots = events.filter(e => e.previousId === null);
  if (!events.length || ids.size !== events.length || roots.length !== 1 || !['COMMITTED', 'ACTIVE'].includes(roots[0].state)) throw new IntegrityError('The commitment history has no unique promotion.');
  const root = roots[0], next = new Map();
  for (const event of events) {
    if (event.commitmentId !== root.commitmentId || sourceKey(event.choice) !== sourceKey(root.choice) || event.choice.quote !== root.choice.quote) throw new IntegrityError('A commitment history changes its original source.');
    if (event.previousId !== null) {
      const parent = ids.get(event.previousId);
      if (!parent || next.has(parent.id) || !transitions[parent.state]?.includes(event.state)) throw new IntegrityError('The commitment history conflicts or skips a transition.');
      next.set(parent.id, event);
    }
  }
  let latest = root, count = 1; const history = [root];
  while (next.has(latest.id)) { latest = next.get(latest.id); history.push(latest); if (++count > events.length) throw new IntegrityError('The commitment history contains a cycle.'); }
  if (count !== events.length) throw new IntegrityError('The commitment history is disconnected.');
  return { id: root.commitmentId, state: latest.state, choice: latest.choice, createdAt: root.at, updatedAt: latest.at, latestId: latest.id, history, receipt: latest.receipt === 'self-report' ? latest : null };
}
export function commitmentGroups(events) {
  const groups = new Map(); for (const event of events) { const group = groups.get(event.commitmentId) ?? []; group.push(event); groups.set(event.commitmentId, group); }
  return groups;
}
export function deriveCommitments(events) { return [...commitmentGroups(events).values()].map(deriveCommitment); }
export function validRoute(route) {
  if (['home', 'spans', 'fort', 'engine'].includes(route)) return true;
  if (/^fort\//.test(route)) return validId(route.slice(5));
  if (/^person\//.test(route)) return validId(route.slice(7));
  if (/^branch\//.test(route)) return validId(route.slice(7));
  if (/^artifact\//.test(route)) return validId(route.slice(9));
  if (/^thread\//.test(route)) return validId(route.slice(7));
  if (/^span\//.test(route)) { try { const encoded = route.slice(5), name = decodeURIComponent(encoded); return name === spanKey(name) && name.length >= 2 && name.length <= 40 && !/[\p{C}]/u.test(name) && encodeURIComponent(name) === encoded; } catch {} }
  return false;
}
export function validContext(context) {
  return exactKeys(context, ['scrollY', 'spanSearch', 'sourceExpanded']) && Number.isFinite(context.scrollY) && context.scrollY >= 0 && context.scrollY <= 10000000 && typeof context.spanSearch === 'string' && context.spanSearch.length <= 100 && typeof context.sourceExpanded === 'boolean';
}
export async function validatePlace(place, captures, recovery) {
  await checkSeal(place, ['id', 'commitmentId', 'choice', 'summary', 'nextAction', 'route', 'context', 'at']);
  if (!validId(place.id) || !(place.commitmentId === null || validId(place.commitmentId)) || !validDate(place.at) ||
      !validContext(place.context) || !noteAllowed(place.summary, true) || !noteAllowed(place.nextAction) || !validRoute(place.route) ||
      !(place.choice === null || sourceIsKnown(place.choice, captures, recovery)) || (place.choice === null) !== (place.commitmentId === null)) throw new IntegrityError('A saved return point has an invalid source or route.');
}
export async function validateResumption(record, places) {
  await checkSeal(record, ['id', 'placeId', 'at', 'kind']);
  if (!validId(record.id) || !validId(record.placeId) || !validDate(record.at) || !['closed', 'resumed'].includes(record.kind) || !places.some(place => place.id === record.placeId)) throw new IntegrityError('A resumption receipt is missing its return point.');
}
export async function legacyIntent(choice) {
  if (!choice) return [];
  const digest = await sha256(`prior-choice:${sourceKey(choice)}:${choice.origin}`), hex = digest.slice(0, 32).split(''); hex[12] = '4'; hex[16] = '8';
  const h = hex.join(''), id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return [await seal({ id, commitmentId: id, previousId: null, state: 'ACTIVE', choice, at: '1970-01-01T00:00:00.000Z', note: 'Imported prior choice. Original selection time is unavailable.', receipt: null })];
}
export async function validateIntentState(state) {
  for (const key of INTENT_TABLES) if (!Array.isArray(state[key]) || state[key].some(row => !row || typeof row !== 'object' || Array.isArray(row)) || state[key].length > (key === 'intentEvents' ? INTENT_LIMIT : 1000) || new Set(state[key].map(row => row.id)).size !== state[key].length) throw new IntegrityError('Too many or duplicate continuity records.');
  for (const event of state.intentEvents) await validateEvent(event, state.captures, state.recovery);
  const commitments = deriveCommitments(state.intentEvents), active = commitments.filter(c => c.state === 'ACTIVE');
  if (active.length > 1) throw new IntegrityError('Only one commitment can be ACTIVE.');
  if (state.now && !active.some(c => same(c.choice, state.now))) throw new IntegrityError('NOW is missing its explicit commitment.');
  for (const place of state.places) {
    await validatePlace(place, state.captures, state.recovery);
    if (place.commitmentId !== null && !commitments.some(c => c.id === place.commitmentId && sourceKey(c.choice) === sourceKey(place.choice)) && !state.recovery.some(r => r.source === 'intentEvents' && r.recordId === place.commitmentId)) throw new IntegrityError('A return point is missing its commitment history.');
  }
  for (const record of state.resumptions) await validateResumption(record, state.places);
  if (new Set(state.resumptions.map(row => row.placeId)).size !== state.resumptions.length) throw new IntegrityError('Duplicate resumption receipts.');
}
