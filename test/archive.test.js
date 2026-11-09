import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveSnapshot, archiveWindow } from '../public/archive.js';
import { validRoute } from '../public/intent.js';
import { readingLink } from '../public/reading.js';
import { inline } from '../public/core/readable.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('FORT sorts actual instants across offsets and preserves exact source identity and text', () => {
  const captures = [
    {id:id(1),createdAt:'2026-01-01T12:00:00+09:00',text:'  Same title\r\nFirst.  '},
    {id:id(2),createdAt:'2026-01-01T04:00:00Z',text:'Same title\nSecond.'},
    {id:id(3),createdAt:'2026-01-01T04:00:00Z',text:'Literal %_ [x] 👩🏽‍💻'},
  ];
  const before = structuredClone(captures), rows = archiveSnapshot(captures);
  assert.deepEqual(rows.map(c=>c.id), [id(3),id(2),id(1)]);
  assert.deepEqual(captures,before); assert.equal(rows[2].text, before[0].text);
  assert.deepEqual(archiveSnapshot(captures,' %_ [x] ').map(c=>c.id),[id(3)]);
  assert.equal(archiveSnapshot(captures,'same TITLE').length,2);
});
test('1000-original paging and deep links keep a stable snapshot through new arrivals', () => {
  const captures = Array.from({length:1000},(_,n)=>({id:id(n),createdAt:new Date(1767225600000+n*1000).toISOString(),text:`Original ${n}`}));
  const rows=archiveSnapshot(captures), all=[]; let offset=0;
  do { const page=archiveWindow(rows,{offset}); all.push(...page.rows); offset=page.next; if (!page.hasMore) break; } while(offset<rows.length);
  assert.equal(all.length,1000); assert.equal(new Set(all.map(c=>c.id)).size,1000);
  const target=id(2), deep=archiveWindow(rows,{aroundId:target}); assert.ok(deep.rows.some(c=>c.id===target));
  captures.push({id:id(1001),createdAt:'2026-12-01T00:00:00Z',text:'Late arrival'});
  assert.equal(rows.length,1000); assert.equal(archiveSnapshot(captures)[0].id,id(1001));
  assert.equal(archiveWindow(rows,{offset:2000}).hasMore,false);
});
test('FORT permalinks use strict source IDs and unsupported variants stay literal',()=>{
  assert.ok(validRoute('fort')); assert.ok(validRoute(`fort/${id(1)}`));
  assert.equal(readingLink(`#fort/${id(1)}`),`#fort/${id(1)}`);
  for(const route of ['fort/title',`FORT/${id(1)}`,`fort/${id(1)}/extra`,`fort/%${id(1)}`]) {
    assert.equal(validRoute(route),false); assert.equal(readingLink(`#${route}`),null);
    const text=`[original](#${route})`; assert.equal(inline(text).map(t=>t.text).join(''),text);
  }
});
