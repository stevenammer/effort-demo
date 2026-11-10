import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { indexedDB } from 'fake-indexeddb';
import { createCapture } from '../packages/core/capture.js';
import { MAX_EXPORT_BYTES, canonical, createExport, restoreExport, verifyExport } from '../packages/core/export.js';
import { createFileStore, recoverFileLock } from '../packages/storage/file.js';
import { createIndexedDbStore } from '../packages/storage/indexeddb.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const childEnv = (() => { const { NODE_TEST_CONTEXT, ...rest } = process.env; return rest; })();

async function records() {
  return [
    { ...await createCapture({
      id: 'capture-a', text: 'Cafe\u0301 ☕\r\nKeep every byte.  ',
      createdAt: '2026-01-02T03:04:05.000Z', metadata: { source: 'synthetic', tags: ['one', 'two'] },
    }, hash), metadata: { source: 'synthetic', tags: ['one', 'two'] } },
    { ...await createCapture({
      id: 'capture-b', text: 'Second synthetic capture.\n',
      createdAt: '2026-01-03T03:04:05.000Z', metadata: { nested: { note: 'exact' } },
    }, hash), metadata: { nested: { note: 'exact' } } },
  ];
}
async function fill(store) {
  const captures = await records();
  for (const record of captures) await store.append(record);
  await store.putDerived({
    id: 'derived-a', createdAt: '2026-01-04T03:04:05.000Z', captureId: 'capture-a',
    metadata: { score: 7, exact: 'x\r\ny' },
  });
  return captures;
}
async function tempFileStore(prefix = 'effort-export-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, store: createFileStore(join(directory, 'captures.jsonl')) };
}
function currentBootForTest() {
  return Date.now() - (uptime() * 1_000);
}
async function writeLock(file, owner) {
  await mkdir(`${file}.lock`);
  await writeFile(`${file}.lock/owner.json`, JSON.stringify(owner));
}
function liveOwner(token) {
  return { pid: process.pid, hostname: hostname(), token, createdAt: new Date().toISOString(),
    bootStartedAt: currentBootForTest() };
}
test('portable export round trips both adapter directions with exact strings and derived records', async () => {
  const sourceFile = await tempFileStore('effort-source-file-');
  const destinationFile = await tempFileStore('effort-destination-file-');
  const sourceIdb = createIndexedDbStore({ factory: indexedDB, name: `export-source-${Date.now()}` });
  const destinationIdb = createIndexedDbStore({ factory: indexedDB, name: `export-dest-${Date.now()}` });
  try {
    await fill(sourceFile.store);
    const fileBundle = await sourceFile.store.exportBundle(hash);
    await destinationIdb.restoreBundle(fileBundle, hash);
    assert.deepEqual(await destinationIdb.snapshot(), await sourceFile.store.snapshot());
    assert.deepEqual((await destinationIdb.get('capture-a')).metadata, { source: 'synthetic', tags: ['one', 'two'] });
    assert.equal(await destinationIdb.exportBundle(hash), fileBundle, 're-export has the same manifest and bytes');
    await fill(sourceIdb);
    const idbBundle = await sourceIdb.exportBundle(hash);
    await destinationFile.store.restoreBundle(idbBundle, hash);
    assert.deepEqual(await destinationFile.store.snapshot(), await sourceIdb.snapshot());
    await destinationFile.store.restoreBundle(idbBundle, hash);
    assert.deepEqual(await destinationFile.store.snapshot(), await sourceIdb.snapshot(), 'repeated restore is a no-op');
  } finally {
    await sourceIdb.close(); await destinationIdb.close();
    await rm(sourceFile.directory, { recursive: true, force: true }); await rm(destinationFile.directory, { recursive: true, force: true });
  }
});

