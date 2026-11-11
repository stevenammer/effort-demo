import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url).pathname;
const suite = ['--test', '--test-concurrency=2', '--test-timeout=15000', 'test/core-s1.test.mjs', 'test/export.test.mjs', 'test/publication-guard.test.mjs', 'test/core-s5.test.mjs', 'test/core-s5-fixes.test.mjs', 'test/opened.test.js'];
const mutants = [
  ['skip readback hash comparison', 'return (await hash(record.text)) === record.hash;', 'return true;'],
  ['accept a tampered record', 'return (await hash(record.text)) === record.hash;', 'return record.id === id;'],
  ['drop generated-core drift check', 'return clean;', 'return true;'],
  ['drop private denylist check', 'if (denylist.hashes.size) {', 'if (false) {'],
  ['make NOW pick a different item',
    'return priority(a) - priority(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) ||',
    'return priority(b) - priority(a) || Date.parse(a.createdAt) - Date.parse(b.createdAt) ||'],
  ['use a different file-adapter hash', "append: (record) => write('capture', record),",
    "append: (record) => write('capture', { ...record, hash: 'wrong' }),"],
  ['manifest checksum', 'if (await digest(hash, canonical(bundle.manifest)) !== bundle.manifestSha256)', 'if (false)'],
  ['entry checksum', 'await digest(hash, entry.text) !== meta.sha256', 'false'],
  ['entry count', 'records.length !== meta.count', 'false'],
  ['canonical JSONL', 'entryText(records) !== entry.text', 'false'],
  ['size limit', 'bytes(input) > MAX_EXPORT_BYTES', 'false'],
  ['capture hash', 'await validateCaptures(all[0], hash);', 'if (false) await validateCaptures(all[0], hash);'],
  ['strict date', '!validIsoInstant(record.createdAt)', 'false'],
  ['quarantined records never restored', 'await store.importSnapshot(incoming, { sourceQuarantine });',
    'await store.importSnapshot({ ...incoming, captures: [...incoming.captures, ...incoming.quarantine] });'],
  ['capture collision refusal', 'captureMap.get(record.id) !== canonical(record)', 'false'],
  ['derived keep-existing', 'keptExisting.push(record.id);', "throw Error('Derived collision.');"],
  ['lock liveness', 'if (alive === false) {', 'if (true) {'],
  ['lock wait deadline',
    'if (Date.now() >= deadline) {\n' +
      '            throw Error(`Nothing was written: timed out waiting for ${lock}, owned by pid ${lockOwner.pid}.`);',
    'if (true) {\n            throw Error(`Nothing was written: timed out waiting for ${lock}, owned by pid ${lockOwner.pid}.`);'],
  ['reboot lock detection', "typeof owner.bootId === 'string' && bootId && owner.bootId !== bootId",
    'false'],
  ['recovery owner token recheck',
    "if (token && (await readOwner(lock))?.token !== token) return { recovered: false, reason: 'owner-changed' };",
    'if (false) return { recovered: false, reason: \'owner-changed\' };'],
  ['recovery race retry', 'if (!result.recovered) await pause();', "throw Error('Lost recovery race.');"],
  ['overwrite refusal', ['if (existing && !overwrite) throw Error', 'else await link(temporary, target);'], ['if (false) throw Error', 'else await rename(temporary, target);']],
  // S5: spans, threads, exploration and moves.
  ['post needs an existing span', "if (!found) throw Error('Create the Attention Span before posting in it.');", "if (false) throw Error('Create the Attention Span before posting in it.');"],
  ['reply stays in its span', "if (span !== undefined && spanKey(span) !== spanKey(spanOf(parent))) throw Error('Reply in the original Attention Span.');", ''],
  ['reply parent is verified', "if (!await verifiedPost(parent)) throw Error('Original source changed or failed verification.');", "if (false) throw Error('Original source changed or failed verification.');"],
  ['post readback is exact', 'if (!await verifiedPost(actual) || !same(actual, record)) {', 'if (false) {'],
  ['thread flags changed words', 'verified: await verifiedPost(record),', 'verified: true,'],
  ['write gate prefix', "if (!allowed(record?.id)) throw Error('This operation may only write its own records.');", "if (false) throw Error('This operation may only write its own records.');"],
  ['write gate create only', 'return store.compareAndSwapDerived(record.id, null, record);', 'await store.putDerived(record); return true;'],
  ['saved record checksum', 'await digest(body) !== checksum', 'false'],
  ['sandbox cannot become a proposal', "if (branch.dial === 'UNHINGED SANDBOX') throw Error('Leave the sandbox", "if (false) throw Error('Leave the sandbox"],
  ['dial is checked', 'if (!EXPLORATION_DIALS.includes(dial)) throw', 'if (false) throw'],
  ['distillation type is checked', 'if (!DISTILLATION_TYPES.includes(type)) throw', 'if (false) throw'],
  ['damaged branch holds back its children', 'if (current && damaged.has(current.id)) for (const pathId of path)', 'if (false) for (const pathId of path)'],
  ['turned-off move cannot be used', 'if (!move || !move.enabled || move.recovery) throw', 'if (!move) throw'],
  ['stale move edit refused', 'if ((current?.latestId ?? null) !== expectedLatestId) throw', 'if (false) throw'],
  // S5 review fixes: damaged records, order, deep threads, strict inputs.
  ['damaged span is named, not retried', ["if (isDamaged(state, clean)) throw damagedSpan(clean);", "if (isDamaged(after, clean)) throw damagedSpan(clean);"],
    ['if (false) throw damagedSpan(clean);', 'if (false) throw damagedSpan(clean);']],
  ['set-aside keeps the damaged record', 'return store.setAsideDerived(damaged.id, damaged, marker, reason);',
    'return store.compareAndSwapDerived(damaged.id, damaged, marker);'],
  ['set-aside only for a real marker', 'if (!allowed(damaged?.id) || !isMarker(marker) || marker.id !== damaged.id) {', 'if (!allowed(damaged?.id)) {'],
  ['damaged move is named', 'if (current?.recovery) throw damagedMove(targetId);', 'if (false) throw damagedMove(targetId);'],
  ['move set-aside takes the unlinked tail', 'for (const r of group.slice(linked)) targets.set(', 'for (const r of group.slice(group.length)) targets.set('],
  ['spans keep one order', 'compare(stamp(a), stamp(b)) || compare(a.id, b.id)', '0'],
  ['spans tie-break by ID', '|| compare(a.id, b.id)', '|| 0'],
  ['reply source ID is checked', "typeof derivedFromId !== 'string' || !derivedFromId", 'false'],
  ['post span shape is checked', "(meta?.span === undefined || typeof meta.span === 'string')", 'true'],
  ['unknown option words are refused', "if (words[0]?.startsWith('-')) throw Error(`Unknown option", "if (false) throw Error(`Unknown option"],
  ['unknown exploration ID is refused', 'if (!await store.get(rest[0])) throw Error(', 'if (false) throw Error('],
  ['empty explorations say so', "if (!branches.length && !state.damaged.length) output(", "if (false) output("],
  ['per-span unread does not count opened writing', '&& !reading.unknown.has(capture.id)).length;', '&& !reading.unknown.has(capture.id) && !reading.opened.has(capture.id)).length;'],
];

