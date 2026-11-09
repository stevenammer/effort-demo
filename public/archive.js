// A display-only snapshot. Original strings and their identities never change.
export const ARCHIVE_PAGE_SIZE = 50;
export function archiveSnapshot(captures, query = '') {
  const needle = String(query).trim().toLowerCase();
  return captures.filter(c => !needle || c.text.toLowerCase().includes(needle)).slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
}
export function archiveWindow(rows, { aroundId = null, offset = 0, limit = ARCHIVE_PAGE_SIZE } = {}) {
  const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || ARCHIVE_PAGE_SIZE)));
  const rank = aroundId ? rows.findIndex(c => c.id === aroundId) : -1;
  const start = rank >= 0 ? Math.max(0, rank - Math.floor(size / 10)) : Math.max(0, Math.floor(Number(offset) || 0));
  return { rows: rows.slice(start, start + size), offset: start, next: start + Math.min(size, Math.max(0, rows.length - start)), total: rows.length, hasMore: start + size < rows.length };
}
