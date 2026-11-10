import { canonical, createExport, quarantineToAppend, restoreExport, verifyExport } from '../core/export.js';
import { copySnapshot, ordered, validateCas } from './records.js';

/** The injected synchronous connection belongs exclusively to this store until close(). */
export async function createSqliteStore(filename = ':memory:', { database } = {}) {
  let db = database;
  if (!db) {
    if (typeof filename !== 'string' || !filename) throw TypeError('SQLite filename must be a non-empty path string or :memory:.');
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch (cause) {
      throw new Error('The default SQLite driver requires Node 22 with node:sqlite. On Node 20, inject a compatible synchronous database connection or use the file adapter.', { cause });
    }
    try {
      if (typeof filename === 'string' && filename !== ':memory:') {
        const { open } = await import('node:fs/promises');
        try { const file = await open(filename, 'wx', 0o600); await file.close(); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      db = new DatabaseSync(filename);
      db.exec('PRAGMA busy_timeout = 1000');
    } catch (cause) {
      try { db?.close(); } catch {}
      throw new Error(`SQLite open failed: ${cause.message}`, { cause });
    }
  }
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function' || typeof db.close !== 'function') {
    throw new TypeError('SQLite requires a synchronous database with prepare(), exec() and close().');
  }
  let closed = false;
  function sql(operation, work) {
    if (closed) throw Error('SQLite store is closed.');
    try { return work(); }
    catch (cause) { throw new Error(`SQLite ${operation} failed: ${cause.message}`, { cause }); }
  }
  function transaction(operation, write, work) {
    return sql(operation, () => {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `${error.message}; SQLite rollback failed: ${rollbackError.message}`);
        }
        throw error;
      }
    });
  }
  try {
    transaction('schema initialization', true, () => db.exec(`
      CREATE TABLE IF NOT EXISTS effort_captures (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effort_derived (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effort_quarantine (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
    `));
  } catch (error) {
    if (!database) { try { db.close(); } catch {} }
    throw error;
  }
  const read = (table) => db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all().map((row) => JSON.parse(row.payload));
  const snapshot = () => ({ captures: read('effort_captures'), derived: read('effort_derived'), quarantine: read('effort_quarantine') });
  function payload(record) {
    if (!record || typeof record.id !== 'string' || !record.id) throw Error('Record ID must be a non-empty string.');
    return canonical(record);
  }
  function append(record) {
    const text = payload(record);
    return transaction('capture append', true, () => {
      if (db.prepare('SELECT id FROM effort_captures WHERE id = ?').get(canonical(record.id))) throw Error('Capture ID collision.');
      db.prepare('INSERT INTO effort_captures (id, payload) VALUES (?, ?)').run(canonical(record.id), text);
      return JSON.parse(text);
    });
  }
  return {
    async append(record) { return append(record); },
    async get(id) {
      return sql('capture read', () => {
        const row = db.prepare('SELECT payload FROM effort_captures WHERE id = ?').get(canonical(id));
        return row ? JSON.parse(row.payload) : null;
      });
    },
    async list() { return sql('capture list', () => ordered(read('effort_captures'))); },
    async putDerived(record) {
      const text = payload(record);
      return transaction('derived write', true, () => {
        db.prepare('INSERT INTO effort_derived (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(canonical(record.id), text);
        return JSON.parse(text);
      });
    },
    async compareAndSwapDerived(id, expected, replacement) {
      [expected, replacement] = validateCas(id, expected, replacement);
      return transaction('derived compare-and-swap', true, () => {
        const row = db.prepare('SELECT payload FROM effort_derived WHERE id = ?').get(canonical(id));
        const current = row ? JSON.parse(row.payload) : null;
        if (canonical(current) !== canonical(expected)) return false;
        db.prepare('INSERT INTO effort_derived (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(canonical(id), payload(replacement));
        return true;
      });
    },
    async snapshot() { return transaction('snapshot', false, snapshot); },
    async export() { return JSON.stringify(await this.snapshot()); },
    exportBundle(hash) { return createExport(this, hash); },
    verifyBundle(input, hash) { return verifyExport(input, hash); },
    restoreBundle(input, hash) { return restoreExport(this, input, hash); },
    async importSnapshot(incoming, { sourceQuarantine = [] } = {}) {
      incoming = copySnapshot(incoming);
      sourceQuarantine = structuredClone(sourceQuarantine);
      return transaction('snapshot import', true, () => {
        const current = snapshot();
        const captures = new Map(current.captures.map((record) => [record.id, canonical(record)]));
        const derived = new Map(current.derived.map((record) => [record.id, canonical(record)]));
        const keptExisting = [];
        for (const record of incoming.captures) {
          const text = payload(record);
          if (captures.has(record.id) && captures.get(record.id) !== text) throw Error('Capture ID collision.');
          if (!captures.has(record.id)) {
            db.prepare('INSERT INTO effort_captures (id, payload) VALUES (?, ?)').run(canonical(record.id), text);
            captures.set(record.id, text);
          }
        }
        for (const record of incoming.derived) {
          const text = payload(record);
          if (derived.has(record.id)) {
            if (derived.get(record.id) !== text) keptExisting.push(record.id);
          } else {
            db.prepare('INSERT INTO effort_derived (id, payload) VALUES (?, ?)').run(canonical(record.id), text);
            derived.set(record.id, text);
          }
        }
        for (const record of quarantineToAppend(current, incoming.quarantine ?? [], sourceQuarantine)) {
          db.prepare('INSERT INTO effort_quarantine (payload) VALUES (?)').run(canonical(record));
        }
        return { keptExisting };
      });
    },
    async close() {
      if (closed) return;
      sql('close', () => db.close());
      closed = true;
    },
  };
}
