import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_EXPORT_BYTES } from '../packages/core/export.js';

const cli = resolve('apps/cli/effort.mjs');
function run(home, ...args) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const result = spawnSync(process.execPath, [cli, ...args], { env: { ...env, EFFORT_HOME: home }, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
function fails(result) {
  assert.notEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /(?:EXPORTED|VERIFIED EXPORT|RESTORED)/);
}

test('CLI export protects its store and aliases, and publishes private backups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'effort-cli-safety-'));
  try {
    const home = join(dir, 'home'), store = join(home, 'captures.jsonl');
    assert.equal(run(home, 'capture', 'A synthetic capture.').status, 0);
    const original = await readFile(store);
    const sym = join(dir, 'symbolic'), hard = join(dir, 'hard');
    await symlink(store, sym); await link(store, hard);
    for (const target of [store, sym, hard]) {
      for (const options of [[], ['--overwrite']]) {
        fails(run(home, 'export', ...options, target));
        assert.deepEqual(await readFile(store), original);
      }
    }
    const backup = join(dir, 'backup.json');
    assert.equal(run(home, 'export', backup).status, 0);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    const backupBytes = await readFile(backup);
    fails(run(home, 'export', backup));
    assert.deepEqual(await readFile(backup), backupBytes);
    await chmod(backup, 0o640);
    assert.equal(run(home, 'export', '--overwrite', backup).status, 0);
    assert.equal((await stat(backup)).mode & 0o777, 0o640);
    assert.deepEqual(await readFile(backup), backupBytes);
    // A failed export cannot truncate an existing backup.
    await writeFile(store, 'not JSON\n');
    fails(run(home, 'export', '--overwrite', backup));
    assert.deepEqual(await readFile(backup), backupBytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI refuses malformed UTF-8 and oversized inputs before restore or success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'effort-cli-input-'));
  try {
    const home = join(dir, 'home'), bad = join(dir, 'bad.json'), huge = join(dir, 'huge.json');
    assert.equal(run(home, 'capture', 'Keep this synthetic capture.').status, 0);
    const store = join(home, 'captures.jsonl'), original = await readFile(store);
    await writeFile(bad, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    await writeFile(huge, ''); await truncate(huge, MAX_EXPORT_BYTES + 1);
    for (const path of [bad, huge]) for (const command of ['verify-export', 'restore']) {
      fails(run(home, command, path));
      assert.deepEqual(await readFile(store), original);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
