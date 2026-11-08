import { createExploration, EXPLORATION_TABLES, validateExplorationState } from './exploration.js';
import { stableId } from './primitives.js';
import { validateDraft, DRAFT_LIMITS, DRAFT_RESET_MARKER, markDraftReset } from './drafts.js';
import { createContinuity } from './continuity-store.js';
import { INTENT_TABLES, seal } from './intent.js';
import { makeSpan, initialSpans, spanKey, validSpan, validSpanName } from './spans.js';
import { openDatabase, request, TABLES } from './database.js';
import { KEY, LIMITS, SPANS, blank, clone, same, exactKeys, textAllowed, sha256, validChoice,
  validateCapture, validateState, recoveryRecord, validHash, validId, IntegrityError } from './records.js';
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
  try { if (legacy && !legacy.getItem(DRAFT_RESET_MARKER)) markDraftReset(legacy); } catch { /* Primary storage remains usable when the emergency mirror is unavailable. */ }
  const listeners = new Set();
  const channel = options.broadcast !== false && typeof window !== 'undefined' && typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(`${db.name}-changes`) : null;
  function notifyListeners() {
    for (const listener of listeners) { try { Promise.resolve(listener()).catch(() => {}); } catch {} }
  }
  function notify() { notifyListeners(); try { channel?.postMessage({ changed: true }); } catch {} }
  if (channel) channel.onmessage = event => { if (event.data?.changed === true) notifyListeners(); };
  let initialized;
  function ready() { return initialized ??= migrate().then(ensureSpans).then(continuity.migrate).catch(error => { initialized = null; throw error; }); }
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
  async function ensureSpans() {
    const snapshot = await db.run(['spans', 'captures', 'meta'], 'readonly', async tx => ({
      epoch: await meta(tx, 'epoch'), spans: await request(tx.objectStore('spans').getAll()), captures: await request(tx.objectStore('captures').getAll()),
    }));
    const bad = snapshot.spans.filter(span => !validSpan(span));
    const recovery = await Promise.all(bad.map(span => recoveryRecord('span', String(span.id).slice(0, 128), json(span), 'The Attention Span metadata could not be verified. Its raw copy was preserved.')));
    const required = initialSpans(snapshot.captures.filter(c => validSpanName(c.span)));
    if (!bad.length && required.every(span => snapshot.spans.some(existing => existing.id === span.id))) return;
    await db.run(['spans', 'quarantine', 'meta'], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== snapshot.epoch) return;
      const table = tx.objectStore('spans');
      for (let i = 0; i < bad.length; i++) {
        if (!same(await request(table.get(bad[i].id)), bad[i])) continue;
        await request(tx.objectStore('quarantine').put(recovery[i])); await request(table.delete(bad[i].id));
      }
      for (const span of required) if (!await request(table.get(span.id))) await request(table.put(span));
    });
  }
  async function createSpan(name) {
    await ready(); const proposed = makeSpan(name, new Date().toISOString());
    const actual = await db.run(['spans', 'meta'], 'readwrite', async tx => {
      const table = tx.objectStore('spans'), existing = await request(table.get(proposed.id));
      if (existing) return existing;
      if (await request(table.count()) >= 100) throw Error('This workspace reached its limit of 100 Attention Spans.');
      await request(table.add(proposed)); await setMeta(tx, 'initialized', true); return proposed;
    });
    if (!validSpan(actual)) throw Error('This Attention Span needs recovery before you can post in it.');
    notify(); return actual;
  }
  async function recover() {
    await ready();
    const snapshot = await db.run(['captures', 'meta', 'quarantine'], 'readonly', async tx => ({
      captures: await request(tx.objectStore('captures').getAll()), now: (await meta(tx, 'now')) ?? null, recovery: await request(tx.objectStore('quarantine').getAll()),
    }));
    const good = [], bad = [];
    for (const capture of snapshot.captures) {
      try { await validateCapture(capture); good.push(capture); }
      catch (error) {
        if (!(error instanceof IntegrityError)) throw error;
        bad.push({ capture, recovery: await recoveryRecord('capture', String(capture.id), json(capture), error.message) });
      }
    }
    // A damaged reply relationship must not trap startup in a cycle or lose its raw original.
    const recovery = [...snapshot.recovery, ...bad.map(item => item.recovery)];
    const byId = new Map(good.map(c => [c.id, c]));
    for (const capture of good) {
      if (!capture.parentId) continue;
      const seen = new Set([capture.id]); let current = capture, reason;
      while (current.parentId) {
        const parent = byId.get(current.parentId);
        if (!parent) { if (!recovery.some(r => r.source === 'capture' && r.recordId === current.parentId)) reason = 'The reply parent is missing. The complete original was preserved for recovery.'; break; }
        if (seen.has(parent.id)) { reason = 'The saved reply links form a cycle. The complete original was preserved for recovery.'; break; }
        if (spanKey(parent.span) !== spanKey(capture.span)) { reason = 'The reply links cross Attention Spans. The complete original was preserved for recovery.'; break; }
        seen.add(parent.id); current = parent;
      }
      if (reason) bad.push({ capture, recovery: await recoveryRecord('capture', capture.id, json(capture), reason) });
    }
    const active = good.filter(c => !bad.some(item => item.capture.id === c.id));
    const brokenNow = snapshot.now !== null && !validChoice(snapshot.now, active)
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
  async function recoverDrafts() {
    const rows = await db.run(['drafts'], 'readonly', tx => request(tx.objectStore('drafts').getAll())), bad = [];
    for (const row of rows) {
      try { await validateDraft(row); }
      catch (error) {
        if (!(error instanceof IntegrityError)) throw error;
        let raw; try { raw = JSON.stringify(row); } catch { throw Error('A draft has unsupported stored data. It has not been removed.'); }
        bad.push({ row, copy: await recoveryRecord('draft', String(row.key).slice(0, 128), raw, error.message) });
      }
    }
    if (!bad.length) return;
    await db.run(['drafts', 'quarantine'], 'readwrite', async tx => {
      for (const { row, copy } of bad) if (same(await request(tx.objectStore('drafts').get(row.key)), row)) {
        await request(tx.objectStore('quarantine').put(copy)); await request(tx.objectStore('drafts').delete(row.key));
      }
    });
  }
  async function read({ includeDrafts = true } = {}) {
    await recover(); await ensureSpans(); await continuity.repair(); await exploration.repair(); if (includeDrafts) await recoverDrafts();
    return db.run(['captures', 'meta', 'quarantine', 'spans', ...(includeDrafts ? ['drafts'] : []), ...INTENT_TABLES, ...EXPLORATION_TABLES], 'readonly', async tx => {
      const captures = await request(tx.objectStore('captures').getAll());
      captures.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { ...blank(), captures, now: (await meta(tx, 'now')) ?? null,
        recovery: await request(tx.objectStore('quarantine').getAll()), spans: await request(tx.objectStore('spans').getAll()), intentEvents: await request(tx.objectStore('intentEvents').getAll()), places: await request(tx.objectStore('places').getAll()), resumptions: await request(tx.objectStore('resumptions').getAll()), explorations: await request(tx.objectStore('explorations').getAll()), distillations: await request(tx.objectStore('distillations').getAll()), drafts: includeDrafts ? await request(tx.objectStore('drafts').getAll()) : [] };
    });
  }
  async function health() {
    await ready();
    return db.run(['meta', 'quarantine'], 'readonly', async tx => ({
      storage: 'IndexedDB', epoch: await meta(tx, 'epoch') ?? null, heldNow: !!await meta(tx, 'heldNow'),
      recoveryCount: await request(tx.objectStore('quarantine').count()),
      migrationWarning: await meta(tx, 'migrationWarning') ?? null,
    }));
  }
  function ensureCapacity(captures, incoming = []) {
    if (captures.length + incoming.length > LIMITS.captures || [...captures, ...incoming].reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0) > LIMITS.total) {
      throw Error('This workspace reached its capture limit. Download a backup before clearing any data.');
    }
  }
  async function capture(text, span = 'Unsorted', parentId = null, { requestId } = {}) {
    if (requestId !== undefined && !validId(requestId)) throw Error('The capture request has an invalid ID.');
    if (!textAllowed(text) || !validSpanName(span)) throw Error('Add between 1 and 4,000 characters of text.');
    await ready();
    const epoch = await db.run(['meta'], 'readonly', tx => meta(tx, 'epoch'));
    const parent = parentId === null ? null : await db.run(['captures'], 'readonly', tx => request(tx.objectStore('captures').get(parentId)));
    if (parentId !== null) { await validateCapture(parent); if (spanKey(parent.span) !== spanKey(span)) throw Error('Reply in the original Attention Span.'); }
    const id = requestId ? await stableId(`capture:${requestId}:${epoch ?? 'initial'}`) : crypto.randomUUID();
    if (requestId) {
      const prior = await db.run(['captures'], 'readonly', tx => request(tx.objectStore('captures').get(id)));
      if (prior) {
        try { await validateCapture(prior); }
        catch (error) { if (!(error instanceof IntegrityError)) throw error; await recover(); }
      }
    }
    const record = { id, text, hash: await sha256(text), createdAt: new Date().toISOString(), span, sample: false, ...(parent ? { parentId } : {}) };
    const expected = await db.run(['captures', 'meta', 'spans'], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== epoch) throw Error('The workspace was reset while saving. Your draft is still here.');
      const destination = await request(tx.objectStore('spans').get(spanKey(span)));
      if (!validSpan(destination)) throw Error('Create the Attention Span before posting in it.');
      if (parent && !same(await request(tx.objectStore('captures').get(parentId)), parent)) throw Error('The parent changed while you were replying. Reopen the thread.');
      const captures = tx.objectStore('captures'), prior = await request(captures.get(record.id));
      if (prior) {
        if (prior.text !== text || prior.span !== span || (prior.parentId ?? null) !== parentId || prior.sample !== false) throw Error('This capture request ID already belongs to different text. Nothing was overwritten.');
        return prior;
      }
      ensureCapacity(await request(captures.getAll()), [record]);
      await request(captures.add(record)); await setMeta(tx, 'initialized', true); return record;
    });
    const actual = await db.run(['captures'], 'readonly', tx => request(tx.objectStore('captures').get(record.id)));
    await validateCapture(actual);
    if (!same(actual, expected)) throw Error('The save could not be read back exactly. Your draft is still here.');
    notify(); return clone(actual);
  }
  async function replace(state) {
    await ready(); state = await validateState(state); const epoch = crypto.randomUUID();
    try { if (legacy) markDraftReset(legacy); } catch { /* The transaction epoch still fences old writers. */ }
    await db.run(TABLES, 'readwrite', async tx => {
      for (const table of TABLES) await request(tx.objectStore(table).clear());
      for (const capture of state.captures) await request(tx.objectStore('captures').put(capture));
      for (const record of state.recovery) await request(tx.objectStore('quarantine').put(record));
      for (const span of state.spans) await request(tx.objectStore('spans').put(span));
      for (const draft of state.drafts) await request(tx.objectStore('drafts').put(draft));
      for (const table of [...INTENT_TABLES, ...EXPLORATION_TABLES]) for (const row of state[table]) await request(tx.objectStore(table).put(row));
      await setMeta(tx, 'intentInitialized', true); await setMeta(tx, 'draftLegacyClosed', true);
      await setMeta(tx, 'now', state.now); await setMeta(tx, 'heldNow', false); await setMeta(tx, 'epoch', epoch);
      await setMeta(tx, 'initialized', true); await setMeta(tx, 'legacyChecked', true);
    });
    try { legacy?.removeItem(KEY); }
    catch { notify(); throw Error('The active workspace was cleared, but its previous-format browser copy could not be removed.'); }
    notify(); return read({ includeDrafts: false });
  }
  async function reset() { return replace(blank()); }
  async function exportData({ draftCopies = [] } = {}) {
    const payload = await read();
    if (!Array.isArray(draftCopies) || draftCopies.length > 1000) throw Error('Too many emergency draft copies for one backup.');
    for (const copy of draftCopies) {
      if (copy.raw === null || copy.raw === undefined) continue;
      if (typeof copy.raw !== 'string' || typeof copy.source !== 'string' || copy.source.length > 128) throw Error('An emergency draft copy has an invalid format.');
      const record = await recoveryRecord('draft', copy.source, copy.raw, String(copy.reason ?? 'Unverified emergency or legacy draft copy.').slice(0, 500));
      if (!payload.recovery.some(r => r.id === record.id)) payload.recovery.push(record);
    }
    await validateState(payload);
    const raw = JSON.stringify({ payload, sha256: await sha256(JSON.stringify(payload)) }, null, 2);
    if (new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('The backup exceeds the portable size limit. No data was removed.');
    return raw;
  }
  async function restore(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('Choose a browser backup under 32 MB.');
    await ready(); const epoch = await db.run(['meta'], 'readonly', tx => meta(tx, 'epoch'));
    const bundle = JSON.parse(raw);
    if (!exactKeys(bundle, ['payload', 'sha256']) || !validHash(bundle.sha256) || await sha256(JSON.stringify(bundle.payload)) !== bundle.sha256) {
      throw Error('Backup checksum mismatch. Nothing was changed.');
    }
    let incoming = await validateState(bundle.payload); const continuityPlan = await continuity.prepareRestore(incoming, { legacy: bundle.payload.version < 4 }); incoming = continuityPlan.incoming;
    const currentExploration = await db.run(EXPLORATION_TABLES, 'readonly', async tx => Object.fromEntries(await Promise.all(EXPLORATION_TABLES.map(async table => [table, await request(tx.objectStore(table).getAll())]))));
    const mergedExploration = {};
    for (const table of EXPLORATION_TABLES) {
      const merged = new Map(currentExploration[table].map(row => [row.id, row]));
      for (const row of incoming[table]) { if (merged.has(row.id) && !same(merged.get(row.id), row)) throw Error('An exploration record with the same ID differs. Nothing was changed.'); merged.set(row.id, row); }
      mergedExploration[table] = [...merged.values()];
    }
    await validateExplorationState({ ...incoming, captures: [...continuityPlan.saved.captures, ...incoming.captures.filter(c => !continuityPlan.saved.captures.some(old => old.id === c.id))], places: [...continuityPlan.saved.places, ...incoming.places.filter(p => !continuityPlan.saved.places.some(old => old.id === p.id))], ...mergedExploration });
    const currentDrafts = await db.run(['drafts'], 'readonly', tx => request(tx.objectStore('drafts').getAll())), draftAdds = [];
    for (const draft of incoming.drafts) {
      const existing = currentDrafts.find(row => row.key === draft.key);
      if (existing && (same(existing, draft) || existing.revision > draft.revision)) continue;
      if (existing) {
        const { hash, ...payload } = draft;
        const key = await stableId(`restored-draft:${draft.key}:${draft.hash}`);
        const copy = await seal({ ...payload, key, tabId: await stableId(`restored-writer:${draft.key}:${draft.hash}`) });
        const restored = currentDrafts.find(row => row.key === key);
        if (restored && !same(restored, copy)) throw Error('A restored draft copy has conflicting data. Nothing was changed.');
        if (!restored) draftAdds.push(copy);
      } else draftAdds.push(draft);
    }
    if (currentDrafts.length + draftAdds.length > DRAFT_LIMITS.records || JSON.stringify([...currentDrafts, ...draftAdds]).length > DRAFT_LIMITS.total) throw Error('Restored drafts would exceed the local draft limit. Nothing was changed.');
    const added = await db.run(['captures', 'meta', 'quarantine', 'spans', 'drafts', ...INTENT_TABLES, ...EXPLORATION_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== epoch) throw Error('The workspace was reset during restore. Reopen the backup before trying again.');
      if (!same(await request(tx.objectStore('drafts').getAll()), currentDrafts)) throw Error('A draft changed during restore. Retry with your writing kept.');
      for (const draft of draftAdds) await request(tx.objectStore('drafts').add(draft));
      for (const table of INTENT_TABLES) if (!same(await request(tx.objectStore(table).getAll()), continuityPlan.saved[table])) throw Error('Work changed during restore. Reopen the backup before trying again.');
      if (!same(await meta(tx, 'now') ?? null, continuityPlan.saved.now)) throw Error('NOW changed during restore. Reopen the backup before trying again.');
      for (const table of EXPLORATION_TABLES) {
        if (!same(await request(tx.objectStore(table).getAll()), currentExploration[table])) throw Error('Exploration changed during restore. Retry with your writing kept.');
        for (const row of incoming[table]) if (!await request(tx.objectStore(table).get(row.id))) await request(tx.objectStore(table).add(row));
      }
      const captures = tx.objectStore('captures'); const existing = await request(captures.getAll()); const missing = [];
      for (const capture of incoming.captures) {
        const previous = existing.find(c => c.id === capture.id);
        if (previous && !same(previous, capture)) throw Error('A capture with the same ID differs. Nothing was changed.');
        if (!previous) missing.push(capture);
      }
      ensureCapacity(existing, missing);
      for (const table of INTENT_TABLES) for (const row of incoming[table]) {
        const previous = await request(tx.objectStore(table).get(row.id));
        if (previous && !same(previous, row)) throw Error('A continuity record with the same ID differs. Nothing was changed.');
        if (!previous) await request(tx.objectStore(table).add(row));
      }
      for (const event of continuityPlan.additional) await request(tx.objectStore('intentEvents').add(event));
      const directory = tx.objectStore('spans'), oldSpans = await request(directory.getAll());
      const missingSpans = incoming.spans.filter(span => !oldSpans.some(previous => previous.id === span.id));
      if (oldSpans.length + missingSpans.length > 100) throw Error('Restore would exceed 100 Attention Spans. Nothing was changed.');
      for (const span of missingSpans) await request(directory.add(span));
      for (const capture of missing) await request(captures.add(capture));
      for (const record of incoming.recovery) if (!await request(tx.objectStore('quarantine').get(record.id))) await request(tx.objectStore('quarantine').put(record));
      await setMeta(tx, 'now', continuityPlan.now);
      if (continuityPlan.now) await setMeta(tx, 'heldNow', false);
      else if (incoming.recovery.some(r => r.source === 'now')) await setMeta(tx, 'heldNow', true);
      await setMeta(tx, 'initialized', true); return missing.length;
    });
    notify(); return added;
  }
  async function seed(force = false) {
    await ready();
    if (!force && await db.run(['meta'], 'readonly', tx => meta(tx, 'initialized'))) return read({ includeDrafts: false });
    const state = blank(); const text = "I'll review the workshop outline before lunch.\nMaybe a short walkthrough would help.\nI'm waiting for the venue to reply.\nWhat should the opening example show?\nI already sent the agenda.";
    const samples = [['Product demo', text], ['Learning', "Maybe build a small practice tool someday.\nI don't need to book the room, it is already reserved.\nWhy do interruptions make it hard to return to a task?"]];
    for (const [span, text] of samples) state.captures.push({ id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: new Date().toISOString(), span, sample: true });
    const quote = "I'll review the workshop outline before lunch.";
    state.now = { captureId: state.captures[0].id, start: 0, end: quote.length, quote, origin: 'sample' };
    const id = crypto.randomUUID(); state.intentEvents = [await seal({ id, commitmentId: id, previousId: null, state: 'ACTIVE', choice: state.now, at: new Date().toISOString(), note: 'Fictional walkthrough choice.', receipt: null })];
    if (force) return replace(state);
    await db.run(['captures', 'meta', 'intentEvents'], 'readwrite', async tx => {
      if (await meta(tx, 'initialized')) return;
      for (const capture of state.captures) await request(tx.objectStore('captures').add(capture));
      for (const event of state.intentEvents) await request(tx.objectStore('intentEvents').add(event));
      await setMeta(tx, 'now', state.now); await setMeta(tx, 'initialized', true);
    });
    notify(); return read({ includeDrafts: false });
  }
  async function close() { channel?.close(); listeners.clear(); await db.close(); }
  const continuity = createContinuity({ db, ready, prepare: recover, notify, read: () => read({ includeDrafts: false }), recoveryRecord });
  const exploration = createExploration({ db, ready, notify, recoveryRecord });
  return { ...continuity, explore: exploration.explore, distill: exploration.distill, read, capture, createSpan, reset, exportData, restore, seed, health, close,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
