import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpans } from '../packages/core/spans.js';
import { createGate } from '../packages/core/sealed.js';
import { printThread, runThinkingCommand } from '../apps/cli/thinking.mjs';
import { s5RepairConformance, capture, hash } from './support/adapter-conformance.mjs';
import { KINDS, hasSqlite, makeStore } from './support/s5-world.mjs';

for (const kind of KINDS.filter(k => k !== 'sqlite' || hasSqlite)) s5RepairConformance(kind, t => makeStore(kind, t));

// Deep chains use a small in-memory store: appending 15000 records one by one through SQLite took over 90 seconds.
function memoryStore() {
  const captures = new Map();
  return {
    captures, append: async record => { captures.set(record.id, record); return record; },
    get: async id => captures.get(id) ?? null, list: async () => [...captures.values()],
    snapshot: async () => ({ captures: [...captures.values()], derived: [], quarantine: [] }), compareAndSwapDerived: async () => false,
  };
}
test('a 15000-deep reply chain lists through the core and `effort thread` without overflowing the stack', { timeout: 120000 }, async () => {
  const store = memoryStore(), DEPTH = 15000;
  for (let i = 0; i < DEPTH; i++) {
    const text = `post ${i}`, metadata = { span: 'Learning', ...(i ? { parentId: `p${i - 1}` } : {}) };
    await store.append({ id: `p${i}`, text, hash: await hash(text), createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), metadata });
  }
  const spans = createSpans({ store, hash, now: () => new Date().toISOString(), id: () => 'x' });
  for (const start of ['p0', `p${DEPTH - 1}`]) {
    let node = await spans.thread(start), depth = 1;
    while (node.replies.length) { assert.equal(node.replies.length, 1); node = node.replies[0]; depth++; }
    assert.equal(depth, DEPTH);
    assert.equal(node.id, `p${DEPTH - 1}`);
  }
  let count = 0, lastLine;
  await runThinkingCommand('thread', ['p5'], { store, hash, output: line => { count++; lastLine = line; } });
  assert.equal(count, DEPTH);
  assert.match(lastLine, /^ {29998}p14999\tpost 14999$/);
  const small = []; printThread({ id: 'a', text: 'A', verified: true, replies: [{ id: 'b', text: 'B', verified: false, replies: [] }, { id: 'c', text: 'C', verified: true, replies: [] }] }, l => small.push(l));
  assert.deepEqual(small.map(l => l.slice(0, 3)), ['a\tA'.slice(0, 3), '  b', '  c']);
});

async function workspace(t) {
  const home = await mkdtemp(join(tmpdir(), 'effort-s5-fix-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = (...args) => spawnSync(process.execPath, [join(process.cwd(), 'apps/cli/effort.mjs'), ...args], { env: { ...env, EFFORT_HOME: home }, encoding: 'utf8' });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  return { home, run, ok };
}

test('CLI: option-looking words are refused and never saved as a name or as writing', async t => {
  const { run, ok } = await workspace(t);
  for (const args of [['span', 'create', '--help'], ['span', 'create', '-x'], ['span', 'set-aside', '--help'], ['post', '--help', 'text'],
    ['reply', '--x', 'y'], ['thread', '--all'], ['explorations', '--all'], ['distill', '--x', 'insight', 'text'], ['explore', '--bogus', 'a', 'text']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /Usage|Unknown or incomplete option/, args.join(' '));
  }
  const names = ok('span', 'list');
  assert.doesNotMatch(names, /--help|-x/);
  assert.equal(ok('span', 'create', '--', '-x'), 'SPAN -x');
  assert.doesNotMatch(ok('span', 'list'), /-- -x/);
});

test('CLI: explorations says so for an unknown ID and when there is nothing to show', async t => {
  const { run, ok } = await workspace(t);
  const unknown = run('explorations', 'no-such-id');
  assert.notEqual(unknown.status, 0); assert.match(unknown.stderr, /no saved thought with the ID no-such-id/);
  const id = ok('capture', 'A fictional thought.').split(' ')[1];
  assert.match(ok('explorations', id), /^Nothing to show/);
});

test('CLI: a damaged Attention Span is explained and can be set aside from the command line without losing anything', async t => {
  const { home, run, ok } = await workspace(t);
  ok('span', 'create', 'Broken'); const post = ok('post', 'Broken', 'Still here.').split(' ')[1];
  const file = join(home, 'captures.jsonl');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"spanKind":"journal"', '"spanKind":"proof"'));
  const refused = run('span', 'create', 'Broken');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /damaged/); assert.match(refused.stderr, /effort span set-aside "Broken"/); assert.doesNotMatch(refused.stderr, /try again/i);
  assert.match(run('post', 'Broken', 'More.').stderr, /damaged/);
  assert.match(ok('thread', post), /Still here\./);
  assert.match(ok('span', 'set-aside', 'Broken'), /SET ASIDE .*kept, not deleted.*effort span create "Broken"/);
  ok('span', 'create', 'Broken'); ok('post', 'Broken', 'Fresh.');
  ok('export', join(home, 'out.json'));
  assert.match(ok('verify-export', join(home, 'out.json')), /1 quarantined/);
});

test('the write gate only sets a record aside when a real marker for that same record takes its place', async t => {
  const store = await makeStore('file', t), gate = createGate(store, ['span:']);
  const damaged = { id: 'span:odd', kind: 'span', checksum: '0'.repeat(64) };
  await store.putDerived(damaged);
  for (const marker of [{ id: 'span:odd', kind: 'span' }, { id: 'span:other', kind: 'set-aside' }, null]) {
    await assert.rejects(gate.setAside(damaged, marker, 'Test.'), /only write its own records/);
  }
  await assert.rejects(gate.setAside({ id: 'elsewhere:x' }, { id: 'elsewhere:x', kind: 'set-aside' }, 'Test.'), /only write its own records/);
  assert.deepEqual((await store.snapshot()).derived, [damaged]);
  assert.deepEqual((await store.snapshot()).quarantine, []);
});
