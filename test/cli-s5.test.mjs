import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(process.cwd(), 'apps/cli/effort.mjs');
const { NODE_TEST_CONTEXT, ...childEnv } = process.env;

async function workspace(t) {
  const home = await mkdtemp(join(tmpdir(), 'effort-s5-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...childEnv, EFFORT_HOME: home }, encoding: 'utf8' });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  return { home, run, ok };
}
const idOf = line => line.split(' ')[1];

test('CLI: spans, posts, nested replies and the thread view keep the exact words', async t => {
  const { ok, run, home } = await workspace(t);
  assert.equal(ok('span', 'create', '  Practice   room'), 'SPAN Practice room');
  assert.match(ok('span', 'list'), /^Unsorted\traw\n[\s\S]*Practice room\tjournal$/);
  const root = idOf(ok('post', 'practice room', 'What', 'should', 'I', 'try?'));
  const reply = idOf(ok('reply', root, 'One small thing.'));
  const nested = idOf(ok('reply', reply, 'Then another.'));
  const lines = ok('thread', nested).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], new RegExp(`^${root}\\tWhat should I try\\?$`));
  assert.match(lines[1], new RegExp(`^  ${reply}\\tOne small thing\\.$`));
  assert.match(lines[2], new RegExp(`^    ${nested}\\tThen another\\.$`));
  const refused = run('post', 'No such span', 'text');
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Create the Attention Span/);
  assert.match(run('reply', 'missing', 'x').stderr, /not found/);
  assert.match(run('post', 'Learning').stderr, /Usage/);
  const file = join(home, 'captures.jsonl');
  await writeFile(file, (await readFile(file, 'utf8')).replace('One small thing.', 'One small thang.'));
  const damaged = ok('thread', root);
  assert.match(damaged, /WARNING: this text no longer matches what was saved\] One small thang\./);
});

test('CLI: explore and distill never create a commitment or change NOW', async t => {
  const { ok, run } = await workspace(t);
  const capture = idOf(ok('capture', 'Call the fictional library tomorrow.'));
  const commitment = idOf(ok('promote', capture, '0', '4')); ok('activate', commitment);
  const nowBefore = ok('now'), commitmentsBefore = ok('commitments');
  const branch = idOf(ok('explore', '--dial', 'sandbox', capture, 'What', 'if', 'it', 'were', 'strange?'));
  const child = idOf(ok('explore', '--from', branch, '--dial', 'tight', capture, 'Now the careful version.'));
  const tension = ok('distill', child, 'open-tension', 'I still', 'do not know.');
  assert.match(tension, /^DISTILLED distillation:.* \(writing, not a commitment\)$/);
  assert.match(ok('distill', branch, 'weird-but-alive', 'A strange idea.'), /^DISTILLED /);
  assert.match(ok('distill', branch, 'insight', 'It helps.'), /^DISTILLED /);
  const listing = ok('explorations', capture);
  assert.match(listing, new RegExp(`${branch}\\tUNHINGED SANDBOX\\t-\\tWhat if it were strange\\?`));
  assert.match(listing, new RegExp(`${child}\\tTIGHT\\t${branch}\\tNow the careful version\\.`));
  assert.match(listing, /OPEN TENSION\tI still do not know\./);
  assert.equal(ok('now'), nowBefore); assert.equal(ok('commitments'), commitmentsBefore);
  assert.match(run('distill', branch, 'commitment', 'No.').stderr, /distillation types/);
  assert.match(run('explore', '--dial', 'loud', capture, 'x').stderr, /Choose a dial/);
  assert.match(run('explore', '--from', 'exploration:nope', capture, 'x').stderr, /not found on this thought/);
  assert.match(run('distill', 'exploration:nope', 'insight', 'x').stderr, /not found/);
  assert.equal(ok('verify'), 'VERIFIED 1');
});

test('CLI: backups carry the new records and old commands still work', async t => {
  const a = await workspace(t), b = await workspace(t);
  const root = idOf(a.ok('post', 'Learning', 'A thought.'));
  a.ok('explore', root, 'A branch.'); a.ok('span', 'create', 'Side project');
  const backup = join(a.home, 'backup.json');
  a.ok('export', backup);
  assert.match(a.ok('verify-export', backup), /^VERIFIED EXPORT 1 captures, 2 derived/);
  b.ok('restore', backup); b.ok('restore', backup);
  assert.match(b.ok('thread', root), /A thought\./);
  assert.match(b.ok('explorations', root), /A branch\./);
  assert.match(b.ok('span', 'list'), /Side project/);
  assert.match(b.ok('list'), /A thought\./);
});
