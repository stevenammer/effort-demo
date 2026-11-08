# EFFORT continuation checkpoint, November 8, 2026

## Start here

The public demo is live at https://stevenammer.github.io/effort-demo/.

Published `main` runtime is **9b9c1032c3e83e58076b0588dbef31314412384e**. The proposal flow is released and independently verified locally, in a fresh checkout and on the hosted site. The working checkout is back on `main`. The earlier `wip/derived-proposals-20261108` branch is historical; it is no longer the next place to resume. Preserve the published history and inspect real Git status before starting the next slice.

The ongoing objective is to bring EFFORT close to its full product vision so other people can use it in their own way and inspect the thinking behind it. A polished classified-text demonstration does not meet that objective. `TODO.md` and `docs/PARITY.md` retain the full map. The public individual experience and the organizational See / Spec / Send product remain separate.

## Earlier safe-exploration release

The release adds saved nested exploration branches, all four divergence dials, self-authored typed distillations (including OPEN TENSION and WEIRD BUT ALIVE), exact-writing views/downloads, parent/source links, saved return context and draft recovery. Browser backup 6 includes the new records and accepts backups 1 through 5. Capturing, branching and distilling never change NOW. Unhinged branches expose no promotion control. Outside the sandbox, selecting from the original is a separate deliberate choice.

The lead ran the full 99-test suite, fresh-checkout install and 99 tests, and the publication guard over 61 tracked files plus public history. Existing browser, draft, composer and offline/update regressions passed. Separate local and hosted exploration acceptance passed at 1440, 390 and 320px, covering keyboard navigation, both drafts/reload, failed writes, cross-tab updates, nested branches, all dials, explicit original selection/return, export/restore and offline reopening. Screenshots exposed a skip-link clipping issue that was fixed and rechecked. GitHub Actions runs **42492851705** (checks) and **42492851053** (Pages) succeeded for the published commit.

## Current released slice: derived proposal preparation and explicit choice

A person should be able to carry a newly distilled idea forward, preserving exactly where it came from. Preparing a proposal must not create a commitment; choosing an exact detail is a second explicit action.

The persistence and public controls are released:

- **Consider as a next step…** prepares exact derived writing and opens its organized original view. It leaves NOW unchanged; a second explicit **Make this my next step** action commits an exact source range. Verified lineage is readable in the reply and original dialog, with an honest recovery state when unavailable. See `docs/PROPOSALS.md`.
- `createStore().prepareProposal({distillationId}, {expectedEpoch})` creates an ordinary reply capture with the distillation's exact text, its source as parent, and a deterministic workspace-scoped ID. It leaves NOW and commitment history unchanged.
- `derivedFromId` points to the distillation. `derivedHash` seals every proposal field except itself; the existing hash continues to verify exact text.
- Unhinged branches refuse preparation. Repeated/concurrent requests reuse the same proposal. Readback failure can be retried without duplication. Reset epochs fence stale forms.
- `validateProposalProvenance` returns `verified`, `recovery`, or null for an ordinary capture. It verifies text, source, span and non-sandbox lineage. Missing or damaged lineage must be visibly distinguished from verified provenance.
- Capture validation accepts only the exact proposal shape. Browser backup is now version **7** in the released browser app, accepting versions 1 through 6. IndexedDB remains schema 5; no new tables were needed.
- Read recovery preserves intact proposal text while recording damaged provenance separately. Metadata checksum failure preserves the whole raw capture through the existing quarantine path.

The lead independently ran the full suite after integration and review fixes: **108/108 tests pass**, including 22 exploration/proposal tests. `git diff --check` passes. A fresh checkout ran `npm ci --offline`, the full 108 tests and the publication guard over 64 tracked files plus public history. The shell manifest is current and its hosted bytes match the tested local manifest.

Core, exploration, draft and offline/update browser regressions passed. Separate proposal rendering checks passed at 1440, 390 and 320px. The lead independently executed the full proposal/fault browser suite locally and on the hosted site: all three widths passed, including source lineage, separate exact-quote choice, readback retry, sandbox refusal, live cross-tab state, backup7/reset/restore, backup6 upgrade, damaged provenance with retained writing, asynchronous reset fencing, keyboard flow and offline reopening. No page errors or external requests were observed. GitHub Actions **42508275886** (checks) and **42508275598** (Pages) succeeded for runtime `9b9c103`.

Review caught and fixed duplicate preparation after backup restoration and source changes during retry verification. An old exploration test incorrectly waited for a hidden Home element after offline Engine Room reload; it now checks the restored route before opening Home. The proposal script also checks preserved raw recovery text by opening its disclosure, instead of expecting collapsed text to be visible. See `docs/PROPOSALS.md` for the product contract.

## Resume here

1. Inspect actual Git state and read `TODO.md`, `docs/PARITY.md`, `docs/EXPLORATION.md` and `docs/PROPOSALS.md`. The tested proposal flow is already published. Don't rebuild or re-release it from the old WIP branch.
2. Build the next usable slice: connected files and artifacts attached to saved posts, with exact bytes, source links, readable safe previews or explicit downloads, immutable originals, retry/reset protection, portable backup/restore and raw recovery. Keep capture and the selected NOW working when an attachment fails. Public built-in examples remain synthetic; user-entered files must stay within the browser workspace.
3. Test that whole path in the browser, including failure/concurrency/backup/offline, desktop and phone layouts, and inaccessible/missing sources. Use the existing full suite and independent fresh-checkout/hosted release checks. Continue the broader map with cross-links, branch/session status and thinking moves, People/unread depth and bounded assistance.
4. Preserve the full objective and the parity map. Do not call the overall goal complete after another narrow green slice. The final audit must inspect the complete usable experience against the owner's vision and all named requirements.

## Remaining full-map work

Attachments and connected artifacts/cross-links come next; branch/session status and thinking-move depth; People/Moves depth and unread context; an explicitly invoked bounded optional helper with provenance/permission receipts; scale/recovery/cache budgets; and a public technical case study plus a full-scope completion audit. Green narrow tests are not completion evidence for the whole product.

## Boundaries

Public repository pushes are authorized for this demo. Private Android data/runtime and personal writing are separate. No phone build/install, private backend deployment, paid provider calls, real messages or external actions are part of this work. Public examples stay synthetic. Keep the home calm and the depth in Attention Spans; thoughts become work only through explicit human choice.
