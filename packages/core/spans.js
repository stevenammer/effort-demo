import { createCapture } from './capture.js';
import { validIsoInstant } from './export.js';
import { createGate, makeDigest, openRecord, sealRecord, same, safePart, textAllowed } from './sealed.js';

const SPAN_PREFIX = 'span:';
export const BUILTIN_SPANS = Object.freeze([
  ['Unsorted', 'raw'], ['Product demo', 'journal'], ['Learning', 'journal'],
  ['Proof', 'proof'], ['People', 'people'], ['Moves', 'moves'], ['Workspace', 'workspace'],
]);
export const cleanSpanName = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
export const spanKey = value => cleanSpanName(value).toLowerCase();
export function validSpanName(value) {
  return typeof value === 'string' && value === cleanSpanName(value) && value.length >= 2 && value.length <= 40 && !/[\p{C}]/u.test(value);
}
const builtinKind = name => BUILTIN_SPANS.find(([builtin]) => spanKey(builtin) === spanKey(name))?.[1] ?? 'journal';
const builtins = () => BUILTIN_SPANS.map(([name, kind]) => ({ id: spanKey(name), name, kind, createdAt: null }));

/** The post's Attention Span. Plain captures made before spans existed belong to Unsorted. */
export const spanOf = record => record?.metadata?.span ?? 'Unsorted';
export const parentOf = record => record?.metadata?.parentId ?? null;

/** Find a reply's top post. Returns null when the chain loops. A missing parent makes the reply its own top. */
export function threadRoot(post, posts) {
  const byId = posts instanceof Map ? posts : new Map(posts.map(p => [p.id, p]));
  const seen = new Set(); let current = post;
  while (current && parentOf(current)) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const parent = byId.get(parentOf(current));
    if (!parent) return current;
    current = parent;
  }
  return current ?? null;
}

const SPAN_KEYS = ['id', 'kind', 'spanId', 'name', 'spanKind', 'createdAt'];

