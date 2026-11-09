import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
function inZone(zone, code) {return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import { contactInstant, contactChoices } from './public/people-ui.js'; ${code}`],{cwd:new URL('..',import.meta.url),env:{...process.env,TZ:zone},encoding:'utf8'}));}
test('local contact time rejects DST gaps and preserves both repeated-time offsets',()=>{
  const result=inZone('America/New_York',`console.log(JSON.stringify({gap:contactChoices('2026-03-08T02:30'),fold:contactChoices('2026-11-01T01:30'),first:contactInstant('2026-11-01T01:30',240),second:contactInstant('2026-11-01T01:30',300)}));`);
  assert.deepEqual(result.gap,[]);assert.deepEqual(result.fold,[240,300]);assert.equal(result.first,'2026-11-01T05:30:00.000Z');assert.equal(result.second,'2026-11-01T06:30:00.000Z');
});
test('a restored offset cannot silently move a contact after the browser timezone changes',()=>{
  const result=inZone('Asia/Tokyo',`let rejected=false;try{contactInstant('2026-11-01T01:30',240);}catch{rejected=true;}console.log(JSON.stringify({rejected,correct:contactInstant('2026-11-01T01:30',-540)}));`);
  assert.equal(result.rejected,true);assert.equal(result.correct,'2026-10-31T16:30:00.000Z');
});
test('invalid calendar dates remain invalid in the local-time composer',()=>{
  assert.deepEqual(inZone('UTC',`console.log(JSON.stringify(contactChoices('2025-02-31T10:00')));`),[]);
});
