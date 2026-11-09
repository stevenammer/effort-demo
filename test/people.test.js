import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { request } from '../public/database.js';
import { sha256 } from '../public/primitives.js';
import { seal } from '../public/intent.js';
import { recoveryRecord } from '../public/records.js';
import { createPeople, derivePeople, personDue, validatePeopleState } from '../public/people.js';

async function setup() {
  const factory = new IDBFactory(), opening = factory.open('people-test', 1);
  opening.onupgradeneeded = () => { for (const name of ['meta', 'captures', 'quarantine', 'personEvents', 'contactReceipts']) opening.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' }); };
  const native = await request(opening), db = { async run(tables, mode, work) { const tx = native.transaction(tables, mode), done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); done.catch(() => {}); let out; try { out = await work(tx); } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; } await done; return out; } };
  const people = createPeople({ db, recoveryRecord }), personId = crypto.randomUUID();
  const state = () => db.run(['captures', 'quarantine', 'personEvents', 'contactReceipts'], 'readonly', async tx => Object.fromEntries(await Promise.all([['captures', 'captures'], ['recovery', 'quarantine'], ['personEvents', 'personEvents'], ['contactReceipts', 'contactReceipts']].map(async ([key, table]) => [key, await request(tx.objectStore(table).getAll())]))));
  async function capture(text) { const row = { id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: new Date().toISOString(), span: 'Unsorted', sample: false }; await db.run(['captures'], 'readwrite', tx => request(tx.objectStore('captures').add(row))); return row; }
  return { db, people, personId, state, capture, close: () => native.close() };
}
const profile = () => ({ name: '  Example Person  ', relationship: 'Colleague', notes: '  Exact\nnotes.  ', importantDates: '', theyToldMe: 'Firsthand.', iToldThem: '', cadenceDays: 30 });
const body = x => ({ personId: x.personId, profile: profile(), links: [], expectedLatestId: null });

test('explicit profile edits preserve exact text, history and stale edit refusal', async () => {
  const x = await setup(), first = await x.people.savePerson(body(x));
  const second = await x.people.savePerson({ ...body(x), profile: { ...profile(), notes: 'Updated explicitly.' }, expectedLatestId: first.id });
  const state = await x.state(), person = derivePeople(state.personEvents, state.contactReceipts, state.recovery)[0];
  assert.equal(person.history.length, 2); assert.equal(person.history[0].profile.name, 'Example Person'); assert.equal(person.history[0].profile.notes, '  Exact\nnotes.  '); assert.equal(person.latestId, second.id);
  await assert.rejects(x.people.savePerson({ ...body(x), profile: { ...profile(), notes: 'Stale.' }, expectedLatestId: first.id }), /changed/); await validatePeopleState(state); x.close();
});

test('concurrent profile retries reuse one revision; contacts deduplicate only by request', async () => {
  const x = await setup(), result = await Promise.all(Array.from({ length: 6 }, () => x.people.savePerson(body(x)))); assert.ok(result.every(r => r.id === result[0].id));
  const requestId = crypto.randomUUID(), input = { personId: x.personId, contactAt: '2020-01-01T12:00:00Z', note: 'Spoke.' };
  const first = await x.people.logContact(input, { requestId }), again = await x.people.logContact(input, { requestId }), separate = await x.people.logContact(input, { requestId: crypto.randomUUID() });
  assert.equal(first.id, again.id); assert.notEqual(first.id, separate.id); assert.equal((await x.state()).contactReceipts.length, 2); x.close();
});

test('preserves a previously linked source through raw capture recovery; refuses new missing links', async () => {
  const x = await setup(), source = await x.capture('Saved source.'), link = { captureId: source.id, captureHash: source.hash };
  const first = await x.people.savePerson({ ...body(x), links: [link] });
  const raw = await recoveryRecord('capture', source.id, JSON.stringify(source), 'Needs recovery.');
  await x.db.run(['captures', 'quarantine'], 'readwrite', async tx => { await request(tx.objectStore('captures').delete(source.id)); await request(tx.objectStore('quarantine').put(raw)); });
  const updated = await x.people.savePerson({ ...body(x), profile: { ...profile(), notes: 'Retained source.' }, links: [link], expectedLatestId: first.id }); assert.deepEqual(updated.links, [link]);
  const freshId = crypto.randomUUID(); await assert.rejects(x.people.savePerson({ ...body(x), personId: freshId, links: [link] }), /recovery/); x.close();
});

