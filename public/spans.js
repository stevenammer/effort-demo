import { exactKeys, validDate, validId } from './primitives.js';

export const BUILTIN_SPANS = Object.freeze([
  ['Unsorted', 'raw'], ['Product demo', 'journal'], ['Learning', 'journal'],
  ['Proof', 'proof'], ['People', 'people'], ['Moves', 'moves'], ['Workspace', 'workspace'],
]);
export const cleanSpanName = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
export const spanKey = value => cleanSpanName(value).toLowerCase();
export function validSpanName(value) {
  return typeof value === 'string' && value === cleanSpanName(value) && value.length >= 2 && value.length <= 40 && !/[\p{C}]/u.test(value);
}
export function makeSpan(name, createdAt = '2026-01-01T00:00:00.000Z') {
  name = cleanSpanName(name);
  if (!validSpanName(name)) throw Error('Give the Attention Span a name between 2 and 40 characters.');
  return { id: spanKey(name), name, kind: BUILTIN_SPANS.find(([n]) => spanKey(n) === spanKey(name))?.[1] ?? 'journal', createdAt };
}
export function validSpan(span) {
  return exactKeys(span, ['id', 'name', 'kind', 'createdAt']) && validSpanName(span.name) && span.id === spanKey(span.name) &&
    span.kind === makeSpan(span.name).kind && validDate(span.createdAt);
}
export function initialSpans(captures = []) {
  const result = new Map(BUILTIN_SPANS.map(([name]) => { const span = makeSpan(name); return [span.id, span]; }));
  for (const capture of captures) if (!result.has(spanKey(capture.span))) {
    const span = makeSpan(capture.span, validDate(capture.createdAt) ? capture.createdAt : undefined); result.set(span.id, span);
  }
  return [...result.values()];
}
export function parentOf(capture) { return capture.parentId ?? null; }
export function threadRoot(capture, captures) {
  const byId = captures instanceof Map ? captures : new Map(captures.map(c => [c.id, c]));
  const seen = new Set(); let current = capture;
  while (current && parentOf(current)) {
    if (seen.has(current.id)) return null;
    seen.add(current.id); const parent = byId.get(current.parentId); if (!parent) return current; current = parent;
  }
  return current ?? null;
}
export function validateThreadLinks(captures, recovery = []) {
  const byId = new Map(captures.map(c => [c.id, c]));
  for (const capture of captures) {
    const parent = parentOf(capture); if (!parent) continue;
    if (!validId(parent) || parent === capture.id) throw Error('The backup contains an invalid reply link.');
    const seen = new Set([capture.id]); let current = capture;
    while (parentOf(current)) {
      const next = byId.get(current.parentId);
      if (!next) {
        if (!recovery.some(r => r.source === 'capture' && r.recordId === current.parentId)) throw Error('A reply is missing its original parent. Nothing was changed.');
        break;
      }
      if (seen.has(next.id)) throw Error('Reply links cannot form a cycle.');
      if (spanKey(next.span) !== spanKey(capture.span)) throw Error('A reply must remain in its parent Attention Span.');
      seen.add(next.id); current = next;
    }
  }
}
