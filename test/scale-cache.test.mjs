import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSpans } from '../packages/core/spans.js';
import { boundedWindow, SPAN_WINDOW, THREAD_WINDOW } from '../public/windowed-list.js';
import { cacheBudget, clearRegenerableCaches } from '../public/cache-budget.js';

const hash = async value => createHash('sha256').update(value).digest('hex');

test('core reads a 10,000-post span through a bounded adapter window', async () => {
  const records = await Promise.all(Array.from({ length: 10_000 }, async (_, n) => {
    const text = `Synthetic post ${n}`;
    return { id: `post-${n}`, text, hash: await hash(text), createdAt: new Date(1767225600000 + n).toISOString(), metadata: { span: 'Scale test' } };
  }));
  let calls = 0;
  const store = {
    async list() { throw Error('The bounded reader must not request every post.'); },
    async get(id) { return records.find(row => row.id === id) ?? null; },
    async snapshot() { return { captures: records, derived: [], quarantine: [] }; },
    async compareAndSwapDerived() { return false; },
    async listWindow({ offset, limit, matches }) { calls++; const matching = records.filter(matches); const page = matching.slice(offset, offset + limit); return { records: page, offset, next: offset + page.length, total: matching.length, hasMore: offset + page.length < matching.length }; },
  };
  const spans = createSpans({ store, hash, now: () => '2026-01-01T00:00:00.000Z', id: () => 'unused' });
  const first = await spans.listPostsWindow('Scale test');
  const later = await spans.listPostsWindow('Scale test', { offset: 9_950, limit: 50 });
  assert.equal(calls, 2); assert.equal(first.posts.length, 50); assert.equal(first.total, 10_000); assert.equal(first.hasMore, true);
  assert.equal(later.posts.length, 50); assert.equal(later.next, 10_000); assert.equal(later.hasMore, false);
});

test('browser display windows keep a 10,000-row fake DOM list bounded and load more deliberately', () => {
  const rows = Array.from({ length: 10_000 }, (_, id) => ({ id }));
  // This tiny fake host stands in for replaceChildren: only the returned window
  // would become DOM nodes, never the full local history.
  const host = { children: [], replaceChildren(...children) { this.children = children; } };
  let page = boundedWindow(rows, 0, SPAN_WINDOW); host.replaceChildren(...page.rows);
  assert.equal(host.children.length, 50); assert.equal(page.hasMore, true);
  page = boundedWindow(rows, page.shown, THREAD_WINDOW); host.replaceChildren(...page.rows);
  assert.equal(host.children.length, 100); assert.equal(page.start, 50); assert.equal(page.shown, 150);
  assert.equal(page.rows[0].id, 50); assert.equal(page.rows.at(-1).id, 149);
});

test('cache budget and cleanup address only regenerable shell caches', async () => {
  const kept = new Map([['effort-offline-shell-v1-current', [{ headers: new Headers({ 'content-length': '1024' }) }]], ['unrelated-cache', [{ headers: new Headers({ 'content-length': '4000' }) }]]]);
  const cacheStorage = { async keys() { return [...kept.keys()]; }, async open(name) { return { async keys() { return kept.get(name); }, async match(request) { return request; } }; } };
  const report = await cacheBudget({ cacheStorage }); assert.deepEqual({ count: report.count, bytes: report.bytes }, { count: 1, bytes: 1024 });
  class Channel { constructor() { this.port1 = {}; this.port2 = {}; } }
  const worker = { postMessage(message, ports) { assert.equal(message.type, 'CLEAR_REGENERABLE_CACHES'); queueMicrotask(() => ports[0] === undefined ? null : null); queueMicrotask(() => this.channel.port1.onmessage({ data: { ok: true, removed: 2 } })); }, channel: null };
  const messageChannel = class extends Channel { constructor() { super(); worker.channel = this; } };
  assert.equal(await clearRegenerableCaches({ worker, messageChannel }), 2);
  await assert.rejects(clearRegenerableCaches({ worker: null, messageChannel }), /not controlling/);
});