test('corrupt person history is quarantined and old restored prefix stays in recovery', async () => {
  const x = await setup(), first = await x.people.savePerson(body(x)), second = await x.people.savePerson({ ...body(x), profile: { ...profile(), notes: 'Later.' }, expectedLatestId: first.id });
  await x.db.run(['personEvents'], 'readwrite', tx => request(tx.objectStore('personEvents').put({ ...second, profile: { ...second.profile, notes: 'Damaged.' } })));
  await x.people.repair(); let state = await x.state(); assert.equal(state.personEvents.length, 0); assert.equal(state.recovery.filter(r => r.source === 'personEvents').length, 2);
  await x.db.run(['personEvents'], 'readwrite', tx => request(tx.objectStore('personEvents').put(first))); state = await x.state(); let person = derivePeople(state.personEvents, state.contactReceipts, state.recovery)[0]; assert.equal(person.recovery, true);
  await x.people.savePerson({ ...body(x), profile: { ...profile(), notes: 'Deliberate revision.' }, expectedLatestId: first.id }); state = await x.state(); person = derivePeople(state.personEvents, state.contactReceipts, state.recovery)[0]; assert.equal(person.recovery, undefined); x.close();
});

test('cadence uses creation or latest contact, timezone correctly, and future times stay unknown', () => {
  const p = { profile: { cadenceDays: 30 }, history: [{ at: '2025-01-01T00:00:00.000Z' }], contacts: [] }, now = Date.parse('2025-02-01T00:00:00Z');
  assert.equal(personDue(p, now).isDue, true); assert.equal(personDue({ ...p, profile: { cadenceDays: null } }, now), null);
  const contacted = { ...p, contacts: [{ contactAt: '2025-01-31T19:00:00-05:00' }] }; assert.equal(personDue(contacted, now).isDue, false); assert.equal(personDue(contacted, now).baselineAt, '2025-02-01T00:00:00.000Z');
  assert.equal(personDue({ ...p, contacts: [{ contactAt: '2024-01-01T00:00:00Z' }] }, now).baselineAt, '2024-01-01T00:00:00.000Z');
  assert.equal(personDue({ ...p, contacts: [{ contactAt: '2025-02-02T00:00:00Z' }] }, now), null); assert.equal(personDue({ ...p, history: [{ at: '2025-03-01T00:00:00Z' }] }, now), null); assert.equal(personDue({ ...p, recovery: true }, now), null);
});

test('rejects future new contacts, invalid Unicode and forked imported history', async () => {
  const x = await setup(), first = await x.people.savePerson(body(x));
  await assert.rejects(x.people.logContact({ personId: x.personId, contactAt: '2999-01-01T00:00:00Z', note: '' }), /future/);
  await assert.rejects(x.people.savePerson({ ...body(x), profile: { ...profile(), notes: '\ud800' }, expectedLatestId: first.id }), /details/);
  const left = await seal({ id: crypto.randomUUID(), personId: x.personId, previousId: first.id, profile: first.profile, links: [], at: new Date().toISOString() }), right = await seal({ ...Object.fromEntries(Object.entries(left).filter(([k]) => k !== 'hash')), id: crypto.randomUUID() });
  await assert.rejects(validatePeopleState({ ...(await x.state()), personEvents: [first, left, right] }), /conflicts/); x.close();
});

test('readback retries and reset fence pending writes', async () => {
  const x = await setup(), requestId = crypto.randomUUID(), add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get; let inserted = false;
  try { IDBObjectStore.prototype.add = function(value, ...args) { const r = add.call(this, value, ...args); if (this.name === 'personEvents') inserted = true; return r; }; IDBObjectStore.prototype.get = function(...args) { if (this.name === 'personEvents' && this.transaction.mode === 'readonly' && inserted) throw Error('readback fault'); return get.apply(this, args); }; await assert.rejects(x.people.savePerson(body(x), { requestId }), /readback fault/); }
  finally { IDBObjectStore.prototype.add = add; IDBObjectStore.prototype.get = get; }
  await x.people.savePerson(body(x), { requestId }); assert.equal((await x.state()).personEvents.length, 1);
  await x.db.run(['meta'], 'readwrite', tx => request(tx.objectStore('meta').put({ key: 'epoch', value: crypto.randomUUID() })));
  await assert.rejects(x.people.savePerson({ ...body(x), personId: crypto.randomUUID() }, { expectedEpoch: null }), /workspace changed/); x.close();
});

