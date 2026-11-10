import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

export const hash = async (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export async function capture(id = 'capture-a', text = 'Cafe\u0301 ☕\r\nKeep \0 every byte.  ', createdAt = '2026-01-02T03:04:05.000Z') {
  return { id, text, hash: await hash(text), createdAt, metadata: { nested: { tags: ['原文', '🌿'] }, exact: '\r\n\0' } };
}
export const derived = (value = 'source') => ({ id: 'view-a', captureId: 'capture-a', createdAt: '2026-01-03T03:04:05.000Z', metadata: { value } });

/** Register the same public storage behavior for any async fixture factory. */
export function adapterConformance(name, make) {
  test(`${name}: derived compare-and-swap is canonical, atomic and isolates call-time inputs`, async (t) => {
    const store = await make(t);
    await store.putDerived({ id: 'unrelated', value: 'keep' });
    const first = { id: 'cas-view', value: 1 };
    assert.equal(await store.compareAndSwapDerived(first.id, null, first), true);
    const second = { id: first.id, value: 2 };
    assert.equal(await store.compareAndSwapDerived(first.id, { value: 1, id: first.id }, second), true);
    const results = await Promise.all([3,4].map(value => store.compareAndSwapDerived(first.id, second, { id: first.id, value })));
    assert.equal(results.filter(Boolean).length, 1);
    const current = (await store.snapshot()).derived.find(record => record.id === first.id);
    assert.equal(await store.compareAndSwapDerived(first.id, second, first), false);
    assert.deepEqual((await store.snapshot()).derived.find(record => record.id === first.id), current);
    const expected = structuredClone(current), next = { id: first.id, value: { exact: 'original' } };
    const pending = store.compareAndSwapDerived(first.id, expected, next);
    expected.value = 'changed'; next.value.exact = 'changed';
    assert.equal(await pending, true);
    assert.deepEqual((await store.snapshot()).derived.find(record => record.id === first.id).value, { exact: 'original' });
    await assert.rejects(store.compareAndSwapDerived(first.id, null, { id: 'wrong' }));
    assert.deepEqual((await store.snapshot()).derived.find(record => record.id === 'unrelated'), { id: 'unrelated', value: 'keep' });
  });

  test(`${name}: duplicate capture and derived IDs reject a direct import atomically`, async (t) => {
    const store = await make(t);
    await store.append(await capture('existing'));
    const before = await store.snapshot();
    const original = await capture('duplicate');
    for (const duplicate of [original, { ...original, text: 'Conflicting incoming original.' }]) {
      await assert.rejects(store.importSnapshot({ captures: [original, duplicate], derived: [derived()], quarantine: [] }), /Duplicate captures ID/);
      assert.deepEqual(await store.snapshot(), before);
    }
    for (const duplicate of [derived(), derived('different')]) {
      await assert.rejects(store.importSnapshot({ captures: [await capture('new')], derived: [derived(), duplicate], quarantine: [] }), /Duplicate derived ID/);
      assert.deepEqual(await store.snapshot(), before);
    }
  });
  test(`${name}: exact JSON records and call-time input isolation`, async (t) => {
    const store = await make(t);
    const record = await capture("quote'; DROP TABLE effort_captures; --\0");
    const expected = structuredClone(record);
    const saving = store.append(record);
    assert.equal(typeof saving.then, 'function');
    record.text = 'changed by caller'; record.metadata.nested.tags.push('changed');
    await saving;
    assert.deepEqual(await store.get(expected.id), expected);
    assert.equal(await store.get('missing'), null);
    const read = await store.get(expected.id);
    read.text = 'changed read'; read.metadata.nested.tags.length = 0;
    const listed = await store.list(); listed[0].metadata.nested.tags.push('changed list');
    const snapshot = await store.snapshot(); snapshot.captures[0].metadata.nested.tags.length = 0;
    assert.deepEqual(await store.get(expected.id), expected);
  });
  test(`${name}: immutable capture IDs and locale-independent ordering`, async (t) => {
    const store = await make(t);
    const ids = ['ä', 'a', 'Z', 'z', 'A', '😀', '\uE000', '\ud800', '\ufffd', 'x\0y', 'x'];
    for (const id of ids) await store.append(await capture(id));
    await store.append(await capture('earlier', 'Earlier.', '2026-01-01T00:00:00.000Z'));
    assert.deepEqual((await store.list()).map((record) => record.id), ['earlier', ...ids.slice().sort()]);
    for (const id of ids) assert.equal((await store.get(id)).id, id);
    const original = await store.get('a');
    await assert.rejects(store.append(await capture('a', 'Replacement.')));
    await assert.rejects(store.append(original));
    assert.deepEqual(await store.get('a'), original);
    assert.equal((await store.list()).length, ids.length + 1);
  });
  test(`${name}: latest detached derived view and exact portable round trip`, async (t) => {
    const source = await make(t), destination = await make(t);
    await source.append(await capture());
    await source.putDerived(derived('old'));
    const view = derived('latest'); const expected = structuredClone(view);
    const writing = source.putDerived(view); view.metadata.value = 'caller changed'; await writing;
    assert.deepEqual((await source.snapshot()).derived, [expected]);
    const detached = await source.snapshot(); detached.derived[0].metadata.value = 'read changed';
    assert.deepEqual((await source.snapshot()).derived, [expected]);
    const bundle = await source.exportBundle(hash);
    await destination.restoreBundle(bundle, hash);
    assert.equal(await destination.exportBundle(hash), bundle);
    await destination.restoreBundle(bundle, hash);
    assert.equal(await destination.exportBundle(hash), bundle);
    const before = await destination.snapshot();
    await assert.rejects(destination.restoreBundle(bundle.replace('Keep', 'Lose'), hash));
    assert.deepEqual(await destination.snapshot(), before);
  });
  test(`${name}: conflict rolls back every new record and keeps destination views`, async (t) => {
    const source = await make(t), destination = await make(t);
    await source.append(await capture('a-new'));
    await source.append(await capture('z-conflict'));
    await source.putDerived(derived('incoming'));
    const bundle = await source.exportBundle(hash);
    await destination.append(await capture('z-conflict', 'Destination original.'));
    const before = await destination.snapshot();
    await assert.rejects(destination.restoreBundle(bundle, hash), /collision|constraint/i);
    assert.deepEqual(await destination.snapshot(), before);
    const fresh = await make(t);
    await fresh.putDerived(derived('destination'));
    const restored = await fresh.restoreBundle(bundle, hash);
    assert.deepEqual(restored.keptExisting, ['view-a']);
    assert.deepEqual((await fresh.snapshot()).derived, [derived('destination')]);
    assert.equal((await fresh.list()).length, 2);
  });
  test(`${name}: quarantine stays separate and restores without multiplication`, async (t) => {
    const source = await make(t), destination = await make(t);
    await source.append(await capture());
    await source.append({ ...await capture('broken'), hash: '0'.repeat(64) });
    const bundle = await source.exportBundle(hash);
    const verified = await source.verifyBundle(bundle, hash);
    assert.equal(verified.quarantine.length, 1);
    await destination.restoreBundle(bundle, hash);
    await destination.restoreBundle(bundle, hash);
    assert.deepEqual((await destination.list()).map((record) => record.id), ['capture-a']);
    assert.deepEqual((await destination.snapshot()).quarantine, verified.quarantine);
    assert.equal(await destination.exportBundle(hash), bundle);
    await source.restoreBundle(bundle, hash);
    await source.restoreBundle(bundle, hash);
    assert.equal(await source.exportBundle(hash), bundle, 'a bad original is not duplicated in quarantine');
    const incoming = { captures: [await capture('direct-import')], derived: [], quarantine: [] };
    const importing = destination.importSnapshot(incoming);
    incoming.captures[0].metadata.nested.tags.push('caller changed'); await importing;
    assert.deepEqual((await destination.get('direct-import')).metadata.nested.tags, ['原文', '🌿']);
  });
}

/** Records no adapter may accept: they either cannot be found again or cannot survive a save and reload. */
const badRecords = () => [
  ['no id', { text: 'x', createdAt: '2026-01-01T00:00:00.000Z' }],
  ['empty id', { id: '', text: 'x' }],
  ['number id', { id: 7, text: 'x' }],
  ['NaN', { id: 'bad-nan', n: NaN }],
  ['Infinity', { id: 'bad-inf', n: Infinity }],
  ['undefined field', { id: 'bad-undefined', x: undefined }],
  ['Date object', { id: 'bad-date', when: new Date(0) }],
  ['nested Date', { id: 'bad-nested', metadata: { list: [{ when: new Date(0) }] } }],
];

export function refusalConformance(name, make) {
  test(`${name}: bad records are refused everywhere and nothing is written`, async (t) => {
    const store = await make(t);
    await store.append(await capture('keep'));
    await store.putDerived({ id: 'keep-view', value: 1 });
    const before = await store.snapshot();
    for (const [label, bad] of badRecords()) {
      await assert.rejects(store.append(bad), undefined, `append: ${label}`);
      await assert.rejects(store.putDerived(bad), undefined, `putDerived: ${label}`);
      const kept = { id: 'keep-view', value: 1 }, next = { id: 'keep-view', value: 2 };
      await assert.rejects(store.compareAndSwapDerived('keep-view', kept, bad), undefined, `cas replacement: ${label}`);
      await assert.rejects(store.compareAndSwapDerived('keep-view', bad, next), undefined, `cas expected: ${label}`);
      await assert.rejects(store.importSnapshot({ captures: [bad], derived: [], quarantine: [] }), undefined, `import capture: ${label}`);
      await assert.rejects(store.importSnapshot({ captures: [], derived: [bad], quarantine: [] }), undefined, `import derived: ${label}`);
      assert.deepEqual(await store.snapshot(), before, `store changed after refusing: ${label}`);
    }
  });
  test(`${name}: a refused import writes none of its good records and the store stays usable`, async (t) => {
    const store = await make(t);
    const before = await store.snapshot();
    const badOne = { id: 'bad-date', when: new Date(0) };
    const incoming = { captures: [await capture('good-one'), badOne], derived: [{ id: 'good-view' }], quarantine: [] };
    await assert.rejects(store.importSnapshot(incoming));
    assert.deepEqual(await store.snapshot(), before);
    await assert.rejects(store.importSnapshot({ captures: [], derived: [], quarantine: [{ kind: 'capture', raw: new Date(0) }] }));
    assert.deepEqual(await store.snapshot(), before);
    await store.append(await capture('after'));
    assert.equal((await store.exportBundle(hash)).length > 0, true);
    assert.deepEqual((await store.list()).map((record) => record.id), ['after']);
  });
}
