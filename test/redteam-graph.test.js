import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, sha256, validateState } from '../public/store.js';

// Inspired by Logseq's importer regression corpus and export→paste report:
// https://github.com/logseq/logseq/blob/master/docs/og_import_graph_cases.md
// https://github.com/logseq/db-test/issues/1445
// These are EFFORT-specific proposed regression cases, not claims about EFFORT.

const fixedTime = '2026-11-08T16:00:00.000Z';
const makeCapture = async (id, text, span = 'Learning', parentId = undefined) => ({
  id, text, hash: await sha256(text), createdAt: fixedTime, span, sample: false,
  ...(parentId === undefined ? {} : { parentId }),
});
const packagePayload = async payload => JSON.stringify({ payload, sha256: await sha256(JSON.stringify(payload)) });
const freshStore = () => createStore({ indexedDB: new IDBFactory(), legacyStorage: null, broadcast: false });
const sourceText = title => `# ${title}\nA synthetic source; its exact bytes stay local.`;

test('generated multi-span reply graph round-trips exact IDs and writing; duplicate titles stay distinct', async () => {
  const source = freshStore();
  const learning = await source.createSpan('Graph Lab');
  const people = await source.createSpan('People Lab');
  const roots = [];
  for (const [span, title] of [[learning.name, 'Same title'], [people.name, 'Same title'], ['Unsorted', 'Third title']]) {
    roots.push(await source.capture(sourceText(title), span));
  }
  const replies = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const first = await source.capture(`Reply ${i}: exact text.\n${'  keep spacing  '}`, root.span, root.id);
    const second = await source.capture(`Nested reply ${i}.`, root.span, first.id);
    replies.push(first, second);
  }
  const before = await source.read();
  assert.equal(before.captures.filter(row => row.text === sourceText('Same title')).length, 2);
  assert.notEqual(roots[0].id, roots[1].id, 'same titles in different spans must not collapse identity');

  const raw = await source.exportData();
  const target = freshStore();
  await target.restore(raw);
  await target.restore(raw);
  const after = await target.read();
  assert.deepEqual(after.captures, before.captures);
  assert.deepEqual(after.spans, before.spans);
  assert.deepEqual(after.captures.map(row => row.id).sort(), [...roots, ...replies].map(row => row.id).sort());
  assert.equal(await target.exportData(), raw, 'second restore is idempotent and the portable bytes are stable');
  await source.close(); await target.close();
});

test('invalid incoming reply graphs are rejected atomically; truncated backup can be retried', async () => {
  const existing = freshStore();
  const keep = await existing.capture('Existing valid workspace remains unchanged.', 'Unsorted');
  const original = await existing.exportData();
  const validPayload = JSON.parse(original).payload;
  const cases = [
    ['missing parent', [await makeCapture('a1000000-0000-4000-8000-000000000001', 'Missing parent reply.', 'Learning', 'a1000000-0000-4000-8000-000000000099')], /missing its original parent/i],
    ['self reference', [await makeCapture('a2000000-0000-4000-8000-000000000002', 'Self linked reply.', 'Learning', 'a2000000-0000-4000-8000-000000000002')], /invalid capture format|invalid reply link/i],
    ['cycle', [
      await makeCapture('a3000000-0000-4000-8000-000000000003', 'Cycle member one.', 'Learning', 'a3000000-0000-4000-8000-000000000004'),
      await makeCapture('a3000000-0000-4000-8000-000000000004', 'Cycle member two.', 'Learning', 'a3000000-0000-4000-8000-000000000003'),
    ], /cycle/i],
  ];

  for (const [label, badRows, error] of cases) {
    const payload = structuredClone(validPayload);
    payload.captures.push(...badRows);
    payload.spans.push({ id: 'learning lab', name: 'Learning Lab', kind: 'journal', createdAt: fixedTime });
    const incoming = await packagePayload(payload);
    await assert.rejects(existing.restore(incoming), error, label);
    assert.equal(await existing.exportData(), original, `${label} must not mutate the existing capture or workspace`);
    assert.equal((await existing.read()).captures.find(row => row.id === keep.id).text, keep.text);
  }

  await assert.rejects(existing.restore(original.slice(0, Math.floor(original.length / 3))), /JSON|backup|Unexpected end/i);
  assert.equal(await existing.exportData(), original, 'truncated backup rejection must preserve existing state');
  const incomingStore = freshStore();
  const incoming = await incomingStore.capture('Valid graph after truncated attempt.', 'Unsorted');
  const validBackup = await incomingStore.exportData();
  await existing.restore(validBackup);
  assert.ok((await existing.read()).captures.some(row => row.id === incoming.id));
  assert.equal((await existing.read()).captures.find(row => row.id === keep.id).text, keep.text);
  await existing.close(); await incomingStore.close();
});

test('unsupported or corrupted payloads fail validation before any workspace mutation', async () => {
  const store = freshStore();
  const keep = await store.capture('Protected valid capture.', 'Unsorted');
  const original = await store.exportData();
  const payload = JSON.parse(original).payload;
  const malformed = [
    ['unsupported format', { ...payload, surprise: true }, /supported EFFORT/i],
    ['duplicate IDs', { ...payload, captures: [...payload.captures, payload.captures[0]] }, /duplicate capture IDs/i],
    ['bad capture payload', { ...payload, captures: [{ ...payload.captures[0], text: '\ud800' }] }, /invalid capture format/i],
  ];
  for (const [label, badPayload, error] of malformed) {
    await assert.rejects(validateState(badPayload), error, label);
    // A correctly checksummed malformed bundle must still be rejected before writes.
    await assert.rejects(store.restore(await packagePayload(badPayload)), error, label);
    assert.equal(await store.exportData(), original, `${label} did not change current persisted data`);
    assert.equal((await store.read()).captures[0].text, keep.text);
  }
  const wrongChecksum = JSON.stringify({ payload, sha256: '0'.repeat(64) });
  await assert.rejects(store.restore(wrongChecksum), /checksum mismatch/i);
  assert.equal(await store.exportData(), original);
  await store.close();
});

test('embed-like Markdown and source links export as exact writing without expanding another source', async () => {
  const store = freshStore();
  const hidden = await store.capture('# Hidden source\nSECRET FIXTURE TEXT NEVER EXPANDED.', 'Learning');
  const text = `# Visible source\nLiteral only: {{embed [[${hidden.id}]]}}\n[Open exact source](#thread/${hidden.id})\n`;
  const visible = await store.capture(text, 'Learning');
  const exported = JSON.parse(await store.exportData()).payload;
  const saved = exported.captures.find(row => row.id === visible.id);
  assert.equal(saved.text, text);
  assert.equal(saved.hash, await sha256(text));
  assert.equal(saved.text.includes('SECRET FIXTURE TEXT NEVER EXPANDED.'), false);
  assert.equal(exported.captures.find(row => row.id === hidden.id).text, '# Hidden source\nSECRET FIXTURE TEXT NEVER EXPANDED.');
  assert.ok(saved.text.includes(`#thread/${hidden.id}`), 'the explicit stable local source link remains byte-exact');
  await store.close();
});
