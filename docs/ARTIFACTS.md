# Connected files and artifacts

A thought can depend on a document, a draft, a small dataset or another piece of source material. Keeping that file elsewhere breaks the return path. This slice attaches exact files to saved thoughts and replies, makes them reachable through Attention Spans, and leaves the person's chosen NOW alone.

**Attach a file…** opens a file picker for a saved source. **Save file with source** reads and verifies the bytes, then saves an immutable record with its source ID, filename, MIME label, byte count, content checksum and metadata checksum. A failed save keeps the selection available for a deliberate retry. The browser can't retain an unconfirmed file-picker selection across a reload; the interface says to reselect the original file. An update pauses until a pending selection is saved or explicitly cleared.

Text/plain files have a passive UTF-8 preview, capped at 4,000 characters and marked when truncated. The preview uses literal text, not HTML. Other types remain exact downloads. Downloading uses an octet-stream blob; attachments never run as app code or automatically load remote content. Previewing doesn't rewrite the saved bytes.

## Connected, not copied into another obligation

Each file has a stable `#artifact/<id>` permalink. A source thread shows its files, and Workspace has a folded connected-file directory. A file whose source needs recovery stays downloadable there, with its source status stated honestly. Recovered source links and file bytes are distinct claims.

**Use in another thought** exposes a Markdown reference such as `[Connected file](#artifact/<id>)`. Local thought and file references are rendered as same-workspace links. They work across Attention Spans without duplicating the file or changing its original source. Only strict UUID routes are accepted; malformed local routes remain literal text. External HTTP(S) links retain their separate navigation behavior.

Selecting a file, saving it, following a link, downloading or restoring it never creates a commitment. Work still requires the separate explicit quote-selection flow.

## Persistence, failure and recovery

IndexedDB schema 6 adds the artifacts table without rewriting previous originals. Browser backup 8 includes files, provenance, drafts, exploration and commitment history, and accepts versions 1 through 7. Restoring an older backup keeps files already in the current workspace. Conflicting file bytes or source metadata are refused atomically. When independent backups contain the same exact file under the same ID but different attachment timestamps, the existing immutable record is reused. Distinct existing permalinks remain valid, and retrying does not add another file. File restores get an exact post-commit readback before the app reports success.

Same-file retries and concurrent tabs reuse the saved record, including after restoration into a new workspace epoch. Source changes and workspace resets fence old asynchronous writes. The bytes are copied before awaiting anything, so a caller can't alter an upload in flight.

Files are limited to 2 MiB each, 500 records, and 8 MiB of combined encoded JSON. The whole browser backup has its existing 32 MB limit. Limits refuse new data without erasing older records.

Damaged file metadata or bytes are preserved as raw quarantine records, never presented as verified downloads. Large recovery entries have a bounded visible preview and an exact raw-record download. Their complete raw data stays in the backup. If file storage itself becomes unreadable, capture and NOW remain usable with an explicit file warning. A complete backup is refused while files are unavailable, rather than silently leaving them out. The final file snapshot is validated again before returning verified files to a reader.

The app doesn't upload selected files. User-entered data stays within that browser profile. The static offline cache contains public application files, not user attachments. Browser storage can still be erased; a downloaded backup remains necessary.

## Acceptance

The module and integration suites check exact binary and zero bytes, full 2 MiB files, aggregate limits, immutable metadata, source links, transaction failures, readback retry, concurrent requests, restore across epochs, old backup migration, damaged records, source/reset races and incomplete-backup refusal.

The browser suite exercises actual file inputs and byte-for-byte downloads, passive previews, local cross-links, file permalinks, unchanged NOW, multiple tabs, backup/reset/restore, missing sources, large raw recovery downloads, unreadable file storage, reset during hashing, offline reload/download and 1440/390/320px layouts. A separate upgrade suite starts with the actual prior published client, updates DB5 to DB6, and checks that two tabs retain their drafts, including new typing in a stale tab recovered after reload. The offline/update suite checks that a pending file selection pauses an update without erasing it.

These are browser workspace features. The private Android app, native backups, private services and provider execution aren't connected.
