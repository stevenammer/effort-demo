import { request } from './database.js';
import { same, clone, IntegrityError } from './primitives.js';
import { validChoice, sourceKey } from './choices.js';
import { INTENT_TABLES, INTENT_LIMIT, seal, noteAllowed, legacyIntent, validateEvent, validatePlace, validateResumption, commitmentGroups, deriveCommitment, deriveCommitments, validRoute, validContext, validateIntentState } from './intent.js';
const meta = (tx, key) => request(tx.objectStore('meta').get(key)).then(row => row?.value);
const setMeta = (tx, key, value) => request(tx.objectStore('meta').put({ key, value }));
const eventFor = (commitmentId, previousId, state, choice, note = '', at = new Date().toISOString()) => seal({ id: crypto.randomUUID(), commitmentId, previousId, state, choice, at, note, receipt: state === 'COMPLETE' ? 'self-report' : null });
const isOpen = item => ['COMMITTED', 'ACTIVE'].includes(item.state);
export function createContinuity({ db, ready, prepare, notify, read, recoveryRecord }) {
  async function migrate() {
    const snapshot = await db.run(['meta', 'captures', 'intentEvents'], 'readonly', async tx => ({ done: await meta(tx, 'intentInitialized'), now: await meta(tx, 'now'), captures: await request(tx.objectStore('captures').getAll()), events: await request(tx.objectStore('intentEvents').getAll()), epoch: await meta(tx, 'epoch') }));
    if (snapshot.done) return;
    const events = !snapshot.events.length && validChoice(snapshot.now, snapshot.captures) ? await legacyIntent(snapshot.now) : [];
    await db.run(['meta', 'intentEvents'], 'readwrite', async tx => {
      if (await meta(tx, 'intentInitialized') || await meta(tx, 'epoch') !== snapshot.epoch) return;
      for (const event of events) if (!await request(tx.objectStore('intentEvents').get(event.id))) await request(tx.objectStore('intentEvents').add(event));
      await setMeta(tx, 'intentInitialized', true);
    });
  }
  async function snapshot() {
    return db.run(['meta', 'captures', 'quarantine', ...INTENT_TABLES], 'readonly', async tx => {
      const result = { now: await meta(tx, 'now') ?? null, epoch: await meta(tx, 'epoch'), captures: await request(tx.objectStore('captures').getAll()), recovery: await request(tx.objectStore('quarantine').getAll()) };
      for (const table of INTENT_TABLES) result[table] = await request(tx.objectStore(table).getAll());
      return result;
    });
  }
  async function repair() {
    const saved = await snapshot(), bad = [], validGroups = [];
    const preserve = async (table, rows, reason) => { for (const row of rows) bad.push({ table, row, recovery: await recoveryRecord(table, String(table === 'intentEvents' ? row.commitmentId : row.id).slice(0, 128), JSON.stringify(row), reason) }); };
    for (const group of commitmentGroups(saved.intentEvents).values()) {
      try { for (const event of group) await validateEvent(event, saved.captures, saved.recovery); validGroups.push(deriveCommitment(group)); }
      catch (error) { if (!(error instanceof IntegrityError)) throw error; await preserve('intentEvents', group, error.message); }
    }
    const active = validGroups.filter(c => c.state === 'ACTIVE');
    if (active.length > 1) for (const c of active) await preserve('intentEvents', c.history, 'Conflicting ACTIVE commitments were preserved for recovery. No replacement was chosen.');
    const goodCommitments = validGroups.filter(c => !bad.some(item => item.table === 'intentEvents' && item.row.commitmentId === c.id));
    const recovery = [...saved.recovery, ...bad.map(item => item.recovery)], places = [];
    for (const place of saved.places) {
      try {
        await validatePlace(place, saved.captures, saved.recovery);
        if (place.commitmentId !== null && !goodCommitments.some(c => c.id === place.commitmentId && sourceKey(c.choice) === sourceKey(place.choice)) && !recovery.some(r => r.source === 'intentEvents' && r.recordId === place.commitmentId)) throw new IntegrityError('The saved return point is missing its commitment history.');
        places.push(place);
      } catch (error) { if (!(error instanceof IntegrityError)) throw error; await preserve('places', [place], error.message); }
    }
    for (const record of saved.resumptions) {
      try {
        await validateResumption(record, places);
        if (saved.resumptions.filter(r => r.placeId === record.placeId).length !== 1) throw new IntegrityError('Conflicting resumption receipts were preserved for recovery.');
      } catch (error) { if (!(error instanceof IntegrityError)) throw error; await preserve('resumptions', [record], error.message); }
    }
    const brokenNow = saved.now && !goodCommitments.some(c => c.state === 'ACTIVE' && same(c.choice, saved.now))
      ? await recoveryRecord('now', 'now', JSON.stringify(saved.now), 'The chosen step needs its commitment history recovered.') : null;
    if (!bad.length && !brokenNow) return;
    await db.run(['meta', 'quarantine', ...INTENT_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== saved.epoch) return;
      for (const item of bad) if (same(await request(tx.objectStore(item.table).get(item.row.id)), item.row)) {
        await request(tx.objectStore('quarantine').put(item.recovery)); await request(tx.objectStore(item.table).delete(item.row.id));
      }
      if (brokenNow && same(await meta(tx, 'now'), saved.now)) { await request(tx.objectStore('quarantine').put(brokenNow)); await setMeta(tx, 'now', null); await setMeta(tx, 'heldNow', true); }
    });
  }
  async function begin() { await ready(); await prepare(); await repair(); return snapshot(); }
  async function planSelection(saved, choice, { commitmentId, makeNow = true } = {}) {
    const commitments = deriveCommitments(saved.intentEvents);
    const target = commitmentId ? commitments.find(c => c.id === commitmentId) : commitments.find(c => isOpen(c) && sourceKey(c.choice) === sourceKey(choice));
    if (commitmentId && (!target || !isOpen(target))) throw Error('This commitment is already complete, dropped or awaiting recovery. Open the original to choose a new commitment explicitly.');
    const events = []; let id = target?.id ?? crypto.randomUUID();
    if (makeNow) for (const active of commitments.filter(c => c.state === 'ACTIVE' && c.id !== id)) events.push(await eventFor(active.id, active.latestId, 'COMMITTED', active.choice, 'Another step was explicitly chosen. This commitment was kept.'));
    const desired = makeNow ? 'ACTIVE' : 'COMMITTED';
    if (!target || (makeNow && (target.state !== 'ACTIVE' || !same(target.choice, choice)))) events.push(await eventFor(id, target?.latestId ?? null, desired, choice, target ? 'Explicitly selected.' : 'Explicitly promoted from an exact source quote.'));
    return { events, now: makeNow ? choice : saved.now, id };
  }
  async function commit(saved, plan, { sameChoice, completedId, completedNote, resumption, place } = {}) {
    const changed = await db.run(['meta', 'captures', ...INTENT_TABLES], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== saved.epoch) throw Error('The workspace was reset. Reopen the original before changing work.');
      const table = tx.objectStore('intentEvents'), current = await request(table.getAll()), now = await meta(tx, 'now') ?? null;
      if (resumption && (await request(tx.objectStore('resumptions').getAll())).some(r => r.placeId === resumption.placeId)) return false;
      if (!same(current, saved.intentEvents) || !same(now, saved.now)) {
        if (sameChoice && same(now, sameChoice)) return false;
        if (completedId && deriveCommitments(current).some(c => c.id === completedId && c.state === 'COMPLETE' && c.receipt?.note === completedNote)) return false;
        throw Error('Work changed in another tab. Refresh before changing the next step.');
      }
      if (place && !same(await request(tx.objectStore('places').get(place.id)), place)) throw Error('The saved return point changed. Reopen it.');
      if (plan.now) {
        const expectedSource = saved.captures.find(c => c.id === plan.now.captureId), actual = await request(tx.objectStore('captures').get(plan.now.captureId));
        if (!actual || !same(actual, expectedSource) || !validChoice(plan.now, [actual])) throw Error('The original needs recovery before it can become NOW.');
      }
      if (current.length + plan.events.length > INTENT_LIMIT) throw Error('The commitment history reached its limit. Download a backup before clearing anything.');
      for (const event of plan.events) await request(table.add(event));
      if (resumption) { if (await request(tx.objectStore('resumptions').count()) >= 1000) throw Error('The return history reached its limit.'); await request(tx.objectStore('resumptions').add(resumption)); }
      await setMeta(tx, 'now', plan.now); if (plan.now !== null || saved.now !== null) await setMeta(tx, 'heldNow', false); return true;
    });
    if (changed) {
      try {
        const actual = await db.run(INTENT_TABLES, 'readonly', async tx => ({
          events: await Promise.all(plan.events.map(event => request(tx.objectStore('intentEvents').get(event.id)))),
          resumption: resumption ? await request(tx.objectStore('resumptions').get(resumption.id)) : null,
        }));
        for (let i = 0; i < plan.events.length; i++) {
          await validateEvent(actual.events[i], saved.captures, saved.recovery);
          if (!same(actual.events[i], plan.events[i])) throw Error('The commitment receipt could not be read back exactly.');
        }
        if (resumption) {
          await validateResumption(actual.resumption, saved.places);
          if (!same(actual.resumption, resumption)) throw Error('The resumption receipt could not be read back exactly.');
        }
      } catch (error) {
        notify(); throw Error(`The change could not be verified: ${error.message} Check Engine Room recovery before trying again.`);
      }
    }
    return changed;
  }
  async function choose(captureId, start, end, { makeNow = true, dial } = {}) {
    if (dial?.toUpperCase() === 'UNHINGED' || dial?.toUpperCase() === 'UNHINGED SANDBOX') throw Error('Unhinged sandbox cannot create commitments. Leave the sandbox first.');
    const saved = await begin(), source = saved.captures.find(c => c.id === captureId);
    const choice = { captureId, start, end, quote: source?.text.slice(start, end), origin: 'chosen' };
    if (!validChoice(choice, saved.captures)) throw Error('Choose an exact detail from a saved original.');
    const plan = await planSelection(saved, choice, { makeNow }); await commit(saved, plan, { sameChoice: makeNow ? choice : null }); notify(); return read();
  }
  async function complete(expected, note = 'Marked done by you.') {
    if (!noteAllowed(note, true)) throw Error('Keep the completion note between 1 and 4,000 characters.');
    const saved = await begin();
    if (expected !== undefined && !same(saved.now, expected)) throw Error('The next step changed in another tab. Reopen it before marking it done.');
    if (!saved.now) return read();
    const item = deriveCommitments(saved.intentEvents).find(c => c.state === 'ACTIVE' && same(c.choice, saved.now));
    if (!item) throw Error('The commitment history needs recovery before recording completion.');
    const event = await eventFor(item.id, item.latestId, 'COMPLETE', item.choice, note);
    await commit(saved, { events: [event], now: null }, { completedId: item.id, completedNote: note }); notify(); return read();
  }
  async function selectCommitment(id, expectedNow) {
    const saved = await begin(); if (!same(saved.now, expectedNow)) throw Error('The next step changed in another tab. Refresh first.');
    const target = deriveCommitments(saved.intentEvents).find(c => c.id === id);
    if (!target || !isOpen(target)) throw Error('That commitment is no longer open.');
    const plan = await planSelection(saved, target.choice, { commitmentId: id }); await commit(saved, plan, { sameChoice: target.choice }); notify(); return read();
  }
  async function dropCommitment(id, note, expectedLatestId) {
    if (!noteAllowed(note, true)) throw Error('Keep a short reason for dropping the commitment.');
    const saved = await begin(), item = deriveCommitments(saved.intentEvents).find(c => c.id === id);
    if (!item || !isOpen(item) || item.latestId !== expectedLatestId) throw Error('That commitment changed. Refresh before dropping it.');
    const event = await eventFor(id, item.latestId, 'DROPPED', item.choice, note);
    await commit(saved, { events: [event], now: item.state === 'ACTIVE' ? null : saved.now }); notify(); return read();
  }
  async function holdPlace({ summary, nextAction = '', route = 'home', context = { scrollY: 0, spanSearch: '', sourceExpanded: false }, expected }) {
    if (!noteAllowed(summary, true) || !noteAllowed(nextAction) || !validRoute(route) || !validContext(context)) throw Error('Add a short summary and a valid return point.');
    const saved = await begin(); if (expected !== undefined && !same(expected, saved.now)) throw Error('The next step changed in another tab. Refresh before holding your place.');
    const item = saved.now && deriveCommitments(saved.intentEvents).find(c => c.state === 'ACTIVE' && same(c.choice, saved.now));
    if (saved.now && !item) throw Error('The chosen step needs recovery before its place can be kept.');
    const place = await seal({ id: crypto.randomUUID(), commitmentId: item?.id ?? null, choice: clone(saved.now), summary, nextAction, route, context: clone(context), at: new Date().toISOString() });
    await db.run(['meta', 'places'], 'readwrite', async tx => {
      if (await meta(tx, 'epoch') !== saved.epoch || !same(await meta(tx, 'now') ?? null, saved.now)) throw Error('Work changed before the return point was saved. Keep your note and retry.');
      if (await request(tx.objectStore('places').count()) >= 1000) throw Error('This workspace reached its return-point limit.');
      await request(tx.objectStore('places').add(place));
    });
    const actual = await db.run(['places'], 'readonly', tx => request(tx.objectStore('places').get(place.id))); await validatePlace(actual, saved.captures, saved.recovery);
    if (!same(actual, place)) throw Error('The saved return point could not be read back exactly. Keep your note.');
    notify(); return place;
  }
  async function resumePlace(id, expectedNow, { closeOnly = false } = {}) {
    const saved = await begin(), place = saved.places.find(p => p.id === id); if (!place) throw Error('This return point needs recovery or belongs to another workspace.');
    if (saved.resumptions.some(r => r.placeId === id)) return { state: await read(), route: place.route, place, alreadyHandled: true };
    if (!same(expectedNow, saved.now)) throw Error('The next step changed in another tab. Refresh before resuming.');
    let plan = { events: [], now: saved.now };
    if (!closeOnly && place.choice) {
      if (!validChoice(place.choice, saved.captures)) throw Error('The saved original needs recovery before you can resume it.');
      plan = await planSelection(saved, place.choice, { commitmentId: place.commitmentId });
    }
    const resumption = await seal({ id: crypto.randomUUID(), placeId: id, at: new Date().toISOString(), kind: closeOnly ? 'closed' : 'resumed' });
    const changed = await commit(saved, plan, { resumption, place }); notify(); return { state: await read(), route: place.route, place, alreadyHandled: !changed };
  }
  async function prepareRestore(incoming, { legacy = false } = {}) {
    const saved = await begin(), merged = {};
    if (legacy) {
      const known = deriveCommitments(saved.intentEvents);
      incoming = { ...incoming, intentEvents: incoming.intentEvents.filter(event => !known.some(c => sourceKey(c.choice) === sourceKey(event.choice))) };
    }
    for (const table of INTENT_TABLES) {
      const rows = new Map(saved[table].map(row => [row.id, row]));
      for (const row of incoming[table]) {
        if (rows.has(row.id) && !same(rows.get(row.id), row)) throw Error('A continuity record with the same ID differs. Nothing was changed.');
        rows.set(row.id, row);
      }
      merged[table] = [...rows.values()];
    }
    const commitments = deriveCommitments(merged.intentEvents);
    const candidate = saved.now ?? incoming.now;
    const chosen = candidate && commitments.find(c => c.state === 'ACTIVE' && same(c.choice, candidate));
    const now = chosen ? candidate : null, additional = [];
    for (const item of commitments.filter(c => c.state === 'ACTIVE' && c.id !== chosen?.id)) {
      additional.push(await eventFor(item.id, item.latestId, 'COMMITTED', item.choice, 'Restored commitment kept without replacing the current NOW.'));
    }
    merged.intentEvents.push(...additional);
    const captures = [...new Map([...saved.captures, ...incoming.captures].map(c => [c.id, c])).values()];
    const recovery = [...new Map([...saved.recovery, ...incoming.recovery].map(r => [r.id, r])).values()];
    await validateIntentState({ ...merged, now, captures, recovery });
    return { saved, additional, now, incoming };
  }
  return { migrate, repair, prepareRestore, choose, complete, selectCommitment, dropCommitment, holdPlace, resumePlace };
}
