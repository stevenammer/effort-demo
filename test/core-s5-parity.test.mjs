import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createStore } from '../public/store.js';
import { createExploration as createDemoExploration } from '../public/exploration.js';
import { deriveMoves, moveSnapshot } from '../public/thinking.js';
import { spanKey as demoSpanKey } from '../public/spans.js';
import { openDatabase } from '../public/database.js';
import { recoveryRecord } from '../public/records.js';
import { MOVE_SEEDS } from '../packages/core/moves.js';
import { spanKey } from '../packages/core/spans.js';
import { makeStore, services } from './support/s5-world.mjs';

/** The browser demo's own modules, driven through the same small interface as the shared core. */
async function demoWorld() {
  const factory = new IDBFactory(), store = createStore({ indexedDB: factory, legacyStorage: null, broadcast: false });
  await store.seed();
  const db = openDatabase({ factory }), exploration = createDemoExploration({ db, recoveryRecord });
  const seeded = await store.read(), place = await store.holdPlace({ summary: 'Return here.', expected: seeded.now });
  const moves = async () => deriveMoves((await store.read()).moveEvents, []);
  return {
    sampleIds: new Set(seeded.captures.map(c => c.id)),
    createSpan: name => store.createSpan(name),
    post: (span, text, parent) => store.capture(text, span, parent),
    explore: async (sourceId, parentId, dial, text, moveId) => {
      const move = moveId ? moveSnapshot(moveId, (await store.read()).moveEvents, []) : null;
      return exploration.explore({ sourceId, parentId, returnPointId: place.id, dial, text, move });
    },
    distill: (explorationId, type, text) => exploration.distill({ explorationId, type, text }),
    propose: distillationId => store.prepareProposal({ distillationId }),
    saveMove: async (moveId, name, prompt, enabled) => {
      const latest = moveId ? (await moves()).find(m => m.id === moveId).latestId : null;
      return store.saveMove({ moveId, name, prompt, enabled, expectedLatestId: latest });
    },
    staleMove: (moveId, name) => store.saveMove({ moveId, name, prompt: 'p', enabled: true, expectedLatestId: null }),
    async state() {
      const s = await store.read();
      return {
        spans: s.spans.map(x => [x.id, x.name, x.kind]),
        posts: s.captures.filter(c => !c.sample).map(c => ({ id: c.id, text: c.text, span: demoSpanKey(c.span), parent: c.parentId ?? null, derived: c.derivedFromId ?? null })),
        explorations: s.explorations.map(e => ({ id: e.id, source: e.sourceId, parent: e.parentId, dial: e.dial, text: e.text, move: e.move ? [e.move.name, e.move.prompt] : null })),
        distillations: s.distillations.map(d => ({ id: d.id, branch: d.explorationId, type: d.type, text: d.text })),
        moves: (await moves()).map(m => ({ id: m.id, name: m.name, prompt: m.prompt, enabled: m.enabled })),
      };
    },
    close: async () => { await store.close(); await db.close(); },
  };
}

async function coreWorld(t) {
  const store = await makeStore('file', t), api = services(store);
  return {
    sampleIds: new Set(),
    createSpan: name => api.spans.createSpan(name),
    post: (span, text, parent) => parent ? api.spans.reply(parent, text, { span }) : api.spans.post(span, text),
    explore: (sourceId, parentId, dial, text, moveId) => api.exploration.explore({ sourceId, parentId, dial, text, moveId }),
    distill: (explorationId, type, text) => api.exploration.distill({ explorationId, type, text }),
    propose: distillationId => api.exploration.prepareProposal({ distillationId }),
    saveMove: async (moveId, name, prompt, enabled) => {
      const latest = moveId ? (await api.moves.list()).find(m => m.id === moveId).latestId : null;
      return api.moves.save({ moveId, name, prompt, enabled, expectedLatestId: latest });
    },
    staleMove: (moveId, name) => api.moves.save({ moveId, name, prompt: 'p', enabled: true, expectedLatestId: null }),
    async state() {
      const spans = await api.spans.listSpans(), posts = await api.spans.listPosts();
      const exploration = await api.exploration.snapshot();
      return {
        spans: spans.spans.map(x => [x.id, x.name, x.kind]),
        posts: await Promise.all(posts.map(async p => ({ id: p.id, text: p.text, span: spanKey(p.span), parent: p.parentId, derived: (await store.get(p.id)).metadata?.derivedFromId ?? null }))),
        explorations: exploration.explorations.map(e => ({ id: e.id, source: e.sourceId, parent: e.parentId, dial: e.dial, text: e.text, move: e.move ? [e.move.name, e.move.prompt] : null })),
        distillations: exploration.distillations.map(d => ({ id: d.id, branch: d.explorationId, type: d.type, text: d.text })),
        moves: (await api.moves.list()).map(m => ({ id: m.id, name: m.name, prompt: m.prompt, enabled: m.enabled })),
      };
    },
    close: async () => {},
  };
}

/** Replace generated IDs with the order things were made in, so two worlds can be compared. */
function normalise(state, labels) {
  const name = id => id === null || id === undefined ? null : (labels.get(id) ?? `unknown:${id}`);
  return {
    spans: state.spans.slice().sort((a, b) => a[0] < b[0] ? -1 : 1),
    posts: state.posts.map(p => ({ ref: name(p.id), text: p.text, span: p.span, parent: name(p.parent), derived: name(p.derived) })).sort((a, b) => a.ref < b.ref ? -1 : 1),
    explorations: state.explorations.map(e => ({ ref: name(e.id), source: name(e.source), parent: name(e.parent), dial: e.dial, text: e.text, move: e.move })).sort((a, b) => a.ref < b.ref ? -1 : 1),
    distillations: state.distillations.map(d => ({ ref: name(d.id), branch: name(d.branch), type: d.type, text: d.text })).sort((a, b) => a.ref < b.ref ? -1 : 1),
    moves: state.moves.map(m => ({ ref: labels.get(m.id) ?? m.id, name: m.name, prompt: m.prompt, enabled: m.enabled })).sort((a, b) => a.ref < b.ref ? -1 : 1),
  };
}

