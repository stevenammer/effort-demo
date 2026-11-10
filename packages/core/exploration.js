import { validIsoInstant } from './export.js';
import { validMoveSnapshot } from './moves.js';
import { createGate, makeDigest, openRecord, sealRecord, same, safePart, textAllowed } from './sealed.js';

const EXPLORATION_PREFIX = 'exploration:', DISTILLATION_PREFIX = 'distillation:';
const EXPLORATION_KEYS = ['id', 'kind', 'sourceId', 'parentId', 'dial', 'text', 'textHash', 'move', 'author', 'createdAt'];
const DISTILLATION_KEYS = ['id', 'kind', 'explorationId', 'type', 'text', 'textHash', 'author', 'createdAt'];
export const EXPLORATION_DIALS = Object.freeze(['TIGHT', 'NORMAL', 'WILD', 'UNHINGED SANDBOX']);
export const DISTILLATION_TYPES = Object.freeze([
  'INSIGHT', 'HYPOTHESIS', 'EXPERIMENT', 'DECISION CANDIDATE', 'FUTURE ARCHITECTURE', 'OPEN TENSION', 'WEIRD BUT ALIVE', 'NOISE', 'RECEIPT',
]);

/**
 * Safe exploration: branches off a saved thought and the writer's own distillations of them.
 * Nothing here can create, activate, complete or change a commitment. The only way out of
 * exploration is a plain reply the writer can read, which stays a proposal until they choose it.
 */
