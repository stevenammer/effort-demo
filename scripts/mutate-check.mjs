import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const suite = ['--test', 'test/core-s1.test.mjs', 'test/publication-guard.test.mjs'];
const mutants = [
  ['skip readback hash comparison', 'return (await hash(record.text)) === record.hash;', 'return true;'],
  ['accept a tampered record', 'return (await hash(record.text)) === record.hash;', 'return record.id === id;'],
  ['drop generated-core drift check', 'return clean;', 'return true;'],
  ['drop private denylist check', 'if (denylist.hashes.size) {', 'if (false) {'],
  ['make NOW pick a different item', 'return priority(a) - priority(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) ||', 'return priority(b) - priority(a) || Date.parse(a.createdAt) - Date.parse(b.createdAt) ||'],
  ['use a different file-adapter hash', "append: (record) => write('capture', record),", "append: (record) => write('capture', { ...record, hash: 'wrong' }),"],
];

function run(cwd, args) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

function green(result) {
  return result.status === 0 && !/# skipped [^0]/.test(result.stdout);
}

const baseline = [
  run(root, ['--test']),
  run(root, ['scripts/check-syntax.mjs']),
  run(root, ['scripts/sync-core.mjs', '--check']),
  run(root, ['scripts/check-public.mjs']),
];
if (!baseline.every(green)) {
  console.error('Unmutated suite is not fully green. Mutation testing stopped.');
  for (const result of baseline) process.stderr.write(result.stdout + result.stderr);
  process.exit(1);
}

let survived = false;
for (const [name, find, replace] of mutants) {
  // Work in the system temp folder: copying the repo into itself is refused by Node.
  const copy = mkdtempSync(join(tmpdir(), 'effort-mutant-'));
  try {
    cpSync(root, copy, {
      recursive: true,
      filter: (path) => !path.includes('/.git') && !path.includes('/node_modules') &&
        !path.includes('/.mutant-'),
    });
    // Tests need the dev dependency; link it so a missing module cannot fake a kill.
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'));
    const candidates = [
      'packages/core/capture.js', 'packages/core/now.js', 'packages/storage/file.js',
      'scripts/check-public.mjs', 'scripts/sync-core.mjs',
    ];
    let changed = false;
    for (const file of candidates) {
      const path = join(copy, file);
      const source = readFileSync(path, 'utf8');
      if (!source.includes(find)) continue;
      writeFileSync(path, source.replace(find, replace));
      changed = true;
      break;
    }
    if (!changed) throw Error(`Mutant source missing: ${name}`);
    const result = run(copy, suite);
    const killed = result.status !== 0;
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
    survived ||= !killed;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
if (survived) process.exitCode = 1;
