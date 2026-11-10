import { checkRecord, checkSnapshotRecords } from '../core/records.js';

/** Use UTF-16 code-unit ordering everywhere, independent of machine locale. */
export function ordered(records) {
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return records.sort((left, right) => compare(left.createdAt, right.createdAt) || compare(left.id, right.id));
}

export function validateCas(id, expected, replacement) {
  if (replacement) checkRecord(replacement);
  if (expected) checkRecord(expected);
  if (typeof id !== 'string' || !id || !replacement || replacement.id !== id ||
      (expected !== null && (!expected || expected.id !== id))) throw Error('Invalid derived compare-and-swap records.');
  return [expected === null ? null : structuredClone(expected), structuredClone(replacement)];
}

/** A direct import must not create two originals or two versions of a view. */
export function copySnapshot(incoming) {
  checkSnapshotRecords(incoming);
  const copy = structuredClone(incoming);
  for (const kind of ['captures', 'derived']) {
    if (!Array.isArray(copy?.[kind])) throw Error(`Invalid ${kind} snapshot.`);
    const ids = new Set();
    for (const record of copy[kind]) {
      if (!record || typeof record.id !== 'string' || !record.id) throw Error('Record ID must be a non-empty string.');
      if (ids.has(record.id)) throw Error(`Duplicate ${kind} ID in snapshot.`);
      ids.add(record.id);
    }
  }
  if (copy.quarantine !== undefined && !Array.isArray(copy.quarantine)) throw Error('Invalid quarantine snapshot.');
  return copy;
}
