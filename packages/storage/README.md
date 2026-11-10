# @effort/storage

Where captures live. Both adapters speak the same small interface, so the core doesn't care which one you use.

| Method | What it does |
|---|---|
| `append(record)` | Adds a capture. Records are never edited in place. |
| `get(id)` | Returns the capture with that id, or `null`. |
| `list()` | Returns captures oldest first. |
| `putDerived(...)` and `snapshot()` | Store organized views separately; read one coherent snapshot including quarantine. |
| `exportBundle(hash)`, `verifyBundle(text, hash)`, `restoreBundle(text, hash)` | Use the common verified portable format, retaining raw quarantined records separately. |
| `export()` | Legacy adapter-specific output; use `exportBundle` for portable backups. |

## Adapters

- **`file.js`** (`createFileStore(path)`): an append-only JSONL file. Good for Node scripts and the command line tool.
- **`indexeddb.js`** (`createIndexedDbStore()`): the browser version. It's tested against `fake-indexeddb`, so it runs in Node tests too.

A shared test runs the same twelve fictional captures through both adapters and requires identical hashes, identical organization and the identical NOW choice. If you write your own adapter, make that test pass.

MIT licensed.

See [the portable format](../../docs/EFFORT_EXPORT.md) for the schema, limits and restore contract. Restore adds missing records, refuses conflicting original captures, and preserves existing derived views with an explicit report. Quarantine is retained separately and never becomes actionable content.
