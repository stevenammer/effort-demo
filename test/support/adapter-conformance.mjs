import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonical } from '../../packages/core/export.js';
import { services } from './s5-world.mjs';
import { createSpans } from '../../packages/core/spans.js';
import { createMoves, MOVE_SEEDS } from '../../packages/core/moves.js';

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

/** One fixed script of S5 operations. Every adapter must end in exactly this state. */
export const S5_STATE_DIGEST = '81cf4dbbef915a2cc77efcc9f44e0c65a2e593d35555a04342eb802d9640bb1f';
export async function runS5Script(store) {
  const api = services(store);
  await api.spans.createSpan('Practice room');
  const root = await api.spans.post('practice room', '  Cafe\u0301 ☕\r\nKeep \0 every byte.  ', { id: 'fixed-root' });
  const reply = await api.spans.reply(root.id, 'First reply.', { id: 'fixed-reply' });
  await api.spans.reply(reply.id, 'Reply to the reply.', { id: 'fixed-nested' });
  const branch = await api.exploration.explore({ sourceId: root.id, dial: 'WILD', text: 'What if?' }, { id: 'fixed-branch' });
  const child = await api.exploration.explore({ sourceId: root.id, parentId: branch.id, dial: 'NORMAL', text: 'Smaller.', moveId: '00000000-0000-4000-8000-000000000009' }, { id: 'fixed-child' });
  const insight = await api.exploration.distill({ explorationId: child.id, type: 'OPEN TENSION', text: 'Maybe not.' }, { id: 'fixed-open' });
  await api.exploration.prepareProposal({ distillationId: insight.id });
  await api.moves.save({ name: 'Mine', prompt: 'Ask the odd question.', enabled: true }, { id: 'fixed-move' });
  const snapshot = await store.snapshot();
  const byId = (a, b) => a.id < b.id ? -1 : 1;
  return canonical({ captures: snapshot.captures.slice().sort(byId), derived: snapshot.derived.slice().sort(byId) });
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
  ['reply with an undefined parent', { id: 'bad-reply', text: 'x', metadata: { span: 'Learning', parentId: undefined } }],
  ['branch with NaN', { id: 'exploration:bad-branch', kind: 'exploration', dial: 'TIGHT', weight: NaN }],
  ['move revision with a Date', { id: 'move:bad-move:1', kind: 'move', createdAt: new Date(0) }],
];

