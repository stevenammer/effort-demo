# @effort/storage

Where captures live. The three adapters speak the same small interface, so the core doesn't care which one you use. Every method returns a promise. Records are JSON data; write methods copy inputs before waiting, and reads return detached records.

| Method | What it does |
|---|---|
| `append(record)` | Adds a capture. Records are never edited in place. |
| `get(id)` | Returns the capture with that id, or `null`. |
| `list()` | Returns captures by `createdAt`, then `id`, using UTF-16 code-unit comparison independent of locale. |
| `putDerived(...)` and `snapshot()` | Store organized views separately; read one coherent snapshot including quarantine. |
| `exportBundle(hash)`, `verifyBundle(text, hash)`, `restoreBundle(text, hash)` | Use the common verified portable format, retaining raw quarantined records separately. |
| `export()` | Legacy adapter-specific output; use `exportBundle` for portable backups. |
| `importSnapshot(snapshot, options)` | Internal add-only restore primitive, atomic across captures, derived views and quarantine. Repeated capture or derived IDs in a batch reject before any writes. Prefer verified `restoreBundle` for outside input. |

## Adapters

- **`file.js`** (`createFileStore(path)`): an append-only JSONL file. Good for Node scripts and the command line tool.
- **`indexeddb.js`** (`createIndexedDbStore()`): the browser version. It's tested against `fake-indexeddb`, so it runs in Node tests too.
- **`sqlite.js`** (`await createSqliteStore(filename)`): persistent SQLite for Node. `filename` defaults to `:memory:`. Exported as `@effort/storage/sqlite`.

The reusable [adapter conformance suite](../../test/support/adapter-conformance.mjs) runs the same capture, mutation-isolation, duplicate, ordering, derived-view, restore, rollback and quarantine checks against every adapter. The [registration tests](../../test/storage-conformance.test.mjs) include transfers between all adapter pairs. The original S1 fixture also checks matching organization and NOW behavior for file and IndexedDB.

## SQLite support and ownership

```js
import { createSqliteStore } from '@effort/storage/sqlite';

const store = await createSqliteStore('./captures.sqlite');
try {
  // Use the same append/get/list/exportBundle/restoreBundle methods.
  console.log(await store.list());
} finally {
  await store.close();
}
```

The default driver dynamically imports Node's built-in `node:sqlite` and is tested on Node 22.23.4. That driver is experimental in this runtime and may print Node's experimental warning. Node 20 can import the adapter module, but creating the default driver rejects with instructions to use the file adapter or inject a compatible synchronous connection:

```js
const store = await createSqliteStore(':memory:', { database: yourConnection });
```

The injected connection supplies synchronous `exec(sql)`, `prepare(sql)` and `close()` methods. Prepared statements supply synchronous `get(...parameters)`, `all(...parameters)` and `run(...parameters)`. No external SQLite driver is bundled, installed or verified by this project. Injection works without importing `node:sqlite`; compatibility with a particular caller-supplied driver is the caller's responsibility.

Give the store exclusive use of that connection, with no transaction already open. `close()` closes injected connections too and can be called twice. Storage operations reject after close. Other connections may use the same database file under normal SQLite locking. All adapter transactions finish synchronously, without waiting for hashing or other promises; reads take one coherent snapshot, writes and restores commit or roll back together. Built-in connections use a bounded 1000 ms busy timeout; injected connections keep the caller's timeout settings. SQL errors include the operation and retain the underlying error as `cause`.

Default filenames must be non-empty path strings (or `:memory:`). New on-disk databases are exclusively created with mode `0600` before opening. Existing files keep their caller-chosen permissions. Containing directories, existing file permissions and injected database paths are the caller's responsibility. Parent directories must already exist. Existing databases aren't replaced, and the adapter creates only its three `effort_` tables. IDs are JSON-encoded SQL keys, preserving distinct JavaScript strings including lone surrogates and embedded NULs. This slice doesn't add encryption, a CLI storage switch, browser SQLite, phone integration or a migration of the existing browser demo. The core remains free of runtime dependencies; Node 20 file and IndexedDB support continues.

MIT licensed.

See [the portable format](../../docs/EFFORT_EXPORT.md) for the schema, limits and restore contract. Restore adds missing records, refuses conflicting original captures, and preserves existing derived views with an explicit report. Quarantine is retained separately and never becomes actionable content.

`compareAndSwapDerived(id, expectedRecordOrNull, replacementRecord)` atomically
compares the canonical current derived record with the expected value and writes
the replacement only on a match. It returns a boolean; both records must carry
the requested ID. The file adapter compares under its process lock, IndexedDB in
a readwrite transaction, and SQLite inside `BEGIN IMMEDIATE`. Callers should
read back and verify their own writes, and retain an idempotency key for retries.