export function createExploration({ store, hash, now, id, spans, moves }) {
  if (typeof now !== 'function' || typeof id !== 'function' || !spans?.reply) throw Error('Exploration needs now, id and spans.');
  const digest = makeDigest(hash);
  const gate = createGate(store, [EXPLORATION_PREFIX, DISTILLATION_PREFIX]);
  const instant = () => { const at = now(); if (!validIsoInstant(at)) throw Error('Time must be a valid ISO instant.'); return at; };
  const partId = (prefix, requestId) => {
    const part = requestId ?? id();
    if (!safePart(part)) throw Error('The ID is not valid.');
    return prefix + part;
  };

  async function sourceFor(sourceId) {
    const source = typeof sourceId === 'string' ? await store.get(sourceId) : null;
    if (!source) throw Error('That saved thought was not found.');
    if (typeof source.text !== 'string' || await hash(source.text) !== source.hash) {
      throw Error('Original source changed or failed verification.');
    }
    return source;
  }

  async function read() {
    const records = await gate.mine(), revisions = moves ? await moves.revisions() : [];
    const branches = new Map(), damaged = new Map(), distillations = [];
    for (const record of records) {
      try {
        if (record.id.startsWith(EXPLORATION_PREFIX)) {
          const body = await openRecord(record, EXPLORATION_KEYS, digest);
          if (body.kind !== 'exploration' || !EXPLORATION_DIALS.includes(body.dial) || !textAllowed(body.text) || body.author !== 'self' ||
              !validIsoInstant(body.createdAt) || await hash(body.text) !== body.textHash || !validMoveSnapshot(body.move, revisions) ||
              typeof body.sourceId !== 'string' || !(body.parentId === null || typeof body.parentId === 'string')) {
            throw Error('A saved branch is not valid.');
          }
          branches.set(body.id, body);
        } else {
          const body = await openRecord(record, DISTILLATION_KEYS, digest);
          if (body.kind !== 'distillation' || !DISTILLATION_TYPES.includes(body.type) || !textAllowed(body.text) ||
              body.author !== 'self' || !validIsoInstant(body.createdAt) || await hash(body.text) !== body.textHash ||
              typeof body.explorationId !== 'string') {
            throw Error('A saved distillation is not valid.');
          }
          distillations.push(body);
        }
      } catch (error) { damaged.set(record.id, error.message); }
    }
    for (const branch of branches.values()) {
      const parent = branch.parentId === null ? null : branches.get(branch.parentId);
      const sourceOk = await store.get(branch.sourceId).then(s => !!s && typeof s.text === 'string', () => false);
      if (!sourceOk) damaged.set(branch.id, 'A branch is missing its saved thought.');
      else if (branch.parentId !== null && (!parent || parent.sourceId !== branch.sourceId)) {
        damaged.set(branch.id, 'A branch has a missing or inconsistent parent.');
      }
    }
    spreadDamage(branches, damaged);
    const usable = [...branches.values()].filter(b => !damaged.has(b.id));
    const good = new Set(usable.map(b => b.id)), keptDistillations = [];
    for (const d of distillations) {
      if (good.has(d.explorationId)) keptDistillations.push(d);
      else damaged.set(d.id, 'A distillation is missing a usable branch.');
    }
    const report = [...damaged].map(([recordId, reason]) => ({ id: recordId, reason }));
    return { explorations: usable, distillations: keptDistillations, damaged: report };
  }

  /** A branch is only as good as its ancestors, including loops. */
  function spreadDamage(branches, damaged) {
    for (const branch of branches.values()) {
      const path = new Set(); let current = branch;
      while (current && !damaged.has(current.id)) {
        if (path.has(current.id)) { damaged.set(current.id, 'A branch has a cyclic parent.'); break; }
        path.add(current.id); current = current.parentId === null ? null : branches.get(current.parentId);
      }
      if (current && damaged.has(current.id)) for (const pathId of path) {
        damaged.set(pathId, damaged.get(pathId) ?? 'A branch ancestor needs recovery.');
      }
    }
  }

  async function createOnce(record, requestId) {
    if (await gate.create(record)) return;
    const existing = (await gate.mine()).find(r => r.id === record.id);
    const { createdAt, checksum, ...theirs } = existing ?? {}, { createdAt: ignoredAt, checksum: ignoredSum, ...mine } = record;
    if (!requestId || !existing || !same(theirs, mine)) throw Error('This request ID already belongs to a different exploration record.');
  }

  async function explore({ sourceId, parentId = null, dial, text, moveId = null }, { id: requestId } = {}) {
    if (requestId !== undefined && !safePart(requestId)) throw Error('The request ID is not valid.');
    if (!EXPLORATION_DIALS.includes(dial)) throw Error('Choose a dial: TIGHT, NORMAL, WILD or UNHINGED SANDBOX.');
    if (!textAllowed(text)) throw Error('Add between 1 and 4,000 characters of text.');
    await sourceFor(sourceId);
    const state = await read();
    if (parentId !== null) {
      const parent = state.explorations.find(b => b.id === parentId);
      if (!parent || parent.sourceId !== sourceId) throw Error('That branch was not found on this thought.');
    }
    if (moveId !== null && !moves) throw Error('Moves are not available here.');
    const move = moveId === null ? null : await moves.snapshot(moveId);
    const body = {
      id: partId(EXPLORATION_PREFIX, requestId), kind: 'exploration', sourceId, parentId, dial, text,
      textHash: await hash(text), move, author: 'self', createdAt: instant(),
    };
    await createOnce(await sealRecord(body, digest), requestId);
    const saved = (await read()).explorations.find(b => b.id === body.id);
    if (!saved || saved.text !== text) throw Error('The branch could not be read back exactly. Keep your text and retry.');
    return structuredClone(saved);
  }

  async function distill({ explorationId, type, text }, { id: requestId } = {}) {
    if (requestId !== undefined && !safePart(requestId)) throw Error('The request ID is not valid.');
    if (!DISTILLATION_TYPES.includes(type)) throw Error('Choose one of the distillation types.');
    if (!textAllowed(text)) throw Error('Add between 1 and 4,000 characters of text.');
    const state = await read();
    if (!state.explorations.some(b => b.id === explorationId)) throw Error('That branch was not found or needs recovery.');
    const body = {
      id: partId(DISTILLATION_PREFIX, requestId), kind: 'distillation', explorationId, type, text,
      textHash: await hash(text), author: 'self', createdAt: instant(),
    };
    await createOnce(await sealRecord(body, digest), requestId);
    const saved = (await read()).distillations.find(d => d.id === body.id);
    if (!saved || saved.text !== text) throw Error('The distillation could not be read back exactly. Keep your text and retry.');
    return structuredClone(saved);
  }

  /** Copies a distillation into the source thread as a plain reply. It is writing, not a commitment. */
  async function prepareProposal({ distillationId }) {
    const state = await read();
    const distillation = state.distillations.find(d => d.id === distillationId);
    const branch = state.explorations.find(b => b.id === distillation?.explorationId);
    if (!distillation || !branch) throw Error('The distillation was not found or needs recovery.');
    if (branch.dial === 'UNHINGED SANDBOX') throw Error('Leave the sandbox by creating a branch with another dial first.');
    const requestId = `proposal.${(await digest(['proposal', distillationId])).slice(0, 40)}`;
    return spans.reply(branch.sourceId, distillation.text, { id: requestId, derivedFromId: distillationId });
  }

  return { explore, distill, prepareProposal, snapshot: async () => structuredClone(await read()) };
}
