import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function rows(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function ordered(records) {
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id));
}

export function createFileStore(file) {
  async function write(kind, value) {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ kind, value })}\n`, 'utf8');
    return value;
  }
  return {
    append: (record) => write('capture', record),
    async get(id) { return (await rows(file)).filter((row) => row.kind === 'capture')
      .map((row) => row.value).find((record) => record.id === id) || null; },
    async list() { return ordered((await rows(file)).filter((row) => row.kind === 'capture')
      .map((row) => row.value)); },
    putDerived: (record) => write('derived', record),
    async export() { return JSON.stringify(await rows(file)); },
  };
}
