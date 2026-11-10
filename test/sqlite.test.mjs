import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSqliteStore } from '../packages/storage/sqlite.js';
import { capture, derived, hash } from './support/adapter-conformance.mjs';

let sqlite;
try { sqlite = await import('node:sqlite'); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }

test('SQLite validates the injected synchronous connection', async () => {
  await assert.rejects(createSqliteStore(':memory:', { database: {} }), /synchronous database/);
});
test('SQLite default filenames cannot bypass private file creation with another path type', async () => {
  for (const filename of [new URL('file:///tmp/effort-synthetic.sqlite'), Buffer.from('synthetic.sqlite'), '', null]) {
    await assert.rejects(createSqliteStore(filename), /filename must be a non-empty path string/);
  }
});
if (sqlite) {
  test('SQLite file persists all record kinds across close and reopen', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'effort-sqlite-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, 'captures.sqlite');
    let store = await createSqliteStore(filename);
    try {
      await store.append(await capture()); await store.putDerived(derived());
      await store.importSnapshot({ captures: [], derived: [], quarantine: [{ kind: 'capture', reason: 'Synthetic.', raw: 'broken' }] });
      const bundle = await store.exportBundle(hash);
      await store.close(); await store.close();
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
      await chmod(filename, 0o640);
      await assert.rejects(store.get('capture-a'), /closed/);
      store = await createSqliteStore(filename);
      assert.equal((await stat(filename)).mode & 0o777, 0o640, 'existing caller permissions stay unchanged');
      assert.equal(await store.exportBundle(hash), bundle);
    } finally { await store.close(); }
  });
  for (const [table, phase] of [['effort_captures', 'capture'], ['effort_derived', 'derived'], ['effort_quarantine', 'quarantine']]) {
    test(`SQLite rolls back an import after SQL failure in ${phase}`, async () => {
      const db = new sqlite.DatabaseSync(':memory:');
      const store = await createSqliteStore(':memory:', { database: db });
      try {
        await store.append(await capture('existing'));
        const before = await store.snapshot();
        const condition = phase === 'capture' ? "WHEN NEW.id = '\"z-fail\"'" : '';
        db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} ${condition} BEGIN SELECT RAISE(ABORT, 'synthetic SQL failure'); END;`);
        await assert.rejects(store.importSnapshot({
          captures: [await capture('a-new'), await capture('z-fail')],
          derived: [derived()], quarantine: [{ kind: 'capture', reason: 'Synthetic.', raw: 'broken' }],
        }), /SQLite snapshot import failed: synthetic SQL failure/);
        assert.deepEqual(await store.snapshot(), before);
        db.exec('DROP TRIGGER synthetic_failure');
        await store.append(await capture('after-failure'));
        assert.ok(await store.get('after-failure'), 'rollback leaves the connection usable');
      } finally { await store.close(); }
    });
  }
  test('SQLite snapshot encloses all reads in one transaction and rolls back failed reads', async () => {
    const db = new sqlite.DatabaseSync(':memory:');
    const events = []; let failRead = false;
    const injected = {
      exec(sql) { events.push(sql); return db.exec(sql); },
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          get: (...values) => statement.get(...values), run: (...values) => statement.run(...values),
          all(...values) { events.push(sql); if (failRead && sql.includes('effort_derived')) throw Error('synthetic read failure'); return statement.all(...values); },
        };
      },
      close: () => db.close(),
    };
    const store = await createSqliteStore(':memory:', { database: injected });
    try {
      events.length = 0; await store.snapshot();
      assert.equal(events[0], 'BEGIN'); assert.equal(events.at(-1), 'COMMIT'); assert.equal(events.length, 5);
      failRead = true; events.length = 0;
      await assert.rejects(store.snapshot(), /SQLite snapshot failed: synthetic read failure/);
      assert.equal(events.at(-1), 'ROLLBACK');
      failRead = false; await store.append(await capture());
      assert.ok(await store.get('capture-a'));
    } finally { await store.close(); }
  });
}
