import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '../packages/core/export.js';
import { DISTILLATION_TYPES, EXPLORATION_DIALS } from '../packages/core/exploration.js';
import { MOVE_SEEDS } from '../packages/core/moves.js';
import { spanKey, threadRoot } from '../packages/core/spans.js';
import { createFileStore } from '../packages/storage/file.js';
import { KINDS, hasSqlite, hash, human, makeStore, services, spyOn } from './support/s5-world.mjs';

const skip = kind => kind === 'sqlite' && !hasSqlite;
const EXACT = '  Café ☕\r\nKeep \0 every byte.  \n';
const CONTINUITY_ID = 'effort.continuity.v1';

async function story(store, api = services(store)) {
  const span = await api.spans.createSpan('  Practice   room ');
  const root = await api.spans.post('practice room', EXACT);
  const reply = await api.spans.reply(root.id, 'First reply.');
  const nested = await api.spans.reply(reply.id, 'Reply to the reply.');
  const branch = await api.exploration.explore({ sourceId: root.id, dial: 'WILD', text: 'What if it went the other way?' });
  const child = await api.exploration.explore({ sourceId: root.id, parentId: branch.id, dial: 'NORMAL', text: 'Smaller version.', moveId: MOVE_SEEDS[8].id });
  const insight = await api.exploration.distill({ explorationId: child.id, type: 'INSIGHT', text: 'The small one is enough.' });
  const proposal = await api.exploration.prepareProposal({ distillationId: insight.id });
  return { api, span, root, reply, nested, branch, child, insight, proposal };
}

for (const kind of KINDS) {
  test(`${kind}: spans, threads, branches, distillations and proposals round trip with the original words exact`, { skip: skip(kind) }, async t => {
    const store = await makeStore(kind, t), s = await story(store);
    assert.equal(s.span.name, 'Practice room');
    assert.equal(s.root.text, EXACT);
    assert.equal((await store.get(s.root.id)).hash, await hash(EXACT));
    const tree = await s.api.spans.thread(s.nested.id);
    assert.equal(tree.id, s.root.id);
    assert.deepEqual(tree.replies.map(r => r.id).sort(), [s.reply.id, s.proposal.id].sort());
    assert.equal(tree.replies.find(r => r.id === s.reply.id).replies[0].id, s.nested.id);
    assert.ok(tree.replies.every(r => r.verified) && tree.verified);
    assert.equal(s.proposal.text, 'The small one is enough.');
    assert.equal((await store.get(s.proposal.id)).metadata.derivedFromId, s.insight.id);
    const before = await store.snapshot(), bundle = await store.exportBundle(hash);
    for (const other of KINDS.filter(k => !skip(k))) {
      const target = await makeStore(other, t);
      await target.restoreBundle(bundle, hash);
      assert.equal(await target.exportBundle(hash), bundle, `${kind} to ${other}`);
      const again = await target.restoreBundle(bundle, hash);
      assert.equal(await target.exportBundle(hash), bundle, 'second restore adds nothing');
      assert.deepEqual(again.keptExisting.sort(), again.keptExisting.slice().sort());
      const read = services(target);
      assert.deepEqual((await read.spans.thread(s.root.id)), tree);
      assert.deepEqual((await read.exploration.snapshot()), await s.api.exploration.snapshot());
      assert.deepEqual((await read.spans.listSpans()).spans, (await s.api.spans.listSpans()).spans);
      const sorted = snap => canonical({ captures: snap.captures, derived: snap.derived.slice().sort((x, y) => x.id < y.id ? -1 : 1), quarantine: snap.quarantine });
      assert.equal(sorted(await target.snapshot()), sorted(before));
    }
  });

  test(`${kind}: an effort-export/1 bundle made before this slice still verifies and restores`, { skip: skip(kind) }, async t => {
    const bundle = await readFile(new URL('./fixtures/effort-export-1-pre-s5.json', import.meta.url), 'utf8');
    const store = await makeStore(kind, t);
    const verified = await store.verifyBundle(bundle, hash);
    assert.equal(verified.captures.length, 2); assert.equal(verified.quarantine.length, 1);
    await store.restoreBundle(bundle, hash);
    assert.equal(await store.exportBundle(hash), bundle);
    const api = services(store);
    assert.equal((await api.continuity.snapshot()).commitments[0].state, 'ACTIVE');
    assert.equal((await api.spans.listPosts('unsorted')).length, 2, 'plain captures read as Unsorted');
    assert.deepEqual((await api.spans.listSpans()).spans.filter(x => x.createdAt).length, 0);
    await api.spans.post('Learning', 'Added after the old backup.');
    await store.restoreBundle(bundle, hash);
    assert.equal((await api.spans.listPosts('Learning')).length, 1, 'restore only adds');
  });
}

