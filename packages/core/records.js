/** One shared check that every storage adapter runs before it writes anything. */
import { canonical } from './export.js';

const PLAIN_PROBLEM = 'cannot be saved exactly as written (it holds a value that does not survive a save and reload)';

/** Throws a plain-English error unless the record has a non-empty string id and round-trips through canonical JSON. */
export function checkRecord(record, label = 'Record') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error(`${label} must be an object.`);
  if (typeof record.id !== 'string' || !record.id) throw Error(`${label} needs an ID that is a non-empty string.`);
  try { canonical(record); } catch { throw Error(`${label} ${PLAIN_PROBLEM}. Nothing was written.`); }
  return record;
}

/** Quarantined entries have no ID rule, but they must still round-trip. */
export function checkRoundTrip(value, label = 'Record') {
  try { canonical(value); } catch { throw Error(`${label} ${PLAIN_PROBLEM}. Nothing was written.`); }
  return value;
}

export function checkSnapshotRecords(incoming) {
  for (const kind of ['captures', 'derived']) {
    if (!Array.isArray(incoming?.[kind])) throw Error(`Invalid ${kind} snapshot.`);
    for (const record of incoming[kind]) checkRecord(record, `A ${kind === 'captures' ? 'capture' : 'derived'} record`);
  }
  if (incoming.quarantine !== undefined) {
    if (!Array.isArray(incoming.quarantine)) throw Error('Invalid quarantine snapshot.');
    checkRoundTrip(incoming.quarantine, 'A quarantined entry');
  }
}
