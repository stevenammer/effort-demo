// Browser-demo storage only. Native EFFORT uses its own SQLite and backup contracts.
export const KEY = 'effort-public-demo-v1';
export const LIMITS = Object.freeze({ captures: 30, text: 4000, total: 80000, backupBytes: 512000 });
export const SPANS = Object.freeze(['Product demo', 'Learning', 'Unsorted']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const queues = new WeakMap();
const copy = value => JSON.parse(JSON.stringify(value));
const blank = () => ({ version: 1, kind: 'effort-browser-demo', captures: [], now: null });
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...keys].sort().join(',');
export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function textAllowed(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= LIMITS.text &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}
export function validChoice(choice, captures) {
  if (!exactKeys(choice, ['captureId', 'start', 'end', 'quote', 'origin'])) return false;
  const source = captures.find(c => c.id === choice.captureId);
  return source && Number.isInteger(choice.start) && Number.isInteger(choice.end) &&
    choice.start >= 0 && choice.end > choice.start && choice.end <= source.text.length &&
    typeof choice.quote === 'string' && source.text.slice(choice.start, choice.end) === choice.quote &&
    ['sample', 'chosen'].includes(choice.origin);
}
export async function validateState(state) {
  if (!exactKeys(state, ['version', 'kind', 'captures', 'now']) || state.version !== 1 ||
      state.kind !== 'effort-browser-demo' || !Array.isArray(state.captures) || state.captures.length > LIMITS.captures) {
    throw Error('This is not a supported EFFORT browser-demo backup.');
  }
  const ids = new Set(); let size = 0;
  for (const c of state.captures) {
    if (!exactKeys(c, ['id', 'text', 'hash', 'createdAt', 'span', 'sample']) || !uuid.test(c.id) || ids.has(c.id) ||
        !textAllowed(c.text) || !digest.test(c.hash) || !SPANS.includes(c.span) || typeof c.sample !== 'boolean' ||
        typeof c.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(c.createdAt) || !Number.isFinite(Date.parse(c.createdAt))) {
      throw Error('The demo data has an invalid capture. Nothing was changed.');
    }
    ids.add(c.id); size += c.text.length;
    if (size > LIMITS.total || await sha256(c.text) !== c.hash) throw Error('The original text could not be verified. Nothing was changed.');
  }
  if (state.now !== null && !validChoice(state.now, state.captures)) throw Error('The next step does not match its original text.');
  return state;
}
export function createStore(storage, locks = globalThis.navigator?.locks) {
  async function read() {
    const raw = storage.getItem(KEY);
    if (raw === null) return blank();
    if (new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('Saved demo data is too large.');
    return validateState(JSON.parse(raw));
  }
  async function persist(state) {
    await validateState(state);
    const raw = JSON.stringify(state);
    if (new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('Demo storage is full. Download a backup, then reset it.');
    storage.setItem(KEY, raw);
    const actual = await read();
    if (JSON.stringify(actual) !== raw) throw Error('The save could not be read back. Keep your draft and try again.');
    return copy(actual);
  }
  function transaction(work) {
    const run = () => work();
    if (locks?.request) return locks.request(KEY, run);
    // Without Web Locks this coordinates only callers in this tab. See README.
    const prior = queues.get(storage) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(run); queues.set(storage, next.catch(() => {})); return next;
  }
  async function capture(text, span = 'Unsorted') {
    if (!textAllowed(text) || !SPANS.includes(span)) throw Error('Add between 1 and 4,000 characters of fictional text.');
    return transaction(async () => {
      const state = await read();
      const record = { id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: new Date().toISOString(), span, sample: false };
      state.captures.push(record);
      await persist(state);
      return copy(record);
    });
  }
  async function choose(captureId, start, end) {
    return transaction(async () => {
      const state = await read(); const source = state.captures.find(c => c.id === captureId);
      const choice = { captureId, start, end, quote: source?.text.slice(start, end), origin: 'chosen' };
      if (!validChoice(choice, state.captures)) throw Error('Choose an exact detail from a saved original.');
      state.now = choice; return persist(state);
    });
  }
  async function complete(expected) {
    return transaction(async () => {
      const state = await read();
      if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(state.now)) throw Error('The next step changed in another tab. Reopen it before marking it done.');
      state.now = null; return persist(state);
    });
  }
  async function reset() { return transaction(() => persist(blank())); }
  async function exportData() {
    const payload = await read(); const sha = await sha256(JSON.stringify(payload));
    return JSON.stringify({ payload, sha256: sha }, null, 2);
  }
  async function restore(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > LIMITS.backupBytes) throw Error('Choose a demo backup under 512 KB.');
    const bundle = JSON.parse(raw);
    if (!exactKeys(bundle, ['payload', 'sha256']) || !digest.test(bundle.sha256) ||
        await sha256(JSON.stringify(bundle.payload)) !== bundle.sha256) throw Error('Backup checksum mismatch. Nothing was changed.');
    const incoming = await validateState(bundle.payload);
    return transaction(async () => {
      const state = await read(); let added = 0;
      for (const c of incoming.captures) {
        const existing = state.captures.find(item => item.id === c.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(c)) throw Error('A capture with the same ID differs. Nothing was changed.');
        if (!existing) { state.captures.push(copy(c)); added++; }
      }
      if (state.now === null) state.now = copy(incoming.now);
      await persist(state); return added;
    });
  }
  async function seed(force = false) {
    return transaction(async () => {
      if (!force && storage.getItem(KEY) !== null) return read();
      const state = blank();
      const samples = [
        ['Product demo', "I'll review the workshop outline before lunch.\nMaybe a short walkthrough would help.\nI'm waiting for the venue to reply.\nWhat should the opening example show?\nI already sent the agenda."],
        ['Learning', 'Maybe build a small practice tool someday.\nI don\'t need to book the room, it is already reserved.\nWhy do interruptions make it hard to return to a task?'],
      ];
      for (const [span, text] of samples) state.captures.push({ id: crypto.randomUUID(), text, hash: await sha256(text), createdAt: new Date().toISOString(), span, sample: true });
      const quote = "I'll review the workshop outline before lunch.";
      state.now = { captureId: state.captures[0].id, start: 0, end: quote.length, quote, origin: 'sample' };
      return persist(state);
    });
  }
  return { read, capture, choose, complete, reset, exportData, restore, seed };
}