test('restoring a backup into a store that already has other spans and branches keeps both', async t => {
  const a = await makeStore('file', t), b = await makeStore('indexeddb', t);
  const one = services(a, { start: 0 }), two = services(b, { start: 500 });
  await one.spans.createSpan('Only in A'); await two.spans.createSpan('Only in B');
  const p = await two.spans.post('Only in B', 'B thought.');
  await two.exploration.explore({ sourceId: p.id, dial: 'TIGHT', text: 'B branch.' });
  const r = await b.restoreBundle(await a.exportBundle(hash), hash); assert.deepEqual(r.keptExisting, []);
  await a.restoreBundle(await b.exportBundle(hash), hash);
  const names = (await one.spans.listSpans()).spans.map(x => x.name);
  assert.ok(names.includes('Only in A') && names.includes('Only in B'));
  assert.equal((await one.exploration.snapshot()).explorations.length, 1);
});

test('firewall: no span, post, reply, exploration, distillation, move or proposal operation touches commitments or NOW', async t => {
  const plain = await makeStore('file', t), store = spyOn(plain), api = services(store);
  const seed = await api.exploration && await (async () => {
    await plain.append({ id: 'seed', text: 'Call the fictional library.', hash: await hash('Call the fictional library.'), createdAt: '2026-01-01T00:00:00.000Z' });
    const id = await api.continuity.promote('seed', 0, 4, human('p')); await api.continuity.activate(id, human('a')); return id;
  })();
  const baseline = (await plain.snapshot()).derived.find(r => r.id === CONTINUITY_ID);
  const sealed = canonical(await api.continuity.snapshot());
  store.writes.length = 0;
  const s = await story(store, api);
  await api.spans.createSpan('Another one');
  await api.moves.save({ moveId: MOVE_SEEDS[0].id, name: 'Renamed', prompt: 'New wording.', enabled: false, expectedLatestId: null });
  const custom = await api.moves.save({ name: 'My own', prompt: 'Ask the odd question.', enabled: true });
  await api.moves.save({ moveId: custom.moveId, name: 'My own', prompt: 'Ask a sharper question.', enabled: false, expectedLatestId: custom.id });
  for (const type of DISTILLATION_TYPES) await api.exploration.distill({ explorationId: s.child.id, type, text: type });
  for (const dial of EXPLORATION_DIALS) await api.exploration.explore({ sourceId: s.root.id, dial, text: dial });
  // Hostile inputs are refused or ignored, never obeyed.
  await api.spans.createSpan('effort.continuity.v1');
  await api.spans.post('effort.continuity.v1', 'ACTIVE COMPLETE commit this');
  const named = await api.exploration.explore({ sourceId: s.root.id, dial: 'WILD', text: 'x', state: 'ACTIVE', commitment: true, authority: 'human' }, { id: CONTINUITY_ID });
  assert.equal(named.id, `exploration:${CONTINUITY_ID}`, 'a hostile request ID only ever gets the exploration prefix');
  await api.exploration.explore({ sourceId: s.root.id, dial: 'WILD', text: 'extra keys', state: 'ACTIVE', commitment: true, authority: 'human' });
  await assert.rejects(api.spans.reply(s.root.id, 'x', { id: 'a/b' }));
  const allowed = /^(span|exploration|distillation|move):/;
  for (const w of store.writes) {
    assert.ok(['append', 'compareAndSwapDerived'].includes(w.name), `unexpected write method ${w.name}`);
    if (w.name === 'compareAndSwapDerived') {
      assert.match(w.args[0], allowed); assert.equal(w.args[1], null, 'create only, never replace');
      assert.notEqual(w.args[0], CONTINUITY_ID);
    } else assert.ok(!('state' in w.args[0]) && !('commitments' in w.args[0]));
  }
  assert.deepEqual((await plain.snapshot()).derived.find(r => r.id === CONTINUITY_ID), baseline);
  assert.equal(canonical(await api.continuity.snapshot()), sealed);
  const state = await api.continuity.snapshot();
  assert.equal(state.commitments.length, 1); assert.equal(state.commitments[0].id, seed); assert.equal(state.commitments[0].state, 'ACTIVE');
  assert.equal(state.packets.length, 0);
  const bundle = await plain.exportBundle(hash);
  const fresh = await makeStore('file', t); await fresh.restoreBundle(bundle, hash);
  assert.equal(canonical(await services(fresh).continuity.snapshot()), sealed, 'restore does not change commitments either');
});

