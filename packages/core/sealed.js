import { canonical, validIsoInstant } from './export.js';

/** Shared helpers for the S5 modules. Nothing here can reach commitments or NOW. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
export const TEXT_LIMIT = 4000;

/** Writing is kept exactly as typed; this only decides whether it can be saved. */
export function textAllowed(value, { required = true } = {}) {
  return typeof value === 'string' && value.length <= TEXT_LIMIT && (!required || value.trim().length > 0) && !LONE_SURROGATE.test(value);
}
export const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export const same = (a, b) => canonical(a) === canonical(b);
export const safePart = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value);

export function makeDigest(hash) {
  if (typeof hash !== 'function') throw Error('A hash function is required.');
  return async value => {
    const result = await hash(typeof value === 'string' ? value : canonical(value));
    if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) throw Error('Invalid hash.');
    return result;
  };
}

export async function sealRecord(body, digest) { return { ...body, checksum: await digest(body) }; }
/** Returns the body when the shape and checksum hold, otherwise throws a plain error. */
export async function openRecord(record, keys, digest) {
  if (!record || typeof record !== 'object') throw Error('A saved record is not readable.');
  const { checksum, ...body } = record;
  if (!exactKeys(body, keys) || await digest(body) !== checksum) throw Error('A saved record failed its check.');
  return body;
}

export const MARKER_KEYS = ['id', 'kind', 'setAsideAt'];
/** A marker takes the place of a damaged record that was set aside. The damaged record itself is kept in quarantine. */
export const isMarker = record => record?.kind === 'set-aside';
export async function openMarker(record, digest) {
  const body = await openRecord(record, [...MARKER_KEYS], digest);
  if (body.kind !== 'set-aside' || typeof body.id !== 'string' || !validIsoInstant(body.setAsideAt)) {
    throw Error('A saved marker is not valid.');
  }
  return body;
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stamp = record => [record?.createdAt, record?.setAsideAt].find(value => typeof value === 'string') ?? '';
/** One defined order on every adapter: creation time, then id (UTF-16 order). */
export const inOrder = records => [...records].sort((a, b) => compare(stamp(a), stamp(b)) || compare(a.id, b.id));

/**
 * The only way S5 modules write derived records. A module may create records
 * under its own prefixes and nowhere else. Recovery retains the old record in
 * quarantine before replacing it with a marker. Only markers can be reused.
 */
export function createGate(store, prefixes) {
  if (!store?.snapshot || !store?.compareAndSwapDerived || !store?.get) {
    throw Error('This needs a store with snapshot, get and compareAndSwapDerived.');
  }
  const allowed = id => typeof id === 'string' && prefixes.some(prefix => id.startsWith(prefix));
  return {
    allowed,
    async create(record) {
      if (!allowed(record?.id)) throw Error('This operation may only write its own records.');
      return store.compareAndSwapDerived(record.id, null, record);
    },
    /** Replaces a marker with a new record under the same ID. Nothing else can be replaced. */
    async createOver(marker, record) {
      if (!allowed(record?.id) || !isMarker(marker)) throw Error('This operation may only write its own records.');
      return store.compareAndSwapDerived(record.id, marker, record);
    },
    /** Moves a damaged record to quarantine (kept, not deleted) and leaves a marker in its place. */
    async setAside(damaged, marker, reason) {
      if (!allowed(damaged?.id) || !isMarker(marker) || marker.id !== damaged.id) {
        throw Error('This operation may only write its own records.');
      }
      if (typeof store.setAsideDerived !== 'function') throw Error('This storage cannot set a damaged record aside.');
      return store.setAsideDerived(damaged.id, damaged, marker, reason);
    },
    async mine() { return inOrder((await store.snapshot()).derived.filter(record => allowed(record?.id))); },
  };
}
