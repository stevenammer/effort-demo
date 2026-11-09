# effort (command line)

The smallest way to try the core. No dependencies. Needs Node 20 or newer.

```sh
node apps/cli/effort.mjs capture "Call the dentist about the invoice"
node apps/cli/effort.mjs list
node apps/cli/effort.mjs now
node apps/cli/effort.mjs verify
```

- `capture` saves the exact text, reads it back, and only then prints `SAVED`.
- `list` shows what you've saved, oldest first.
- `now` shows the one thing to do, with a reason. If nothing reads like a next step, it says so.
- `verify` re-hashes every saved capture. If anything changed on disk, it names the capture and exits with a nonzero code.

Your data goes in `EFFORT_HOME`, or in a local `.effort` folder if you don't set it. That folder is git-ignored.

MIT licensed.