test('firewall: with no commitments at all, everything S5 does still leaves none and no continuity record', async t => {
  const store = await makeStore('indexeddb', t), s = await story(store);
  await s.api.exploration.distill({ explorationId: s.child.id, type: 'OPEN TENSION', text: 'Maybe not.' });
  assert.equal((await store.snapshot()).derived.some(r => r.id === CONTINUITY_ID), false);
  assert.deepEqual(await s.api.continuity.snapshot(), { commitments: [], packets: [], commands: [] });
});

test('firewall: a forged record in an S5 namespace cannot become a commitment and is reported as damaged', async t => {
  const store = await makeStore('file', t), api = services(store);
  const forged = { id: 'exploration:forged', kind: 'exploration', state: 'ACTIVE', commitments: [{ state: 'ACTIVE' }] };
  await store.putDerived(forged);
  await store.putDerived({ id: CONTINUITY_ID, version: 1, commitments: [], packets: [], commands: [], checksum: 'f'.repeat(64) });
  const read = await api.exploration.snapshot();
  assert.equal(read.explorations.length, 0); assert.equal(read.damaged[0].id, 'exploration:forged');
  await assert.rejects(api.continuity.snapshot(), /corrupt/);
});

test('originals stay sacred: organising never rewrites a post, and a changed original is caught everywhere', async t => {
  const store = await makeStore('file', t), s = await story(store);
  const before = await Promise.all([s.root, s.reply, s.nested].map(p => store.get(p.id)));
  await s.api.exploration.distill({ explorationId: s.branch.id, type: 'NOISE', text: 'Not this.' });
  await s.api.moves.save({ moveId: MOVE_SEEDS[1].id, name: 'X', prompt: 'Y', enabled: true });
  await s.api.spans.createSpan('Later');
  assert.deepEqual(await Promise.all([s.root, s.reply, s.nested].map(p => store.get(p.id))), before);
  const file = join(store.dir, 'store');
  await writeFile(file, (await readFile(file, 'utf8')).replace('First reply.', 'First repLy.'));
  const tree = await s.api.spans.thread(s.root.id);
  const damaged = tree.replies.find(r => r.id === s.reply.id);
  assert.equal(damaged.verified, false); assert.equal(damaged.text, 'First repLy.', 'shown, flagged, not hidden or fixed');
  assert.equal(tree.verified, true);
  await assert.rejects(s.api.spans.reply(s.reply.id, 'Under a changed post.'), /failed verification/);
  await writeFile(file, (await readFile(file, 'utf8')).replace('Every byte', 'x').replace('every byte', 'EVERY BYTE'));
  await assert.rejects(s.api.exploration.explore({ sourceId: s.root.id, dial: 'TIGHT', text: 'On a changed original.' }), /failed verification/);
  await assert.rejects(s.api.spans.reply(s.root.id, 'Also refused.'), /failed verification/);
  const bundle = await createFileStore(file).exportBundle(hash);
  const fresh = await makeStore('file', t);
  const restored = await fresh.restoreBundle(bundle, hash);
  assert.ok(restored.quarantine.length >= 2, 'changed originals go to quarantine, never into threads');
  assert.equal((await services(fresh).spans.listPosts('practice room')).some(p => p.text === 'First repLy.'), false);
});