export function s5Conformance(name, make) {
  test(`${name}: spans, replies, branches and moves are stored and returned identically to every other adapter`, async (t) => {
    const store = await make(t);
    const state = await runS5Script(store);
    assert.equal(await hash(state), S5_STATE_DIGEST);
    const other = await make(t);
    await other.restoreBundle(await store.exportBundle(hash), hash);
    assert.equal(await runS5Read(other), await runS5Read(store));
  });
  test(`${name}: a reply whose words no longer match its hash is quarantined and never listed as a post`, async (t) => {
    const source = await make(t), destination = await make(t);
    const root = await capture('thread-root', 'Root.'); root.metadata = { span: 'Learning' };
    const reply = await capture('thread-reply', 'Original reply.'); reply.metadata = { span: 'Learning', parentId: 'thread-root' };
    await source.append(root); await source.append({ ...reply, text: 'Rewritten reply.' });
    const bundle = await source.exportBundle(hash);
    assert.equal((await source.verifyBundle(bundle, hash)).quarantine.length, 1);
    await destination.restoreBundle(bundle, hash);
    const tree = await services(destination).spans.thread('thread-root');
    assert.deepEqual(tree.replies, []);
    assert.equal((await destination.list()).length, 1);
  });
}
/** Order and repair behaviour of the S5 records, which every adapter must share. */
export function s5RepairConformance(name, make) {
  const at = iso => ({ now: () => iso, id: (() => { let n = 0; return () => `r-${++n}`; })(), hash });
  test(`${name}: Attention Spans and thinking moves come back in one defined order (creation time, then ID)`, async (t) => {
    const store = await make(t);
    const noon = createSpans({ store, ...at('2026-01-01T12:00:00.000Z') }), early = createSpans({ store, ...at('2026-01-01T08:00:00.000Z') });
    for (const spanName of ['Zeta', 'Alpha', 'Mid']) await noon.createSpan(spanName);
    await early.createSpan('Zz early');
    const names = (await noon.listSpans()).spans.map(span => span.name);
    assert.deepEqual(names, ['Unsorted', 'Product demo', 'Learning', 'Proof', 'People', 'Moves', 'Workspace', 'Zz early', 'Alpha', 'Mid', 'Zeta']);
    const moves = createMoves({ store, ...at('2026-01-01T12:00:00.000Z') });
    for (const id of ['zz', 'mm', 'aa']) await moves.save({ name: id, prompt: 'p', enabled: true }, { id });
    assert.deepEqual((await moves.list()).slice(-3).map(move => move.id), ['aa', 'mm', 'zz']);
  });
  test(`${name}: a damaged Attention Span is explained, kept, and can be set aside so the name can be created again`, async (t) => {
    const store = await make(t), api = services(store);
    await api.spans.createSpan('Broken');
    const post = await api.spans.post('Broken', 'Still readable.');
    const saved = (await store.snapshot()).derived.find(record => record.id === 'span:broken');
    const damaged = { ...saved, checksum: '0'.repeat(64) };
    await store.putDerived(damaged);
    for (const attempt of [() => api.spans.createSpan('broken'), () => api.spans.post('Broken', 'More.')]) {
      await assert.rejects(attempt(), error => /damaged/.test(error.message) && !/try again|Create the Attention Span before/i.test(error.message));
    }
    assert.equal((await api.spans.listPosts('Broken')).length, 1);
    assert.equal((await api.spans.thread(post.id)).text, 'Still readable.');
    await assert.rejects(api.spans.setAsideSpan('Nothing here'), /no damaged saved record/);
    assert.deepEqual(await api.spans.setAsideSpan('BROKEN'), { setAside: 'span:broken', name: 'BROKEN' });
    const quarantine = (await store.snapshot()).quarantine;
    assert.equal(quarantine.length, 1);
    assert.deepEqual([quarantine[0].kind, JSON.parse(quarantine[0].raw)], ['derived', damaged]);
    assert.equal((await api.spans.listSpans()).damaged.length, 0);
    assert.equal((await api.spans.createSpan('Broken')).name, 'Broken');
    assert.equal((await api.spans.post('Broken', 'Fresh.')).span, 'Broken');
    assert.equal((await api.spans.listPosts('Broken')).length, 2);
    await assert.rejects(api.spans.setAsideSpan('Broken'), /no damaged saved record/);
    const bundle = await store.exportBundle(hash), verified = await store.verifyBundle(bundle, hash);
    assert.equal(verified.quarantine.length, 1);
    const other = await make(t); await other.restoreBundle(bundle, hash); await other.restoreBundle(bundle, hash);
    assert.equal(await other.exportBundle(hash), bundle);
    assert.equal((await other.snapshot()).quarantine.length, 1);
  });
  test(`${name}: a damaged thinking move is explained and can be set aside without losing earlier wording`, async (t) => {
    const store = await make(t), api = services(store);
    const first = await api.moves.save({ name: 'Mine', prompt: 'One.', enabled: true }, { id: 'mv' });
    const second = await api.moves.save({ moveId: 'mv', name: 'Mine', prompt: 'Two.', enabled: true, expectedLatestId: first.id });
    const third = await api.moves.save({ moveId: 'mv', name: 'Mine', prompt: 'Three.', enabled: true, expectedLatestId: second.id });
    await store.putDerived({ ...second, checksum: '0'.repeat(64) });
    const broken = [() => api.moves.save({ name: 'Again', prompt: 'x', enabled: true }, { id: 'mv' }),
      () => api.moves.save({ moveId: 'mv', name: 'Mine', prompt: 'x', enabled: true, expectedLatestId: third.id }), () => api.moves.snapshot('mv')];
    for (const attempt of broken) await assert.rejects(attempt(), error => /damaged/.test(error.message) && !/another tab|try again/i.test(error.message));
    await assert.rejects(api.moves.setAsideMove('nope'), /no damaged saved record/);
    assert.deepEqual((await api.moves.setAsideMove('mv')).setAside.sort(), [second.id, third.id]);
    assert.equal((await store.snapshot()).quarantine.length, 2);
    const mv = (await api.moves.list()).find(move => move.id === 'mv');
    assert.deepEqual([mv.recovery, mv.prompt, mv.history.length], [false, 'One.', 1]);
    const next = await api.moves.save({ moveId: 'mv', name: 'Mine', prompt: 'Fresh.', enabled: true, expectedLatestId: first.id });
    assert.deepEqual([next.id, next.revision, next.previousId], [second.id, 2, first.id]);
    assert.equal((await api.moves.list()).find(move => move.id === 'mv').prompt, 'Fresh.');
  });
  test(`${name}: recovery refuses a record that changed after inspection instead of setting aside its replacement`, async (t) => {
    for (const kind of ['span', 'move']) {
      const store = await make(t), api = services(store);
      if (kind === 'span') await api.spans.createSpan('Race');
      else await api.moves.save({ name: 'Race', prompt: 'Keep.', enabled: true }, { id: 'race' });
      const healthy = (await store.snapshot()).derived[0];
      const damaged = { ...healthy, checksum: '0'.repeat(64) };
      await store.putDerived(damaged);
      let changed = false;
      const racing = { ...store, async snapshot() {
        const inspected = await store.snapshot();
        if (!changed) { changed = true; await store.putDerived(healthy); }
        return inspected;
      } };
      const recovery = services(racing);
      await assert.rejects(kind === 'span' ? recovery.spans.setAsideSpan('Race') : recovery.moves.setAsideMove('race'), /changed while it was being set aside/);
      const after = await store.snapshot();
      assert.deepEqual(after.derived, [healthy]);
      assert.deepEqual(after.quarantine, []);
    }
  });
  test(`${name}: damage to a built-in move revision blocks it until explicit recovery`, async (t) => {
    const store = await make(t), api = services(store), seed = MOVE_SEEDS[0];
    const first = await api.moves.save({ moveId: seed.id, name: seed.name, prompt: 'My version.', enabled: true });
    await store.putDerived({ ...first, checksum: '0'.repeat(64) });
    assert.equal((await api.moves.list()).find(move => move.id === seed.id).recovery, true);
    await assert.rejects(api.moves.snapshot(seed.id), /damaged/);
    await assert.rejects(api.moves.save({ moveId: seed.id, name: seed.name, prompt: 'Again.', enabled: true }), /damaged/);
    await api.moves.setAsideMove(seed.id);
    assert.equal((await api.moves.snapshot(seed.id)).prompt, seed.prompt);
    await api.moves.save({ moveId: seed.id, name: seed.name, prompt: 'Recovered.', enabled: true });
    assert.equal((await api.moves.snapshot(seed.id)).prompt, 'Recovered.');
    assert.equal((await store.snapshot()).quarantine.length, 1);
  });
  test(`${name}: reply refuses a bad source ID, and a post whose Attention Span is not text is flagged and never built on`, async (t) => {
    const store = await make(t), api = services(store);
    await api.spans.createSpan('Learning');
    const root = await api.spans.post('Learning', 'Root.');
    for (const bad of [{ a: 1 }, '', null, 7, ['x']]) {
      await assert.rejects(api.spans.reply(root.id, 'x', { derivedFromId: bad }), /source of this reply is not valid/);
    }
    assert.equal((await api.spans.reply(root.id, 'ok', { derivedFromId: 'distillation:real' })).parentId, root.id);
    const forged = await capture('forged', 'Forged.'); forged.metadata = { span: { a: 1 } };
    await store.append(forged);
    const view = await api.spans.getPost('forged');
    assert.deepEqual([view.verified, view.span], [false, null]);
    await assert.rejects(api.spans.reply('forged', 'x'), /failed verification/);
    assert.equal((await store.list()).filter(record => record.metadata?.parentId === 'forged').length, 0);
  });
}
async function runS5Read(store) {
  const api = services(store);
  return canonical({ spans: await api.spans.listSpans(), tree: await api.spans.thread('fixed-root'), exploration: await api.exploration.snapshot(), moves: await api.moves.list() });
}

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
