import { moveSnapshotShape } from './thinking.js';
import { openDatabase, request } from './database.js';
import { exactKeys, validId, validDate, validHash, sha256, same, IntegrityError } from './primitives.js';
import { validContext, validRoute, noteAllowed } from './intent.js';
import { choiceShape } from './choices.js';
import { KEY } from './constants.js';

export const DRAFT_LIMITS = Object.freeze({ records: 1000, total: 4000000, recovery: 8000000 });
export const DRAFT_RESET_MARKER = `${KEY}-draft-reset-marker`;
export function markDraftReset(storage) { const marker = crypto.randomUUID(); storage.setItem(DRAFT_RESET_MARKER, marker); return marker; }
const PREFIX = `${KEY}-shelf-`, TAB = `${KEY}-shelf-tab`;
const uuid = () => crypto.randomUUID();
const contextValid = c => typeof c === 'string' && (['capture', 'hold', 'span', 'move', 'person'].includes(c) || /^(reply|drop|explore|distill|move|branch|person|contact|correction|transcript):/.test(c) && validId(c.slice(c.indexOf(':') + 1)));
const str = (v, max = 4000) => typeof v === 'string' && v.length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
function bodyValid(c, b) {
  if (c.startsWith('correction:') || c.startsWith('transcript:')) return exactKeys(b,['captureId','captureHash','kind','text','expectedLatestId','expectedEffectiveId','acknowledgedRecovery','requestId']) && b.captureId === c.slice(c.indexOf(':')+1) && validHash(b.captureHash) && b.kind === (c.startsWith('correction:')?'edit':'transcript') && str(b.text) && (b.expectedLatestId===null||validId(b.expectedLatestId)) && (b.expectedEffectiveId===null||validId(b.expectedEffectiveId)) && Array.isArray(b.acknowledgedRecovery) && b.acknowledgedRecovery.length<=4000 && b.acknowledgedRecovery.every(validHash) && new Set(b.acknowledgedRecovery).size===b.acknowledgedRecovery.length && validId(b.requestId);
  if (c.startsWith('explore:')) return (exactKeys(b, ['text', 'sourceId', 'parentId', 'returnPointId', 'dial', 'returnData']) || exactKeys(b, ['text', 'sourceId', 'parentId', 'returnPointId', 'dial', 'returnData', 'move']) && moveSnapshotShape(b.move)) && str(b.text) && b.sourceId === c.slice(8) && validId(b.sourceId) && (b.parentId === null || validId(b.parentId)) && (b.returnPointId === null || validId(b.returnPointId)) && ['TIGHT', 'NORMAL', 'WILD', 'UNHINGED SANDBOX'].includes(b.dial) && exactKeys(b.returnData, ['route', 'context', 'expected', 'summary']) && validRoute(b.returnData.route) && validContext(b.returnData.context) && noteAllowed(b.returnData.summary, true) && (b.returnData.expected === null || choiceShape(b.returnData.expected));
  if (c.startsWith('distill:')) return exactKeys(b, ['text', 'explorationId', 'type']) && str(b.text) && b.explorationId === c.slice(8) && ['RECEIPT', 'INSIGHT', 'HYPOTHESIS', 'EXPERIMENT', 'DECISION CANDIDATE', 'FUTURE ARCHITECTURE', 'OPEN TENSION', 'WEIRD BUT ALIVE', 'NOISE'].includes(b.type);
  if (c === 'move' || c.startsWith('move:')) return exactKeys(b, ['moveId', 'name', 'prompt', 'enabled', 'expectedLatestId']) && (b.moveId === null || validId(b.moveId)) && (c === 'move' ? b.moveId === null : b.moveId === c.slice(5)) && str(b.name, 120) && str(b.prompt, 2000) && typeof b.enabled === 'boolean' && (b.expectedLatestId === null || validId(b.expectedLatestId));
  if (c.startsWith('branch:')) return exactKeys(b, ['branchId', 'status', 'note', 'evidence', 'expectedLatestId']) && b.branchId === c.slice(7) && ['', 'active', 'parked', 'distilled', 'discarded', 'weird_but_alive'].includes(b.status) && str(b.note) && typeof b.evidence === 'boolean' && (b.expectedLatestId === null || validId(b.expectedLatestId));
  if (c === 'person' || c.startsWith('person:')) return exactKeys(b, ['personId','profile','links','expectedLatestId']) && validId(b.personId) && (c === 'person' || c.slice(7) === b.personId) && exactKeys(b.profile, ['name','relationship','notes','importantDates','theyToldMe','iToldThem','cadenceDays']) && str(b.profile.name,120) && !/[\r\n\t]/.test(b.profile.name) && str(b.profile.relationship,200) && !/[\r\n\t]/.test(b.profile.relationship) && str(b.profile.notes) && str(b.profile.importantDates,1000) && str(b.profile.theyToldMe) && str(b.profile.iToldThem) && str(b.profile.cadenceDays,10) && !/[\r\n\t]/.test(b.profile.cadenceDays) && Array.isArray(b.links) && b.links.length<=50 && b.links.every(l=>exactKeys(l,['captureId','captureHash'])&&validId(l.captureId)&&validHash(l.captureHash)) && new Set(b.links.map(l=>l.captureId)).size===b.links.length && (b.expectedLatestId === null || validId(b.expectedLatestId));
  if (c.startsWith('contact:')) return exactKeys(b,['personId','when','offsetMinutes','note','requestId']) && b.personId === c.slice(8) && validId(b.personId) && str(b.when,40) && (b.offsetMinutes===null || Number.isInteger(b.offsetMinutes)&&Math.abs(b.offsetMinutes)<=1440) && str(b.note) && validId(b.requestId);
  if (c === 'capture') return exactKeys(b, ['text', 'span']) && str(b.text) && str(b.span, 100);
  if (c.startsWith('reply:')) return exactKeys(b, ['text', 'parentId']) && str(b.text) && (b.parentId === null || validId(b.parentId));
  if (c === 'span') return exactKeys(b, ['name']) && str(b.name, 100);
  if (c.startsWith('drop:')) return exactKeys(b, ['note', 'commitmentId', 'latestId']) && str(b.note) && b.commitmentId === c.slice(5) && (b.latestId === null || validId(b.latestId));
  if (c === 'hold') return exactKeys(b, ['summary', 'nextAction', 'route', 'context', 'expected']) && noteAllowed(b.summary) && noteAllowed(b.nextAction) && validRoute(b.route) && validContext(b.context) && (b.expected === null || choiceShape(b.expected));
  return false;
}
export async function validateDraft(r) {
  if (!exactKeys(r, ['key', 'tabId', 'context', 'body', 'revision', 'updatedAt', 'hash']) || !validId(r.key) || !validId(r.tabId) || !contextValid(r.context) || !bodyValid(r.context, r.body) || !Number.isSafeInteger(r.revision) || r.revision < 1 || !validDate(r.updatedAt) || !validHash(r.hash)) throw new IntegrityError('Invalid draft record.');
  const { hash, ...payload } = r;
  if (await sha256(JSON.stringify(payload)) !== hash) throw new IntegrityError('Draft checksum mismatch.');
  return r;
}
const emptyBody = (c, old) => c === 'person' || c.startsWith('person:') ? {...old,profile:{name:'',relationship:'',notes:'',importantDates:'',theyToldMe:'',iToldThem:'',cadenceDays:''},links:[]} : c.startsWith('contact:') ? {...old,when:'',note:'',offsetMinutes:null} : c === 'move' || c.startsWith('move:') ? { ...old, name: '', prompt: '' } : c.startsWith('branch:') ? { ...old, status: '', note: '', evidence: false } : c.startsWith('correction:') || c.startsWith('transcript:') || c.startsWith('explore:') || c.startsWith('distill:') ? { ...old, text: '' } : c === 'capture' ? { text: '', span: old?.span ?? '' } : c.startsWith('reply:') ? { text: '', parentId: old?.parentId ?? null } : c === 'span' ? { name: '' } : c.startsWith('drop:') ? { note: '', commitmentId: c.slice(5), latestId: old?.latestId ?? null } : { summary: '', nextAction: '', route: old?.route ?? 'home', context: old?.context ?? { scrollY: 0, spanSearch: '', sourceExpanded: false }, expected: old?.expected ?? null };