test('Attention Span names follow the demo rules and posts need an existing span', async t => {
  const api = services(await makeStore('file', t));
  for (const bad of ['x', 'a'.repeat(41), '', '   ', 'bell\u0007here', 7, null]) await assert.rejects(api.spans.createSpan(bad), /between 2 and 40/);
  assert.equal(spanKey('  Ünsorted́  Two '), spanKey('ünsorted́ two'));
  const one = await api.spans.createSpan('Proof'); assert.equal(one.kind, 'proof');
  assert.deepEqual((await api.spans.listSpans()).spans.map(s => s.id).slice(0, 7), ['unsorted', 'product demo', 'learning', 'proof', 'people', 'moves', 'workspace']);
  const a = await api.spans.createSpan('Same  Name'), b = await api.spans.createSpan('same name');
  assert.deepEqual(a, b);
  await assert.rejects(api.spans.post('Missing span', 'text'), /Create the Attention Span/);
  for (const text of ['', '   ', 'x'.repeat(4001), 'lone \ud800 surrogate', 5]) await assert.rejects(api.spans.post('Learning', text), /between 1 and 4,000/);
  assert.equal((await api.spans.post('Learning', 'x'.repeat(4000))).text.length, 4000);
});

test('replies stay in their parent span, need a real verified parent, and can be retried safely', async t => {
  const api = services(await makeStore('file', t));
  const root = await api.spans.post('Learning', 'Root.');
  await assert.rejects(api.spans.reply(root.id, 'Wrong place.', { span: 'Proof' }), /original Attention Span/);
  await assert.rejects(api.spans.reply('nope', 'Nobody home.'), /not found/);
  const a = await api.spans.reply(root.id, 'Same.', { id: 'retry-1' }), b = await api.spans.reply(root.id, 'Same.', { id: 'retry-1' });
  assert.deepEqual(a, b);
  await assert.rejects(api.spans.reply(root.id, 'Different.', { id: 'retry-1' }), /different writing/);
  assert.equal((await api.spans.thread(root.id)).replies.length, 1);
  assert.equal((await api.spans.getPost(a.id)).span, 'Learning');
});

test('threads survive an orphan reply and a loop in the saved links', async t => {
  const store = await makeStore('file', t), api = services(store);
  const mk = async (id, parentId) => ({ id, text: id, hash: await hash(id), createdAt: '2026-01-01T00:00:00.000Z', metadata: { span: 'Learning', ...(parentId ? { parentId } : {}) } });
  await store.append(await mk('orphan', 'gone'));
  await store.append(await mk('loop-a', 'loop-b')); await store.append(await mk('loop-b', 'loop-a'));
  assert.equal((await api.spans.thread('orphan')).id, 'orphan');
  const loop = await api.spans.thread('loop-a'); assert.ok(loop.id === 'loop-a');
  assert.equal(threadRoot({ id: 'loop-a', metadata: { parentId: 'loop-b' } }, [{ id: 'loop-a', metadata: { parentId: 'loop-b' } }, { id: 'loop-b', metadata: { parentId: 'loop-a' } }]), null);
});

