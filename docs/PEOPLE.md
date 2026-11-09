# People context

People is an Attention Span, not another Home dashboard. Its fields follow the actual app: name, relationship, notes, important dates, things they told me, things I told them and an optional 1–365-day cadence. Only the name is required. Names are trimmed once; authored multiline context retains its exact stored string. Editing appends a sealed revision and leaves earlier context accessible and downloadable.

Source links are manually chosen saved post/reply IDs and text hashes. Names never pull in another thought automatically. Duplicate source titles remain distinct. A damaged or missing source stays visible as recovery context without erasing the person or preventing unrelated context edits. Person permalinks open the People Attention Span at the exact stable ID.

Logging a conversation creates a separate, self-reported contact receipt. Editing notes or links never fabricates one. No message is sent, no notification or task is scheduled, and NOW isn't changed. A repeated submission reuses its request receipt; a separate intentional log gets another identity. Contact drafts retain their request ID and UTC offset through reload and backup recovery.

The contact form uses the browser timezone and exposes the offset. Nonexistent DST times are rejected; repeated local times offer the two offsets. A saved offset that no longer fits the browser timezone requires review rather than silently changing the intended instant. Impossible calendar timestamps are rejected throughout the browser store. Important-date notes remain plain authored text, without hidden timestamps or automatic reminders.

Cadence is optional and stays inside People. It uses the latest self-reported contact, or person creation if none exists, measured in elapsed 24-hour days. It never produces an overdue count or an obligation. Future clock anomalies and unresolved damaged contact receipts suppress cadence. Raw damaged receipts remain in Engine Room; restoring a valid receipt resolves its uncertainty. Logging a different contact doesn't pretend that missing history has been recovered.

Schema9 adds `personEvents` and `contactReceipts`; backup11 accepts backups1 through10. Both histories, exact selected source references, drafts and raw recovery travel in complete workspace backups. Restoring an older backup doesn't erase current People history. Conflicting revision chains refuse atomically. Readback failure leaves accepted data intact and supports retry. An unavailable optional People store leaves ordinary capture and NOW usable but prevents a backup from silently omitting unknown history.

Drafts exist for new and existing context and self-reported contacts. Changed-tab revisions require an explicit current-base choice while retaining the writer's wording and chosen links. Failed draft cleanup is retried only for the exact saved body; newer writing and workspace reset fences stay protected. A missing person permalink can reopen its editing-draft context. Previous revisions and source originals remain distinct from new corrections.

Bounds: 100 live person identities, 2,000 profile revisions, 2,000 contact receipts, 50 links per revision and 4 MiB encoded People history, in addition to the workspace's portable-backup budget. These are failure boundaries, not a completed scale/performance audit. Public fixtures are fictional. No private phone, account, family ledger or provider receives this data.

Run `npm test`, `npm run check:syntax`, then `PLAYWRIGHT_DIR=/path/to/playwright node scripts/people-browser-check.mjs`. The browser suite accepts `DEMO_BASE_URL` for hosted checks and `PEOPLE_WIDTHS` for a scoped diagnostic run. See CURRENT_STATE.md and RED_TEAM.md for executed evidence and remaining work.
