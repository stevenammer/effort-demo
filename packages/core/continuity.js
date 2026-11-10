import { canonical, validIsoInstant } from './export.js';

const RECORD_ID = 'effort.continuity.v1';
const open = c => c && ['COMMITTED', 'ACTIVE'].includes(c.state);
const required = (s, name) => { if (typeof s !== 'string' || !s.trim()) throw Error(`${name} is required.`); };
const same = (a, b) => canonical(a) === canonical(b);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Authority expresses caller intent; it does not authenticate identity. */
export function createContinuity({ store, hash, now, id }) {
  if (!store?.snapshot || !store?.compareAndSwapDerived || !store?.get || typeof hash !== 'function' || typeof now !== 'function' || typeof id !== 'function') throw Error('Continuity requires store, hash, now and id.');
  const digest = async value => {
    const result = await hash(canonical(value));
    if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) throw Error('Invalid hash.');
    return result;
  };
  async function read(candidate) {
    let record = candidate;
    if (candidate === undefined) {
      const snapshot = await store.snapshot();
      const matches = snapshot.derived.filter(r => r?.id === RECORD_ID);
      if (matches.length > 1) throw Error('Duplicate continuity state.');
      record = matches[0] ?? null;
    }
    if (!record) return { record, data: { commitments: [], packets: [], commands: [] } };
    const { checksum, ...body } = record;
    if (!shape(body, ['id','version','commitments','packets','commands']) || body.id !== RECORD_ID || body.version !== 1 || !Array.isArray(body.commitments) || !Array.isArray(body.packets) || !Array.isArray(body.commands) || await digest(body) !== checksum) throw Error('Continuity state is corrupt.');
    const ids = new Set();
    for (const c of body.commitments) {
      if (!shape(c, ['id','state','source','history']) || typeof c.id !== 'string' || !c.id || ids.has(c.id) || !['COMMITTED','ACTIVE','COMPLETE','DROPPED'].includes(c.state) || !Array.isArray(c.history) || !c.history.length || !shape(c.source, ['captureId','hash','recordHash','start','end','quote']) || typeof c.source.captureId !== 'string' || !/^([a-f0-9]{64})$/.test(c.source.hash) || !/^([a-f0-9]{64})$/.test(c.source.recordHash) || !Number.isInteger(c.source.start) || !Number.isInteger(c.source.end) || c.source.start < 0 || c.source.end <= c.source.start || typeof c.source.quote !== 'string' || c.source.quote.length !== c.source.end-c.source.start || !c.source.quote.trim() || c.source.quote.length > 4000 || c.history.at(-1).state !== c.state) throw Error('Continuity state is corrupt.');
      let previous = null;
      for (const e of c.history) {
        const transitions = { COMMITTED: ['ACTIVE','COMPLETE','DROPPED'], ACTIVE: ['COMMITTED','COMPLETE','DROPPED'] };
        if (!shape(e, ['state','at','note','receipt','commandId']) || !validIsoInstant(e.at) || typeof e.commandId !== 'string' || !e.commandId || typeof e.note !== 'string' || (previous === null ? e.state !== 'COMMITTED' : !transitions[previous]?.includes(e.state)) || e.receipt !== (e.state === 'COMPLETE' ? 'self-report' : null) || (['COMPLETE','DROPPED'].includes(e.state) && !e.note.trim())) throw Error('Continuity history is corrupt.');
        previous = e.state;
      }
      ids.add(c.id);
    }
    if (body.commitments.filter(c => c.state === 'ACTIVE').length > 1 || new Set(body.commands.map(c => c.id)).size !== body.commands.length || new Set(body.packets.map(p => p.id)).size !== body.packets.length) throw Error('Continuity state is corrupt.');
    for (const p of body.packets) {
      const c = p && body.commitments.find(c => c.id === p.commitmentId);
      if (!shape(p, ['id','commitmentId','source','summary','nextAction','route','context','at','resumedAt']) || typeof p.id !== 'string' || !p.id || typeof p.summary !== 'string' || !p.summary.trim() || typeof p.nextAction !== 'string' || typeof p.route !== 'string' || !p.route || !p.context || typeof p.context !== 'object' || Array.isArray(p.context) || !validIsoInstant(p.at) || !(p.resumedAt === null || validIsoInstant(p.resumedAt)) || (p.commitmentId === null ? p.source !== null : !c || !same(c.source, p.source))) throw Error('Return point is corrupt.');
    }
    for (const c of body.commitments) for (const e of c.history) if (!body.commands.some(command => command.id === e.commandId)) throw Error('Continuity command history is incomplete.');
    for (const command of body.commands) if (!shape(command, ['id','signature','result']) || typeof command.id !== 'string' || !command.id || typeof command.signature !== 'string' || !/^[a-f0-9]{64}$/.test(command.signature) || typeof command.result !== 'string' || !command.result) throw Error('Command history is corrupt.');
    const sources = new Map();
    for (const commitment of body.commitments) await verifySource(commitment.source, sources);
    return { record, data: structuredClone({ commitments: body.commitments, packets: body.packets, commands: body.commands }) };
  }
  async function verifySource(source, cache = new Map()) {
    if (!cache.has(source.captureId)) cache.set(source.captureId, (async () => {
      const capture = await store.get(source.captureId);
      if (!capture || capture.id !== source.captureId || !validIsoInstant(capture.createdAt) || typeof capture.text !== 'string' || await hash(capture.text) !== capture.hash) throw Error('Original source changed or failed verification.');
      return { capture, recordHash: await digest(capture) };
    })());
    const { capture, recordHash } = await cache.get(source.captureId);
    if (capture.hash !== source.hash || recordHash !== source.recordHash || capture.text.slice(source.start, source.end) !== source.quote) throw Error('Original source changed or failed verification.');
  }
  async function execute(type, args, { authority, commandId } = {}) {
    args = structuredClone(args);
    canonical(args);
    if (authority !== 'human') throw Error('Explicit human authority is required.');
    required(commandId, 'Command ID');
    const signature = await digest({ type, args });
    for (let attempt = 0; attempt < 20; attempt++) {
      const { record, data } = await read();
      const prior = data.commands.find(c => c.id === commandId);
      if (prior) {
        if (prior.signature !== signature) throw Error('Command ID already used for another action.');
        return structuredClone(prior.result);
      }
      const at = now();
      if (!validIsoInstant(at)) throw Error('Time must be a valid ISO instant.');
      const freshId = () => { const value = id(); required(value, 'Generated ID'); return value; };
      const event = (c, state, note = '', receipt = null) => { c.state = state; c.history.push({ state, at, note, receipt, commandId }); };
      const select = async c => {
        if (!open(c)) throw Error('Commitment is not open.');
        await verifySource(c.source);
        for (const current of data.commitments) if (current.state === 'ACTIVE' && current.id !== c.id) event(current, 'COMMITTED');
        if (c.state !== 'ACTIVE') event(c, 'ACTIVE');
      };
      let result;
      if (type === 'promote') {
        if (!['TIGHT','NORMAL','WILD'].includes(args.dial)) throw Error('Promotion dial is invalid or cannot promote.');
        const capture = await store.get(args.captureId);
        if (!capture || !validIsoInstant(capture.createdAt) || typeof capture.text !== 'string' || await hash(capture.text) !== capture.hash || !Number.isInteger(args.start) || !Number.isInteger(args.end) || args.start < 0 || args.end <= args.start || args.end > capture.text.length) throw Error('Choose an exact detail from a verified original.');
        const quote = capture.text.slice(args.start, args.end);
        if (!quote.trim() || quote.length > 4000) throw Error('Choose a non-empty detail of at most 4000 characters.');
        const source = { captureId: capture.id, hash: capture.hash, recordHash: await digest(capture), start: args.start, end: args.end, quote };
        let c = data.commitments.find(c => open(c) && same(c.source, source));
        if (!c) { c = { id: freshId(), state: 'COMMITTED', source, history: [] }; event(c, 'COMMITTED'); data.commitments.push(c); }
        result = c.id;
      } else if (type === 'activate') {
        const c = data.commitments.find(c => c.id === args.id); await select(c); result = c.id;
      } else if (type === 'complete' || type === 'drop') {
        required(args.note, type === 'complete' ? 'Completion note' : 'Drop reason');
        const c = data.commitments.find(c => c.id === args.id);
        if (!open(c)) throw Error('Commitment is not open.');
        event(c, type === 'complete' ? 'COMPLETE' : 'DROPPED', args.note, type === 'complete' ? 'self-report' : null); result = c.id;
      } else if (type === 'hold') {
        required(args.summary, 'Summary');
        if (typeof args.nextAction !== 'string' || typeof args.route !== 'string' || !args.route || !args.context || typeof args.context !== 'object' || Array.isArray(args.context)) throw Error('Invalid return point.');
        const c = data.commitments.find(c => c.state === 'ACTIVE');
        if (c) await verifySource(c.source);
        const packet = { id: freshId(), commitmentId: c?.id ?? null, source: c ? structuredClone(c.source) : null, summary: args.summary, nextAction: args.nextAction, route: args.route, context: structuredClone(args.context), at, resumedAt: null };
        data.packets.push(packet); result = packet.id;
      } else if (type === 'resume') {
        const packet = data.packets.find(p => p.id === args.id);
        if (!packet) throw Error('Return point not found.');
        if (packet.resumedAt !== null) throw Error('Return point was already resumed.');
        if (packet.resumedAt === null) {
          if (packet.commitmentId) {
            const c = data.commitments.find(c => c.id === packet.commitmentId);
            if (!open(c) || !same(c.source, packet.source)) throw Error('Saved commitment is no longer open.');
            await select(c);
          }
          packet.resumedAt = at;
        }
        result = packet.id;
      } else throw Error('Unknown continuity command.');
      data.commands.push({ id: commandId, signature, result });
      const body = { id: RECORD_ID, version: 1, ...data };
      if (data.commands.length > 10000 || data.commitments.length > 2000 || data.packets.length > 2000 || new TextEncoder().encode(canonical(body)).length > 4 * 1024 * 1024) throw Error('Continuity history limit reached. Export your data before continuing.');
      const replacement = { ...body, checksum: await digest(body) };
      await read(replacement);
      if (!await store.compareAndSwapDerived(RECORD_ID, record, replacement)) continue;
      const verified = await read();
      const saved = verified.data.commands.find(c => c.id === commandId);
      if (!saved || saved.signature !== signature || !same(saved.result, result)) throw Error('Change could not be verified after writing; retry with the same command ID.');
      return structuredClone(result);
    }
    throw Error('Continuity changed repeatedly; retry with the same command ID.');
  }
  return {
    async snapshot() { const data = (await read()).data; const active = data.commitments.find(c => c.state === 'ACTIVE'); if (active) await verifySource(active.source); return structuredClone(data); },
    promote: (captureId, start, end, options = {}) => execute('promote', { captureId, start, end, dial: options.dial ?? 'NORMAL' }, options),
    activate: (id, options) => execute('activate', { id }, options),
    complete: (id, note, options) => execute('complete', { id, note }, options),
    drop: (id, note, options) => execute('drop', { id, note }, options),
    hold: ({ summary, nextAction = '', route = 'home', context = {} }, options) => execute('hold', { summary, nextAction, route, context }, options),
    resume: (id, options) => execute('resume', { id }, options),
  };
}