test('exploration refuses bad dials, types, sources, parents and unknown moves; retries are idempotent', async t => {
  const store = await makeStore('file', t), s = await story(store), x = s.api.exploration;
  const base = { sourceId: s.root.id, dial: 'TIGHT', text: 'Branch.' };
  await assert.rejects(x.explore({ ...base, dial: 'LOUD' }), /Choose a dial/);
  await assert.rejects(x.explore({ ...base, text: '  ' }), /between 1 and 4,000/);
  await assert.rejects(x.explore({ ...base, sourceId: 'nothing' }), /not found/);
  await assert.rejects(x.explore({ ...base, parentId: 'exploration:nope' }), /not found on this thought/);
  const other = await s.api.spans.post('Learning', 'A different thought.');
  await assert.rejects(x.explore({ ...base, sourceId: other.id, parentId: s.branch.id }), /not found on this thought/);
  await assert.rejects(x.explore({ ...base, moveId: 'missing-move' }), /unavailable or turned off/);
  await assert.rejects(x.distill({ explorationId: s.child.id, type: 'COMMITMENT', text: 'No automatic action.' }), /distillation types/);
  await assert.rejects(x.distill({ explorationId: 'exploration:nope', type: 'INSIGHT', text: 'x' }), /not found/);
  const a = await x.explore(base, { id: 'once' }), b = await x.explore(base, { id: 'once' });
  assert.deepEqual(a, b);
  await assert.rejects(x.explore({ ...base, text: 'Changed.' }, { id: 'once' }), /different exploration record/);
  assert.equal(a.author, 'self');
  const sandbox = await x.explore({ ...base, dial: 'UNHINGED SANDBOX' }), idea = await x.distill({ explorationId: sandbox.id, type: 'WEIRD BUT ALIVE', text: 'Alive.' });
  await assert.rejects(x.prepareProposal({ distillationId: idea.id }), /Leave the sandbox/);
  assert.equal((await store.list()).filter(r => r.metadata?.derivedFromId === idea.id).length, 0);
  assert.deepEqual(await x.prepareProposal({ distillationId: s.insight.id }), s.proposal, 'proposals are idempotent');
  await assert.rejects(x.prepareProposal({ distillationId: 'nope' }), /not found/);
});

test('moves: seeds, versioned wording, switching off, stale edits refused, branches keep the wording they used', async t => {
  const store = await makeStore('file', t), api = services(store);
  assert.equal((await api.moves.list()).length, 9);
  const first = await api.moves.save({ moveId: MOVE_SEEDS[8].id, name: 'SMALL PROOF', prompt: 'Cheapest test?', enabled: true });
  assert.equal(first.revision, 1); assert.equal(first.previousId, null);
  await assert.rejects(api.moves.save({ moveId: MOVE_SEEDS[8].id, name: 'SMALL PROOF', prompt: 'Stale.', enabled: true }), /changed in another tab/);
  const src = await api.spans.post('Learning', 'Thought.');
  const branch = await api.exploration.explore({ sourceId: src.id, dial: 'NORMAL', text: 'Try it.', moveId: MOVE_SEEDS[8].id });
  assert.equal(branch.move.prompt, 'Cheapest test?'); assert.equal(branch.move.revisionId, first.id);
  const off = await api.moves.save({ moveId: MOVE_SEEDS[8].id, name: 'SMALL PROOF', prompt: 'Changed wording.', enabled: false, expectedLatestId: first.id });
  assert.equal(off.revision, 2); assert.equal(off.previousId, first.id);
  await assert.rejects(api.exploration.explore({ sourceId: src.id, dial: 'NORMAL', text: 'Again.', moveId: MOVE_SEEDS[8].id }), /unavailable or turned off/);
  assert.equal((await api.exploration.snapshot()).explorations.find(b => b.id === branch.id).move.prompt, 'Cheapest test?');
  await assert.rejects(api.moves.save({ moveId: 'not-a-move', name: 'n', prompt: 'p', enabled: true }), /not found/);
  await assert.rejects(api.moves.save({ name: 'n'.repeat(121), prompt: 'p', enabled: true }), /name/);
  await assert.rejects(api.moves.save({ name: 'n', prompt: ' ', enabled: true }), /prompt/);
  await assert.rejects(api.moves.save({ name: 'n', prompt: 'p', enabled: 'yes' }), /turned on/);
  const history = (await api.moves.list()).find(m => m.id === MOVE_SEEDS[8].id).history;
  assert.deepEqual(history.map(h => h.prompt), ['Cheapest test?', 'Changed wording.']);
});

test('moves: a broken revision chain turns the move off and asks for recovery, and a forged branch move is damaged', async t => {
  const store = await makeStore('file', t), api = services(store);
  const first = await api.moves.save({ moveId: MOVE_SEEDS[0].id, name: 'T', prompt: 'p', enabled: true });
  const forged = { ...first, id: `move:${MOVE_SEEDS[0].id}:2`, revision: 2, previousId: 'not-the-first' };
  await store.putDerived({ ...forged, checksum: await hash(canonical(forged)) });
  const move = (await api.moves.list()).find(m => m.id === MOVE_SEEDS[0].id);
  assert.equal(move.recovery, true); assert.equal(move.enabled, false);
  await assert.rejects(api.moves.snapshot(MOVE_SEEDS[0].id), /unavailable/);
  await assert.rejects(api.moves.save({ moveId: MOVE_SEEDS[0].id, name: 'T', prompt: 'p', enabled: true, expectedLatestId: first.id }), /recovery/);
});

