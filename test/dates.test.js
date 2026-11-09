import test from 'node:test';
import assert from 'node:assert/strict';
import { validDate } from '../public/primitives.js';
test('timestamps reject calendar normalization, missing timezone and invalid clock components', () => {
  for (const value of ['2025-02-29T10:00:00Z','2025-02-31T10:00:00Z','1900-02-29T10:00:00Z','2026-04-31T10:00Z','2026-11-08T24:00Z','2026-11-08T12:60Z','2026-11-08T12:30:60Z','2026-11-08T12:00:00','2026-11-08T12:00:00+24:00','2026-11-08T12:00:00-04:60','2026-00-01T00:00:00Z','2026-01-00T00:00:00Z']) assert.equal(validDate(value), false, value);
});
test('valid leap days, timezone representations and fractional instants remain portable', () => {
  for (const value of ['2000-02-29T10:00:00Z','2024-02-29T10:00:00.123Z','2026-11-08T10:00-05:00','2026-11-08T15:00:00Z','2026-11-09T00:00:00+09:00','0000-02-29T00:00:00Z']) assert.equal(validDate(value), true, value);
  assert.equal(Date.parse('2026-11-08T10:00-05:00'),Date.parse('2026-11-08T15:00:00Z'));
});

test('an impossible stored source timestamp is quarantined without inventing replacement NOW or blocking capture',async()=>{
  const { IDBFactory }=await import('fake-indexeddb'),{createStore}=await import('../public/store.js'),{openDatabase,request}=await import('../public/database.js');
  const factory=new IDBFactory(),store=createStore({indexedDB:factory,legacyStorage:null,broadcast:false});await store.seed();const before=await store.read(),source=before.captures.find(c=>c.id===before.now.captureId),db=openDatabase({factory});
  await db.run(['captures'],'readwrite',tx=>request(tx.objectStore('captures').put({...source,createdAt:'2025-02-31T12:00:00.000Z'})));
  const recovered=await store.read();assert.equal(recovered.now,null);assert.ok(!recovered.captures.some(c=>c.id===source.id));assert.ok(recovered.recovery.some(r=>r.source==='capture'&&r.recordId===source.id&&JSON.parse(r.raw).text===source.text&&JSON.parse(r.raw).createdAt==='2025-02-31T12:00:00.000Z'));
  const saved=await store.capture('The valid source can still be saved.','Unsorted');assert.ok((await store.read()).captures.some(c=>c.id===saved.id));await db.close();await store.close();
});
