import { canonical } from './export.js';

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

/**
 * The only way S5 modules write derived records. A module may create records
 * under its own prefixes and nowhere else, and it can never overwrite one.
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
    async mine() { return (await store.snapshot()).derived.filter(record => allowed(record?.id)); },
  };
}
