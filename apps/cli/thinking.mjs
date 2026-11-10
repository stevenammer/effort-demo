import { randomUUID } from 'node:crypto';
import { createSpans } from '../../packages/core/spans.js';
import { createMoves } from '../../packages/core/moves.js';
import { createExploration } from '../../packages/core/exploration.js';

const DIALS = { tight: 'TIGHT', normal: 'NORMAL', wild: 'WILD', sandbox: 'UNHINGED SANDBOX' };
const WARNING = 'WARNING: this text no longer matches what was saved';
const COMMANDS = ['span', 'post', 'reply', 'thread', 'explore', 'distill', 'explorations'];

export const isThinkingCommand = command => COMMANDS.includes(command);

/** Prints a thread top to bottom. Iterative on purpose: a very long chain of replies must not overflow the stack. */
export function printThread(root, output) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    output(`${'  '.repeat(depth)}${node.id}\t${node.verified ? '' : `[${WARNING}] `}${node.text}`);
    for (let i = node.replies.length - 1; i >= 0; i--) stack.push([node.replies[i], depth + 1]);
  }
}

/** A leading word that looks like an option is refused, never saved as writing. `--` says the rest is plain text. */
function plain(words, usage) {
  if (words[0] === '--') return words.slice(1);
  if (words[0]?.startsWith('-')) throw Error(`Unknown option ${words[0]}. ${usage}`);
  return words;
}

/** Takes `--flag value` pairs off the front of the words. */
function takeFlags(words, allowed) {
  const flags = {}; let rest = words;
  while (rest[0]?.startsWith('-')) {
    if (rest[0] === '--') { rest = rest.slice(1); break; }
    if (!allowed.includes(rest[0]) || rest.length < 2) throw Error(`Unknown or incomplete option ${rest[0]}.`);
    flags[rest[0].slice(2)] = rest[1]; rest = rest.slice(2);
  }
  return { flags, rest };
}

export async function runThinkingCommand(command, words, context) {
  try { return await runCommand(command, words, context); } catch (error) {
    if (error.code === 'SPAN_DAMAGED') error.message += ` Run: effort span set-aside "${error.target}"`;
    throw error;
  }
}

async function runCommand(command, words, { store, hash, output }) {
  const now = () => new Date().toISOString();
  const spans = createSpans({ store, hash, now, id: randomUUID });
  const moves = createMoves({ store, hash, now, id: randomUUID });
  const exploration = createExploration({ store, hash, now, id: randomUUID, spans, moves });
  if (command === 'span') {
    const usage = 'Usage: effort span create <name> | effort span set-aside <name> | effort span list';
    if (words[0] === 'create' || words[0] === 'set-aside') {
      const name = plain(words.slice(1), usage);
      if (!name.length) throw Error(usage);
      if (words[0] === 'create') { output(`SPAN ${(await spans.createSpan(name.join(' '))).name}`); return; }
      const done = await spans.setAsideSpan(name.join(' '));
      output(`SET ASIDE the damaged record for ${done.name} (kept, not deleted). Now run: effort span create "${done.name}"`); return;
    }
    if (words[0] === 'list' && words.length === 1) {
      for (const span of (await spans.listSpans()).spans) output(`${span.name}\t${span.kind}`);
      return;
    }
    throw Error(usage);
  }
  if (command === 'post') {
    const usage = 'Usage: effort post <span> <text>', rest = plain(words, usage);
    if (rest.length < 2) throw Error(usage);
    output(`POSTED ${(await spans.post(rest[0], rest.slice(1).join(' '))).id}`); return;
  }
  if (command === 'reply') {
    const usage = 'Usage: effort reply <postId> <text>', rest = plain(words, usage);
    if (rest.length < 2) throw Error(usage);
    output(`REPLIED ${(await spans.reply(rest[0], rest.slice(1).join(' '))).id}`); return;
  }
  if (command === 'thread') {
    const usage = 'Usage: effort thread <postId>', rest = plain(words, usage);
    if (rest.length !== 1) throw Error(usage);
    printThread(await spans.thread(rest[0]), output); return;
  }
  if (command === 'explore') {
    const { flags, rest } = takeFlags(words, ['--dial', '--from']);
    if (rest.length < 2) throw Error('Usage: effort explore [--dial tight|normal|wild|sandbox] [--from <branchId>] <sourceId> <text>');
    const dial = DIALS[(flags.dial ?? 'normal').toLowerCase()];
    if (!dial) throw Error('Choose a dial: tight, normal, wild or sandbox.');
    const branch = await exploration.explore({ sourceId: rest[0], parentId: flags.from ?? null, dial, text: rest.slice(1).join(' ') });
    output(`EXPLORED ${branch.id} (a branch, not a commitment)`); return;
  }
  if (command === 'distill') {
    const usage = 'Usage: effort distill <branchId> <type> <text>  (type: insight, open-tension, ...)', rest = plain(words, usage);
    if (rest.length < 3) throw Error(usage);
    const type = rest[1].toUpperCase().replaceAll('-', ' ');
    const text = rest.slice(2).join(' ');
    output(`DISTILLED ${(await exploration.distill({ explorationId: rest[0], type, text })).id} (writing, not a commitment)`); return;
  }
  const usage = 'Usage: effort explorations <sourceId>', rest = plain(words, usage);
  if (rest.length !== 1) throw Error(usage);
  if (!await store.get(rest[0])) throw Error(`There is no saved thought with the ID ${rest[0]}.`);
  const state = await exploration.snapshot(), branches = state.explorations.filter(b => b.sourceId === rest[0]);
  for (const branch of branches) {
    output(`${branch.id}\t${branch.dial}\t${branch.parentId ?? '-'}\t${branch.text}`);
    for (const d of state.distillations.filter(item => item.explorationId === branch.id)) output(`  ${d.id}\t${d.type}\t${d.text}`);
  }
  for (const item of state.damaged) output(`Left out: ${item.id}. ${item.reason}`);
  if (!branches.length && !state.damaged.length) output('Nothing to show: this thought has no branches yet.');
}
