# Opening context

Attention Spans show which exact posts and replies haven't been opened in this browser workspace. Counts live in the directory and chronological feed. They don't add a backlog to Home or change NOW.

Opening a thread records only the original and replies displayed for that opening. The record means opened, not read, understood, agreed with or completed. A reply arriving while the thread is already open keeps its own label until the person explicitly marks displayed writing opened or opens the thread again. Opening a source-only dialog or browsing the directory doesn't acknowledge a whole conversation.

Receipts refer to exact capture IDs and text hashes. There is no last-read timestamp cutoff, so a late or backdated reply stays separate. The time in a receipt describes the opening; it never decides which other writing was seen. Branches, files and distillations retain their existing separate histories; these counts cover source posts and replies only.

Each source has one portable, sealed opening receipt. Concurrent tabs reuse the canonical row. An accepted write with failed readback offers an explicit verification retry. Changed sources and workspace resets fence stale operations. Reading a thread doesn't alter originals, choices or commitments.

IndexedDB schema 8 adds `openedReceipts`. Backup10 accepts backups1 through9 and carries the receipts. Restoring an older backup doesn't erase existing opening history or acknowledge writing it didn't contain. Independently recorded opening times for the same exact source merge without replacing an existing receipt. Conflicting records refuse atomically; restoration reads back its opening receipts before reporting success.

Damaged receipts retain raw recovery copies. Their affected sources show unknown status rather than a verified opening until the person opens the exact source again or restores a valid receipt. If the optional opening store is unavailable, primary writing and NOW remain usable, status is visibly unavailable and a complete backup refuses to omit the unknown history.

The opening store has a 10,000-record / 2 MiB encoded JSON limit. The workspace's existing 1,000-original and portable-backup limits also apply. These bounds aren't a completed long-term scale/cache policy.

Acceptance uses synthetic data and isolated browser contexts. Run `npm test`, then `PLAYWRIGHT_DIR=/path/to/playwright node scripts/opened-browser-check.mjs`. `DEMO_BASE_URL` runs the same browser flow against the hosted app. See CURRENT_STATE.md for executed evidence and release status.