export function createSpans({ store, hash, now, id }) {
  if (typeof now !== 'function' || typeof id !== 'function') throw Error('Spans need now and id.');
  const digest = makeDigest(hash);
  const gate = createGate(store, [SPAN_PREFIX]);
  const instant = () => { const at = now(); if (!validIsoInstant(at)) throw Error('Time must be a valid ISO instant.'); return at; };

  async function readSpans() {
    const result = new Map(builtins().map(span => [span.id, span])), damaged = [];
    for (const record of await gate.mine()) {
      try {
        const body = await openRecord(record, SPAN_KEYS, digest);
        const valid = body.kind === 'span' && body.id === SPAN_PREFIX + body.spanId && validSpanName(body.name) &&
          body.spanId === spanKey(body.name) && body.spanKind === builtinKind(body.name) && validIsoInstant(body.createdAt);
        if (!valid) throw Error('A saved Attention Span is not valid.');
        const { spanId, name, spanKind, createdAt } = body;
        if (!result.has(spanId)) result.set(spanId, { id: spanId, name, kind: spanKind, createdAt });
      } catch (error) { damaged.push({ id: record.id, reason: error.message }); }
    }
    return { spans: [...result.values()], damaged };
  }

  async function createSpan(name) {
    const clean = cleanSpanName(name);
    if (!validSpanName(clean)) throw Error('Give the Attention Span a name between 2 and 40 characters.');
    const existing = (await readSpans()).spans.find(span => span.id === spanKey(clean));
    if (existing) return structuredClone(existing);
    const spanId = spanKey(clean);
    const body = { id: SPAN_PREFIX + spanId, kind: 'span', spanId, name: clean, spanKind: builtinKind(clean), createdAt: instant() };
    await gate.create(await sealRecord(body, digest));
    const saved = (await readSpans()).spans.find(span => span.id === body.spanId);
    if (!saved) throw Error('The Attention Span could not be read back. Try again.');
    return structuredClone(saved);
  }

  async function verifiedPost(record) {
    return !!record && typeof record.id === 'string' && typeof record.text === 'string' && validIsoInstant(record.createdAt) &&
      await hash(record.text) === record.hash;
  }
  const view = async record => ({
    id: record.id, text: record.text, createdAt: record.createdAt, span: spanOf(record), parentId: parentOf(record),
    verified: await verifiedPost(record),
  });

  async function save({ text, span, parentId, requestId, derivedFromId }) {
    if (!textAllowed(text)) throw Error('Add between 1 and 4,000 characters of text.');
    const metadata = { span, ...(parentId ? { parentId } : {}), ...(derivedFromId ? { derivedFromId } : {}) };
    const record = await createCapture({ id: requestId ?? id(), text, createdAt: instant(), metadata }, hash);
    const prior = requestId ? await store.get(requestId) : null;
    if (prior) {
      if (prior.text !== text || spanOf(prior) !== span || parentOf(prior) !== (parentId ?? null) ||
          (prior.metadata?.derivedFromId ?? null) !== (derivedFromId ?? null)) {
        throw Error('This request ID already belongs to different writing. Nothing was overwritten.');
      }
      if (!await verifiedPost(prior)) throw Error('Original source changed or failed verification.');
      return view(prior);
    }
    await store.append(record);
    const actual = await store.get(record.id);
    if (!await verifiedPost(actual) || !same(actual, record)) {
      throw Error('The save could not be read back exactly. Your writing is still here.');
    }
    return view(actual);
  }

  async function post(spanName, text, { id: requestId } = {}) {
    if (requestId !== undefined && !safePart(requestId)) throw Error('The request ID is not valid.');
    const found = (await readSpans()).spans.find(span => span.id === spanKey(spanName));
    if (!found) throw Error('Create the Attention Span before posting in it.');
    return save({ text, span: found.name, parentId: null, requestId });
  }

  async function reply(parentId, text, { span, id: requestId, derivedFromId } = {}) {
    if (requestId !== undefined && !safePart(requestId)) throw Error('The request ID is not valid.');
    const parent = typeof parentId === 'string' ? await store.get(parentId) : null;
    if (!parent) throw Error('That post was not found.');
    if (!await verifiedPost(parent)) throw Error('Original source changed or failed verification.');
    if (span !== undefined && spanKey(span) !== spanKey(spanOf(parent))) throw Error('Reply in the original Attention Span.');
    return save({ text, span: spanOf(parent), parentId: parent.id, requestId, derivedFromId });
  }

  async function getPost(postId) {
    const record = await store.get(postId);
    if (!record) throw Error('That post was not found.');
    return view(record);
  }

  async function listPosts(spanName) {
    const records = await store.list();
    const wanted = spanName === undefined ? null : spanKey(spanName);
    const mine = records.filter(record => wanted === null || spanKey(spanOf(record)) === wanted);
    return Promise.all(mine.map(view));
  }

  /** The whole thread around a post, nested. Damaged posts stay visible and are marked, never hidden or fixed. */
  async function thread(postId) {
    const records = await store.list(), byId = new Map(records.map(r => [r.id, r]));
    const start = byId.get(postId);
    if (!start) throw Error('That post was not found.');
    const top = threadRoot(start, byId) ?? start;
    const children = new Map();
    for (const record of records) if (parentOf(record)) {
      const list = children.get(parentOf(record)) ?? [];
      list.push(record); children.set(parentOf(record), list);
    }
    const seen = new Set();
    const build = async record => {
      seen.add(record.id);
      const replies = [];
      for (const child of children.get(record.id) ?? []) if (!seen.has(child.id)) replies.push(await build(child));
      return { ...await view(record), replies };
    };
    return build(top);
  }

  return { listSpans: async () => structuredClone(await readSpans()), createSpan, post, reply, getPost, listPosts, thread };
}
