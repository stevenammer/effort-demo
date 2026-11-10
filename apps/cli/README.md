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
- `list` shows what you've saved, oldest first.
- `now` shows the one thing to do, with a reason. If nothing reads like a next step, it says so.
- `verify` re-hashes every saved capture. If anything changed on disk, it names the capture and exits with a nonzero code.
- `export` writes a deterministic `effort-export/1` bundle. It refuses to overwrite an existing path unless `--overwrite` is supplied.
- `verify-export` validates the complete bundle before printing a success line.
- `restore` validates every record and hash before it changes storage. A capture
  collision fails without adding records. A changed derived record stays in the
  destination and is reported. Matching records are a no-op.
- `recover-lock` only clears a lock held by a dead same-host process. `--force` is required when ownership is unknown.
  Locks record the machine boot time, so a reused PID after reboot is safely treated as dead. On Linux, they also record
  the process start tick from `/proc`; other platforms rely on the boot check. A lock is never cleared for age alone.

Your data goes in `EFFORT_HOME`, or in a local `.effort` folder if you don't set it. That folder is git-ignored.

MIT licensed.
