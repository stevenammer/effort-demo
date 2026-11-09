# Details

The fuller notes that used to sit at the bottom of the README, moved here unchanged: what comes from the actual app, data and limitations, verification, and attribution. The README keeps the short version.

## What comes from the actual app

`public/core/readable.js` turns the original into display-only headings, paragraphs, nested lists, code, quotes and tables. Browser reading never evaluates source HTML or fetches remote images. Links require a tap, and unsafe schemes stay inert. The exact original remains available separately.

`public/core/semantic.js` classifies source fragments with conservative rules. `public/core/ef.js` groups them into a reversible view. Quotes retain exact source ranges. Private role aliases were replaced with generic roles for this extract. [SOURCE.md](SOURCE.md) records the source revision, adaptations and boundaries.

The browser interface, local storage and browser backup format are demonstration code. The Android app uses a different native storage and backup implementation. Browser-demo backups cannot be imported into the phone app.

The existing Android source passed **41 suites and 393 tests** on November 7, 2026. This is a source-level check, not proof of what is installed on a phone. The demo has its own tests.

## Data and limitations

- Examples are fictional. Use fictional text when trying it.
- Demo data and drafts are stored as plaintext in this browser profile. No accounts or trackers. Helpers are off until you configure a self-hosted companion and explicitly approve/start a selected-context invitation. See [THREAD review](docs/THREAD_REVIEW.md) and [structured results and input receipts](docs/HELPER_RESULTS.md), and [HTTPS/pairing](docs/HELPER_CONNECTIONS.md). No private service is paired automatically.
- Offline storage contains a fixed set of public app files, never capture text, backup downloads or arbitrary requests. Previous app caches are retained so older tabs can keep their matching version. Cache storage grows with releases and remains subject to browser eviction. Offline readiness requires one complete connected visit. If a browser restart opens a fresh tab without its previous identity, use Engine Room → Draft recovery to bring the retained writing into that tab.
- Browser storage can be cleared by the browser, its owner, or other code on the same origin. Checksums detect accidental changes; they don't make the browser a trusted security boundary.
- Drafts have verified revisions and per-tab identities. A cloned tab forks the writing rather than overwriting it. Where supported, browser Web Locks retain a tab's identity across reloads; fallback copies remain available in Engine Room. Failed draft writes retain an emergency localStorage copy when available. If both storage mechanisms fail, keep the window open and copy the writing.
- IndexedDB transactions serialize writes across tabs. Change notifications and window activation refresh the displayed workspace.
- Classification can be wrong. A suggested category never creates a commitment or executes an action.
- Voice capture, repository execution, notifications, cloud sync and native phone backup/restore remain outside the released demonstration. This branch adds optional text-only helper execution; its release gates remain in CURRENT_STATE.md.
- Workspace limits: 100 named Attention Spans, 1,000 captures (including replies), 4,000 UTF-16 code units per capture, 2,000,000 total, and 32 MB per backup. A failed save preserves its draft; a conflicting or corrupt restore is refused before writing.
- Draft limits: 1,000 records and 4,000,000 JSON characters, with bounded emergency recovery. A deliberate reset fences delayed writes and passive drafts in other tabs. Capture and return-point retries reuse a workspace-scoped request, so an accepted save followed by a confirmation failure doesn't duplicate it.
- The previous browser format migrates without deleting its original copy. Damaged records are preserved in a recovery area, included in downloads, and isolated from verified originals. Replies whose parent needs recovery remain readable. New capture does not depend on every old record being valid.
- Completion receipts document a self-reported human action, not independent evidence that a task succeeded. Choosing different work keeps the prior commitment; no item automatically takes its place after completion.
- Hold my place preserves the chosen source quote, return notes, route, scroll position and reading context. Completed or dropped commitments cannot be silently resumed.

## Verification

`npm test` checks exact quote ranges, negation/possibility handling, verified storage, concurrent writes, named destinations, nested reply links, database migration, explicit commitment histories, completion receipts, hold/resume, backup round trips, idempotency and rejection of tampering. A local preview-server check also verifies path and method restrictions.

