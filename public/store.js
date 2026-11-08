import { openDatabase, request, TABLES } from './database.js';
import { KEY, LIMITS, SPANS, blank, clone, same, exactKeys, textAllowed, sha256, validChoice,
  validateCapture, validateState, recoveryRecord, validHash, IntegrityError } from './records.js';
export { KEY, LIMITS, SPANS, sha256, validChoice, validateState } from './records.js';

const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
const setMeta = (tx, key, value) => request(tx.objectStore('meta').put({ key, value }));
const json = value => JSON.stringify(value) ?? 'undefined';

// Hash outside transactions; transactional callbacks await only IndexedDB requests.
export function createStore(options = {}) {
  if (typeof options?.getItem === 'function') options = { legacyStorage: options };
  let legacy = options.legacyStorage;
  if (legacy === undefined) { try { legacy = globalThis.localStorage; } catch { legacy = null; } }
  const db = openDatabase({ factory: options.indexedDB ?? globalThis.indexedDB, name: options.name });
  const listeners = new Set();
  const channel = options.broadcast !== false && typeof window !== 'undefined' && typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(`${db.name}-changes`) : null;
  function notifyListeners() {
    for (const listener of listeners) { try { Promise.resolve(listener()).catch(() => {}); } catch {} }
  }
  function notify() { notifyListeners(); try { channel?.postMessage({ changed: true }); } catch {} }
  if (channel) channel.onmessage = event => { if (event.data?.changed === true) notifyListeners(); };
  let initialized;
  function ready() { return initialized ??= migrate().catch(error => { initialized = null; throw error; }); }
  async function migrate() {
    if (!globalThis.crypto?.subtle) throw Error('This browser cannot verify originals. Keep the draft and open the HTTPS version.');
    if (await db.run(['meta'], 'readonly', tx => meta(tx, 'legacyChecked'))) return;
    let raw;
    try { raw = legacy ? legacy.getItem(KEY) : null; }
    catch {
      await db.run(['meta'], 'readwrite', tx => setMeta(tx, 'migrationWarning', 'The previous browser copy could not be read. It has not been removed.'));
      return;
    }
    const valid = [], recovery = [], conflicts = new Map(); let oldNow = null;
    if (raw !== null) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch {}
      if (!exactKeys(parsed, ['version', 'kind', 'captures', 'now']) || parsed.version !== 1 ||
          parsed.kind !== 'effort-browser-demo' || !Array.isArray(parsed.captures) || parsed.captures.length > LIMITS.captures) {
        recovery.push(await recoveryRecord('legacy-state', KEY, raw, 'The previous-format browser copy could not be parsed safely.'));
      } else {
        const counts = new Map();
        for (const c of parsed.captures) counts.set(c?.id, (counts.get(c?.id) ?? 0) + 1);
        for (const c of parsed.captures) {
          try {
            await validateCapture(c);
            if (counts.get(c.id) !== 1) throw new IntegrityError('The previous copy contains a duplicate capture ID.');
            valid.push(c);
            conflicts.set(c.id, await recoveryRecord('capture', c.id, json(c), 'An existing original with this ID differs from the previous browser copy.'));
          } catch (error) {
            if (!(error instanceof IntegrityError)) throw error;
            recovery.push(await recoveryRecord('capture', String(c?.id ?? 'unknown').slice(0, 128), json(c), error.message));
          }
        }
        if (parsed.now !== null) {
          if (validChoice(parsed.now, valid)) oldNow = parsed.now;
          else recovery.push(await recoveryRecord('now', 'now', json(parsed.now), 'The previous chosen step needs its original recovered.'));
        }
      }
    }
    await db.run(['captures', 'meta', 'quarantine'], 'readwrite', async tx => {
      if (await meta(tx, 'legacyChecked')) return;
      const captures = tx.objectStore('captures');
      for (const c of valid) {
        const existing = await request(captures.get(c.id));
        if (!existing) await request(captures.put(c));
        else if (!same(existing, c)) recovery.push(conflicts.get(c.id));
      }
      for (const r of recovery) if (!await request(tx.objectStore('quarantine').get(r.id))) await request(tx.objectStore('quarantine').put(r));
      if ((await meta(tx, 'now')) === undefined) await setMeta(tx, 'now', oldNow);
      if (recovery.some(r => r.source === 'now')) await setMeta(tx, 'heldNow', true);
      if (raw !== null) await setMeta(tx, 'initialized', true);
      await setMeta(tx, 'legacyChecked', true); await setMeta(tx, 'migrationWarning', null);
    });
    // Preserve the original localStorage bytes as a rollback copy.
  }
  async function recover() {
    await ready();
    const snapshot = await db.run(['captures', 'meta'], 'readonly', async tx => ({
      captures: await request(tx.objectStore('captures').getAll()), now: (await meta(tx, 'now')) ?? null,
    }));
    const good = [], bad = [];
    for (const capture of snapshot.captures) {
      try { await validateCapture(capture); good.push(capture); }
      catch (error) {
        if (!(error instanceof IntegrityError)) throw error;
        bad.push({ capture, recovery: await recoveryRecord('capture', String(capture.id), json(capture), error.message) });
      }
    }
    const brokenNow = snapshot.now !== null && !validChoice(snapshot.now, good)
      ? await recoveryRecord('now', 'now', json(snapshot.now), 'The chosen step needs its original recovered.') : null;
    if (!bad.length && !brokenNow) return;
    await db.run(['captures', 'meta', 'quarantine'], 'readwrite', async tx => {
      for (const item of bad) {
        const current = await request(tx.objectStore('captures').get(item.capture.id));
        if (!same(current, item.capture)) continue;
        await request(tx.objectStore('quarantine').put(item.recovery));
        await request(tx.objectStore('captures').delete(item.capture.id));
      }
      if (brokenNow && same(await meta(tx, 'now'), snapshot.now)) {
        await request(tx.objectStore('quarantine').put(brokenNow));
        await setMeta(tx, 'now', null); await setMeta(tx, 'heldNow', true);
      }
    });
  }
  async function read() {
    await recover();
    return db.run(['captures', 'meta', 'quarantine'], 'readonly', async tx => {
      const captures = await request(tx.objectStore('captures').getAll());
      captures.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { ...blank(), captures, now: (await meta(tx, 'now')) ?? null,
        recovery: await request(tx.objectStore('quarantine').getAll()) };
    });
  }
  async function health() {
    await ready();
    return db.run(['meta', 'quarantine'], 'readonly', async tx => ({
      storage: 'IndexedDB', heldNow: !!await meta(tx, 'heldNow'),
      recoveryCount: await request(tx.objectStore('quarantine').count()),
      migrationWarning: await meta(tx, 'migrationWarning') ?? null,
    }));
  }
  function ensureCapacity(captures, incoming = []) {
    if (captures.length + incoming.length > LIMITS.captures || [...captures, ...incoming].reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0) > LIMITS.total) {
      throw Error('This workspace reached its capture limit. Download a backup before clearing any data.');
    }
  }
  async function capture(text, span = 'Unsorted') {
    if (!textAllowed(text) || !SPANS.includes(span)) throw Error('Add between 1 and 4,000 characters of text.');
    await ready();
    const record = { id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: new Date().toISOString(), span, sample: false };
    await db.run(['captures', 'meta'], 'readwrite', async tx => {
      const captures = tx.objectStore('captures'); ensureCapacity(await request(captures.getAll()), [record]);
      await request(captures.add(record)); await setMeta(tx, 'initialized', true);
    });
    const actual = await db.run(['captures'], 'readonly', tx => request(tx.objectStore('captures').get(record.id)));
    await validateCapture(actual);
    if (!same(actual, record)) throw Error('The save could not be read back exactly. Your draft is still here.');
    notify(); return clone(actual);
  }
  async function choose(captureId, start, end) {
    await ready();
    const source = await db.run(['captures'], 'readonly', tx => request(tx.objectStore('captures').get(captureId)));
    await validateCapture(source);
    const choice = { captureId, start, end, quote: source.text.slice(start, end), origin: 'chosen' };
    if (!validChoice(choice, [source])) throw Error('Choose an exact detail from a saved original.');
    await db.run(['captures', 'meta'], 'readwrite', async tx => {
      if (!same(await request(tx.objectStore('captures').get(captureId)), source)) throw Error('The original changed while you were choosing. Reopen it first.');
      await setMeta(tx, 'now', choice); await setMeta(tx, 'heldNow', false);
    });
    notify(); return read();
  }
  async function complete(expected) {
    await ready();
    await db.run(['meta'], 'readwrite', async tx => {
      if (expected !== undefined && !same(await meta(tx, 'now'), expected)) throw Error('The next step changed in another tab. Reopen it before marking it done.');
      await setMeta(tx, 'now', null); await setMeta(tx, 'heldNow', false);
    });
    notify(); return read();
  }
  async function replace(state) {
    await ready(); state = await validateState(state);
    await db.run(TABLES, 'readwrite', async tx => {
      for (const table of TABLES) await request(tx.objectStore(table).clear());
      for (const capture of state.captures) await request(tx.objectStore('captures').put(capture));
      for (const record of state.recovery) await request(tx.objectStore('quarantine').put(record));
      await setMeta(tx, 'now', state.now); await setMeta(tx, 'heldNow', false);
      await setMeta(tx, 'initialized', true); await setMeta(tx, 'legacyChecked', true);
    });
    try { legacy?.removeItem(KEY); }
    catch { notify(); throw Error('The active workspace was cleared, but its previous-format browser copy could not be removed.'); }
    notify(); return read();
  }
  async function reset() { return replace(blank()); }
  async function exportData() {
    const payload = await read(); await validateState(payload);
    const raw = JSON.stringify({ payload, sha256: await sha256(JSON.stringify(payload)) }, null, 2);
    if (new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('The backup exceeds the portable size limit. No data was removed.');
    return raw;
  }
  async function restore(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('Choose a browser backup under 32 MB.');
    const bundle = JSON.parse(raw);
    if (!exactKeys(bundle, ['payload', 'sha256']) || !validHash(bundle.sha256) || await sha256(JSON.stringify(bundle.payload)) !== bundle.sha256) {
      throw Error('Backup checksum mismatch. Nothing was changed.');
    }
    const incoming = await validateState(bundle.payload); await ready(); await recover();
    const added = await db.run(['captures', 'meta', 'quarantine'], 'readwrite', async tx => {
      const captures = tx.objectStore('captures'); const existing = await request(captures.getAll()); const missing = [];
      for (const capture of incoming.captures) {
        const previous = existing.find(c => c.id === capture.id);
        if (previous && !same(previous, capture)) throw Error('A capture with the same ID differs. Nothing was changed.');
        if (!previous) missing.push(capture);
      }
      ensureCapacity(existing, missing);
      for (const capture of missing) await request(captures.add(capture));
      for (const record of incoming.recovery) if (!await request(tx.objectStore('quarantine').get(record.id))) await request(tx.objectStore('quarantine').put(record));
      if (!await meta(tx, 'now')) {
        if (incoming.now !== null) { await setMeta(tx, 'now', incoming.now); await setMeta(tx, 'heldNow', false); }
        else if (incoming.recovery.some(r => r.source === 'now')) await setMeta(tx, 'heldNow', true);
      }
      await setMeta(tx, 'initialized', true); return missing.length;
    });
    notify(); return added;
  }
  async function seed(force = false) {
    await ready();
    if (!force && await db.run(['meta'], 'readonly', tx => meta(tx, 'initialized'))) return read();
    const state = blank(); const text = "I'll review the workshop outline before lunch.\nMaybe a short walkthrough would help.\nI'm waiting for the venue to reply.\nWhat should the opening example show?\nI already sent the agenda.";
    const samples = [['Product demo', text], ['Learning', "Maybe build a small practice tool someday.\nI don't need to book the room, it is already reserved.\nWhy do interruptions make it hard to return to a task?"]];
    for (const [span, text] of samples) state.captures.push({ id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: new Date().toISOString(), span, sample: true });
    const quote = "I'll review the workshop outline before lunch.";
    state.now = { captureId: state.captures[0].id, start: 0, end: quote.length, quote, origin: 'sample' };
    if (force) return replace(state);
    await db.run(['captures', 'meta'], 'readwrite', async tx => {
      if (await meta(tx, 'initialized')) return;
      for (const capture of state.captures) await request(tx.objectStore('captures').add(capture));
      await setMeta(tx, 'now', state.now); await setMeta(tx, 'initialized', true);
    });
    notify(); return read();
  }
  async function close() { channel?.close(); listeners.clear(); await db.close(); }
  return { read, capture, choose, complete, reset, exportData, restore, seed, health, close,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
