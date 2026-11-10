import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { createCapture } from '../packages/core/capture.js';
import { createContinuity } from '../packages/core/continuity.js';
import { createFileStore } from '../packages/storage/file.js';
import { createIndexedDbStore } from '../packages/storage/indexeddb.js';
import { createSqliteStore } from '../packages/storage/sqlite.js';
import { shouldInterrupt, budgeted } from '../packages/core/interrupt.js';
import { frictionFor, isNight } from '../packages/core/night.js';
import { runCli } from '../apps/cli/lib.mjs';
const hash = async s => createHash('sha256').update(s).digest('hex');
const instant = '2026-01-01T12:00:00.000Z';
const human = commandId => ({ authority: 'human', commandId });
let sequence = 0;
function service(store) { return createContinuity({ store, hash, now: () => instant, id: () => `id-${++sequence}` }); }
async function temp(t) { const p = await mkdtemp(join(tmpdir(), 'effort-s4-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }
let hasSqlite = true;
try { await import('node:sqlite'); } catch (error) { if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') hasSqlite = false; else throw error; }
for (const kind of ['file','indexeddb','sqlite']) test(`${kind} atomic compare and swap and lifecycle`, { skip: kind === 'sqlite' && !hasSqlite }, async t => {
  const dir = await temp(t);
  const store = kind === 'file' ? createFileStore(join(dir, 'store')) : kind === 'indexeddb' ? createIndexedDbStore({ factory: indexedDB, name: `s4-${++sequence}` }) : await createSqliteStore(join(dir, 'store.db'));
  t.after(() => store.close?.());
  const a = { id: 'test', x: 1 }, b = { id: 'test', x: 2 }, c = { id: 'test', x: 3 };
  assert.equal(await store.compareAndSwapDerived('test', null, a), true);
  assert.deepEqual((await Promise.all([store.compareAndSwapDerived('test', a, b), store.compareAndSwapDerived('test', a, c)])).sort(), [false, true]);
  await assert.rejects(store.compareAndSwapDerived('test', null, { id: 'wrong' }));
  const capture = await createCapture({ id: 'capture', text: 'First 🐈 action and second', createdAt: instant }, hash); await store.append(capture);
  const api = service(store);
  await assert.rejects(api.promote('capture', 0, 5, { commandId: 'bad' }));
  await assert.rejects(api.promote('capture', 0, 5, { ...human('sandbox'), dial: 'UNHINGED' }));
  const one = await api.promote('capture', 0, 5, human('p1'));
  assert.equal(await api.promote('capture', 0, 5, human('p2')), one);
  assert.equal((await api.snapshot()).commitments[0].state, 'COMMITTED');
  const two = await api.promote('capture', 6, 15, human('p3'));
  await Promise.all([api.activate(one, human('a1')), api.activate(two, human('a2'))]);
  let state = await api.snapshot(); assert.equal(state.commitments.filter(x => x.state === 'ACTIVE').length, 1);
  const active = state.commitments.find(x => x.state === 'ACTIVE');
  const context = { position: 0 }; const pending = api.hold({ summary: 'keep this', context }, human('h1')); context.position = 2; const packet = await pending;
  state = await api.snapshot(); assert.equal(state.packets[0].context.position, 0);
  await api.complete(active.id, 'finished exactly', human('c1'));
  assert.equal(await api.complete(active.id, 'finished exactly', human('c1')), active.id);
  await assert.rejects(api.resume(packet, human('r1')));
  state = await api.snapshot(); const receipt = state.commitments.find(x => x.id === active.id).history.at(-1);
  assert.equal(receipt.receipt, 'self-report'); assert.equal(receipt.note, 'finished exactly'); assert.equal(receipt.at, instant);
  assert.deepEqual(await store.get('capture'), capture);
  const bundle = await store.exportBundle(hash); const other = createFileStore(join(dir, 'restored')); await other.restoreBundle(bundle, hash);
  assert.deepEqual(await service(other).snapshot(), state);
});
test('policies respect time, quiet hours, budgets, dismissals and invalid dials', () => {
  const noon = new Date(2026, 0, 1, 12).getTime(), ctx = { now: noon, dial: 'normal' }, candidate = { key: 'a', type: 'task' };
  assert.equal(shouldInterrupt(candidate, ctx).allow, true);
  assert.equal(shouldInterrupt(candidate, { ...ctx, activeCommitment: true }).allow, false);
  assert.equal(shouldInterrupt(candidate, { ...ctx, recentDismissals: [{ type: 'task', at: noon }] }).allow, false);
  assert.equal(budgeted([candidate, { ...candidate, key: 'b' }], ctx).length, 1);
  assert.equal(budgeted([candidate, candidate, candidate], { ...ctx, dial: 'loud' }).length, 1);
  assert.throws(() => budgeted([], { now: noon, dial: 'bad' }));
  assert.equal(isNight(new Date(2026, 0, 1, 12), 6, 6), false);
  assert.equal(isNight(new Date(2026, 0, 1, 23)), true); assert.equal(isNight(new Date(2026, 0, 1, 6)), false);
  assert.equal(frictionFor({ date: new Date(2026, 0, 1, 23), action: 'tomorrow-first-step' }), null);
  assert.throws(() => shouldInterrupt(candidate, { now: 0, dial: 'unknown' }));
  assert.throws(() => frictionFor({ date: new Date(NaN), action: 'capture' }));
});
test('CLI uses explicit activation on real files', async t => {
  const home = await temp(t), output = [];
  const run = (...args) => runCli(args, { home, output: line => output.push(line) });
  await run('capture', 'one action'); const capture = output.at(-1).split(' ')[1];
  await run('now'); assert.match(output.at(-1), /No active/);
  await run('promote', capture, '0', '3'); const id = output.at(-1).split(' ')[1];
  await run('now'); assert.match(output.at(-1), /No active/);
  await run('activate', id); await run('now'); assert.match(output.at(-1), /one/);
  await run('complete', id, 'done'); assert.match(output.at(-1), /self-reported/);
});
test('seeded action sequences preserve originals, a single active item, receipts, and return paths', async t => {
  const dir = await temp(t), store = createFileStore(join(dir, 'store')), api = service(store);
  const source = await createCapture({ id: 'original', text: 'alpha beta gamma delta', createdAt: instant }, hash); await store.append(source);
  let seed = 1729; const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let command = 0; const auth = () => human(`property-${++command}`);
  const slices = [[0,5],[6,10],[11,16],[17,22]];
  for (let i = 0; i < 50; i++) {
    const state = await api.snapshot(), open = state.commitments.filter(c => ['ACTIVE','COMMITTED'].includes(c.state)), active = open.find(c => c.state === 'ACTIVE');
    const choice = rand(5);
    if (choice === 0) { const [a,b] = slices[rand(slices.length)]; await api.promote(source.id, a, b, auth()); }
    else if (choice === 1 && open.length) await api.activate(open[rand(open.length)].id, auth());
    else if (choice === 2 && active) { const packet = await api.hold({ summary: `return ${i}` }, auth()); await api.resume(packet, auth()); }
    else if (choice === 3 && open.length) await api.complete(open[rand(open.length)].id, `receipt ${i}`, auth());
    else if (choice === 4 && open.length) await api.drop(open[rand(open.length)].id, `reason ${i}`, auth());
    const next = await api.snapshot();
    assert.ok(next.commitments.filter(c => c.state === 'ACTIVE').length <= 1);
    for (const c of next.commitments) { assert.equal(source.text.slice(c.source.start, c.source.end), c.source.quote); if (c.state === 'COMPLETE') assert.equal(c.history.at(-1).receipt, 'self-report'); }
    assert.deepEqual(await store.get(source.id), source);
  }
});