// save(context, body) mirrors synchronously and returns Promise<verified record>.
// load(context) returns this writer's verified record or null. list()/recover() return
// {records, damaged}: all writers and bounded raw recovery entries, including mirrors
// and untouched legacy values. clear(context) saves a tombstone. flush() waits for saves.
// A rejected save leaves its mirror intact; callers must retain their input as well.
export function createDraftShelf(options = {}) {
  const database = options.database ?? openDatabase();
  const safeGlobal = name => { try { return globalThis[name]; } catch { return undefined; } };
  const localStorage = 'localStorage' in options ? options.localStorage : safeGlobal('localStorage');
  const sessionStorage = 'sessionStorage' in options ? options.sessionStorage : safeGlobal('sessionStorage');
  const locks = 'locks' in options ? options.locks : safeGlobal('navigator')?.locks;
  const readEpoch = () => database.run(['meta'], 'readonly', async tx => (await request(tx.objectStore('meta').get('epoch')))?.value ?? null);
  let epochValue; let epochPromise = readEpoch().then(value => { epochValue = value; return value; }); epochPromise.catch(() => {});
  let resetMarker = null; try { resetMarker = localStorage?.getItem(DRAFT_RESET_MARKER) ?? null; } catch {}
  let tabId = uuid(), release, lease, closed = false, serial = 0, initialized = false;
  const bootstrap = uuid(), bootstrapKey = `${TAB}-bootstraps`, serialKey = `${TAB}-attempt`; let predecessors = []; let sessionAvailable = true;
  try { if (!sessionStorage) throw Error(); const saved = JSON.parse(sessionStorage.getItem(bootstrapKey) || "[]"); if (Array.isArray(saved)) predecessors = saved.filter(validId).slice(-63); serial = Number(sessionStorage.getItem(serialKey) || 0); if (!Number.isSafeInteger(serial) || serial < 0) serial = 0; sessionStorage.setItem(bootstrapKey, JSON.stringify([...predecessors, bootstrap])); } catch { sessionAvailable = false; }
  const known = new Map(), queues = new Map(), lastWrites = new Map(), pointers = new Map(), attempts = new Map(), pendingClears = new Map(), warnings = [];
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  if (!sessionAvailable) warn('Session storage is unavailable. Emergency copies remain available in recovery, but automatic continuity is unavailable.');
  let candidate; try { candidate = sessionStorage?.getItem(TAB); } catch { warn('Session storage is unavailable. Draft identity will change after reload.'); }
  if (!validId(candidate)) candidate = uuid();
  const ready = (async () => {
    if (locks?.request) {
      let signal; const acquired = new Promise(resolve => { signal = resolve; });
      try {
        lease = Promise.resolve(locks.request(`${PREFIX}lease-${candidate}`, { ifAvailable: true }, async lock => {
          if (!lock) { signal(false); return; }
          signal(true); await new Promise(resolve => { release = resolve; });
        })).catch(() => signal(false));
        if (await acquired) tabId = candidate;
        else warn('Another tab holds this draft identity. Its writing remains available for recovery.');
      } catch { warn('The tab lease is unavailable. Existing writing will be forked.'); }
    } else warn('The tab lease is unavailable. Existing writing will be forked.');
    try { sessionStorage?.setItem(TAB, tabId); } catch { warn('Session storage is unavailable. Draft identity will change after reload.'); }
    await epochPromise.catch(() => {}); initialized = true; return tabId;
  })();
  const pointerKey = c => `${PREFIX}active-${encodeURIComponent(c)}`;
  function pointer(c) { if (pointers.has(c)) return pointers.get(c); try { return sessionStorage?.getItem(pointerKey(c)); } catch { return null; } }
  function setPointer(c, key) { pointers.set(c, key); try { sessionStorage?.setItem(pointerKey(c), key); } catch { warn('Session storage is unavailable. Draft selection may need recovery after reload.'); } }
  async function all() { return database.run(['drafts'], 'readonly', tx => request(tx.objectStore('drafts').getAll())); }
  async function inspect() {
    const records = [], damaged = []; let recoverySize = 0;
    const damage = (source, raw, reason) => { let text; try { text = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { text = null; } if (typeof text === 'string' && recoverySize + text.length <= DRAFT_LIMITS.recovery) { damaged.push({ id: source, source, raw: text, reason }); recoverySize += text.length; } else damaged.push({ id: source, source, raw: null, reason: 'Recovery limit exceeded; original remains in browser storage.' }); };
    for (const row of await all()) { try { records.push(await validateDraft(row)); } catch (e) { if (!(e instanceof IntegrityError)) throw e; damage(`database:${row?.key ?? 'unknown'}`, row, e.message); } }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); if (!(k?.startsWith(PREFIX) || k === `${KEY}-draft` || k?.startsWith(`${KEY}-reply-`))) continue;
        const raw = localStorage.getItem(k); if (raw === null) continue;
        let reason;
        try {
          const data = JSON.parse(raw);
          if (k.startsWith(PREFIX)) {
            if (!mirrorValid(data)) throw Error('Invalid emergency mirror.');
            reason = 'Emergency mirror available for recovery.';
          } else {
            const context = k === `${KEY}-draft` ? 'capture' : `reply:${k.slice(`${KEY}-reply-`.length)}`;
            if (!contextValid(context) || !bodyValid(context, data)) throw Error('Invalid legacy draft.');
            reason = 'Legacy draft available for recovery.';
          }
        } catch (e) { reason = e.message; }
        damage(k, raw, reason);
      }
    } catch (e) { damaged.push({ id: 'localStorage', source: 'localStorage', raw: null, reason: e.message }); }
    return { records, damaged };
  }
  function mirrorValid(data) {
    return (exactKeys(data, ['tabId', 'context', 'body', 'sequence', 'at', 'order', 'baseHash', 'writer', 'epoch', 'marker']) || exactKeys(data, ['tabId', 'context', 'body', 'sequence', 'at', 'order', 'baseHash', 'writer']) || exactKeys(data, ['tabId', 'context', 'body', 'sequence', 'at', 'order', 'baseHash']) || exactKeys(data, ['tabId', 'context', 'body', 'sequence', 'at', 'order']) || exactKeys(data, ['tabId', 'context', 'body', 'sequence'])) && validId(data.tabId) && contextValid(data.context) && bodyValid(data.context, data.body) && validId(data.sequence) && (data.writer === undefined || validId(data.writer)) && (data.at === undefined || validDate(data.at) && Number.isSafeInteger(data.order) && data.order >= 0);
  }
  // Select only a verified record. The active pointer is advisory and may refer to
  // a cloned tab or a damaged row; neither permits overwriting the source.
  async function stored(context) {
    const report = await inspect(); const own = report.records.filter(r => r.tabId === tabId && r.context === context);
    const selected = own.find(r => r.key === pointer(context)) ?? own.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.revision - a.revision)[0] ?? null;
    if (selected) setPointer(context, selected.key);
    return { report, selected };
  }
  async function load(context) {
    await ready; if (!contextValid(context)) throw Error('Invalid draft context.');
    epochPromise = readEpoch().then(value => { epochValue = value; return value; }); const epoch = await epochPromise;
    try { resetMarker = localStorage?.getItem(DRAFT_RESET_MARKER) ?? null; } catch {}
    const { report, selected } = await stored(context); known.set(context, selected);
    const inherited = report.records.filter(r => r.tabId === candidate && r.context === context && r.tabId !== tabId).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.revision - a.revision)[0];
    let acknowledged = 0;
    try { acknowledged = Number(sessionStorage?.getItem(`${pointerKey(context)}-ack`) || 0); } catch {}
    const mirrors = report.damaged.filter(x => x.raw && x.reason === 'Emergency mirror available for recovery.').map(x => { try { return { item: x, value: JSON.parse(x.raw) }; } catch { return null; } }).filter(x => sessionAvailable && x && x.value.context === context && [...predecessors, bootstrap].includes(x.value.writer) && x.value.order > acknowledged && Object.hasOwn(x.value, 'epoch') && (x.value.epoch === epoch || x.value.epoch === '__unknown__' && resetMarker !== null) && x.value.marker === resetMarker);
    mirrors.sort((a,b) => b.value.order - a.value.order);
    const mirror = mirrors[0];
    const base = selected ?? inherited;
    if (mirror && selected && same(mirror.value.body, selected.body)) {
      // A pagehide mirror may outlive an already verified write. Reopening it
      // must not create another copy of identical writing on every reload.
      try { sessionStorage.setItem(`${pointerKey(context)}-ack`, String(mirror.value.order)); } catch { warn('Emergency copies may need manual recovery.'); }
      try { if (localStorage.getItem(mirror.item.source) === mirror.item.raw) localStorage.removeItem(mirror.item.source); } catch { warn('The verified draft is available, but its emergency copy could not be removed.'); }
      return selected;
    }
    if (mirror && mirror.value.baseHash && base && mirror.value.baseHash !== base.hash) { warn('An emergency draft has a different base and is available in recovery.'); }
    else if (mirror) {
      warn('An emergency draft was recovered. Its original copy was kept.');
      return persist(context, mirror.value.body, null, true, mirror.value.order, Promise.resolve(epoch));
    }
    if (!selected && inherited) { warn('A previous tab draft was copied. Its original was kept.'); return persist(context, inherited.body, null, true, 0, Promise.resolve(epoch)); }
    return selected;
  }
  async function persist(context, snapshot, mirrored, forceFork = false, attempt = 0, saveEpoch = epochPromise) {
    await ready; const epoch = await saveEpoch;
    let expected = known.has(context) ? known.get(context) : (await stored(context)).selected;
    if (forceFork) expected = null;
    let record;
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload = { key: expected?.key ?? uuid(), tabId, context, body: snapshot, revision: (expected?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      record = { ...payload, hash: await sha256(JSON.stringify(payload)) };
      try {
        await database.run(['drafts', 'meta'], 'readwrite', async tx => {
          const currentEpoch = (await request(tx.objectStore('meta').get('epoch')))?.value ?? null;
          if (currentEpoch !== epoch) throw Error('The workspace was reset while saving. Your draft is still here.');
          const store = tx.objectStore('drafts'), rows = await request(store.getAll());
          const current = expected && rows.find(r => r?.key === expected.key);
          if (expected && !same(current, expected)) throw Error('DRAFT_CONFLICT');
          if ((!expected && rows.length >= DRAFT_LIMITS.records) || rows.reduce((n, r) => n + (JSON.stringify(r)?.length ?? 0), 0) - (expected ? JSON.stringify(expected).length : 0) + JSON.stringify(record).length > DRAFT_LIMITS.total) throw Error('Draft shelf is full. Existing drafts were kept.');
          await request(store.put(record));
        });
        break;
      } catch (e) {
        if (e.message !== 'DRAFT_CONFLICT' || !expected || attempt) throw e;
        warn('A conflicting draft was kept and this writing was saved as a separate copy.'); expected = null;
      }
    }
    const read = await database.run(['drafts'], 'readonly', tx => request(tx.objectStore('drafts').get(record.key)));
    await validateDraft(read); if (!same(read, record)) throw Error('Draft readback did not match.');
    known.set(context, record); setPointer(context, record.key);
    if (sessionAvailable && attempt) try { sessionStorage.setItem(`${pointerKey(context)}-ack`, String(attempt)); } catch { warn('Session storage is unavailable. Emergency copies may need manual recovery.'); }
    if (mirrored) try { if (localStorage.getItem(mirrored.key) === mirrored.raw) localStorage.removeItem(mirrored.key); } catch { warn('The verified draft was saved, but its emergency copy could not be removed.'); }
    return record;
  }
  function save(context, body, fromClear = false) {
    if (closed || !contextValid(context) || !bodyValid(context, body)) return Promise.reject(Error('Invalid draft or closed shelf.'));
    if (!fromClear) pendingClears.delete(context);
    const saveEpoch = epochPromise;
    let currentMarker = resetMarker; try { currentMarker = localStorage?.getItem(DRAFT_RESET_MARKER) ?? null; } catch {}
    if (currentMarker !== resetMarker) return Promise.reject(Error('The workspace was reset. Reload before saving this draft.'));
    const snapshot = structuredClone(body), sequence = uuid(), key = `${PREFIX}pending-${sequence}`;
    const order = ++serial;
    try { if (!sessionAvailable) throw Error(); sessionStorage.setItem(serialKey, String(order)); } catch { sessionAvailable = false; warn('Session storage is unavailable. Emergency copies remain available in recovery, but automatic continuity is unavailable.'); }
    const raw = JSON.stringify({ tabId: initialized ? tabId : candidate, writer: bootstrap, context, body: snapshot, sequence, at: new Date().toISOString(), order, baseHash: known.get(context)?.hash ?? null, epoch: epochValue === undefined ? '__unknown__' : epochValue, marker: resetMarker });
    let mirrored = null;
    try { if (!localStorage) throw Error('unavailable'); localStorage.setItem(key, raw); mirrored = { key, raw }; }
    catch { warn('Emergency browser storage is unavailable. Drafts can still be saved to the local database.'); }
    attempts.set(context, snapshot);
    const previous = queues.get(context) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => persist(context, snapshot, mirrored, false, order, saveEpoch));
    queues.set(context, task); lastWrites.set(context, task); task.finally(() => { if (queues.get(context) === task) queues.delete(context); }).catch(() => {}); return task;
  }
  async function migrateLegacy(context) {
    const existing = await load(context); if (existing) return existing;
    const source = context === 'capture' ? `${KEY}-draft` : context.startsWith('reply:') ? `${KEY}-reply-${context.slice(6)}` : null;
    if (!source) return null;
    let raw; try { raw = localStorage?.getItem(source); } catch { warn('The previous draft could not be read. Its copy has not been removed.'); return null; }
    if (!raw) return null;
    let body; try { body = JSON.parse(raw); } catch { warn('The previous draft needs recovery. Its raw copy is kept.'); return null; }
    if (!bodyValid(context, body)) { warn('The previous draft needs recovery. Its raw copy is kept.'); return null; }
    const epoch = await epochPromise, claimKey = `${PREFIX}legacy:${source}`;
    const payload = { key: uuid(), tabId, context, body, revision: 1, updatedAt: new Date().toISOString() };
    const record = { ...payload, hash: await sha256(JSON.stringify(payload)) };
    const imported = await database.run(['meta', 'drafts'], 'readwrite', async tx => {
      const meta = tx.objectStore('meta'), drafts = tx.objectStore('drafts');
      if (((await request(meta.get('epoch')))?.value ?? null) !== epoch) throw Error('The workspace changed during draft migration.');
      if ((await request(meta.get('draftLegacyClosed')))?.value) return false;
      if (await request(meta.get(claimKey))) return false;
      const rows = await request(drafts.getAll());
      if (rows.some(row => row.tabId === tabId && row.context === context)) return false;
      if (rows.length >= DRAFT_LIMITS.records || rows.reduce((n, r) => n + JSON.stringify(r).length, 0) + JSON.stringify(record).length > DRAFT_LIMITS.total) throw Error('Draft shelf is full. The previous browser draft is unchanged.');
      await request(drafts.add(record)); await request(meta.put({ key: claimKey, value: record.key })); return true;
    });
    if (!imported) return load(context);
    const actual = await database.run(['drafts'], 'readonly', tx => request(tx.objectStore('drafts').get(record.key)));
    await validateDraft(actual); if (!same(actual, record)) throw Error('The migrated draft could not be read back exactly. Its previous copy is kept.');
    known.set(context, record); setPointer(context, record.key); return actual;
  }
  async function recoverBody(context, body) {
    if (!contextValid(context) || !bodyValid(context, body)) throw Error('Invalid recovery entry.');
    await (queues.get(context) ?? Promise.resolve()).catch(() => {});
    const assertEmpty = () => { const pending = attempts.get(context); if (pending && !isEmpty(context, pending) && !same(pending, body)) throw Error('This tab already has a different draft. Copy it before recovering another.'); };
    assertEmpty();
    const existing = await load(context);
    assertEmpty();
    if (existing && same(existing.body, body)) return existing;
    if (existing && !isEmpty(context, existing.body)) throw Error('This tab already has a draft in that context. Copy the recovered text instead.');
    return save(context, body);
  }
  function isEmpty(context, body) {
    if (context === 'capture' || context.startsWith('correction:') || context.startsWith('transcript:') || context.startsWith('reply:') || context.startsWith('explore:') || context.startsWith('distill:')) return !body.text;
    if (context === 'span') return !body.name;
    if (context.startsWith('drop:')) return !body.note;
    if (context === 'move' || context.startsWith('move:')) return !body.name && !body.prompt;
    if (context.startsWith('branch:')) return !body.status && !body.note && !body.evidence;
    if (context === 'person' || context.startsWith('person:')) return !Object.values(body.profile).some(Boolean) && !body.links.length;
    if (context.startsWith('contact:')) return !body.when && !body.note;
    return !body.summary && !body.nextAction;
  }
  async function clear(context, expectedBody) {
    await (queues.get(context) ?? Promise.resolve()).catch(() => {});
    const old = known.get(context) ?? (await stored(context)).selected;
    const attempted = attempts.get(context), pending = pendingClears.get(context);
    const retry = expectedBody !== undefined && pending && same(expectedBody, pending.original) && same(attempted, pending.tombstone);
    if (expectedBody !== undefined && !retry && !same(attempted ?? old?.body, expectedBody)) throw Error('Draft changed before clearing.');
    if (expectedBody === undefined && attempts.has(context) && !same(attempted, old?.body)) throw Error('Draft changed before clearing.');
    if (retry && old && same(old.body, pending.tombstone)) {
      const expectedEpoch = await epochPromise;
      await database.run(['meta', 'drafts'], 'readonly', async tx => {
        if (((await request(tx.objectStore('meta').get('epoch')))?.value ?? null) !== expectedEpoch) throw Error('The workspace was reset while saving. Your draft is still here.');
        if (!same(await request(tx.objectStore('drafts').get(old.key)), old)) throw Error('Draft changed before clearing.');
      });
      return old;
    }
    const original = retry ? pending.original : attempted ?? old?.body;
    const tombstone = retry ? pending.tombstone : emptyBody(context, original);
    pendingClears.set(context, { original: structuredClone(original), tombstone: structuredClone(tombstone) });
    return save(context, tombstone, true);
  }
  return { ready, load, migrateLegacy, save, health: () => ({ warnings: [...warnings] }), clear, list: inspect, async recoverRecord(record) { await validateDraft(record); return recoverBody(record.context, record.body); }, async recover(source) { if (source === undefined) return inspect(); const item = (await inspect()).damaged.find(entry => entry.source === source); if (!item?.raw || source.startsWith('database:')) throw Error('This recovery entry cannot be imported automatically.'); const value = JSON.parse(item.raw); const context = source.startsWith(PREFIX) ? value.context : source === `${KEY}-draft` ? 'capture' : `reply:${source.slice(`${KEY}-reply-`.length)}`; const body = source.startsWith(PREFIX) ? value.body : value; return recoverBody(context, body); }, async flush() { await Promise.all([...lastWrites.values()]); }, async close() { closed = true; try { await Promise.allSettled([...queues.values()]); } finally { await ready; release?.(); await lease?.catch(() => {}); } } };
}
