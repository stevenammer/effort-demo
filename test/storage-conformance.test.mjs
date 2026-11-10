import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';
import { createFileStore } from '../packages/storage/file.js';
import { createIndexedDbStore } from '../packages/storage/indexeddb.js';
import { createSqliteStore } from '../packages/storage/sqlite.js';
import { adapterConformance, capture, derived, hash } from './support/adapter-conformance.mjs';

const adapters = {
  file: async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'effort-contract-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return createFileStore(join(directory, 'captures.jsonl'));
  },
  indexeddb: async (t) => {
    const store = createIndexedDbStore({ factory: indexedDB, name: `contract-${randomUUID()}` });
    t.after(() => store.close()); return store;
  },
};
let sqlite;
try { sqlite = await import('node:sqlite'); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
if (sqlite) adapters.sqlite = async (t) => {
  const store = await createSqliteStore(); t.after(() => store.close()); return store;
};
else test('SQLite default driver reports unsupported runtime', async () => {
  await assert.rejects(createSqliteStore(), /requires Node 22.*inject a compatible synchronous database/);
});

for (const [name, make] of Object.entries(adapters)) adapterConformance(name, make);
for (const [sourceName, makeSource] of Object.entries(adapters)) {
  for (const [destinationName, makeDestination] of Object.entries(adapters)) {
    if (sourceName === destinationName) continue;
    test(`portable transfer ${sourceName} -> ${destinationName}`, async (t) => {
      const source = await makeSource(t), destination = await makeDestination(t);
      for (const id of ['ä', 'Z', 'A']) await source.append(await capture(id));
      await source.putDerived(derived());
      await source.importSnapshot({ captures: [], derived: [], quarantine: [{ kind: 'capture', reason: 'Synthetic recovery.', raw: '{bad' }] });
      const bundle = await source.exportBundle(hash);
      await destination.restoreBundle(bundle, hash);
      assert.equal(await destination.exportBundle(hash), bundle);
      assert.deepEqual(await destination.list(), await source.list());
    });
  }
}
