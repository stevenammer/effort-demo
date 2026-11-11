// Bounded DOM windows keep a long local history scrollable. The source records
// remain in IndexedDB and are never evicted by this display policy.
export const SPAN_WINDOW = 50;
export const THREAD_WINDOW = 100;

export function boundedWindow(rows, offset = 0, limit = SPAN_WINDOW) {
  const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || SPAN_WINDOW)));
  const start = Math.min(rows.length, Math.max(0, Math.floor(Number(offset) || 0)));
  const end = Math.min(rows.length, start + size);
  return {
    rows: rows.slice(start, end),
    start,
    end,
    shown: end,
    total: rows.length,
    hasOlder: end < rows.length,
    hasNewer: start > 0,
    hasMore: end < rows.length,
  };
}
