import { createCapture } from './capture.js';
import { validIsoInstant } from './export.js';
import { createGate, inOrder, isMarker, makeDigest, openMarker, openRecord, sealRecord, same, safePart, textAllowed } from './sealed.js';

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
    const result = new Map(builtins().map(span => [span.id, span])), damaged = [], markers = new Map(), originals = new Map();
    for (const record of await gate.mine()) {
      originals.set(record.id, record);
      try {
        if (isMarker(record)) { await openMarker(record, digest); markers.set(record.id, record); continue; }
        const body = await openRecord(record, SPAN_KEYS, digest);
        const valid = body.kind === 'span' && body.id === SPAN_PREFIX + body.spanId && validSpanName(body.name) &&
          body.spanId === spanKey(body.name) && body.spanKind === builtinKind(body.name) && validIsoInstant(body.createdAt);
        if (!valid) throw Error('A saved Attention Span is not valid.');
        const { spanId, name, spanKind, createdAt } = body;
        if (!result.has(spanId)) result.set(spanId, { id: spanId, name, kind: spanKind, createdAt });
      } catch (error) { damaged.push({ id: record.id, reason: error.message }); }
    }
    // Built-in spans first, then the others by creation time and then ID, the same on every adapter.
    const builtin = [...result.values()].filter(span => span.createdAt === null);
    return { spans: [...builtin, ...inOrder([...result.values()].filter(span => span.createdAt !== null))], damaged, markers, originals };
  }

  const damagedSpan = name => Object.assign(Error(
    `The saved record for the Attention Span "${name}" is damaged. The posts already in it are still readable ` +
    'and nothing was deleted. Set the damaged record aside (it is kept, not deleted), ' +
    'then create the Attention Span again.'), { code: 'SPAN_DAMAGED', target: name });
  const isDamaged = (state, name) => state.damaged.some(item => item.id === SPAN_PREFIX + spanKey(name));

  async function createSpan(name) {
    const clean = cleanSpanName(name);
    if (!validSpanName(clean)) throw Error('Give the Attention Span a name between 2 and 40 characters.');
    const state = await readSpans(), existing = state.spans.find(span => span.id === spanKey(clean));
    if (existing) return structuredClone(existing);
    if (isDamaged(state, clean)) throw damagedSpan(clean);
    const spanId = spanKey(clean);
    const body = { id: SPAN_PREFIX + spanId, kind: 'span', spanId, name: clean, spanKind: builtinKind(clean), createdAt: instant() };
    const sealed = await sealRecord(body, digest), marker = state.markers.get(body.id);
    const made = marker ? await gate.createOver(marker, sealed) : await gate.create(sealed);
    const after = await readSpans(), saved = after.spans.find(span => span.id === body.spanId);
    if (!saved) {
      if (isDamaged(after, clean)) throw damagedSpan(clean);
      throw Error(made ? 'The Attention Span was saved but could not be read back, so it is not in use yet. Your posts are unchanged.'
        : 'This Attention Span changed in another tab. Look at the list of Attention Spans again.');
    }
    return structuredClone(saved);
  }

  /** Puts a damaged saved Attention Span record in quarantine (kept, still in exports) so the name can be created again. */
  async function setAsideSpan(name) {
    const clean = cleanSpanName(name);
    if (!validSpanName(clean)) throw Error('Give the Attention Span a name between 2 and 40 characters.');
    const state = await readSpans(), recordId = SPAN_PREFIX + spanKey(clean);
    const hurt = state.damaged.find(item => item.id === recordId);
    if (!hurt) throw Error(`There is no damaged saved record for the Attention Span "${clean}", so nothing was set aside.`);
    const record = state.originals.get(recordId);
    const marker = await sealRecord({ id: recordId, kind: 'set-aside', setAsideAt: instant() }, digest);
    if (!record || !await gate.setAside(record, marker, `Set aside from the Attention Span "${clean}": ${hurt.reason}`)) {
      throw Error('The saved record changed while it was being set aside. Nothing was lost. Look at the Attention Spans again.');
    }
    return { setAside: recordId, name: clean };
  }

  async function verifiedPost(record) {
    const meta = record?.metadata;
    const shapeOk = (meta?.span === undefined || typeof meta.span === 'string') &&
      (meta?.parentId === undefined || meta.parentId === null || typeof meta.parentId === 'string');
    return !!record && shapeOk && typeof record.id === 'string' && typeof record.text === 'string' && validIsoInstant(record.createdAt) &&
      await hash(record.text) === record.hash;
  }
  const view = async record => ({
    id: record.id, text: record.text, createdAt: record.createdAt, span: typeof spanOf(record) === 'string' ? spanOf(record) : null,
    parentId: typeof parentOf(record) === 'string' ? parentOf(record) : null, verified: await verifiedPost(record),
  });

  async function save({ text, span, parentId, requestId, derivedFromId }) {
    if (!textAllowed(text)) throw Error('Add between 1 and 4,000 characters of text.');
    if (typeof span !== 'string') throw Error('This post has no valid Attention Span, so nothing was saved.');
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
    const state = await readSpans(), found = state.spans.find(span => span.id === spanKey(spanName));
    if (!found && isDamaged(state, cleanSpanName(spanName))) throw damagedSpan(cleanSpanName(spanName));
    if (!found) throw Error('Create the Attention Span before posting in it.');
    return save({ text, span: found.name, parentId: null, requestId });
  }

  async function reply(parentId, text, { span, id: requestId, derivedFromId } = {}) {
    if (requestId !== undefined && !safePart(requestId)) throw Error('The request ID is not valid.');
    if (derivedFromId !== undefined && (typeof derivedFromId !== 'string' || !derivedFromId)) {
      throw Error('The source of this reply is not valid, so nothing was saved.');
    }
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

  /**
   * A bounded, stable reading window for callers that don't need every post.
   * Adapters may provide listWindow in the future; keeping the envelope here
   * gives browser and CLI callers one pagination contract now without changing
   * the long-standing listPosts result.
   */
  async function listPostsWindow(spanName, { offset = 0, limit = 50 } = {}) {
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    const wanted = spanName === undefined ? null : spanKey(spanName);
    if (typeof store.listWindow === 'function') {
      const page = await store.listWindow({ offset: start, limit: size, matches: record => wanted === null || spanKey(spanOf(record)) === wanted });
      const posts = await Promise.all(page.records.map(view));
      return { posts, offset: page.offset, next: page.next, total: page.total, hasMore: page.hasMore };
    }
    const all = await listPosts(spanName), posts = all.slice(start, start + size);
    return { posts, offset: start, next: start + posts.length, total: all.length, hasMore: start + posts.length < all.length };
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
    // Iterative on purpose: a very long chain of replies must not overflow the stack.
    const seen = new Set(), stack = [{ record: top, into: null }];
    let root = null;
    while (stack.length) {
      const { record, into } = stack.pop();
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      const node = { ...await view(record), replies: [] };
      if (into) into.replies.push(node); else root = node;
      const kids = children.get(record.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) if (!seen.has(kids[i].id)) stack.push({ record: kids[i], into: node });
    }
    return root;
  }

  return {
    listSpans: async () => { const { spans, damaged } = await readSpans(); return structuredClone({ spans, damaged }); },
    createSpan, setAsideSpan, post, reply, getPost, listPosts, listPostsWindow, thread,
  };
}