test('restore rejects one collision without partially importing either store', async () => {
  const source = await tempFileStore('effort-conflict-source-');
  const destination = await tempFileStore('effort-conflict-destination-');
  try {
    await fill(source.store);
    const bundle = await createExport(source.store, hash);
    const collision = await createCapture({
      id: 'capture-a', text: 'Different synthetic content.', createdAt: '2026-01-02T03:04:05.000Z',
    }, hash);
    await destination.store.append(collision);
    const before = await destination.store.snapshot();
    await assert.rejects(restoreExport(destination.store, bundle, hash), /collision/);
    assert.deepEqual(await destination.store.snapshot(), before);
  } finally {
    await rm(source.directory, { recursive: true, force: true });
    await rm(destination.directory, { recursive: true, force: true });
  }
});

test('runtime validator and declared schema agree on envelope structure', async () => {
  const { directory, store } = await tempFileStore('effort-schema-');
  try {
    await fill(store);
    const bundle = await createExport(store, hash);
    const schema = JSON.parse(await readFile('docs/effort-export-1.schema.json', 'utf8'));
    const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    const valid = JSON.parse(bundle);
    assert.equal(validateSchema(valid), true);
    await assert.doesNotReject(verifyExport(bundle, hash));
    const invalid = structuredClone(valid);
    invalid.entries.push({ path: 'extra.jsonl', text: '' });
    assert.equal(validateSchema(invalid), false);
    await assert.rejects(verifyExport(JSON.stringify(invalid), hash));
    const unknown = structuredClone(valid); unknown.manifest.format = 'effort-export/2';
    assert.equal(validateSchema(unknown), false);
    await assert.rejects(verifyExport(JSON.stringify(unknown), hash));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validator refuses tampered, truncated, malformed, unsafe-path, unknown and oversize input', async () => {
  const { directory, store } = await tempFileStore('effort-reject-');
  try {
    await fill(store); const bundle = await createExport(store, hash); const parsed = JSON.parse(bundle);
    const cases = [
      bundle.replace('Second synthetic', 'Tampered synthetic'),
      bundle.slice(0, -3),
      '{not json',
      JSON.stringify({ ...parsed, entries: [{ ...parsed.entries[0], path: '../../unsafe' }, parsed.entries[1]] }),
      JSON.stringify({ ...parsed, manifest: { ...parsed.manifest, format: 'effort-export/99' } }),
      'x'.repeat(MAX_EXPORT_BYTES + 1),
    ];
    for (const input of cases) await assert.rejects(verifyExport(input, hash));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validator checks manifest checksum, entry checksum, count, and canonical JSONL', async () => {
  const { directory, store } = await tempFileStore('effort-checksums-');
  try {
    await fill(store);
    const bundle = await createExport(store, hash);
    const parsed = JSON.parse(bundle);
    const signManifest = async (value) => { value.manifestSha256 = await hash(canonical(value.manifest)); };
    const manifestMismatch = structuredClone(parsed);
    manifestMismatch.manifest.entries[0].count++;
    await assert.rejects(verifyExport(JSON.stringify(manifestMismatch), hash), /Manifest checksum/);
    const entryMismatch = structuredClone(parsed);
    entryMismatch.entries[0].text = entryMismatch.entries[0].text.replace('synthetic', 'altered  ');
    await assert.rejects(verifyExport(JSON.stringify(entryMismatch), hash), /checksum/);
    const countMismatch = structuredClone(parsed);
    countMismatch.manifest.entries[0].count++;
    await signManifest(countMismatch);
    await assert.rejects(verifyExport(JSON.stringify(countMismatch), hash), /Noncanonical|Invalid entry/);
    const truncatedEntry = structuredClone(parsed);
    truncatedEntry.entries[0].text = truncatedEntry.entries[0].text.slice(0, -1);
    truncatedEntry.manifest.entries[0].bytes = Buffer.byteLength(truncatedEntry.entries[0].text);
    truncatedEntry.manifest.entries[0].sha256 = await hash(truncatedEntry.entries[0].text);
    await signManifest(truncatedEntry);
    await assert.rejects(verifyExport(JSON.stringify(truncatedEntry), hash));
    const noncanonical = structuredClone(parsed);
    const first = JSON.parse(noncanonical.entries[0].text.split('\n')[0]);
    const reordered = { text: first.text, ...first };
    noncanonical.entries[0].text = `${JSON.stringify(reordered)}\n${noncanonical.entries[0].text.split('\n').slice(1).join('\n')}`;
    noncanonical.manifest.entries[0].bytes = Buffer.byteLength(noncanonical.entries[0].text);
    noncanonical.manifest.entries[0].sha256 = await hash(noncanonical.entries[0].text);
    await signManifest(noncanonical);
    await assert.rejects(verifyExport(JSON.stringify(noncanonical), hash), /Noncanonical/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI subprocess exports, verifies, restores into a fresh directory, and refuses overwrite', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'effort-cli-export-source-'));
  const destination = await mkdtemp(join(tmpdir(), 'effort-cli-export-destination-'));
  const backup = join(source, 'synthetic-backup.json'); const cli = join(process.cwd(), 'apps/cli/effort.mjs');
  const run = (home, ...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...childEnv, EFFORT_HOME: home }, encoding: 'utf8' });
  try {
    const capture = run(source, 'capture', 'I will test the portable export.');
    if (capture.error?.code === 'EPERM') return t.skip('Sandbox prevents child processes; subprocess path could not be verified.');
    assert.equal(capture.status, 0, capture.stderr);
    assert.equal(run(source, 'export', backup).status, 0);
    assert.equal(run(source, 'verify-export', backup).status, 0);
    const restore = run(destination, 'restore', backup);
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(run(destination, 'list').stdout, /portable export/);
    assert.notEqual(run(source, 'export', backup).status, 0, 'existing backup is protected');
  } finally { await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); }
});

test('file adapter serializes independent child-process writers', async (t) => {
  const { directory, store } = await tempFileStore('effort-lock-'); const path = join(directory, 'captures.jsonl');
  const moduleUrl = JSON.stringify(new URL('../packages/storage/file.js', import.meta.url).href);
  const script = `import {createFileStore} from ${moduleUrl}; const s=createFileStore(process.argv[1]); ` +
    `await s.append({id:process.argv[2],text:'synthetic',hash:'${'0'.repeat(64)}',` +
    `createdAt:'2026-01-01T00:00:00.000Z'});`;
  try {
    const children = await Promise.all(['child-a', 'child-b', 'child-c'].map((id) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, id], {
        env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => resolve({ error, status: null, stderr }));
      child.on('close', (status) => resolve({ status, stderr }));
    })));
    if (children.some((child) => child.error?.code === 'EPERM')) {
      return t.skip('Sandbox prevents child processes; file contention could not be verified.');
    }
    for (const child of children) assert.equal(child.status, 0, child.stderr);
    assert.deepEqual((await store.list()).map((record) => record.id).sort(), ['child-a', 'child-b', 'child-c']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('strict calendar validation quarantines impossible capture dates', async () => {
  const { directory, store } = await tempFileStore('effort-date-');
  try {
    await store.append(await createCapture({ id: 'valid', text: 'safe', createdAt: '2026-01-01T00:00:00.000Z' }, hash));
    await store.append({ id: 'bad-date', text: 'keep me', hash: await hash('keep me'), createdAt: '2026-02-31T00:00:00.000Z' });
    const verified = await verifyExport(await store.exportBundle(hash), hash);
    assert.deepEqual(verified.captures.map((record) => record.id), ['valid']);
    assert.equal(verified.quarantine.length, 1);
    assert.match(verified.quarantine[0].reason, /impossible date/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('quarantine reasons name the broken capture rule', async () => {
  const valid = await createCapture({ id: 'valid', text: 'safe', createdAt: '2026-01-01T00:00:00.000Z' }, hash);
  const unsafe = JSON.parse('{"id":"unsafe","text":"x","hash":"' + '0'.repeat(64) +
    '","createdAt":"2026-01-01T00:00:00.000Z","__proto__":true}');
  const circular = { id: 'circular' }; circular.self = circular;
  const bundle = await createExport({ snapshot: async () => ({ captures: [valid,
    { id: 'date', text: 'x', hash: await hash('x'), createdAt: '2026-02-31T00:00:00.000Z' },
    { id: 'text', hash: await hash('x'), createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'format', text: 'x', hash: 'not-a-hash', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'mismatch', text: 'x', hash: await hash('y'), createdAt: '2026-01-01T00:00:00.000Z' }, unsafe, circular],
    derived: [],
  }) }, hash);
  const reasons = (await verifyExport(bundle, hash)).quarantine.map((entry) => entry.reason).join('\n');
  for (const rule of ['impossible date', 'missing text', 'bad hash format', 'hash does not match text',
    'unsafe key', 'cannot be serialized']) assert.match(reasons, new RegExp(rule, 'i'));
});

test('file lock waits for a live owner only until its configured deadline', async () => {
  const { directory } = await tempFileStore('effort-lock-timeout-');
  const file = join(directory, 'captures.jsonl'); const owner = liveOwner('live-timeout');
  try {
    await writeLock(file, owner);
    const store = createFileStore(file, { lockWaitMs: 50 });
    const started = Date.now();
    await assert.rejects(store.append(await createCapture({ id: 'late', text: 'late',
      createdAt: '2026-01-01T00:00:00.000Z' }, hash)), /Nothing was written.*\.lock.*pid/);
    assert.ok(Date.now() - started >= 40, 'a live lock is not rejected before the configured wait expires');
    assert.deepEqual(JSON.parse(await readFile(`${file}.lock/owner.json`, 'utf8')), owner);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('file lock recovery treats an earlier boot as dead even when its pid is now live', async () => {
  const { directory } = await tempFileStore('effort-lock-reboot-'); const file = join(directory, 'captures.jsonl');
  try {
    await writeLock(file, { ...liveOwner('before-reboot'), bootStartedAt: 0, bootId: 'previous-synthetic-boot' });
    assert.deepEqual(await recoverFileLock(file), { recovered: true, reason: 'dead-owner' });
    await assert.rejects(access(`${file}.lock`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('file lock recovery never clears a current-boot live owner, even with force', async () => {
  const { directory } = await tempFileStore('effort-lock-live-'); const file = join(directory, 'captures.jsonl');
  try {
    await writeLock(file, liveOwner('current-live'));
    await assert.rejects(recoverFileLock(file), /held by a live owner/);
    await assert.rejects(recoverFileLock(file, { force: true }), /held by a live owner/);
    await access(`${file}.lock`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recovery rechecks the dead token before removal, preserving a fresh live lock', async () => {
  const { directory } = await tempFileStore('effort-lock-token-'); const file = join(directory, 'captures.jsonl');
  try {
    await writeLock(file, { ...liveOwner('dead-token'), pid: 99999999 });
    const store = createFileStore(file, { lockWaitMs: 50, recoveryHooks: { afterDeadOwnerRead: async () => {
      await rm(`${file}.lock`, { recursive: true, force: true });
      await writeLock(file, liveOwner('fresh-live'));
    } } });
    await assert.rejects(store.append(await createCapture({ id: 'waiter', text: 'waiter',
      createdAt: '2026-01-01T00:00:00.000Z' }, hash)), /Nothing was written/);
    assert.equal(JSON.parse(await readFile(`${file}.lock/owner.json`, 'utf8')).token, 'fresh-live');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a waiter that loses recovery ownership waits and completes after the fresh lock releases', async () => {
  const { directory } = await tempFileStore('effort-lock-race-'); const file = join(directory, 'captures.jsonl');
  try {
    await writeLock(file, { ...liveOwner('dead-race'), pid: 99999999 });
    const store = createFileStore(file, { lockWaitMs: 250, recoveryHooks: { afterDeadOwnerRead: async () => {
      await rm(`${file}.lock`, { recursive: true, force: true });
      await writeLock(file, liveOwner('brief-live'));
      setTimeout(() => { rm(`${file}.lock`, { recursive: true, force: true }); }, 15);
    } } });
    await store.append(await createCapture({ id: 'eventual', text: 'eventual',
      createdAt: '2026-01-01T00:00:00.000Z' }, hash));
    assert.deepEqual((await store.list()).map((record) => record.id), ['eventual']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bad hashes and unsafe proto keys are quarantined while constructor data exports', async () => {
  const { directory, store } = await tempFileStore('effort-quarantine-');
  try {
    const good = await createCapture({ id: 'good', text: 'good', createdAt: '2026-01-01T00:00:00.000Z' }, hash);
    await store.append({ ...good, metadata: { constructor: 'allowed', prototype: 'allowed' } });
    await store.append({ id: 'bad-hash', text: 'changed', hash: await hash('original'), createdAt: '2026-01-01T00:00:00.000Z' });
    const unsafe = '{"id":"bad-proto","text":"x","hash":"' + '0'.repeat(64) +
      '","createdAt":"2026-01-01T00:00:00.000Z","__proto__":true}';
    await store.append(JSON.parse(unsafe));
    const bundle = await store.exportBundle(hash);
    const verified = await verifyExport(bundle, hash);
    assert.equal(verified.captures.length, 1);
    assert.equal(verified.captures[0].metadata.constructor, 'allowed');
    assert.equal(verified.quarantine.length, 2);
    const destination = (await tempFileStore('effort-quarantine-destination-'));
    try {
      const restored = await destination.store.restoreBundle(bundle, hash);
      assert.equal(restored.quarantine.length, 2);
      assert.deepEqual((await destination.store.list()).map((record) => record.id), ['good']);
    } finally { await rm(destination.directory, { recursive: true, force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restore refuses capture changes but keeps changed derived records', async () => {
  const source = await tempFileStore('effort-derived-source-');
  const destination = await tempFileStore('effort-derived-destination-');
  try {
    await source.store.append(await createCapture({ id: 'capture', text: 'same', createdAt: '2026-01-01T00:00:00.000Z' }, hash));
    await source.store.putDerived({ id: 'now', choice: 'source' });
    await destination.store.append(await createCapture({ id: 'capture', text: 'same', createdAt: '2026-01-01T00:00:00.000Z' }, hash));
    await destination.store.putDerived({ id: 'now', choice: 'destination' });
    const result = await destination.store.restoreBundle(await source.store.exportBundle(hash), hash);
    assert.deepEqual(result.keptExisting, ['now']);
    assert.equal((await destination.store.snapshot()).derived[0].choice, 'destination');
    const changed = await tempFileStore('effort-capture-conflict-');
    try {
      await changed.store.append(await createCapture({ id: 'capture', text: 'changed', createdAt: '2026-01-01T00:00:00.000Z' }, hash));
      await assert.rejects(destination.store.restoreBundle(await changed.store.exportBundle(hash), hash), /Capture ID collision/);
    } finally { await rm(changed.directory, { recursive: true, force: true }); }
  } finally {
    await rm(source.directory, { recursive: true, force: true });
    await rm(destination.directory, { recursive: true, force: true });
  }
});

test('readers retry an unfinished final JSONL line and then fail loudly', async () => {
  const { directory, store } = await tempFileStore('effort-partial-read-');
  const file = join(directory, 'captures.jsonl');
  try {
    await writeFile(file, '{"kind":"capture","value":', 'utf8');
    await assert.rejects(store.list(), /Storage JSONL is malformed/);
    await writeFile(file, '{"kind":"capture","value":{"id":"a","text":"x","createdAt":"2026-01-01T00:00:00.000Z"}}\n', 'utf8');
    assert.equal((await store.list()).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dead lock owner is recovered and live lock owner is never displaced', async (t) => {
  const { directory, store } = await tempFileStore('effort-lock-liveness-');
  const file = join(directory, 'captures.jsonl');
  const lock = `${file}.lock`;
  const moduleUrl = JSON.stringify(new URL('../packages/storage/file.js', import.meta.url).href);
  const holder = `import {createFileStore} from ${moduleUrl}; ` +
    `const blocker=new Int32Array(new SharedArrayBuffer(4)); ` +
    `const record={id:'holder',text:'x',hash:'${'0'.repeat(64)}',` +
    `createdAt:'2026-01-01T00:00:00.000Z'}; ` +
    `Object.defineProperty(record,'text',{get(){Atomics.wait(blocker,0,0,10000);return 'x';}}); ` +
    `await createFileStore(process.argv[1]).append(record);`;
  let child;
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', holder, file], { env: childEnv, stdio: 'ignore' });
    if (child.pid === undefined) return t.skip('Sandbox prevents child processes; lock liveness could not be verified.');
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await readFile(join(lock, 'owner.json'), 'utf8'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    await assert.rejects(recoverFileLock(file), /live owner/);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
    await store.append(await createCapture({ id: 'after-kill', text: 'works', createdAt: '2026-01-01T00:00:00.000Z' }, hash));
    assert.equal((await store.list()).length, 1);
  } finally {
    if (child && !child.killed) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown lock recovery needs force and envelope proto keys are refused', async () => {
  const { directory, store } = await tempFileStore('effort-unknown-lock-');
  const file = join(directory, 'captures.jsonl');
  try {
    await mkdir(`${file}.lock`);
    await assert.rejects(recoverFileLock(file), /ownership is unknown/);
    await assert.doesNotReject(recoverFileLock(file, { force: true }));
    await store.append(await createCapture({ id: 'safe', text: 'safe', createdAt: '2026-01-01T00:00:00.000Z' }, hash));
    const bundle = await store.exportBundle(hash);
    const unsafe = bundle.replace('{"entries"', '{"__proto__":true,"entries"');
    await assert.rejects(verifyExport(unsafe, hash), /Unsafe key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('export bytes are identical across locale settings', () => {
  const code = `
    import { createHash } from 'node:crypto';
    import { createExport } from './packages/core/export.js';
    const hash = async text => createHash('sha256').update(text).digest('hex');
    const captures = [];
    for (const id of ['z', 'ä']) captures.push({id, text:id, hash:await hash(id), createdAt:'2026-01-01T00:00:00.000Z'});
    console.log(await createExport({snapshot:async()=>({captures,derived:[]})},hash));
  `;
  const run = locale => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...childEnv, LANG: locale, LC_ALL: locale }, encoding: 'utf8', timeout: 5000,
  });
  const english = run('en_US.UTF-8'), swedish = run('sv_SE.UTF-8');
  assert.equal(english.status, 0, english.stderr);
  assert.equal(swedish.status, 0, swedish.stderr);
  assert.equal(english.stdout, swedish.stdout);
});

test('quarantine survives both adapter restores and repeated backup without becoming captures', async () => {
  const good = await createCapture({ id: 'good', text: 'Keep this original.', createdAt: '2026-01-01T00:00:00.000Z' }, hash);
  const bad = { ...good, id: 'broken', hash: '0'.repeat(64) };
  const original = await createExport({ snapshot: async () => ({ captures: [good, bad], derived: [] }) }, hash);
  const file = await tempFileStore('effort-quarantine-roundtrip-');
  const idb = createIndexedDbStore({ factory: indexedDB, name: `q-roundtrip-${Date.now()}` });
  try {
    for (const store of [file.store, idb]) {
      await restoreExport(store, original, hash);
      await restoreExport(store, original, hash);
      assert.deepEqual((await store.list()).map(row => row.id), ['good']);
      assert.equal((await store.snapshot()).quarantine.length, 1);
      assert.equal(await createExport(store, hash), original);
    }
  } finally { await idb.close(); await rm(file.directory, { recursive: true, force: true }); }
});

test('capture creation retains an isolated copy of metadata', async () => {
  const metadata = { source: 'synthetic', nested: { value: 1 } };
  const capture = await createCapture({ id: 'metadata', text: 'Exact.', createdAt: '2026-01-01T00:00:00.000Z', metadata }, hash);
  metadata.nested.value = 2;
  assert.deepEqual(capture.metadata, { source: 'synthetic', nested: { value: 1 } });
});

test('rehashing the container does not hide a corrupt capture hash or oversized valid bundle', async () => {
  async function forged(text, digestValue) {
    const record = { id: 'forged', text, hash: digestValue ?? await hash(text), createdAt: '2026-01-01T00:00:00.000Z' };
    const entries = [ { path:'captures.jsonl', text: canonical(record)+'\n' }, {path:'derived.jsonl',text:''}, {path:'quarantine.jsonl',text:''} ];
    const manifest = { format:'effort-export/1', entries:await Promise.all(entries.map(async e=>({path:e.path,count:e.text?1:0,bytes:Buffer.byteLength(e.text),sha256:await hash(e.text)}))) };
    return canonical({entries,manifest,manifestSha256:await hash(canonical(manifest))});
  }
  await assert.rejects(verifyExport(await forged('Altered source.', '0'.repeat(64)), hash), /Capture hash mismatch/);
  await assert.rejects(verifyExport(await forged('x'.repeat(MAX_EXPORT_BYTES)), hash), /oversized/);
});


test('a wall-clock adjustment never makes a live writer belong to an older boot', async () => {
  const { directory } = await tempFileStore('effort-clock-change-'); const file = join(directory, 'captures.jsonl');
  try {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const owner = { ...liveOwner('clock-adjusted-live'), bootId, bootStartedAt: currentBootForTest() - 60000 };
    await writeLock(file, owner);
    await assert.rejects(recoverFileLock(file, { force: true }), /held by a live owner/);
    assert.deepEqual(JSON.parse(await readFile(`${file}.lock/owner.json`, 'utf8')), owner);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('IndexedDB shared store upgrade retains existing captures and views', async () => {
  const name = `export-old-schema-${Date.now()}`;
  const capture = await createCapture({id:'old',text:'Existing original.',createdAt:'2026-01-01T00:00:00.000Z'},hash);
  await new Promise((resolve,reject) => {
    const opening = indexedDB.open(name,1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('captures',{keyPath:'id'});
      opening.result.createObjectStore('derived',{keyPath:'id'});
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db=opening.result,tx=db.transaction(['captures','derived'],'readwrite');
      tx.objectStore('captures').add(capture);
      tx.objectStore('derived').add({id:'view',text:'Existing view.'});
      tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
    };
  });
  const store=createIndexedDbStore({factory:indexedDB,name});
  try {
    assert.deepEqual(await store.snapshot(),{captures:[capture],derived:[{id:'view',text:'Existing view.'}],quarantine:[]});
  } finally {await store.close();}
});

test('restoring into the same corrupt source does not multiply quarantine records', async () => {
  const file = await tempFileStore('effort-quarantine-self-');
  const idb = createIndexedDbStore({ factory:indexedDB,name:`q-self-${Date.now()}` });
  try {
    for (const store of [file.store,idb]) {
      await store.append({id:'corrupt',text:'Original remains.',hash:'0'.repeat(64),createdAt:'2026-01-01T00:00:00.000Z'});
      const bundle=await store.exportBundle(hash);
      await store.restoreBundle(bundle,hash);
      await store.restoreBundle(bundle,hash);
      assert.equal(await store.exportBundle(hash),bundle);
    }
  } finally {await idb.close();await rm(file.directory,{recursive:true,force:true});}
});
