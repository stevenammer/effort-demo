import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { MAX_EXPORT_BYTES } from '../../packages/core/export.js';
import { createCapture, verifySaved } from '../../packages/core/capture.js';
import { chooseNow } from '../../packages/core/now.js';
import { createContinuity } from '../../packages/core/continuity.js';
import { createFileStore, recoverFileLock } from '../../packages/storage/file.js';
import { runHelperCommand } from './helpers.mjs';
import { isThinkingCommand, runThinkingCommand } from './thinking.mjs';

const hash = async (text) => createHash('sha256').update(text).digest('hex');

async function statIfPresent(path) {
  try { return await stat(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function resolvedName(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await resolvedName(parent), basename(path));
  }
}
async function refuseStoreAlias(target, storePath) {
  // Resolve even nonexistent filenames through their parent directories.
  const [targetName, storeName, targetStat, storeStat] = await Promise.all([
    resolvedName(target), resolvedName(storePath), statIfPresent(target), statIfPresent(storePath),
  ]);
  if (targetName === storeName || (targetStat && storeStat &&
      targetStat.dev === storeStat.dev && targetStat.ino === storeStat.ino)) {
    throw Error('Export path refers to the capture store.');
  }
}
async function readBundle(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error('Export input must be a regular file.');
    if (info.size > MAX_EXPORT_BYTES) throw Error('Export input exceeds size limit.');
    // Read at most the limit plus one byte, including if the file grows during reading.
    const buffer = Buffer.allocUnsafe(MAX_EXPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_EXPORT_BYTES) throw Error('Export input exceeds size limit.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw Error('Export input is not valid UTF-8.'); }
  } finally { await handle.close(); }
}
async function publishBundle(target, storePath, bundle, overwrite) {
  await refuseStoreAlias(target, storePath);
  let existing;
  try { existing = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !overwrite) throw Error('Export file already exists. Use --overwrite to replace it.');
  if (existing && !existing.isFile()) throw Error('Export target must be a regular file.');
  // Preserve the target's permission bits for regular files, without exposing a new backup.
  const mode = existing?.isFile() ? existing.mode & 0o7777 : 0o600;
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bundle, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await refuseStoreAlias(target, storePath);
    if (overwrite) await rename(temporary, target);
    else await link(temporary, target); // Atomic create; never replaces a concurrently created path.
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

const DAMAGED_NOTE = 'WARNING: this text no longer matches what was saved';

async function matchesSavedHash(record) {
  return typeof record?.text === 'string' && await hash(record.text) === record.hash;
}

/** Split saved items into those whose text still matches its recorded hash and those that do not. */
async function checkOriginals(records) {
  const intact = [], damaged = [];
  for (const record of records) (await matchesSavedHash(record) ? intact : damaged).push(record);
  return { intact, damaged };
}

function damagedLines(damaged, total) {
  if (!damaged.length) return [];
  return [`${damaged.length} of ${total} saved items failed their check. Run effort verify for the list.`];
}

async function lockIsPresent(storePath) {
  return Boolean(await statIfPresent(`${storePath}.lock`));
}

export async function runCli(args, { home, output = console.log } = {}) {
  const [command, ...words] = args;
  const directory = home || join(process.cwd(), '.effort');
  const storePath = join(directory, 'captures.jsonl');
  const store = createFileStore(storePath);
  if (command === 'recover-lock') {
    if (words.length > 1 || (words.length === 1 && words[0] !== '--force')) {
      throw Error('Usage: effort recover-lock [--force]');
    }
    if (!await lockIsPresent(storePath)) {
      output('There is no lock to recover. Nothing was changed.');
      return;
    }
    const result = await recoverFileLock(storePath, { force: words[0] === '--force' });
    output(`RECOVERED LOCK ${result.reason}`);
    return;
  }
  if (command === 'capture') {
    const text = words.join(' ');
    if (!text) throw Error('Capture text is required.');
    const record = await createCapture(
      { id: randomUUID(), text, createdAt: new Date().toISOString() },
      hash,
    );
    await store.append(record);
    if (!await verifySaved(store, record.id, hash)) {
      throw Error('Saved record could not be verified.');
    }
    output(`SAVED ${record.id}`);
    return;
  }
  if (command === 'list') {
    const records = await store.list();
    const { damaged } = await checkOriginals(records);
    for (const record of records) output(`${record.id}\t${damaged.includes(record) ? `[${DAMAGED_NOTE}] ` : ''}${record.text}`);
    for (const line of damagedLines(damaged, records.length)) output(line);
    return;
  }
  if (command === 'helper') return runHelperCommand(words, { store, hash, home: directory, output });
  if (isThinkingCommand(command)) return runThinkingCommand(command, words, { store, hash, output });
  const continuity = createContinuity({ store, hash, now: () => new Date().toISOString(), id: randomUUID });
  const authority = () => ({ authority: 'human', commandId: randomUUID() });
  if (command === 'now') {
    if (words.length) throw Error('Usage: effort now');
    const state = await continuity.snapshot();
    const active = state.commitments.find(c => c.state === 'ACTIVE');
    output(active ? `${active.id}\t${active.source.quote}` : 'No active commitment.');
    return;
  }
  if (command === 'suggest') {
    if (words.length) throw Error('Usage: effort suggest');
    const records = await store.list();
    const { intact, damaged } = await checkOriginals(records);
    const selection = chooseNow(intact);
    output(selection.item ? `SUGGESTION (not a commitment)\n${selection.item.quote}\n${selection.reason}` : 'No suggestion.');
    for (const record of damaged) output(`Left out: ${record.id}. ${DAMAGED_NOTE}, so I won't suggest from it.`);
    for (const line of damagedLines(damaged, records.length)) output(line);
    return;
  }
  if (command === 'commitments') {
    if (words.length) throw Error('Usage: effort commitments');
    for (const c of (await continuity.snapshot()).commitments) output(`${c.id}\t${c.state}\t${c.source.quote}`);
    return;
  }
  if (command === 'promote') {
    if (words.length !== 3 || !/^\d+$/.test(words[1]) || !/^\d+$/.test(words[2])) throw Error('Usage: effort promote <captureId> <start> <end>');
    output(`COMMITTED ${await continuity.promote(words[0], Number(words[1]), Number(words[2]), authority())}`); return;
  }
  if (command === 'activate' || command === 'resume') {
    if (words.length !== 1) throw Error(`Usage: effort ${command} <id>`);
    output(`${command.toUpperCase()} ${await continuity[command](words[0], authority())}`); return;
  }
  if (command === 'complete' || command === 'drop') {
    if (words.length < 2) throw Error(`Usage: effort ${command} <id> <${command === 'complete' ? 'note' : 'reason'}>`);
    output(`${command === 'complete' ? 'COMPLETE (self-reported)' : 'DROPPED'} ${await continuity[command](words[0], words.slice(1).join(' '), authority())}`); return;
  }
  if (command === 'hold') {
    if (!words.length) throw Error('Usage: effort hold <summary>');
    output(`HELD ${await continuity.hold({ summary: words.join(' ') }, authority())}`); return;
  }
  if (command === 'verify') {
    const records = await store.list();
    const failed = [];
    for (const record of records) {
      if (!await verifySaved(store, record.id, hash)) failed.push(record.id);
    }
    if (failed.length) throw Error(`Verification failed for ${failed.join(', ')}.`);
    output(`VERIFIED ${records.length}`);
    return;
  }
  if (command === 'export') {
    const overwrite = words[0] === '--overwrite';
    const path = words[overwrite ? 1 : 0];
    if (!path || words.length !== (overwrite ? 2 : 1)) throw Error('Usage: effort export [--overwrite] <path>');
    const target = resolve(path);
    // Check before snapshotting too: an export must never replace the store itself.
    await refuseStoreAlias(target, storePath);
    const bundle = await store.exportBundle(hash);
    await publishBundle(target, storePath, bundle, overwrite);
    // Verify the published bytes, never just the in-memory serialization.
    await store.verifyBundle(await readBundle(target), hash);
    output(`EXPORTED ${target}`);
    return;
  }
  if (command === 'verify-export') {
    if (words.length !== 1) throw Error('Usage: effort verify-export <path>');
    const verified = await store.verifyBundle(await readBundle(resolve(words[0])), hash);
    output(`VERIFIED EXPORT ${verified.captures.length} captures, ${verified.derived.length} derived, ` +
      `${verified.quarantine.length} quarantined`);
    return;
  }
  if (command === 'restore') {
    if (words.length !== 1) throw Error('Usage: effort restore <path>');
    const restored = await store.restoreBundle(await readBundle(resolve(words[0])), hash);
    output(`RESTORED ${restored.captures.length} captures, ${restored.derived.length} derived, ` +
      `${restored.quarantine.length} quarantined, ${restored.keptExisting.length} kept existing`);
    return;
  }
  throw Error('Usage: effort capture "text" | list | suggest | now | promote <captureId> <start> <end> | commitments | ' +
    'activate <id> | complete <id> <note> | drop <id> <reason> | hold <summary> | resume <packetId> | ' +
    'span create <name> | span set-aside <name> | span list | post <span> <text> | reply <postId> <text> | thread <postId> | ' +
    'explore [--dial d] [--from <branchId>] <sourceId> <text> | distill <branchId> <type> <text> | explorations <sourceId> | ' +
    'verify | export [--overwrite] <path> | ' +
    'verify-export <path> | restore <path> | recover-lock [--force]');
}