The optional browser acceptance script uses an existing Playwright installation:

```sh
PLAYWRIGHT_DIR=/path/to/playwright node scripts/browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/draft-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/composer-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/offline-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/exploration-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/proposal-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/artifact-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/artifact-upgrade-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/thinking-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/opened-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/people-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/archive-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/revisions-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/exploration-navigation-browser-check.mjs
PLAYWRIGHT_DIR=/path/to/playwright node scripts/redteam-reading-browser-check.mjs
```

It uses synthetic text and checks 1440px, 390px and 320px layouts, draft recovery, explicit promotion, named spans, nested replies, search, permalinks, original preservation, hold/resume, self-reported receipts, old-backup behavior, export/restore, failure recovery and absence of external requests. Set `CHROME_PATH` if Chrome isn't at `/usr/bin/google-chrome`. Screenshots go to `/tmp/effort-demo-screens` unless `DEMO_SCREEN_DIR` is set.

The composer check adds delayed startup, nested reply destinations, fast route changes, and writing entered during a pending save. The draft fault check covers separate and cloned tabs, reset fencing, failed-write recovery, cleanup failures, retry idempotency and primary saving when the draft shelf is unavailable.

The offline check uses actual service workers and synthetic releases on a repository subpath. It checks disconnected reload, a fresh tab through the root URL, offline capture, deliberately applied updates, refusal when writing cannot be saved, and rollback after a corrupt release. After editing public app files, run `node scripts/update-shell.mjs` to refresh the checked asset manifest.

Set `DEMO_BASE_URL=https://stevenammer.github.io/effort-demo` to run the same browser acceptance against the hosted walkthrough. It uses an isolated browser context with fictional data and doesn't connect to the private app.

The exploration check exercises nested branches and all four dials, self-authored distillations, the promotion boundary, exact return context, failed-write drafts, cross-tab updates, backup restore and offline reopen. This unpublished branch writes backup17 and accepts versions1 through16. Published main still writes backup13; see CURRENT_STATE.md for the current release boundary. Exploration and distillation records share a 4 MiB encoded JSON budget, with 4,000 characters per note. Checksums verify stored bytes, not truth or authorship. See [the exploration contract](docs/EXPLORATION.md) for the product decisions and remaining limits.

## Attribution

Product requirements and decisions: Steven Ammer. Implementation is AI-assisted, including this public adaptation. This is independent work and implies no employer or provider endorsement.

Original demonstration code is MIT licensed. No third-party libraries, fonts or images are bundled.

Connected files are stored with their exact bytes and source links, with limits of 2 MiB per file and 8 MiB combined encoded JSON. Text/plain previews are passive and bounded; other types are downloadable. See [the file and recovery contract](docs/ARTIFACTS.md). CI also runs `npm run check:syntax` for every browser and worker module.

Thinking moves are optional prompts you can edit, turn off or add yourself. A branch preserves the exact prompt it used. Status changes keep history without creating work; examples appear only when you explicitly tag them. Open Moves through Attention Spans for definitions and chosen examples. See [the thinking and recovery contract](docs/THINKING.md).

Attention Spans show exact posts and replies not opened here. Opening a thread acknowledges only its displayed writing; later replies keep their own status, even with older timestamps. This records opening, not reading, agreement or completion. See [the opening-context contract](docs/OPENED.md).

People keeps optional relationship context, manually selected source links, exact revision history and self-reported conversations inside its Attention Span. Contact drafts preserve timezone intent, including ambiguous DST times; editing context never logs a conversation or changes NOW. See [the People contract](docs/PEOPLE.md).

FORT / EF opens the full verified original history, with literal search, stable source links and older-capture paging. EF also organizes the capture draft live; switching it off shows the exact wording. A preview failure leaves original saving available. See [the FORT and live projection contract](docs/FORT.md).

Corrections and supplied transcripts append separate records. FORT can organize from them while preserving the original, earlier revisions and existing NOW. Historical search, exact downloads, stale-tab rebasing and explicit recovery are included. Supplied transcript text does not verify audio. See [the source-revision contract](docs/REVISIONS.md).
