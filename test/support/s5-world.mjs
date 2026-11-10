import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { createFileStore } from '../../packages/storage/file.js';
import { createIndexedDbStore } from '../../packages/storage/indexeddb.js';
import { createSqliteStore } from '../../packages/storage/sqlite.js';
import { createSpans } from '../../packages/core/spans.js';
import { createMoves } from '../../packages/core/moves.js';
import { createExploration } from '../../packages/core/exploration.js';
import { createContinuity } from '../../packages/core/continuity.js';

export const hash = async s => createHash('sha256').update(s).digest('hex');
export let hasSqlite = true;
try { await import('node:sqlite'); } catch (error) { if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') hasSqlite = false; else throw error; }
export const KINDS = ['file', 'indexeddb', 'sqlite'];
let counter = 0;

export async function makeStore(kind, t) {
  const dir = await mkdtemp(join(tmpdir(), 'effort-s5-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = kind === 'file' ? createFileStore(join(dir, 'store'))
    : kind === 'indexeddb' ? createIndexedDbStore({ factory: indexedDB, name: `s5-${++counter}-${Math.random()}` })
      : await createSqliteStore(join(dir, 'store.db'));
  t.after(() => store.close?.());
  return Object.assign(store, { dir });
}

/** Wraps a store so tests can see every write. */
export function spyOn(store) {
  const writes = [];
  const wrapped = { ...store, writes };
  for (const name of ['append', 'putDerived', 'compareAndSwapDerived', 'importSnapshot', 'restoreBundle']) {
    wrapped[name] = (...args) => { writes.push({ name, args: structuredClone(args) }); return store[name](...args); };
  }
  for (const name of ['get', 'list', 'snapshot', 'exportBundle', 'verifyBundle']) wrapped[name] = (...args) => store[name](...args);
  return wrapped;
}

export function services(store, { start = 0 } = {}) {
  let n = start, tick = 0;
  const id = () => `id-${++n}`;
  const now = () => new Date(Date.UTC(2026, 0, 1, 12, 0, ++tick)).toISOString();
  const spans = createSpans({ store, hash, now, id });
  const moves = createMoves({ store, hash, now, id });
  const exploration = createExploration({ store, hash, now, id, spans, moves });
  const continuity = createContinuity({ store, hash, now, id });
  return { spans, moves, exploration, continuity };
}
export const human = commandId => ({ authority: 'human', commandId });
