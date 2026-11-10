/** Portable, deterministic shared-store backup. Hash accepts a UTF-8 string. */
export const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const paths = ['captures.jsonl', 'derived.jsonl', 'quarantine.jsonl'];
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).length;

function own(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function validIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? 0) > 59) return false;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || seen.has(value)) throw Error('Unsupported JSON value.');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw Error('Unsupported array.');
    result = `[${value.map((item) => canonical(item, seen)).join(',')}]`;
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Unsupported object.');
    const keys = Object.keys(value).sort();
    if (keys.includes('__proto__')) throw Error('Unsafe key.');
    result = `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function normalize(records, capture) {
  if (!Array.isArray(records)) throw Error('Records must be an array.');
  const ids = new Set();
  return records.map((record) => {
    canonical(record);
    const invalidId = !record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.id !== 'string' || !record.id || ids.has(record.id);
    if (invalidId) {
      throw Error('Invalid or duplicate record ID.');
    }
    if (capture && typeof record.text !== 'string') throw Error('Missing text.');
    if (capture && (typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.hash))) {
      throw Error('Bad hash format.');
    }
    if (capture && !validIsoInstant(record.createdAt)) throw Error('Impossible date.');
    ids.add(record.id);
    return record;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function digest(hash, text) {
  if (typeof hash !== 'function') throw Error('SHA-256 function required.');
  const result = await hash(text);
  if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) throw Error('Invalid SHA-256 result.');
  return result;
}

async function validateCaptures(captures, hash) {
  for (const record of captures) {
    if (await digest(hash, record.text) !== record.hash) throw Error('Capture hash mismatch.');
  }
}

function quarantineReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (['Missing text.', 'Bad hash format.', 'Impossible date.'].includes(message)) return message;
  if (message === 'Capture hash mismatch.') return 'Hash does not match text.';
  if (message === 'Unsafe key.') return 'Unsafe key.';
  if (/Unsupported JSON|Unsupported array|Unsupported object/.test(message)) return 'Cannot be serialized.';
  return message;
}

function serializeRaw(record) {
  try {
    const raw = JSON.stringify(record);
    if (typeof raw !== 'string') throw Error('Stored record is not serializable.');
    return { raw, suffix: '' };
  } catch {
    return { raw: null, suffix: ' Raw record could not be serialized.' };
  }
}

async function splitRecords(records, capture, hash, kind) {
  if (!Array.isArray(records)) {
    const serialized = serializeRaw(records);
    return { valid: [], quarantine: [{ kind, reason: `Records must be an array.${serialized.suffix}`, raw: serialized.raw }] };
  }
  const valid = [];
  const quarantine = [];
  const ids = new Set();
  for (const record of records) {
    try {
      const [normalized] = normalize([record], capture);
      if (ids.has(normalized.id)) throw Error('Invalid or duplicate record ID.');
      if (capture) await validateCaptures([normalized], hash);
      valid.push(normalized);
      ids.add(normalized.id);
    } catch (error) {
      const serialized = serializeRaw(record);
      quarantine.push({ kind, reason: `${quarantineReason(error)}${serialized.suffix}`, raw: serialized.raw });
    }
  }
  return { valid: normalize(valid, capture), quarantine };
}

function entryText(records) {
  return records.map((record) => canonical(record)).join('\n') + (records.length ? '\n' : '');
}

export async function createExport(store, hash) {
  const snapshot = await store.snapshot();
  const captureSet = await splitRecords(snapshot.captures, true, hash, 'capture');
  const derivedSet = await splitRecords(snapshot.derived, false, hash, 'derived');
  const quarantine = [...(snapshot.quarantine ?? []), ...captureSet.quarantine, ...derivedSet.quarantine];
  for (const record of quarantine) validateQuarantine(record);
  quarantine.sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  const recordSets = [captureSet.valid, derivedSet.valid, quarantine];
  const entries = recordSets.map((records, index) => ({ path: paths[index], text: entryText(records) }));
  const meta = [];
  for (let index = 0; index < entries.length; index++) {
    meta.push({
      path: paths[index],
      count: recordSets[index].length,
      bytes: bytes(entries[index].text),
      sha256: await digest(hash, entries[index].text),
    });
  }
  const manifest = { format: 'effort-export/1', entries: meta };
  const bundle = canonical({ manifest, manifestSha256: await digest(hash, canonical(manifest)), entries });
  if (bytes(bundle) > MAX_EXPORT_BYTES) throw Error('Export exceeds size limit.');
  return bundle;
}

function parseEntry(text) {
  if (!text) return [];
  if (!text.endsWith('\n')) throw Error('Truncated JSONL.');
  try { return text.slice(0, -1).split('\n').map((line) => JSON.parse(line)); } catch { throw Error('Malformed JSONL.'); }
}

function validateQuarantine(record) {
  if (!own(record, ['kind', 'reason', 'raw']) || !['capture', 'derived'].includes(record.kind) ||
      typeof record.reason !== 'string' || (record.raw !== null && typeof record.raw !== 'string')) {
    throw Error('Invalid quarantine record.');
  }
}

/** Preserve quarantine counts, including bad originals still present at destination. */
export function quarantineToAppend(current, incoming, sourceQuarantine = []) {
  const sources = new Map();
  for (const [kind, records] of [['capture', current.captures], ['derived', current.derived]]) {
    for (const record of records) {
      const key = canonical({ kind, raw: serializeRaw(record).raw });
      sources.set(key, (sources.get(key) ?? 0) + 1);
    }
  }
  const remaining = new Map();
  for (const record of current.quarantine ?? []) {
    const key = canonical(record); remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  // Coverage was verified before the transaction; retain it only while the raw
  // source is still present in the transaction's current snapshot.
  for (const record of sourceQuarantine) {
    const source = canonical({ kind: record.kind, raw: record.raw }), count = sources.get(source) ?? 0;
    if (count) {
      sources.set(source, count - 1);
      const key = canonical(record); remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
  }
  return incoming.filter(record => {
    const key = canonical(record), count = remaining.get(key) ?? 0;
    if (!count) return true;
    remaining.set(key, count - 1); return false;
  });
}

export async function verifyExport(input, hash) {
  if (typeof input !== 'string' || bytes(input) > MAX_EXPORT_BYTES) throw Error('Invalid or oversized export.');
  let bundle;
  try { bundle = JSON.parse(input); } catch { throw Error('Malformed export JSON.'); }
  canonical(bundle);
  if (!own(bundle, ['manifest', 'manifestSha256', 'entries']) || !own(bundle.manifest, ['format', 'entries']) ||
    bundle.manifest.format !== 'effort-export/1' || !Array.isArray(bundle.entries) ||
    !Array.isArray(bundle.manifest.entries) || bundle.entries.length !== paths.length ||
    bundle.manifest.entries.length !== paths.length) throw Error('Invalid export envelope or version.');
  if (await digest(hash, canonical(bundle.manifest)) !== bundle.manifestSha256) throw Error('Manifest checksum mismatch.');
  const all = [];
  for (let index = 0; index < paths.length; index++) {
    const entry = bundle.entries[index];
    const meta = bundle.manifest.entries[index];
    if (!own(entry, ['path', 'text']) || !own(meta, ['path', 'count', 'bytes', 'sha256']) ||
      entry.path !== paths[index] || meta.path !== paths[index] || typeof entry.text !== 'string' ||
      !Number.isSafeInteger(meta.count) || meta.count < 0 || !Number.isSafeInteger(meta.bytes) ||
      meta.bytes < 0 || bytes(entry.text) !== meta.bytes || await digest(hash, entry.text) !== meta.sha256) {
      throw Error('Invalid entry or checksum.');
    }
    const parsed = parseEntry(entry.text);
    const records = index === 2 ? parsed : normalize(parsed, index === 0);
    if (records.length !== meta.count || entryText(records) !== entry.text) throw Error('Noncanonical or invalid JSONL.');
    all.push(records);
  }
  await validateCaptures(all[0], hash);
  for (const record of all[2]) validateQuarantine(record);
  return { captures: all[0], derived: all[1], quarantine: all[2] };
}

export async function restoreExport(store, input, hash) {
  const incoming = await verifyExport(input, hash);
  const before = await store.snapshot();
  const sourceQuarantine = [...(await splitRecords(before.captures, true, hash, 'capture')).quarantine,
    ...(await splitRecords(before.derived, false, hash, 'derived')).quarantine];
  const result = await store.importSnapshot(incoming, { sourceQuarantine });
  const readback = await store.snapshot();
  for (const kind of ['captures', 'derived']) {
    const byId = new Map(readback[kind].map((record) => [record.id, canonical(record)]));
    for (const record of incoming[kind]) {
      if (kind === 'derived' && result?.keptExisting?.includes(record.id)) continue;
      if (byId.get(record.id) !== canonical(record)) throw Error('Import committed but readback failed; retry is safe.');
    }
  }
  const available = new Map();
  const recovered = [...(readback.quarantine ?? []),
    ...(await splitRecords(readback.captures, true, hash, 'capture')).quarantine,
    ...(await splitRecords(readback.derived, false, hash, 'derived')).quarantine];
  for (const row of recovered) {
    const key = canonical(row); available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const row of incoming.quarantine) {
    const key = canonical(row), count = available.get(key) ?? 0;
    if (!count) throw Error('Import committed but quarantine readback failed; retry is safe.');
    available.set(key, count - 1);
  }
  return { ...incoming, keptExisting: result?.keptExisting ?? [] };
}
