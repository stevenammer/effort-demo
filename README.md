# EFFORT, a public walkthrough

**Capture a thought. Keep the original. Choose one next step.**

[Open the interactive walkthrough](https://stevenammer.github.io/effort-demo/).

This is an interactive browser demonstration of E.F.F.O.R.T. (Executive Function For Organizing Random Thoughts), Steven Ammer's existing personal Android app. Attention Spans are named places with chronological posts and nested replies. It uses a small extract of the app's actual deterministic organisation code and fabricated examples.

The walkthrough is separate from the private app and its data. It isn't a replacement phone app, a connected agent service, or an export of someone's personal workspace.

![EFFORT browser walkthrough, using fictional sample data](docs/screens/home-desktop.png)

## Try it locally

Needs Node 20.20 or newer. There are no runtime package dependencies. Tests use fake-indexeddb to exercise real transaction boundaries without a browser.

```sh
npm ci
npm test
npm run dev
```

Open `http://127.0.0.1:4174/public/`. A static host can serve the same files; the root index links to the walkthrough. No API key, account or private backend is needed.

## The loop to try

1. Open a fictional example and switch between its organised view and original wording.
2. Capture a fictional thought. Close and reopen the dialog, or reload, to check its draft.
3. Save it. The browser reads back the exact text and verifies its SHA-256 before reporting success. The existing NOW choice stays put.
4. Deliberately choose one exact quote as the next step. Marking it done preserves the original capture.
5. Open Attention Spans, create a named destination, and post in it. Open the thread, reply, then reply to that reply. Reload or follow a permalink to check the context.
6. Keep your place with a short summary and return note. Deliberately choose another step, then resume the held one. The earlier commitment and original both stay saved.
7. Mark a step done and open Proof. The receipt records your own action and is labeled self-reported. Workspace holds other commitments, return notes and drop reasons.
8. Download a demo backup in Engine Room. Clear the demo, restore the file, then restore it again. The second restore adds no duplicates. The directory, nested replies, choice histories, completion receipts and return points survive too. Restoring an older backup doesn't reopen completed or dropped work.

## What comes from the actual app

`public/core/readable.js` turns the original into display-only headings, paragraphs, nested lists, code, quotes and tables. Browser reading never evaluates source HTML or fetches remote images. Links require a tap, and unsafe schemes stay inert. The exact original remains available separately.

`public/core/semantic.js` classifies source fragments with conservative rules. `public/core/ef.js` groups them into a reversible view. Quotes retain exact source ranges. Private role aliases were replaced with generic roles for this extract. [SOURCE.md](SOURCE.md) records the source revision, adaptations and boundaries.

The browser interface, local storage and browser backup format are demonstration code. The Android app uses a different native storage and backup implementation. Browser-demo backups cannot be imported into the phone app.

The existing Android source passed **41 suites and 393 tests** on November 7, 2026. This is a source-level check, not proof of what is installed on a phone. The demo has its own tests.

## Data and limitations

- Examples are fictional. Use fictional text when trying it.
- Demo data and drafts are stored as plaintext in this browser profile. No accounts, trackers, model calls or private services are connected.
- Browser storage can be cleared by the browser, its owner, or other code on the same origin. Checksums detect accidental changes; they don't make the browser a trusted security boundary.
- IndexedDB transactions serialize writes across tabs. Change notifications and window activation refresh the displayed workspace.
- Classification can be wrong. A suggested category never creates a commitment or executes an action.
- Voice, agents, notifications, cloud sync and native phone backup/restore are outside this demonstration.
- Workspace limits: 100 named Attention Spans, 1,000 captures (including replies), 4,000 UTF-16 code units per capture, 2,000,000 total, and 32 MB per backup. A failed save preserves its draft; a conflicting or corrupt restore is refused before writing.
- The previous browser format migrates without deleting its original copy. Damaged records are preserved in a recovery area, included in downloads, and isolated from verified originals. Replies whose parent needs recovery remain readable. New capture does not depend on every old record being valid.
- Completion receipts document a self-reported human action, not independent evidence that a task succeeded. Choosing different work keeps the prior commitment; no item automatically takes its place after completion.
- Hold my place preserves the chosen source quote, return notes, route, scroll position and reading context. Completed or dropped commitments cannot be silently resumed.

## Verification

`npm test` checks exact quote ranges, negation/possibility handling, verified storage, concurrent writes, named destinations, nested reply links, database migration, explicit commitment histories, completion receipts, hold/resume, backup round trips, idempotency and rejection of tampering. A local preview-server check also verifies path and method restrictions.

The optional browser acceptance script uses an existing Playwright installation:

```sh
PLAYWRIGHT_DIR=/path/to/playwright node scripts/browser-check.mjs
```

It uses synthetic text and checks 1440px, 390px and 320px layouts, draft recovery, explicit promotion, named spans, nested replies, search, permalinks, original preservation, hold/resume, self-reported receipts, old-backup behavior, export/restore, failure recovery and absence of external requests. Set `CHROME_PATH` if Chrome isn't at `/usr/bin/google-chrome`. Screenshots go to `/tmp/effort-demo-screens` unless `DEMO_SCREEN_DIR` is set.

Set `DEMO_BASE_URL=https://stevenammer.github.io/effort-demo` to run the same browser acceptance against the hosted walkthrough. It uses an isolated browser context with fictional data and doesn't connect to the private app.

## Attribution

Product requirements and decisions: Steven Ammer. Implementation is AI-assisted, including this public adaptation. This is independent work and implies no employer or provider endorsement.

Original demonstration code is MIT licensed. No third-party libraries, fonts or images are bundled.
