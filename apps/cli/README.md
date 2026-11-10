# effort (command line)

The smallest way to try the core. No dependencies. Needs Node 20 or newer.

```sh
node apps/cli/effort.mjs capture "Call the dentist about the invoice"
node apps/cli/effort.mjs list
node apps/cli/effort.mjs now
node apps/cli/effort.mjs verify
node apps/cli/effort.mjs export effort-backup.json
node apps/cli/effort.mjs verify-export effort-backup.json
node apps/cli/effort.mjs restore effort-backup.json
node apps/cli/effort.mjs recover-lock --force
```

- `capture` saves the exact text, reads it back, and only then prints `SAVED`.
- `list` shows what you've saved, oldest first. If a saved text no longer matches the check I recorded when I saved it, `list` still shows it, marks it with a warning, and tells you how many items failed.
- `suggest` offers a ranking of captures. A suggestion is not a commitment. It leaves out any item that fails its check and says so.
- `promote <captureId> <start> <end>` explicitly commits the exact UTF-16 slice of a verified capture. `commitments` lists its history's current states.
- `activate <id>` deliberately selects the single active commitment shown by `now`.
- `complete <id> <note>` records the exact note as a self-report; `drop <id> <reason>` keeps the reason.
- `hold <summary>` saves a return point; `resume <packetId>` deliberately returns to its open commitment.
- The core API requires caller intent `authority: 'human'`, which is not identity authentication. Reuse a command ID when retrying an uncertain write.
- Continuity retains its history up to 10,000 commands, 2,000 commitments, 2,000 return points, and 4 MiB encoded state. It refuses further changes when a limit is reached, without removing history.
- `span create <name>` and `span list` manage Attention Spans. Names are 2 to 40 characters and the built-in spans are always listed.
- `post <span> <text>` saves a post in an existing span and prints its ID. `reply <postId> <text>` replies in the same span.
- `thread <postId>` prints the whole thread, nested by indent. A post whose words no longer match its hash is shown with a warning, not hidden.
- `explore [--dial tight|normal|wild|sandbox] [--from <branchId>] <sourceId> <text>` saves a branch off a thought, or off another branch with `--from`. The dial defaults to `normal`.
- `distill <branchId> <type> <text>` saves your own distillation of a branch. Types are written in lowercase with dashes, such as `insight`, `open-tension` or `weird-but-alive`.
- `explorations <sourceId>` lists a thought's branches with their distillations.
- None of these commands creates or changes a commitment, and `now` doesn't change. Editing moves and turning a distillation into a proposal are in the core library but have no command yet.
- `verify` re-hashes every saved capture. If anything changed on disk, it names the capture and exits with a nonzero code.
- `export` writes a deterministic `effort-export/1` bundle. It refuses to overwrite an existing path unless `--overwrite` is supplied.
- `verify-export` validates the complete bundle before printing a success line.
- `restore` validates every record and hash before it changes storage. A capture
  collision fails without adding records. A changed derived record stays in the
  destination and is reported. Matching records are a no-op.
- `recover-lock` clears a lock only when its owner is gone. Without `--force` it clears a lock held by a dead process on this computer. With `--force` it also clears a lock whose owner I can't work out (the owner file is missing or unreadable, or the lock came from another computer). It never clears a lock whose owner is still running on this computer. If there's no lock at all, it says so and changes nothing.
  When available, the OS boot ID and process start ticks help detect a reused PID. Wall-clock boot time is diagnostic only; elsewhere a live PID is treated conservatively. A lock is never cleared for age alone.

If `recover-lock --force` refuses because a lock's process number has been reused, and your machine has no Linux boot ID to prove the old process is gone, I can't tell the old owner from the new one. Close every program that uses the store, then delete the `<store>.lock` folder by hand. For the default store that's `captures.jsonl.lock` next to `captures.jsonl`. Your captures aren't in that folder.

Your data goes in `EFFORT_HOME`, or in a local `.effort` folder if you don't set it. That folder is git-ignored.

MIT licensed.
