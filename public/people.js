import { request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, stableId, same, IntegrityError } from './primitives.js';
import { seal } from './intent.js';
import { validateCapture } from './records.js';

export const PEOPLE_TABLES = Object.freeze(['personEvents', 'contactReceipts']);
export const PEOPLE_LIMITS = Object.freeze({ people: 100, events: 2000, contacts: 2000, bytes: 4 * 1024 * 1024, links: 50 });
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const text = (value, max, required = false, single = false) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0) && !controls.test(value) && (!single || !/[\r\n\t]/.test(value));
const iso = validDate;
function profileValid(p) {
  return exactKeys(p, ['name', 'relationship', 'notes', 'importantDates', 'theyToldMe', 'iToldThem', 'cadenceDays']) && text(p.name, 120, true, true) && p.name === p.name.trim() && text(p.relationship, 200, false, true) && text(p.notes, 4000) && text(p.importantDates, 1000) && text(p.theyToldMe, 4000) && text(p.iToldThem, 4000) && (p.cadenceDays === null || Number.isInteger(p.cadenceDays) && p.cadenceDays >= 1 && p.cadenceDays <= 365);
}
const linksValid = links => Array.isArray(links) && links.length <= PEOPLE_LIMITS.links && links.every(link => exactKeys(link, ['captureId', 'captureHash']) && validId(link.captureId) && validHash(link.captureHash)) && new Set(links.map(link => link.captureId)).size === links.length;
async function checkSeal(row, keys) {
  if (!exactKeys(row, [...keys, 'hash']) || !validHash(row.hash)) throw new IntegrityError('A People record has an invalid format.');
  const payload = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'hash'));
  if (await sha256(JSON.stringify(payload)) !== row.hash) throw new IntegrityError('A People record checksum does not match.');
}
function group(events) { const result = new Map(); for (const row of events) { const list = result.get(row.personId) ?? []; list.push(row); result.set(row.personId, list); } return result; }
function chain(rows) {
  const ids = new Map(rows.map(row => [row.id, row])), roots = rows.filter(row => row.previousId === null), next = new Map();
  if (ids.size !== rows.length || roots.length !== 1) throw new IntegrityError('A person history has no unique beginning.');
  for (const row of rows) if (row.previousId !== null) { const parent = ids.get(row.previousId); if (!parent || parent.personId !== row.personId || next.has(row.previousId)) throw new IntegrityError('A person history conflicts or is disconnected.'); next.set(row.previousId, row); }
  const result = [roots[0]]; let current = roots[0]; while (next.has(current.id)) { current = next.get(current.id); result.push(current); if (result.length > rows.length) throw new IntegrityError('A person history contains a cycle.'); }
  if (result.length !== rows.length) throw new IntegrityError('A person history is disconnected.'); return result;
}
function recoveredGroups(recovery) {
  const result = new Map(); for (const r of recovery.filter(r => r.source === 'personEvents')) try { const row = JSON.parse(r.raw); if (!validId(row.personId)) continue; const a = result.get(row.personId) ?? []; a.push(r); result.set(row.personId, a); } catch {} return result;
}
export function derivePeople(events, contacts, recovery = []) {
  const histories = group(events), recovered = recoveredGroups(recovery), receipts = group(contacts), result = [];
  for (const id of new Set([...histories.keys(), ...recovered.keys(), ...receipts.keys()])) {
    const history = histories.has(id) ? chain(histories.get(id)) : [], last = history.at(-1), rec = recovered.get(id) ?? [], recoveredIds = new Set(rec.map(r => r.recordId)), ids = new Set(history.map(r => r.id));
    const unresolved = rec.length > 0 && (!last || recoveredIds.has(last.id) && [...recoveredIds].some(i => !ids.has(i)));
    const personContacts = receipts.get(id) ?? [], contactIds = new Set(personContacts.map(row => row.id));
    const contactRecovery = recovery.some(entry => {
      if (entry.source !== 'contactReceipts' || contactIds.has(entry.recordId)) return false;
      try { return JSON.parse(entry.raw)?.personId === id; } catch { return false; }
    });
    result.push({ id, profile: last?.profile ?? null, links: last?.links ?? [], latestId: last?.id ?? null, history, contacts: personContacts, ...(unresolved || !last ? { recovery: true } : {}), ...(contactRecovery ? { contactRecovery: true } : {}) });
  }
  return result;
}
export function personDue(person, nowMs) {
  if (person?.recovery || person?.contactRecovery || !person?.history?.length || !Number.isFinite(nowMs) || !Number.isInteger(person.profile?.cadenceDays)) return null;
  const created = Date.parse(person.history[0].at); if (!Number.isFinite(created) || created > nowMs) return null;
  let baseline = null;
  for (const receipt of person.contacts ?? []) { const at = Date.parse(receipt.contactAt); if (!Number.isFinite(at) || at > nowMs) return null; baseline = baseline === null ? at : Math.max(baseline, at); }
  baseline ??= created;
  const due = baseline + person.profile.cadenceDays * 86400000; return { baselineAt: new Date(baseline).toISOString(), dueAt: new Date(due).toISOString(), isDue: nowMs >= due };
}
async function validateRow(row, table, state) {
  if (table === 'personEvents') {
    await checkSeal(row, ['id', 'personId', 'previousId', 'profile', 'links', 'at']);
    if (!validId(row.id) || !validId(row.personId) || !(row.previousId === null || validId(row.previousId)) || !profileValid(row.profile) || !linksValid(row.links) || !validDate(row.at)) throw new IntegrityError('A People profile has invalid content.');
    for (const link of row.links) {
      const capture = state.captures.find(c => c.id === link.captureId);
      if (capture) { await validateCapture(capture); if (capture.hash !== link.captureHash) throw new IntegrityError('A People link no longer matches its source.'); }
      else if (!state.recovery.some(r => r.source === 'capture' && r.recordId === link.captureId)) throw new IntegrityError('A People link is missing its source.');
    }
  } else {
    await checkSeal(row, ['id', 'personId', 'contactAt', 'note', 'at']);
    if (!validId(row.id) || !validId(row.personId) || !iso(row.contactAt) || !text(row.note, 4000) || !validDate(row.at) || !state.personEvents.some(e => e.personId === row.personId) && !recoveredGroups(state.recovery).has(row.personId)) throw new IntegrityError('A self-reported contact has invalid content or source.');
  }
}
export async function validatePeopleState(state) {
  if (!Array.isArray(state.captures) || !Array.isArray(state.recovery)) throw new IntegrityError('People sources are missing.');
  for (const [table, limit] of [['personEvents', PEOPLE_LIMITS.events], ['contactReceipts', PEOPLE_LIMITS.contacts]]) {
    const rows = state[table]; if (!Array.isArray(rows) || rows.length > limit || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r)) || new Set(rows.map(r => r.id)).size !== rows.length) throw new IntegrityError('Invalid or duplicate People records.');
    for (const row of rows) await validateRow(row, table, state);
  }
  if (new Set([...state.personEvents.map(r => r.personId), ...state.contactReceipts.map(r => r.personId), ...recoveredGroups(state.recovery).keys()]).size > PEOPLE_LIMITS.people || new TextEncoder().encode(JSON.stringify(PEOPLE_TABLES.map(key => state[key]))).length > PEOPLE_LIMITS.bytes) throw new IntegrityError('People history exceeds its portable storage limit.');
  derivePeople(state.personEvents, state.contactReceipts, state.recovery);
}
export function createPeople({ db, ready = async () => {}, notify = () => {}, recoveryRecord }) {
  async function snapshot() {
    await ready(); return db.run(['meta', 'captures', 'quarantine', ...PEOPLE_TABLES], 'readonly', async tx => ({ epoch: await meta(tx, 'epoch'), captures: await request(tx.objectStore('captures').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()), personEvents: await request(tx.objectStore('personEvents').getAll()), contactReceipts: await request(tx.objectStore('contactReceipts').getAll()) }));
  }
  async function repair() {
    const state = await snapshot(), bad = [];
    for (const rows of group(state.personEvents).values()) {
      try { for (const row of rows) await validateRow(row, 'personEvents', state); chain(rows); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; for (const row of rows) bad.push({ table: 'personEvents', row, reason: error.message }); }
    }
    if (bad.length && !recoveryRecord) throw new IntegrityError('People history needs recovery.');
    for (const item of bad) item.recovery = await recoveryRecord(item.table, String(item.row?.id ?? 'unknown').slice(0, 128), JSON.stringify(item.row), item.reason);
    const pending = { ...state, personEvents: state.personEvents.filter(row => !bad.some(item => item.row === row)), recovery: [...state.recovery, ...bad.map(item => item.recovery)] };
    for (const row of state.contactReceipts) {
      try { await validateRow(row, 'contactReceipts', pending); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; if (!recoveryRecord) throw error; bad.push({ table: 'contactReceipts', row, reason: error.message, recovery: await recoveryRecord('contactReceipts', String(row?.id ?? 'unknown').slice(0, 128), JSON.stringify(row), error.message) }); }
    }
    if (!bad.length) return;
    await db.run(['meta', 'captures', 'quarantine', ...PEOPLE_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) return;
      for (const [table, expected] of [['captures', state.captures], ['quarantine', state.recovery], ...PEOPLE_TABLES.map(table => [table, state[table]])]) if (!same(await request(tx.objectStore(table).getAll()), expected)) return;
      for (const item of bad) { await request(tx.objectStore('quarantine').put(item.recovery)); await request(tx.objectStore(item.table).delete(item.row.id)); }
    }); notify();
  }
  async function save(table, input, { requestId, expectedEpoch } = {}) {
    if (!validId(input.personId) || requestId !== undefined && !validId(requestId)) throw Error('The People request ID is invalid.');
    input = structuredClone(input);
    if (table === 'personEvents' && typeof input.profile?.name === 'string') input.profile.name = input.profile.name.trim();
    const state = await snapshot(); if (expectedEpoch !== undefined && expectedEpoch !== (state.epoch ?? null)) throw Error('The workspace changed. Reopen this person before saving.');
    await validatePeopleState(state);
    const current = derivePeople(state.personEvents, state.contactReceipts, state.recovery).find(p => p.id === input.personId);
    const id = requestId ? await stableId(JSON.stringify([table, requestId])) : crypto.randomUUID();
    const { expectedLatestId, ...content } = input;
    const matches = row => (table !== 'personEvents' || row.previousId === expectedLatestId) && Object.entries(content).every(([k, v]) => same(row[k], v));
    const prior = state[table].find(row => row.id === id);
    if (prior && !matches(prior)) throw Error('This request ID belongs to different People information.');
    const semantic = table === 'personEvents' ? state.personEvents.find(matches) : null;
    if (prior || semantic) {
      const saved = prior ?? semantic;
      await db.run(['meta', 'captures', 'quarantine', ...PEOPLE_TABLES], 'readonly', async tx => {
        if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Reopen this person before saving.');
        for (const [name, expected] of [['captures', state.captures], ['quarantine', state.recovery]]) if (!same(await request(tx.objectStore(name).getAll()), expected)) throw Error('People sources changed. Refresh before saving.');
        if (!same(await request(tx.objectStore(table).get(saved.id)), saved)) throw Error('People information changed. Refresh before saving.');
      });
      return saved;
    }
    if (table === 'personEvents') {
      if ((current?.latestId ?? null) !== expectedLatestId) throw Error('This person changed in another tab. Refresh before saving.');
      if (!profileValid(input.profile) || !linksValid(input.links)) throw Error('Check the person details and linked sources.');
      for (const link of input.links) {
        const capture = state.captures.find(c => c.id === link.captureId);
        if (capture) { await validateCapture(capture); if (capture.hash !== link.captureHash) throw Error('A linked source changed.'); }
        else if (!current?.links.some(old => same(old, link)) || !state.recovery.some(r => r.source === 'capture' && r.recordId === link.captureId)) throw Error('A linked source needs recovery before it can be added.');
      }
    } else {
      if (!current || current.recovery || !current.history.length) throw Error('The person needs recovery before recording contact.');
      if (!iso(input.contactAt) || Date.parse(input.contactAt) > Date.now() || !text(input.note, 4000)) throw Error('Enter a valid contact time that is not in the future and a short note.');
    }
    const record = await seal({ id, ...content, ...(table === 'personEvents' ? { previousId: expectedLatestId } : {}), at: new Date().toISOString() });
    await validatePeopleState({ ...state, [table]: [...state[table], record] });
    const inserted = await db.run(['meta', 'captures', 'quarantine', ...PEOPLE_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== state.epoch) throw Error('The workspace changed. Reopen this person before saving.');
      for (const [name, expected] of [['captures', state.captures], ['quarantine', state.recovery]]) if (!same(await request(tx.objectStore(name).getAll()), expected)) throw Error('People sources changed in another tab. Refresh before saving.');
      for (const name of PEOPLE_TABLES) if (!same(await request(tx.objectStore(name).getAll()), state[name])) {
        const all = await request(tx.objectStore(table).getAll());
        const existing = all.find(row => row.id === id) ?? (table === 'personEvents' ? all.find(matches) : null);
        if (existing && matches(existing)) return existing;
        throw Error('People information changed in another tab. Refresh before saving.');
      }
      await request(tx.objectStore(table).add(record)); return record;
    });
    try { const actual = await db.run([table], 'readonly', tx => request(tx.objectStore(table).get(inserted.id))); if (!same(actual, inserted) || !matches(actual)) throw Error('The saved People record differs from its readback.'); await validateRow(actual, table, state); notify(); return actual; }
    catch (error) { notify(); throw Error(`The People record could not be verified: ${error.message} Keep your writing and retry.`); }
  }
  return {
    repair,
    savePerson: ({ personId, profile, links, expectedLatestId }, options) => save('personEvents', { personId, profile, links, expectedLatestId }, options),
    logContact: ({ personId, contactAt, note = '' }, options) => save('contactReceipts', { personId, contactAt, note }, options),
  };
}
