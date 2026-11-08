# Safe exploration

The product problem: a new idea should have room to grow without displacing the work a person already chose. A useful thought can stay unresolved. Saving one should never silently turn it into an obligation.

From NOW or any thread, **Explore safely…** keeps a return point and saves the person's exact writing. A branch has a source, optional parent, dial, author marker and timestamp. Nested branches retain the same source and return point. They are immutable records, not edits to the original.

The dial offers TIGHT, NORMAL, WILD and UNHINGED SANDBOX. This browser slice is a place for the person's own writing; changing the dial doesn't call a model, generate material or authorize action. The label preserves the context in which the idea was written.

**Distill…** keeps an INSIGHT, HYPOTHESIS, EXPERIMENT, DECISION CANDIDATE, FUTURE ARCHITECTURE, OPEN TENSION, WEIRD BUT ALIVE, NOISE or RECEIPT. These are self-authored interpretations. Even RECEIPT doesn't complete work or appear as verified Proof. Exact branch and distillation text stays available separately from the reading view and can be downloaded.

Outside the unhinged sandbox, **Choose from original…** opens the original's organized view. It doesn't change NOW. Only choosing an exact source range does that. Unhinged branches expose no promotion control. A person can deliberately create a child with another dial before considering action. **Consider as a next step…** prepares the distillation's exact writing as a separate proposal with its source attached. Preparation leaves NOW and commitment history unchanged. The proposal opens in the organized original view, where a second explicit choice can select an exact detail as NOW. The original distillation remains intact. Its lineage is readable from the saved reply, original view, and chosen step's source.

**Return to where I was** restores the saved choice, route, scroll and reading context. Resuming can't reactivate completed or dropped work. A handled return point remains in history; repeated taps don't override newer choices.

## Persistence and failure behavior

IndexedDB schema 5 adds exploration and distillation tables without rewriting old originals. Browser backup 7 covers the exploration tables, proposal captures, derivation links and drafts, and accepts versions 1 through 6. Proposal metadata has its own checksum in addition to the exact-text checksum. Restore adds missing immutable records, refuses conflicts atomically and keeps the current chosen work. Capture remains available after damaged exploration records are quarantined with their raw bytes.

Preparing a proposal reuses its prior capture after backup restoration, even when the workspace epoch changes. Source changes during verification are refused. Intact proposal writing remains available if its derivation needs recovery; the UI labels that state instead of claiming a verified link.

Saves have workspace-scoped retry IDs, reset fencing and exact readback. A failed confirmation can be retried without creating another branch or distillation. Both composers use the existing isolated draft shelf and emergency recovery. Their combined record budget is 4 MiB of encoded JSON, with at most 10,000 of either record type and 4,000 characters per note. Return points have their existing 1,000-record limit. A storage limit refuses new writing; it never discards saved records.

## Acceptance and remaining work

Tests cover source and parent integrity, reset boundaries, retry conflicts, concurrent retries, readback failure, malformed imports, old database and backup upgrades, conflicting restore, exact draft preservation, budget rejection and damaged-source recovery. Browser acceptance covers desktop and phone sizes, all dials, nested branches, inert distillation saves, deliberate original choice and return, cross-tab updates, failed-write drafts, portable restore and offline reopen.

Further work includes explicit branch/session status transitions, thinking moves, attachments and connected artifacts, and a bounded optional helper. No private runtime, provider calls or external actions are connected by this slice.
