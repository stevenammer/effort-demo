import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname, uptime } from 'node:os';
import { dirname } from 'node:path';
import { canonical, createExport, quarantineToAppend, restoreExport, verifyExport } from '../core/export.js';
import { checkRecord } from '../core/records.js';
import { copySnapshot, ordered, validateCas } from './records.js';

const WAIT_MS = 25;
const READ_ATTEMPTS = 8;
const DEFAULT_LOCK_WAIT_MS = 10_000;

function pause() {
  return new Promise((resolve) => setTimeout(resolve, WAIT_MS));
}

async function rows(file, attempts = READ_ATTEMPTS) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const unfinished = !text.endsWith('\n');
    try { return lines.filter(Boolean).map((line) => JSON.parse(line)); } catch (error) {
      if (unfinished && attempt + 1 < attempts) {
        await pause();
        continue;
      }
      throw Error(`Storage JSONL is malformed: ${file}. ${error.message}`);
    }
    if (unfinished && attempt + 1 < attempts) await pause();
  }
  throw Error(`Storage JSONL write did not finish: ${file}`);
}

function snapshotRows(data) {
  const captures = [];
  const derived = new Map();
  const invalidDerived = [];
  const quarantine = [];
  for (const row of data) {
    if (row?.kind === 'capture') captures.push(row.value);
    else if (row?.kind === 'quarantine') quarantine.push(row.value);
    else if (row?.kind === 'derived' && row.value && typeof row.value === 'object' &&
      typeof row.value.id === 'string') derived.set(row.value.id, row.value);
    else invalidDerived.push(row?.value ?? row);
  }
  return { captures, derived: [...derived.values(), ...invalidDerived], quarantine };
}

function lockPath(file) {
  return `${file}.lock`;
}

function ownerPath(lock) {
  return `${lock}/owner.json`;
}

function recoveryPath(lock) {
  return `${lock}.recover`;
}

function bootStartedAt() {
  return Date.now() - (uptime() * 1_000);
}

async function bootIdentity() {
  try { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }
  catch { return null; }
}

async function processStartTicks(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    const fields = text.slice(close + 2).trim().split(/\s+/);
    const value = fields[19];
    return /^\d+$/.test(value) ? value : null;
  } catch { return null; }
}

async function newOwner() {
  return {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    bootStartedAt: bootStartedAt(),
    bootId: await bootIdentity(),
    processStartTicks: await processStartTicks(process.pid),
  };
}

async function readOwner(lock) {
  try {
    const owner = JSON.parse(await readFile(ownerPath(lock), 'utf8'));
    if (!owner || typeof owner !== 'object' || typeof owner.hostname !== 'string' ||
      !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' ||
      typeof owner.createdAt !== 'string') return null;
    return owner;
  } catch { return null; }
}

async function ownerAlive(owner) {
  if (owner.hostname !== hostname()) return null;
  const bootId = await bootIdentity();
  if (typeof owner.bootId === 'string' && bootId && owner.bootId !== bootId) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    if (typeof owner.processStartTicks === 'string') {
      const currentStart = await processStartTicks(owner.pid);
      if (currentStart !== null && currentStart !== owner.processStartTicks) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return null;
  }
}

async function removeDeadDirectory(path, force = false) {
  const owner = await readOwner(path);
  const alive = owner && await ownerAlive(owner);
  if (alive === true) return { removed: false, reason: 'live-owner' };
  if (alive !== false && !force) return { removed: false, reason: 'unknown-owner' };
  const token = owner?.token;
  if (token && (await readOwner(path))?.token !== token) return { removed: false, reason: 'owner-changed' };
  const retired = `${path}.retired-${randomUUID()}`;
  try {
    await rename(path, retired);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, reason: 'race' };
    throw error;
  }
  await rm(retired, { recursive: true, force: true });
  return { removed: true, reason: alive === false ? 'dead-owner' : 'forced-unknown-owner' };
}