test('damaged and altered saved records are reported, their dependents are held back, nothing throws away the rest', async t => {
  const store = await makeStore('file', t), s = await story(store);
  const snap = await store.snapshot(), record = snap.derived.find(r => r.id === s.branch.id);
  const file = join(store.dir, 'store');
  await writeFile(file, (await readFile(file, 'utf8')).replace('What if it went the other way?', 'What if it went some other way?'));
  const read = await s.api.exploration.snapshot();
  assert.ok(read.damaged.some(d => d.id === record.id));
  assert.ok(read.damaged.some(d => d.id === s.child.id), 'the child of a damaged branch is held back');
  assert.ok(read.damaged.some(d => d.id === s.insight.id), 'and so is its distillation');
  assert.equal(read.explorations.length, 0);
  await assert.rejects(s.api.exploration.distill({ explorationId: s.branch.id, type: 'INSIGHT', text: 'x' }), /not found or needs recovery/);
  assert.equal((await s.api.spans.thread(s.root.id)).verified, true, 'the thread itself is untouched');
  assert.equal((await s.api.spans.listSpans()).damaged.length, 0);
});

test('the write gate only creates records under its own prefixes and never replaces one', async t => {
  const { createGate } = await import('../packages/core/sealed.js');
  const store = await makeStore('indexeddb', t), gate = createGate(store, ['mine:']);
  await assert.rejects(gate.create({ id: CONTINUITY_ID, version: 1 }), /only write its own records/);
  assert.equal(await gate.create({ id: 'mine:a', x: 1 }), true);
  assert.equal(await gate.create({ id: 'mine:a', x: 2 }), false, 'a second create does not overwrite');
  assert.deepEqual((await store.snapshot()).derived, [{ id: 'mine:a', x: 1 }]);
  assert.deepEqual(await gate.mine(), [{ id: 'mine:a', x: 1 }]);
});

test('a store that does not return what was written is caught before success is reported', async t => {
  const store = await makeStore('file', t), api = services(store);
  const lying = { ...store, get: async id => { const found = await store.get(id); return found && id.startsWith('lie-') ? { ...found, metadata: { ...found.metadata, span: 'Proof' } } : found; } };
  const liar = services(lying);
  await assert.rejects(liar.spans.post('Learning', 'Saved as typed.', { id: 'lie-1' }), /read back exactly/);
  assert.equal((await api.spans.post('Learning', 'Fine.', { id: 'honest-1' })).text, 'Fine.');
});

test('a changed field in a saved branch is caught by its checksum, not only changed words', async t => {
  const store = await makeStore('file', t), s = await story(store);
  const file = join(store.dir, 'store');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"dial":"WILD"', '"dial":"TIGHT"'));
  const read = await s.api.exploration.snapshot();
  assert.ok(read.damaged.some(d => d.id === s.branch.id));
  assert.equal(read.explorations.some(b => b.id === s.branch.id), false);
});

test('a forged loop of branches, with valid checksums, is held back along with everything under it', async t => {
  const store = await makeStore('file', t), s = await story(store);
  const forge = async (name, parentId) => {
    const body = { id: `exploration:${name}`, kind: 'exploration', sourceId: s.root.id, parentId, dial: 'TIGHT', text: name, textHash: await hash(name), move: null, author: 'self', createdAt: '2026-01-01T00:00:00.000Z' };
    await store.putDerived({ ...body, checksum: await hash(canonical(body)) });
  };
  await forge('loop-a', 'exploration:loop-b'); await forge('loop-b', 'exploration:loop-a'); await forge('under-loop', 'exploration:loop-a');
  const read = await s.api.exploration.snapshot();
  for (const name of ['loop-a', 'loop-b', 'under-loop']) assert.ok(read.damaged.some(d => d.id === `exploration:${name}`), name);
  assert.equal(read.explorations.length, 2, 'the real branches are untouched');
});
