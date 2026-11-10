import { validIsoInstant } from './export.js';
import { createGate, makeDigest, openRecord, sealRecord, same, safePart, textAllowed } from './sealed.js';

const MOVE_PREFIX = 'move:';
const MOVE_KEYS = ['id', 'kind', 'moveId', 'revision', 'previousId', 'name', 'prompt', 'enabled', 'createdAt'];
const NAME_LIMIT = 120, PROMPT_LIMIT = 2000;

/** Optional thinking prompts. They are tools for the writer's own thinking, never tasks. */
export const MOVE_SEEDS = Object.freeze([
  ['TACIT TO EXPLICIT', 'Take something experienced people just know and make the hidden process visible.'],
  ['FRICTION TO TOOL', 'Notice recurring real-world friction and make the smallest useful artifact that changes the experience.'],
  ['CROSS-DOMAIN TRANSFER', 'Take a mechanism that works in one domain and ask where else it applies.'],
  ['HUMAN UNDERNEATH SYSTEM', 'Ignore the official workflow for a moment. What is the person actually trying to accomplish?'],
  ['COMPRESSION', 'Find the sentence, visual, interaction, or loop that keeps most of the useful complexity.'],
  ['FUTURE ARCHITECTURE', 'If this primitive works, what larger system does it naturally become part of?'],
  ['INVERT THE METRIC', 'What if the KPI is optimizing the wrong thing?'],
  ['FOLLOW THE USER', 'Where does real behavior depart from the written process?'],
  ['SMALL PROOF', 'What is the cheapest artifact that could falsify or validate the interesting part?'],
].map(([name, prompt], i) => {
  const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  return Object.freeze({ id, name, prompt, enabled: true });
}));

const nameAllowed = value => textAllowed(value) && value.length <= NAME_LIMIT;
const promptAllowed = value => textAllowed(value) && value.length <= PROMPT_LIMIT;
const fromSeed = seed => ({ ...seed, latestId: null, history: [], recovery: false });

/** True when a snapshot saved on a branch still matches a real revision (or a seed) that was on when it was taken. */
export function validMoveSnapshot(snapshot, revisions) {
  if (snapshot === null) return true;
  if (!snapshot || typeof snapshot !== 'object' || Object.keys(snapshot).sort().join() !== 'id,name,prompt,revisionId') return false;
  if (!safePart(snapshot.id) || !nameAllowed(snapshot.name) || !promptAllowed(snapshot.prompt)) return false;
  const row = snapshot.revisionId === null ? MOVE_SEEDS.find(seed => seed.id === snapshot.id)
    : revisions.find(r => r.id === snapshot.revisionId && r.moveId === snapshot.id);
  return !!row && row.name === snapshot.name && row.prompt === snapshot.prompt && row.enabled === true;
}

export function createMoves({ store, hash, now, id }) {
  if (typeof now !== 'function' || typeof id !== 'function') throw Error('Moves need now and id.');
  const digest = makeDigest(hash);
  const gate = createGate(store, [MOVE_PREFIX]);

  async function read() {
    const revisions = [], damaged = [];
    for (const record of await gate.mine()) {
      try {
        const body = await openRecord(record, MOVE_KEYS, digest);
        if (body.kind !== 'move' || !safePart(body.moveId) || !Number.isInteger(body.revision) || body.revision < 1 ||
            body.id !== `${MOVE_PREFIX}${body.moveId}:${body.revision}` || !nameAllowed(body.name) || !promptAllowed(body.prompt) ||
            typeof body.enabled !== 'boolean' || !validIsoInstant(body.createdAt)) throw Error('A saved thinking move is not valid.');
        revisions.push(body);
      } catch (error) { damaged.push({ id: record.id, reason: error.message }); }
    }
    return { revisions, damaged };
  }

  function derive({ revisions, damaged }) {
    const result = new Map(MOVE_SEEDS.map(seed => [seed.id, fromSeed(seed)]));
    const groups = new Map();
    for (const revision of revisions) groups.set(revision.moveId, [...(groups.get(revision.moveId) ?? []), revision]);
    const brokenIds = new Set(damaged.map(d => d.id.split(':')[1]).filter(Boolean));
    for (const [moveId, group] of groups) {
      group.sort((a, b) => a.revision - b.revision);
      const linked = group.every((r, i) => r.revision === i + 1 && r.previousId === (i ? group[i - 1].id : null));
      const last = group.at(-1);
      const recovery = !linked || brokenIds.has(moveId);
      result.set(moveId, {
        id: moveId, name: last.name, prompt: last.prompt, enabled: recovery ? false : last.enabled,
        latestId: last.id, history: group, recovery,
      });
    }
    for (const moveId of brokenIds) if (!result.has(moveId)) {
      result.set(moveId, {
        id: moveId, name: 'Move definition needs recovery', prompt: '', enabled: false, latestId: null, history: [], recovery: true,
      });
    }
    return [...result.values()];
  }

  async function list() { return structuredClone(derive(await read())); }

  async function snapshot(moveId) {
    const move = derive(await read()).find(item => item.id === moveId);
    if (!move || !move.enabled || move.recovery) throw Error('This thinking move is unavailable or turned off.');
    return { id: move.id, revisionId: move.latestId, name: move.name, prompt: move.prompt };
  }

  /** Saves a new revision. The earlier wording stays in the history. */
  async function save({ moveId = null, name, prompt, enabled, expectedLatestId = null }, { id: requestId } = {}) {
    if (!nameAllowed(name)) throw Error('Give the move a name of up to 120 characters.');
    if (!promptAllowed(prompt)) throw Error('Give the move a prompt of up to 2,000 characters.');
    if (typeof enabled !== 'boolean') throw Error('Say whether the move is turned on.');
    const state = await read();
    const targetId = moveId ?? (safePart(requestId) ? requestId : id());
    if (!safePart(targetId)) throw Error('The move ID is not valid.');
    const current = derive(state).find(item => item.id === targetId);
    if (moveId === null && current) throw Error('This move changed in another tab. Refresh before saving.');
    if (moveId !== null && !current) throw Error('That thinking move was not found.');
    if (current?.recovery) throw Error('This move needs recovery before it can change. Your writing is still here.');
    if ((current?.latestId ?? null) !== expectedLatestId) throw Error('This move changed in another tab. Refresh before saving.');
    const revision = (current?.history.length ?? 0) + 1;
    const body = {
      id: `${MOVE_PREFIX}${targetId}:${revision}`, kind: 'move', moveId: targetId, revision,
      previousId: current?.latestId ?? null, name, prompt, enabled, createdAt: now(),
    };
    if (!validIsoInstant(body.createdAt)) throw Error('Time must be a valid ISO instant.');
    const record = await sealRecord(body, digest);
    if (!await gate.create(record)) {
      const existing = (await read()).revisions.find(r => r.id === body.id);
      const { createdAt, checksum, ...theirs } = existing ?? {}, { createdAt: ignoredAt, ...mine } = body;
      if (!existing || !same(theirs, mine)) throw Error('This move changed in another tab. Refresh before saving.');
    }
    const saved = (await read()).revisions.find(r => r.id === body.id);
    if (!saved || saved.name !== name || saved.prompt !== prompt || saved.enabled !== enabled) {
      throw Error('The saved move differs from its readback. Keep your writing and retry.');
    }
    return structuredClone(saved);
  }

  return { list, snapshot, save, revisions: async () => structuredClone((await read()).revisions) };
}
