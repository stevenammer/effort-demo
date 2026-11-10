/** Save-first capture records. Hashing is injected so this stays platform-neutral. */
export async function createCapture({ id, text, createdAt, metadata }, hash) {
  if (typeof hash !== 'function') throw new TypeError('hash must be a function');
  if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string');
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    throw new TypeError('createdAt must be an ISO date string');
  }
  return Object.freeze({ id, text, hash: await hash(text), createdAt,
    ...(metadata === undefined ? {} : { metadata: structuredClone(metadata) }) });
}

export async function verifySaved(store, id, hash) {
  if (!store || typeof store.get !== 'function') throw new TypeError('store must provide get');
  if (typeof hash !== 'function') throw new TypeError('hash must be a function');
  const record = await store.get(id);
  if (!record || record.id !== id || typeof record.text !== 'string') return false;
  return (await hash(record.text)) === record.hash;
}