function run(cwd, args) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 90_000 });
}

function green(result) {
  return result.status === 0 && !/# skipped [^0]/.test(result.stdout);
}

const baseline = [
  run(root, ['--test', '--test-concurrency=2', '--test-timeout=30000']),
  run(root, ['scripts/check-syntax.mjs']),
  run(root, ['scripts/sync-core.mjs', '--check']),
  run(root, ['scripts/check-public.mjs']),
];
if (!baseline.every(green)) {
  console.error('Unmutated suite is not fully green. Mutation testing stopped.');
  for (const result of baseline) process.stderr.write(result.stdout + result.stderr);
  process.exit(1);
}

console.log(baseline[0].stdout.split('\n').slice(-10).join('\n'));
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
      'packages/core/capture.js', 'packages/core/export.js', 'packages/core/now.js', 'packages/storage/file.js',
      'apps/cli/lib.mjs', 'apps/cli/thinking.mjs', 'packages/core/spans.js', 'packages/core/sealed.js', 'packages/core/exploration.js', 'packages/core/moves.js',
      'scripts/check-public.mjs', 'scripts/sync-core.mjs', 'public/opened.js',
    ];
    const replacements = Array.isArray(find) ? find.map((value, index) => [value, replace[index]]) : [[find, replace]];
    for (const [needle, replacement] of replacements) {
      let changed = false;
      for (const file of candidates) {
        const path = join(copy, file);
        const source = readFileSync(path, 'utf8');
        if (!source.includes(needle)) continue;
        writeFileSync(path, source.replace(needle, replacement));
        changed = true;
        break;
      }
      if (!changed) throw Error(`Mutant source missing: ${name}`);
    }
    const result = run(copy, suite);
    // A harness timeout or spawn error is not evidence that a test caught the bug.
    if (result.error || result.signal) {
      throw Error(`Mutation harness failed for ${name}: ${result.error?.message || result.signal}`);
    }
    const killed = result.status !== 0;
    console.log(`${killed ? 'KILLED' : 'SURVIVED'} ${name}`);
    survived ||= !killed;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
if (survived) process.exitCode = 1;
