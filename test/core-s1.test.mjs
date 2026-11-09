import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { createCapture, verifySaved } from '../packages/core/capture.js';
import { organizeText } from '../packages/core/ef.js';
import { chooseNow } from '../packages/core/now.js';
import { createFileStore } from '../packages/storage/file.js';
import { createIndexedDbStore } from '../packages/storage/indexeddb.js';
import { syncCore } from '../scripts/sync-core.mjs';
import { runCli } from '../apps/cli/lib.mjs';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const texts = [
  'I will call the fictional library.', 'Schedule a walk.', 'Café plans ☕', 'Use __proto__ safely.',
  'A NUL follows: \0 then continue.', 'Duplicate note.', 'Duplicate note.', 'Maybe make a map.',
  'Ask what changed?', 'I will send the outline.', 'Read https://example.test.', 'x'.repeat(12_000),
];

async function fixture() {
  return Promise.all(texts.map((text, index) => createCapture({
    id: `capture-${index}`,
    text,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }, hash)));
}

test('both adapters preserve fixture hashes, EF output, and NOW selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'effort-s1-'));
  const file = createFileStore(join(directory, 'captures.jsonl'));
  const indexed = createIndexedDbStore({ factory: indexedDB, name: `s1-${Date.now()}` });
  try {
    const records = await fixture();
    for (const record of records) {
      await file.append(record);
      await indexed.append(record);
    }
    const [fromFile, fromIndexed] = await Promise.all([file.list(), indexed.list()]);
    assert.deepEqual(fromFile.map((item) => item.hash), fromIndexed.map((item) => item.hash));
    assert.deepEqual(fromFile.map((item) => organizeText(item.id, item.text)),
      fromIndexed.map((item) => organizeText(item.id, item.text)));
    const fileNow = chooseNow(fromFile, {}, { now: Date.UTC(2026, 1, 1) });
    assert.deepEqual(fileNow, chooseNow(fromIndexed, {}, { now: Date.UTC(2026, 1, 1) }));
    assert.equal(fileNow.item.quote, 'I will call the fictional library.');
  } finally {
    await indexed.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('verifySaved rejects a tampered stored record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'effort-tamper-'));
  const path = join(directory, 'captures.jsonl');
  const store = createFileStore(path);
  try {
    const record = await createCapture({
      id: 'tampered', text: 'I will keep the original.', createdAt: '2026-01-01T00:00:00.000Z',
    }, hash);
    await store.append(record);
    await writeFile(path, (await readFile(path, 'utf8')).replace('original', 'changed'));
    assert.equal(await verifySaved(store, record.id, hash), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI captures, lists, chooses NOW, and refuses tampering', async () => {
  const home = await mkdtemp(join(tmpdir(), 'effort-cli-'));
  const cli = join(process.cwd(), 'apps/cli/effort.mjs');
  const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...childEnv, EFFORT_HOME: home }, encoding: 'utf8',
  });
  try {
    const captured = run('capture', 'I will call the fictional library.');
    if (captured.error?.code !== 'EPERM') assert.equal(captured.status, 0);
    const localOutput = [];
    const localRun = async (...args) => runCli(args, {
      home, output: (line) => localOutput.push(line),
    });
    if (captured.error?.code === 'EPERM') await localRun('capture', 'I will call the fictional library.');
    const listed = run('list');
    if (listed.error?.code === 'EPERM') await localRun('list');
    else assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.error?.code === 'EPERM' ? localOutput.pop() : listed.stdout, /fictional library/);
    const selected = run('now');
    if (selected.error?.code === 'EPERM') await localRun('now');
    else assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.error?.code === 'EPERM' ? localOutput.pop() : selected.stdout, /call the fictional library/);
    const verified = run('verify');
    if (verified.error?.code === 'EPERM') await localRun('verify');
    else assert.equal(verified.status, 0);
    const path = join(home, 'captures.jsonl');
    await writeFile(path, (await readFile(path, 'utf8')).replace('library', 'archive'));
    const tampered = run('verify');
    if (tampered.error?.code === 'EPERM') await assert.rejects(localRun('verify'), /Verification failed/);
    else assert.notEqual(tampered.status, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('generated public core drift is detected', async () => {
  const path = join(process.cwd(), 'public/core/ef.js');
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, `${original}\n// hand edit\n`);
    assert.equal(await syncCore({ check: true }), false);
  } finally {
    await writeFile(path, original);
  }
  assert.equal(await syncCore({ check: true }), true);
});