/** A scripted sequence including refusals. Each step names what it makes so both worlds can be lined up. */
async function drive(world, t) {
  const labels = new Map(), outcomes = [];
  const step = async (label, run, { label: made, key = r => r.id } = {}) => {
    try { const result = await run(); if (made) labels.set(key(result), made); outcomes.push([label, 'ok']); return result; }
    catch (error) { outcomes.push([label, 'refused']); return null; }
  };
  const ref = label => [...labels].find(([, v]) => v === label)?.[0];
  await step('create span', () => world.createSpan('  Practice   room '));
  await step('create same span again', () => world.createSpan('practice ROOM'));
  await step('create bad span', () => world.createSpan('x'));
  await step('post', () => world.post('Practice room', '  Exact\r\nwords  ', undefined), { label: 'p1' });
  await step('post in missing span', () => world.post('Nowhere', 'text'));
  await step('post blank', () => world.post('Learning', '   '));
  await step('reply', () => world.post('Practice room', 'A reply.', ref('p1')), { label: 'p2' });
  await step('nested reply', () => world.post('Practice room', 'Nested.', ref('p2')), { label: 'p3' });
  await step('reply in the wrong span', () => world.post('Learning', 'Wrong.', ref('p1')));
  await step('post in Learning', () => world.post('Learning', 'Elsewhere.'), { label: 'p4' });
  await step('explore sandbox', () => world.explore(ref('p1'), null, 'UNHINGED SANDBOX', 'Strange.'), { label: 'b1' });
  await step('explore under it', () => world.explore(ref('p1'), ref('b1'), 'NORMAL', 'Careful.'), { label: 'b2' });
  await step('explore bad dial', () => world.explore(ref('p1'), null, 'LOUD', 'x'));
  await step('explore under a branch of another thought', () => world.explore(ref('p4'), ref('b1'), 'TIGHT', 'x'));
  await step('explore blank', () => world.explore(ref('p1'), null, 'TIGHT', ' '));
  await step('distill insight', () => world.distill(ref('b2'), 'INSIGHT', '  It helps.\r\n'), { label: 'd1' });
  await step('distill open tension', () => world.distill(ref('b1'), 'OPEN TENSION', 'Unsure.'), { label: 'd2' });
  await step('distill weird', () => world.distill(ref('b1'), 'WEIRD BUT ALIVE', 'Alive.'), { label: 'd3' });
  await step('distill bad type', () => world.distill(ref('b2'), 'COMMITMENT', 'x'));
  await step('distill blank', () => world.distill(ref('b2'), 'NOISE', ''));
  await step('propose from sandbox', () => world.propose(ref('d3')));
  await step('propose', async () => { const r = await world.propose(ref('d1')); return r; }, { label: 'p5' });
  const seed = MOVE_SEEDS[8].id;
  await step('edit a move', () => world.saveMove(seed, 'SMALL PROOF', 'Cheapest test?', true));
  await step('explore with a move', () => world.explore(ref('p1'), null, 'WILD', 'With a move.', seed), { label: 'b3' });
  await step('turn the move off', () => world.saveMove(seed, 'SMALL PROOF', 'Cheapest test?', false));
  await step('explore with a turned-off move', () => world.explore(ref('p1'), null, 'WILD', 'Nope.', seed));
  await step('stale move edit', () => world.staleMove(seed, 'Stale'));
  await step('new custom move', () => world.saveMove(null, 'Mine', 'Ask the odd thing.', true), { label: 'm-custom', key: r => r.moveId });
  return { labels, outcomes };
}

test('parity: the shared core ends in the same state as the browser demo modules for a scripted sequence, refusals included', async t => {
  const demo = await demoWorld(), core = await coreWorld(t);
  t.after(() => demo.close());
  const a = await drive(demo, t), b = await drive(core, t);
  assert.deepEqual(b.outcomes, a.outcomes, 'the same steps are accepted and refused');
  assert.ok(a.outcomes.filter(([, r]) => r === 'refused').length >= 10);
  const demoState = await demo.state(), coreState = await core.state();
  // The demo's seeded sample thought is not part of the script.
  demoState.posts = demoState.posts.filter(p => !demo.sampleIds.has(p.id));
  const left = normalise(demoState, a.labels), right = normalise(coreState, b.labels);
  const customDemo = left.moves.find(m => m.name === 'Mine'), customCore = right.moves.find(m => m.name === 'Mine');
  assert.ok(customDemo && customCore);
  assert.deepEqual(right, left);
  assert.deepEqual([left.posts.length, left.explorations.length, left.distillations.length], [5, 3, 3]);
  assert.equal(left.moves.length, 10);
  const proposalPost = left.posts.find(p => p.ref === 'p5');
  assert.equal(proposalPost.text, '  It helps.\r\n'); assert.equal(proposalPost.parent, 'p1'); assert.equal(proposalPost.span, 'practice room');
  assert.equal(proposalPost.derived, 'd1', 'both link a proposal to the distillation it came from');
});