test('reset while hashing cannot put People details into the new workspace', async () => {
  const x = await setup(), original = globalThis.crypto, descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); let release, entered, blocked = false;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: original.randomUUID.bind(original), subtle: { digest: async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original.subtle.digest(...args); } } } });
  try { const pending = x.people.savePerson(body(x), { requestId: crypto.randomUUID() }); await started;
    await x.db.run(['meta', 'personEvents', 'contactReceipts'], 'readwrite', async tx => { await request(tx.objectStore('personEvents').clear()); await request(tx.objectStore('contactReceipts').clear()); await request(tx.objectStore('meta').put({ key: 'epoch', value: crypto.randomUUID() })); });
    release(); await assert.rejects(pending, /workspace changed/);
  } finally { release(); Object.defineProperty(globalThis, 'crypto', descriptor); }
  assert.equal((await x.state()).personEvents.length, 0); x.close();
});

test('identical profile retry after restoration uses the original revision despite a new request ID', async () => {
  const x = await setup(), saved = await x.people.savePerson(body(x), { requestId: crypto.randomUUID() });
  await x.db.run(['meta'], 'readwrite', tx => request(tx.objectStore('meta').put({ key: 'epoch', value: crypto.randomUUID() })));
  const retry = await x.people.savePerson(body(x), { requestId: crypto.randomUUID() }); assert.deepEqual(retry, saved); assert.equal((await x.state()).personEvents.length, 1); x.close();
});


test('contact history recovery suppresses cadence until the missing receipt is restored', async () => {
  const x = await setup(); await x.people.savePerson(body(x));
  const contact = await x.people.logContact({ personId: x.personId, contactAt: '2025-01-01T00:00:00Z', note: 'A remembered conversation.' });
  await x.db.run(['contactReceipts'], 'readwrite', tx => request(tx.objectStore('contactReceipts').put({ ...contact, note: 'Damaged.' })));
  await x.people.repair(); let state = await x.state(), person = derivePeople(state.personEvents, state.contactReceipts, state.recovery)[0];
  assert.equal(person.contactRecovery, true); assert.equal(personDue(person, Date.now()), null);
  await x.people.logContact({ personId: x.personId, contactAt: '2025-02-01T00:00:00Z', note: 'Another conversation.' });
  state = await x.state(); person = derivePeople(state.personEvents, state.contactReceipts, state.recovery)[0]; assert.equal(personDue(person, Date.now()), null);
  await x.db.run(['contactReceipts'], 'readwrite', tx => request(tx.objectStore('contactReceipts').put(contact)));
  state = await x.state(); person = derivePeople(state.personEvents, state.contactReceipts, state.recovery)[0]; assert.equal(person.contactRecovery, undefined); assert.equal(personDue(person, Date.now()).baselineAt, '2025-02-01T00:00:00.000Z'); x.close();
});

test('calendar-invalid contact dates are rejected and numeric offsets remain exact', async () => {
  const x = await setup(); await x.people.savePerson(body(x));
  await assert.rejects(x.people.logContact({ personId: x.personId, contactAt: '2025-02-31T10:00:00Z', note: '' }), /valid contact time/);
  await assert.rejects(x.people.logContact({ personId: x.personId, contactAt: '2025-04-31T10:00:00+02:00', note: '' }), /valid contact time/);
  const saved = await x.people.logContact({ personId: x.personId, contactAt: '2024-02-29T23:15:00-05:00', note: 'Exact offset retained.' });
  assert.equal(saved.contactAt, '2024-02-29T23:15:00-05:00'); await validatePeopleState(await x.state()); x.close();
});

test('trimmed name is canonical for retries while multiline whitespace stays exact', async () => {
  const x = await setup(), requestId = crypto.randomUUID(), input = body(x), saved = await x.people.savePerson(input, { requestId });
  const retried = await x.people.savePerson({ ...input, profile: { ...input.profile, name: 'Example Person' } }, { requestId });
  assert.deepEqual(saved, retried); assert.equal(saved.profile.name, 'Example Person'); assert.equal(saved.profile.notes, '  Exact\nnotes.  '); x.close();
});
