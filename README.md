# EFFORT, a public walkthrough

**Capture a thought. Keep the original. Choose one next step.**

[Open the interactive walkthrough](https://stevenammer.github.io/effort-demo/).

This is an interactive browser demonstration of E.F.F.O.R.T. (Executive Function For Organizing Random Thoughts), Steven Ammer's existing personal Android app. It uses a small extract of the app's actual deterministic organisation code and fabricated examples.

The walkthrough is separate from the private app and its data. It isn't a replacement phone app, a connected agent service, or an export of someone's personal workspace.

![EFFORT browser walkthrough, using fictional sample data](docs/screens/home-desktop.png)

## Try it locally

Needs Node 20.20 or newer. There are no runtime or development package dependencies.

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
5. Download a demo backup in Engine Room. Clear the demo, restore the file, then restore it again. The second restore adds no duplicates.

## What comes from the actual app

`public/core/semantic.js` classifies source fragments with conservative rules. `public/core/ef.js` groups them into a reversible view. Quotes retain exact source ranges. Private role aliases were replaced with generic roles for this extract. [SOURCE.md](SOURCE.md) records the source revision, adaptations and boundaries.

The browser interface, local storage and browser backup format are demonstration code. The Android app uses a different native storage and backup implementation. Browser-demo backups cannot be imported into the phone app.

The existing Android source passed **41 suites and 393 tests** on November 7, 2026. This is a source-level check, not proof of what is installed on a phone. The demo has its own tests.

## Data and limitations

- Examples are fictional. Use fictional text when trying it.
- Demo data and drafts are stored as plaintext in this browser profile. No accounts, trackers, model calls or private services are connected.
- Browser storage can be cleared by the browser, its owner, or other code on the same origin. Checksums detect accidental changes; they don't make the browser a trusted security boundary.
- Web Locks serialize supported-browser writes across tabs. Where unavailable, use one demo tab; the fallback coordinates only that tab.
- Classification can be wrong. A suggested category never creates a commitment or executes an action.
- Voice, agents, notifications, cloud sync and native phone backup/restore are outside this demonstration.
- Demo limits: 30 captures, 4,000 UTF-16 code units per capture, 80,000 total, and 512 KB per backup. A failed save preserves its draft; a conflicting or corrupt restore is refused before writing.

## Verification

`npm test` checks exact quote ranges, negation/possibility handling, verified storage, concurrent writes, backup round trips, idempotency and rejection of tampering. A local preview-server check also verifies path and method restrictions.

The optional browser acceptance script uses an existing Playwright installation:

```sh
PLAYWRIGHT_DIR=/path/to/playwright node scripts/browser-check.mjs
```

It uses synthetic text and checks 1440px, 390px and 320px layouts, draft recovery, explicit promotion, original preservation, export/restore, failure recovery and absence of external requests. Set `CHROME_PATH` if Chrome isn't at `/usr/bin/google-chrome`. Screenshots go to `/tmp/effort-demo-screens` unless `DEMO_SCREEN_DIR` is set.

Set `DEMO_BASE_URL=https://stevenammer.github.io/effort-demo` to run the same browser acceptance against the hosted walkthrough. It uses an isolated browser context with fictional data and doesn't connect to the private app.

## Attribution

Product requirements and decisions: Steven Ammer. Implementation is AI-assisted, including this public adaptation. This is independent work and implies no employer or provider endorsement.

Original demonstration code is MIT licensed. No third-party libraries, fonts or images are bundled.
