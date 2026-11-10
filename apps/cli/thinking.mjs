import { randomUUID } from 'node:crypto';
import { createSpans } from '../../packages/core/spans.js';
import { createMoves } from '../../packages/core/moves.js';
import { createExploration } from '../../packages/core/exploration.js';

const DIALS = { tight: 'TIGHT', normal: 'NORMAL', wild: 'WILD', sandbox: 'UNHINGED SANDBOX' };
const WARNING = 'WARNING: this text no longer matches what was saved';
const COMMANDS = ['span', 'post', 'reply', 'thread', 'explore', 'distill', 'explorations'];

export const isThinkingCommand = command => COMMANDS.includes(command);

function printThread(node, output, depth = 0) {
  output(`${'  '.repeat(depth)}${node.id}\t${node.verified ? '' : `[${WARNING}] `}${node.text}`);
  for (const reply of node.replies) printThread(reply, output, depth + 1);
}

/** Takes `--flag value` pairs off the front of the words. */
function takeFlags(words, allowed) {
  const flags = {}; let rest = words;
  while (rest[0]?.startsWith('--')) {
    if (!allowed.includes(rest[0]) || rest.length < 2) throw Error(`Unknown or incomplete option ${rest[0]}.`);
    flags[rest[0].slice(2)] = rest[1]; rest = rest.slice(2);
  }
  return { flags, rest };
}

export async function runThinkingCommand(command, words, { store, hash, output }) {
  const now = () => new Date().toISOString();
  const spans = createSpans({ store, hash, now, id: randomUUID });
  const moves = createMoves({ store, hash, now, id: randomUUID });
  const exploration = createExploration({ store, hash, now, id: randomUUID, spans, moves });
  if (command === 'span') {
    if (words[0] === 'create' && words.length >= 2) { output(`SPAN ${(await spans.createSpan(words.slice(1).join(' '))).name}`); return; }
    if (words[0] === 'list' && words.length === 1) {
      for (const span of (await spans.listSpans()).spans) output(`${span.name}\t${span.kind}`);
      return;
    }
    throw Error('Usage: effort span create <name> | effort span list');
  }
  if (command === 'post') {
    if (words.length < 2) throw Error('Usage: effort post <span> <text>');
    output(`POSTED ${(await spans.post(words[0], words.slice(1).join(' '))).id}`); return;
  }
  if (command === 'reply') {
    if (words.length < 2) throw Error('Usage: effort reply <postId> <text>');
    output(`REPLIED ${(await spans.reply(words[0], words.slice(1).join(' '))).id}`); return;
  }
  if (command === 'thread') {
    if (words.length !== 1) throw Error('Usage: effort thread <postId>');
    printThread(await spans.thread(words[0]), output); return;
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
    if (words.length < 3) throw Error('Usage: effort distill <branchId> <type> <text>  (type: insight, open-tension, ...)');
    const type = words[1].toUpperCase().replaceAll('-', ' ');
    const text = words.slice(2).join(' ');
    output(`DISTILLED ${(await exploration.distill({ explorationId: words[0], type, text })).id} (writing, not a commitment)`); return;
  }
  if (words.length !== 1) throw Error('Usage: effort explorations <sourceId>');
  const state = await exploration.snapshot();
  for (const branch of state.explorations.filter(b => b.sourceId === words[0])) {
    output(`${branch.id}\t${branch.dial}\t${branch.parentId ?? '-'}\t${branch.text}`);
    for (const d of state.distillations.filter(item => item.explorationId === branch.id)) output(`  ${d.id}\t${d.type}\t${d.text}`);
  }
  for (const item of state.damaged) output(`Left out: ${item.id}. ${item.reason}`);
}
