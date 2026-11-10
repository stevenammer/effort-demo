# `effort-export/1`

`effort-export/1` is the portable format for the shared S1 store. It is one UTF-8 JSON
document with exactly three top-level properties: `manifest`, `manifestSha256`, and
`entries`.

`entries` is ordered and fixed: `captures.jsonl`, `derived.jsonl`, then
`quarantine.jsonl`. Each entry holds exact UTF-8 JSONL text. Records are canonical
JSON, ordered by `id` where they have IDs, and terminated by a newline when nonempty.
The manifest names the format and carries each fixed entry's path, record count,
UTF-8 byte length, and SHA-256. `manifestSha256` is SHA-256 of the canonical JSON
manifest. Capture records retain their original `text`, metadata, and content `hash`;
import checks that content hash too.

If a stored capture or derived record can't be validated, export preserves a canonical
`{kind, reason, raw}` entry in `quarantine.jsonl` and continues with the usable
records. `raw` is the stored record serialized as JSON, or `null` when it couldn't be
serialized. Restore retains those records in a separate quarantine collection. They never become captures or derived views. Repeated restore preserves their multiplicity without duplicating them, and the next backup retains them.

The machine-readable envelope schema is
[effort-export-1.schema.json](effort-export-1.schema.json). It checks the outer structure, not the JSONL strings or their hashes. Use `verifyExport` for the full semantic contract. The runtime rejects unknown
versions, unknown/extra entries, duplicate IDs, noncanonical or malformed JSONL, bad
checksums/counts, unsafe object keys, unsupported JSON values, and inputs over 16 MiB.
Fixed logical paths are never converted to filesystem paths.

Hashes catch accidental corruption and ordinary tampering. They do not authenticate a
malicious bundle whose author can recompute all hashes.

This format currently backs up the shared core's captures and derived records only. It
doesn't replace the browser demo's richer, backward-compatible workspace backup and it
isn't a native-phone backup. Later slices may extend the shared record set with a new
format version.

S5 changed nothing about the format. Posts and replies are captures whose `metadata` holds `span` and `parentId`, so they travel in `captures.jsonl` with their hashes. Attention Spans, branches, distillations and move revisions are derived records with IDs starting `span:`, `exploration:`, `distillation:` and `move:`, so they travel in `derived.jsonl`. A bundle made before this slice has none of them, still verifies and restores, and reads back with only the built-in spans. Because each item is its own derived record, restoring a backup into a store that already has other spans or branches adds the missing ones. A derived record with the same ID but different content still keeps the destination's and is reported as `keptExisting`.

Use it through the CLI:

```sh
node apps/cli/effort.mjs export effort-backup.json
node apps/cli/effort.mjs verify-export effort-backup.json
node apps/cli/effort.mjs restore effort-backup.json
```

Restore validates the entire bundle before its first write. Restore only ever adds. It
never replaces anything already in the store. Matching records are retained as a
no-op. A conflicting capture ID aborts the whole restore, while a conflicting derived
ID keeps the destination record and is reported as `keptExisting`. File storage uses a
cross-process directory lock for writers and atomic rename for restore publication.
IndexedDB inserts both stores in one transaction. A successful restore is read back
before it is reported.

File-lock owners record PID, hostname, token, creation time and, where available, the OS boot identity and process start tick. Linux boot IDs establish a previous boot even when a PID was reused. Wall-clock-derived boot timestamps are diagnostic only: clock adjustments never establish that a live owner is dead. Platforms or legacy locks without this evidence conservatively keep a live PID, even with force. A lock is never cleared for age alone. Captures wait up to 10 seconds by default (configurable with `createFileStore`'s
`lockWaitMs`) and then report that nothing was written, leaving the lock untouched.

Recovery takes a short-lived, owner-recorded sibling guard. It re-reads the lock token
inside that guard before removal, so it only removes the dead owner it inspected. A
stale guard follows the same liveness rules and is atomically renamed aside before
deletion, so it cannot permanently block the store. If ownership can't be determined,
inspect the named lock path and run `effort recover-lock --force` only when it is safe
to remove an unknown abandoned lock.

On a machine without a Linux boot ID, a lock whose process number has been reused can look alive, and
`recover-lock --force` refuses to remove it. In that case, close every program that uses the store, then delete the
`<store>.lock` folder by hand (for the default store, `captures.jsonl.lock`). The captures themselves live in the
store file, not in that folder.

Record ordering uses JavaScript UTF-16 code-unit order, independent of locale. Test-only Ajv validates the envelope with JSON Schema2020-12; core and storage retain zero runtime dependencies. IndexedDB adapter schema2 adds a separate quarantine store while preserving existing schema1 records.
