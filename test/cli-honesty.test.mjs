import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(process.cwd(), 'apps/cli/effort.mjs');
const { NODE_TEST_CONTEXT, ...childEnv } = process.env;

async function workspace(t) {
  const home = await mkdtemp(join(tmpdir(), 'effort-honest-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...childEnv, EFFORT_HOME: home }, encoding: 'utf8' });
  return { home, run, store: join(home, 'captures.jsonl') };
}

async function twoCapturesOneAltered({ home, run, store }) {
  assert.equal(run('capture', 'I will call the fictional library.').status, 0);
  assert.equal(run('capture', 'I will water the plants.').status, 0);
  await writeFile(store, (await readFile(store, 'utf8')).replace('library', 'archive'));
}

test('list marks an altered original in plain words, still shows the rest and exits 0', async (t) => {
  const w = await workspace(t);
  await twoCapturesOneAltered(w);
  const listed = w.run('list');
  assert.equal(listed.status, 0, listed.stderr);
  const lines = listed.stdout.split('\n');
  const altered = lines.find((line) => line.includes('archive'));
  assert.match(altered, /no longer matches/i);
  const fine = lines.find((line) => line.includes('water the plants'));
  assert.doesNotMatch(fine, /no longer matches/i);
  assert.match(listed.stdout, /1 of 2 saved items failed their check/);
});

test('list says nothing extra when every original checks out', async (t) => {
  const w = await workspace(t);
  assert.equal(w.run('capture', 'I will water the plants.').status, 0);
  const listed = w.run('list');
  assert.equal(listed.status, 0);
  assert.doesNotMatch(listed.stdout, /no longer matches|failed their check/i);
});

test('suggest never recommends an altered original but still suggests the rest', async (t) => {
  const w = await workspace(t);
  await twoCapturesOneAltered(w);
  const suggested = w.run('suggest');
  assert.equal(suggested.status, 0, suggested.stderr);
  assert.doesNotMatch(suggested.stdout.split('SUGGESTION')[1] ?? '', /archive/);
  assert.match(suggested.stdout, /water the plants/);
  assert.match(suggested.stdout, /no longer matches/i);
  assert.match(suggested.stdout, /1 of 2 saved items failed their check/);
});

test('suggest with only an altered original suggests nothing and says why', async (t) => {
  const w = await workspace(t);
  assert.equal(w.run('capture', 'I will call the fictional library.').status, 0);
  await writeFile(w.store, (await readFile(w.store, 'utf8')).replace('library', 'archive'));
  const suggested = w.run('suggest');
  assert.equal(suggested.status, 0);
  assert.doesNotMatch(suggested.stdout, /SUGGESTION/);
  assert.match(suggested.stdout, /No suggestion/);
  assert.match(suggested.stdout, /no longer matches/i);
});

test('recover-lock with no lock says so and exits 0, with or without --force', async (t) => {
  const w = await workspace(t);
  for (const args of [['recover-lock'], ['recover-lock', '--force']]) {
    const result = w.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no lock to recover/i);
    assert.doesNotMatch(result.stdout + result.stderr, /RECOVERED|unknown/i);
  }
});

test('recover-lock still clears a lock directory with no owner when --force is given', async (t) => {
  const w = await workspace(t);
  await mkdir(`${w.store}.lock`, { recursive: true });
  const refused = w.run('recover-lock');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /ownership is unknown/);
  const forced = w.run('recover-lock', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /RECOVERED LOCK/);
});
