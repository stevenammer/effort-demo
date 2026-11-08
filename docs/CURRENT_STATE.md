# EFFORT continuation checkpoint, November 8, 2026

## Start here

The public demo is live at https://stevenammer.github.io/effort-demo/.

Published `main` is **39823414f274db988e62ba99d670156b75c838f3**. It is a tested release. The current development branch is **wip/derived-proposals-20261108**, based on that release. The proposal changes on this branch are unfinished and have not been deployed. Preserve both histories; do not replace main with the unfinished branch without completing its acceptance work.

The ongoing objective is to bring EFFORT close to its full product vision so other people can use it in their own way and inspect the thinking behind it. A polished classified-text demonstration does not meet that objective. `TODO.md` and `docs/PARITY.md` retain the full map. The public individual experience and the organizational See / Spec / Send product remain separate.

## Published and independently verified

The release adds saved nested exploration branches, all four divergence dials, self-authored typed distillations (including OPEN TENSION and WEIRD BUT ALIVE), exact-writing views/downloads, parent/source links, saved return context and draft recovery. Browser backup 6 includes the new records and accepts backups 1 through 5. Capturing, branching and distilling never change NOW. Unhinged branches expose no promotion control. Outside the sandbox, selecting from the original is a separate deliberate choice.

The lead ran the full 99-test suite, fresh-checkout install and 99 tests, and the publication guard over 61 tracked files plus public history. Existing browser, draft, composer and offline/update regressions passed. Separate local and hosted exploration acceptance passed at 1440, 390 and 320px, covering keyboard navigation, both drafts/reload, failed writes, cross-tab updates, nested branches, all dials, explicit original selection/return, export/restore and offline reopening. Screenshots exposed a skip-link clipping issue that was fixed and rechecked. GitHub Actions runs **42492851705** (checks) and **42492851053** (Pages) succeeded for the published commit.

## Current unfinished slice: derived proposal preparation

A person should be able to carry a newly distilled idea forward, preserving exactly where it came from. Preparing a proposal must not create a commitment; choosing an exact detail is a second explicit action.

Persistence is implemented on this branch:

- `createStore().prepareProposal({distillationId}, {expectedEpoch})` creates an ordinary reply capture with the distillation's exact text, its source as parent, and a deterministic workspace-scoped ID. It leaves NOW and commitment history unchanged.
- `derivedFromId` points to the distillation. `derivedHash` seals every proposal field except itself; the existing hash continues to verify exact text.
- Unhinged branches refuse preparation. Repeated/concurrent requests reuse the same proposal. Readback failure can be retried without duplication. Reset epochs fence stale forms.
- `validateProposalProvenance` returns `verified`, `recovery`, or null for an ordinary capture. It verifies text, source, span and non-sandbox lineage. Missing or damaged lineage must be visibly distinguished from verified provenance.
- Capture validation accepts only the exact proposal shape. Browser backup is now version **7** on this development branch, accepting versions 1 through 6. IndexedDB remains schema 5; no new tables were needed.
- Read recovery preserves intact proposal text while recording damaged provenance separately. Metadata checksum failure preserves the whole raw capture through the existing quarantine path.

The lead independently ran the full suite after these changes: **105/105 tests pass**, including 19 exploration/proposal tests. `git diff --check` passes. The shell manifest has been regenerated. This is source verification only. There has been no proposal UI or hosted acceptance, no fresh-checkout proposal-release check, and no deployment of this branch.

## Resume here

1. Read this checkpoint and inspect the real diff from `main` before changing anything. Keep the published safe-exploration release intact.
2. Add a non-sandbox distillation action such as **Consider as a next step…**. Capture the current workspace epoch before awaits, call `prepareProposal`, refresh, and open the newly saved proposal in its organized exact-source view. Clearly state that preparation has not changed NOW. A second explicit choice uses the existing commitment API.
3. Show verified derivation links and source writing in both thread/reply and original views. Show an honest recovery state when lineage is unavailable. Do not label merely hash-checked or self-authored records as independent proof.
4. Add actual browser/fault acceptance for the new flow: sandbox refusal; inert preparation; separate exact-quote commitment; original distillation retained; retries after committed-save/readback failure; concurrent tabs; stale forms across reset; backup7 round trips and old-backup upgrade; damaged provenance with preserved writing; mobile/keyboard/overflow; offline reopen and explicit update behavior. Review restore merging and recovery under races.
5. Run the full suite yourself, regenerate/check the shell manifest after public-file changes, inspect screenshots/diff and run the publication guard. Fresh-checkout and hosted verification are required before calling this slice released. Merge/publish only the completed slice, then update this checkpoint and the full parity map.

## Remaining full-map work

Direct proposal UI and acceptance come first. Then branch/session status and thinking-move depth; attachments and connected artifacts/cross-links; People/Moves depth and unread context; an explicitly invoked bounded optional helper with provenance/permission receipts; scale/recovery/cache budgets; and a public technical case study plus a full-scope completion audit. Green narrow tests are not completion evidence for the whole product.

## Boundaries

Public repository pushes are authorized for this demo. Private Android data/runtime and personal writing are separate. No phone build/install, private backend deployment, paid provider calls, real messages or external actions are part of this work. Public examples stay synthetic. Keep the home calm and the depth in Attention Spans; thoughts become work only through explicit human choice.
