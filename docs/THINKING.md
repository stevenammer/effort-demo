# Thinking moves and branch continuity

This slice is implemented on `feature/thinking-continuity-20261108`. Local acceptance is complete; publication and hosted acceptance remain separate gates. See CURRENT_STATE.md for verified evidence and remaining checks.

A thinking move is an optional, editable prompt. It is not an assessment of a person. The nine generic suggestions come from EFFORT's existing move library. People can change them, turn them off or add their own. No helper or provider runs when choosing a move.

Each saved branch retains its exact selected name, prompt and definition revision. Editing or disabling a move later leaves that snapshot intact. A historical prompt remains readable even if its definition needs recovery. Only available definitions are offered for new selection.

Branch states are open, set aside, distilled, let go with history kept, and weird but alive. Status changes append immutable records. They do not edit branch writing or create work. Set-aside branches are folded; their permalinks open the fold. Parent and session-root links retain the existing return point. A branch is shown as used for a chosen step only when an actual commitment points through its derived proposal and distillation.

Examples appear in the Moves Attention Span only after the person explicitly checks the evidence option. Choosing a prompt or distilling a thought never implies evidence or success. All prompt editing and branch-status forms have recoverable drafts. Conflicting tab edits require reviewing the current revision and explicitly adopting it as the editing base, while preserving the person's wording.

IndexedDB schema 7 adds `branchEvents` and `moveEvents`. Backup 9 carries both histories and accepts backups 1 through 8. Sealed records, chain validation, compare-and-swap bases, workspace epochs, readback checks and limits cover writes and restoration. Damaged histories retain raw recovery copies. A damaged disabled override is not silently replaced by an enabled seed. Unreadable thinking storage leaves primary thoughts and NOW usable; complete backup refuses to omit unknown history.

The integrated reader revalidates the final primary snapshot before presenting verified originals, in addition to checking optional histories and files. An injected snapshot-only corruption test verifies it retries rather than showing altered writing.

The slice also releases a root exploration's return-point retry token after successful saving, so the next session can save a fresh return point. An unfinished root exploration can explicitly adopt the current return context without discarding its writing. Nested branches keep their parent's return point.

Verification commands:

- `npm test`
- `npm run check:syntax`
- `npm run check:public`
- `PLAYWRIGHT_DIR=/path/to/playwright node scripts/thinking-browser-check.mjs`

Browser acceptance uses isolated synthetic data and supports `DEMO_BASE_URL`. It exercises optional selection, exact old prompts after disabling, explicit evidence, folded branch permalinks, custom-move draft reload, concurrent edit conflict/rebase, backup/reset/restore and three viewport widths. Store tests cover reset races, recovery and immutable restoration; regression browser checks cover older published clients, drafts, files, source-linked choices and offline updates. See CURRENT_STATE.md for the executed checks. Unit tests alone do not establish the whole product's completion.
