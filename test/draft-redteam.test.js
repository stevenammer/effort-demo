import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createDraftShelf } from '../public/drafts.js';
import { openDatabase, request } from '../public/database.js';
import { seal } from '../public/intent.js';

class Storage {
  constructor() { this.data = new Map(); }
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
function setup() { const factory = new IDBFactory(), database = openDatabase({ factory }), localStorage = new Storage(), sessionStorage = new Storage(), shelf = createDraftShelf({ database, localStorage, sessionStorage, locks: null }); return { database, shelf }; }
const id = () => crypto.randomUUID();
const personBody = personId => ({ personId, profile: { name: 'Alex', relationship: '', notes: 'A real note.', importantDates: '', theyToldMe: '', iToldThem: '', cadenceDays: '' }, links: [], expectedLatestId: null });
const contactBody = personId => ({ personId, when: '2025-03-01T12:30', offsetMinutes: 300, note: 'Spoke.', requestId: id() });
const moveBody = () => ({ moveId: null, name: 'My move', prompt: 'A real prompt.', enabled: true, expectedLatestId: null });
const branchBody = branchId => ({ branchId, status: 'parked', note: '', evidence: false, expectedLatestId: null });
const exploreBody = sourceId => ({ text: 'A branch thought.', sourceId, parentId: null, returnPointId: null, dial: 'NORMAL', returnData: { route: 'home', context: { scrollY: 0, spanSearch: '', sourceExpanded: false }, expected: null, summary: 'Return here.' } });
const distillBody = explorationId => ({ text: 'An insight.', explorationId, type: 'INSIGHT' });
async function alternate(record, body) { const { hash, ...payload } = record; return seal({ ...payload, key: id(), tabId: id(), body }); }

test('recovery never overwrites substantive people, move, exploration, branch or contact drafts', async () => {
  const x = setup(), person = id(), branch = id(), source = id(), dist = id();
  const cases = [
    [`review:${source}`,{sourceId:source,contextIds:[source],question:'Keep this exact question.\r\nStill open.',requestedResult:'OPTIONS',state:'REVIEW',invited:['critic'],requestId:id()},b=>({...b,question:'Another request.'})],
    ['person', personBody(person), b => ({ ...b, profile: { ...b.profile, notes: 'Other person writing.' } })],
    [`contact:${person}`, contactBody(person), b => ({ ...b, note: 'Different note.' })],
    ['move', moveBody(), b => ({ ...b, prompt: 'Another prompt.' })],
    [`branch:${branch}`, branchBody(branch), b => ({ ...b, note: 'Another branch note.' })],
    [`explore:${source}`, exploreBody(source), b => ({ ...b, text: 'Another branch.' })],
    [`distill:${dist}`, distillBody(dist), b => ({ ...b, text: 'Another insight.' })],
    ...['edit','transcript'].map(kind=>[`${kind==='edit'?'correction':'transcript'}:${source}`,{captureId:source,captureHash:'0'.repeat(64),kind,text:'Keep this exact draft.',expectedLatestId:null,expectedEffectiveId:null,acknowledgedRecovery:[],requestId:id()},b=>({...b,text:'A different recovered revision.'})]),
  ];
  for (const [context, body, change] of cases) {
    const current = await x.shelf.save(context, body), other = await alternate(current, change(body));
    await assert.rejects(x.shelf.recoverRecord(other), /already has a different draft|already has a draft/);
    assert.deepEqual((await x.shelf.load(context)).body, body);
  }
  await x.shelf.close(); await x.database.close();
});

test('failed tombstone write can be retried exactly for person, contact and move', async () => {
  const x = setup(), person = id(), cases = [['person', personBody(person)], [`contact:${person}`, contactBody(person)], ['move', moveBody()]];
  for (const [context, body] of cases) {
    await x.shelf.save(context, body); const put = IDBObjectStore.prototype.put; let fail = true;
    try { IDBObjectStore.prototype.put = function(value, ...args) { if (this.name === 'drafts' && value.context === context && fail) { fail = false; throw Error('tombstone write fault'); } return put.call(this, value, ...args); };
      await assert.rejects(x.shelf.clear(context, body), /tombstone write fault/);
    } finally { IDBObjectStore.prototype.put = put; }
    const cleared = await x.shelf.clear(context, body); assert.deepEqual(await x.shelf.clear(context, body), cleared);
    if (context === 'person') assert.equal(cleared.body.profile.name, ''); else if (context === 'move') assert.equal(cleared.body.prompt, ''); else assert.equal(cleared.body.note, '');
    const replacement = context === 'person' ? { ...body, profile: { ...body.profile, notes: 'New writing.' } } : context === 'move' ? { ...body, prompt: 'New writing.' } : { ...body, note: 'New writing.' };
    await x.shelf.save(context, replacement); await assert.rejects(x.shelf.clear(context, body), /changed/); assert.deepEqual((await x.shelf.load(context)).body, replacement);
  }
  await x.shelf.close(); await x.database.close();
});

test('failed cleanup cannot erase later edits, including when the edit is pending', async () => {
  const x = setup(), context = 'move', body = moveBody(); await x.shelf.save(context, body);
  const put = IDBObjectStore.prototype.put;
  try { IDBObjectStore.prototype.put = function(value, ...args) { if (this.name === 'drafts' && value.context === context) throw Error('write fault'); return put.call(this, value, ...args); }; await assert.rejects(x.shelf.clear(context, body), /write fault/); }
  finally { IDBObjectStore.prototype.put = put; }
  const changed = { ...body, prompt: 'A newer prompt.' }; const pending = x.shelf.save(context, changed); await assert.rejects(x.shelf.clear(context, body), /changed/); await pending;
  assert.deepEqual((await x.shelf.load(context)).body, changed); await x.shelf.close(); await x.database.close();
});

test('reset epoch still fences a retry of failed cleanup', async () => {
  const x = setup(), body = moveBody(); await x.shelf.save('move', body); const put = IDBObjectStore.prototype.put;
  try { IDBObjectStore.prototype.put = function(value, ...args) { if (this.name === 'drafts') throw Error('write fault'); return put.call(this, value, ...args); }; await assert.rejects(x.shelf.clear('move', body), /write fault/); }
  finally { IDBObjectStore.prototype.put = put; }
  await x.database.run(['meta', 'drafts'], 'readwrite', async tx => { await request(tx.objectStore('drafts').clear()); await request(tx.objectStore('meta').put({ key: 'epoch', value: id() })); });
  await assert.rejects(x.shelf.clear('move', body), /workspace was reset/); assert.equal((await x.shelf.list()).records.length, 0); await x.shelf.close(); await x.database.close();
});

test('acknowledging an already verified tombstone still checks the reset epoch', async () => {
  const x = setup(), body = moveBody(); await x.shelf.save('move', body); await x.shelf.clear('move', body);
  await x.database.run(['meta', 'drafts'], 'readwrite', async tx => { await request(tx.objectStore('drafts').clear()); await request(tx.objectStore('meta').put({ key: 'epoch', value: id() })); });
  await assert.rejects(x.shelf.clear('move', body), /workspace was reset/); await x.shelf.close(); await x.database.close();
});

test('cleanup uses attempted metadata when only the emergency copy exists', async () => {
  const x = setup(), person = id(), body = contactBody(person), context = `contact:${person}`, put = IDBObjectStore.prototype.put;
  try { IDBObjectStore.prototype.put = function(value, ...args) { if (this.name === 'drafts') throw Error('initial save fault'); return put.call(this, value, ...args); }; await assert.rejects(x.shelf.save(context, body), /initial save fault/); }
  finally { IDBObjectStore.prototype.put = put; }
  const tombstone = await x.shelf.clear(context, body); assert.equal(tombstone.body.personId, person); assert.equal(tombstone.body.requestId, body.requestId); assert.equal(tombstone.body.note, '');
  await x.shelf.close(); await x.database.close();
});
