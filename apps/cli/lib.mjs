import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createCapture, verifySaved } from '../../packages/core/capture.js';
import { chooseNow } from '../../packages/core/now.js';
import { createFileStore } from '../../packages/storage/file.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');

export async function runCli(args, { home, output = console.log } = {}) {
  const [command, ...words] = args;
  const directory = home || join(process.cwd(), '.effort');
  const store = createFileStore(join(directory, 'captures.jsonl'));
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
    for (const record of await store.list()) output(`${record.id}\t${record.text}`);
    return;
  }
  if (command === 'now') {
    const selection = chooseNow(await store.list());
    output(selection.item ? `${selection.item.quote}\n${selection.reason}` : 'Nothing is ready now.');
    return;
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
  throw Error('Usage: effort capture "text" | list | now | verify');
}