async function acquireRecoveryGuard(lock, force, deadline) {
  const guard = recoveryPath(lock);
  const owner = await newOwner();
  let unknownAttempts = 0;
  for (;;) {
    try {
      await mkdir(guard);
      await writeFile(ownerPath(guard), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return async () => {
        if ((await readOwner(guard))?.token === owner.token) await rm(guard, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const cleared = await removeDeadDirectory(guard, force);
      if (cleared.removed || cleared.reason === 'race') continue;
      if (cleared.reason === 'unknown-owner' && unknownAttempts++ >= READ_ATTEMPTS) {
        throw Error(`Storage recovery guard ownership is unknown: ${guard}. Run effort recover-lock --force.`);
      }
      if (Date.now() >= deadline) throw Error(`Storage recovery guard is held: ${guard}`);
      await pause();
    }
  }
}

async function recoverLock(file, force = false, options = {}) {
  const lock = lockPath(file);
  const deadline = options.deadline ?? Date.now() + DEFAULT_LOCK_WAIT_MS;
  const releaseGuard = await acquireRecoveryGuard(lock, force, deadline);
  try {
    const owner = await readOwner(lock);
    const alive = owner && await ownerAlive(owner);
    if (alive === true) throw Error(`Storage lock is held by a live owner: ${lock}`);
    if (alive !== false && !force) throw Error(`Storage lock ownership is unknown: ${lock}. Run effort recover-lock --force.`);
    const token = owner?.token;
    await options.afterDeadOwnerRead?.({ lock, owner });
    // The guard prevents other recoverers from replacing this lock. Re-reading its token means we only remove the owner
    // we judged dead, while a normal writer cannot acquire this existing directory.
    if (token && (await readOwner(lock))?.token !== token) return { recovered: false, reason: 'owner-changed' };
    await rm(lock, { recursive: true, force: true });
    return { recovered: true, reason: alive === false ? 'dead-owner' : 'forced-unknown-owner' };
  } finally { await releaseGuard(); }
}

export async function recoverFileLock(file, { force = false } = {}) {
  return recoverLock(file, force);
}

// The caller holds the process lock. Stage the full append so a failed write
// cannot leave a partial continuity row blocking every subsequent capture.
async function appendAtomically(file, additions) {
  const original = await readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const mode = await stat(file).then(item => item.mode & 0o7777, error => error.code === 'ENOENT' ? 0o600 : Promise.reject(error));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const suffix = additions.map(row => JSON.stringify(row)).join('\n');
    await writeFile(temp, `${original}${original && !original.endsWith('\n') ? '\n' : ''}${suffix}\n`, { flag: 'wx', mode });
    await chmod(temp, mode);
    const handle = await open(temp, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export function createFileStore(file, { lockWaitMs = DEFAULT_LOCK_WAIT_MS, recoveryHooks = {} } = {}) {
  if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0) throw Error('lockWaitMs must be a non-negative finite number.');
  async function locked(work) {
    await mkdir(dirname(file), { recursive: true });
    const lock = lockPath(file);
    const owner = await newOwner();
    let unknownAttempts = 0;
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(ownerPath(lock), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lockOwner = await readOwner(lock);
        const alive = lockOwner && await ownerAlive(lockOwner);
        if (alive === false) {
          try {
            const result = await recoverLock(file, false, { deadline, ...recoveryHooks });
            if (!result.recovered) await pause();
          } catch (recoveryError) {
            if (!/held by a live owner|ownership is unknown/.test(recoveryError.message)) throw recoveryError;
            await pause();
          }
          continue;
        }
        if (alive === true) {
          if (Date.now() >= deadline) {
            throw Error(`Nothing was written: timed out waiting for ${lock}, owned by pid ${lockOwner.pid}.`);
          }
          await pause();
          continue;
        }
        if (unknownAttempts++ < READ_ATTEMPTS) {
          await pause();
          continue;
        }
        throw Error(`Storage lock ownership is unknown: ${lock}. Run effort recover-lock --force.`);
      }
    }
    try { return await work(); } finally {
      const current = await readOwner(lock);
      if (current?.token === owner.token) await rm(lock, { recursive: true, force: true });
    }
  }

  async function write(kind, value) {
    value = structuredClone(checkRecord(value));
    return locked(async () => {
      if (kind === 'capture' && (await rows(file)).some((row) => row.kind === kind && row.value.id === value.id)) {
        throw Error('Capture ID collision.');
      }
      await appendFile(file, `${JSON.stringify({ kind, value })}\n`, { encoding: 'utf8', mode: 0o600 });
      return value;
    });
  }

  return {
    append: (record) => write('capture', record),
    async get(id) {
      return (await rows(file)).filter((row) => row.kind === 'capture').map((row) => row.value)
        .find((record) => record.id === id) || null;
    },
    async list() {
      return ordered((await rows(file)).filter((row) => row.kind === 'capture').map((row) => row.value));
    },
    putDerived: (record) => write('derived', record),
    async compareAndSwapDerived(id, expected, replacement) {
      [expected, replacement] = validateCas(id, expected, replacement);
      return locked(async () => {
        const current = snapshotRows(await rows(file)).derived.find((record) => record?.id === id) ?? null;
        if (canonical(current) !== canonical(expected)) return false;
        await appendAtomically(file, [{ kind: 'derived', value: replacement }]);
        return true;
      });
    },
    async export() { return JSON.stringify(await rows(file)); },
    exportBundle(hash) { return createExport(this, hash); },
    verifyBundle(input, hash) { return verifyExport(input, hash); },
    restoreBundle(input, hash) { return restoreExport(this, input, hash); },
    snapshot: () => locked(async () => snapshotRows(await rows(file))),
    async importSnapshot(incoming, { sourceQuarantine = [] } = {}) {
      incoming = copySnapshot(incoming);
      sourceQuarantine = structuredClone(sourceQuarantine);
      return locked(async () => {
      const data = await rows(file);
      const current = snapshotRows(data);
      const additions = [];
      const keptExisting = [];
      const validCaptures = current.captures.filter((record) => record && typeof record.id === 'string');
      const validDerived = current.derived.filter((record) => record && typeof record.id === 'string');
      const captureMap = new Map(validCaptures.map((record) => [record.id, canonical(record)]));
      for (const record of incoming.captures) {
        if (captureMap.has(record.id) && captureMap.get(record.id) !== canonical(record)) throw Error('Capture ID collision.');
        if (!captureMap.has(record.id)) additions.push({ kind: 'capture', value: record });
      }
      const derivedMap = new Map(validDerived.map((record) => [record.id, canonical(record)]));
      for (const record of incoming.derived) {
        if (derivedMap.has(record.id)) {
          if (derivedMap.get(record.id) !== canonical(record)) keptExisting.push(record.id);
        } else additions.push({ kind: 'derived', value: record });
      }
      for (const record of quarantineToAppend(current, incoming.quarantine ?? [], sourceQuarantine)) {
        additions.push({ kind: 'quarantine', value: record });
      }
      if (!additions.length) return { keptExisting };
      await appendAtomically(file, additions);
      return { keptExisting };
      });
    },
  };
}
