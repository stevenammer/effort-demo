# EFFORT adversarial test ledger

The active goal includes parity with the actual app and its intention, followed by deliberate attempts to break it. A feature checklist or green happy-path suite doesn't establish completion. This ledger turns comparable open-source projects' documented failures into test hypotheses for EFFORT. An upstream report isn't evidence of an EFFORT defect.

## Upstream evidence and adopted attacks

| Priority | Primary source | EFFORT attack and required evidence | Current execution |
|---|---|---|---|
| P0 | [Joplin Markdown-link security advisory](https://github.com/laurent22/joplin/security/advisories/GHSA-hff8-hjwv-j9q7) | Render hostile HTML/SVG/Mermaid-like markup and dangerous schemes. No executable elements, automatic egress, source mutation or unsafe local navigation. | Parent executed redteam-reading-browser-check.mjs at1440/390/320: pass. EFFORT doesn't use Electron or Mermaid, so the exploit mechanism itself isn't assumed applicable. |
| P0 | [Joplin conflict documentation](https://joplinapp.org/help/apps/conflict/) | Independently edit in offline/stale tabs; reject or preserve competing revisions, preserve drafts, retry without duplicate records. | Existing immutable-history and draft tests cover part; People browser CAS/rebase, preserved draft and failed-cleanup retry acceptance passes at1440/390/320. |
| P0 | [Logseq failed graph download report](https://github.com/logseq/db-test/issues/1059) | Truncated or invalid restore into a populated workspace must leave existing data intact and allow corrected retry. | New redteam-graph.test.js executes malformed/truncated restore fixtures; full parent suite passed with these tests. |
| P0 | [Logseq unexpected export expansion report](https://github.com/logseq/db-test/issues/1445) | Embedded-reference-looking text must export exactly, never silently expand another thought's content or omit the original reference. | New deterministic graph/export tests execute exact-string and hidden-content assertions. |
| P1 | [Logseq importer regression catalog](https://github.com/logseq/logseq/blob/master/docs/og_import_graph_cases.md) | Duplicate titles, missing/self/cyclic/forward links, malformed identifiers, source identity and attached files. Stable IDs must survive round trip; bad graphs must refuse atomically. | New generated graph tests plus existing span/file tests. Broader seeded fuzz campaigns pending. |
| P1 | [AppFlowy date-only comparison report](https://github.com/AppFlowy-IO/AppFlowy/issues/9126), [Monica birthday date-boundary report](https://github.com/monicahq/monica/issues/2024) | Reject impossible dates and DST gaps. Distinguish repeated local times; preserve UTC offset in contact drafts across timezone changes. Date-only context stays authored text, with no hidden timestamp. | New dates.test.js and contact-time.test.js execute leap-year, invalid component, New York DST and Tokyo restored-offset cases. |
| P1 | [Monica duplicate tagged-contact activity report](https://github.com/monicahq/monica/issues/7844) | Editing a person's context or source links must never create contact receipts or messages. One retried contact submission must yield one self-report. | People persistence tests execute separation and retry checks; People browser acceptance passes at1440/390/320. |

## EFFORT defects found in this pass

| Finding | Required behavior | Evidence/status |
|---|---|---|
| JavaScript accepted impossible calendar timestamps by normalizing them. | Calendar-valid ISO timestamps only, including numeric offsets; preserve exact originals and quarantine malformed metadata. | Strict shared validDate; dates.test.js and People date cases pass. |
| A damaged contact receipt could make cadence fall back to an older baseline. | Unknown contact history suppresses cadence; a different newly logged conversation doesn't fabricate recovery. | People contactRecovery flag and focused tests pass. |
| Person names weren't trimmed consistently with the actual app. | Normalize name once before sealing and retry matching; retain authored multiline context exactly. | People normalization/retry tests pass. |
| Generic draft emptiness didn't recognize several deeper composers. | A recovery action must refuse to overwrite nonempty People, move, exploration, branch or contact drafts. | Context-aware emptiness guards and new adversarial tests pass. |
| Failed tombstone writes could make draft cleanup permanently unretryable. | Retry only the exact failed cleanup; newer writing must remain protected. | Exact cleanup retry/newer-writing/reset tests and real browser contact-cleanup fault pass. |
| Rejected credential-bearing links lost their destination in the readable view. | Rejected references stay literal and inactive; raw writing stays exact. | Parser validation, Node regression and hostile browser suite pass. |

| A lost offline readiness response could leave the status stuck until another lifecycle event. | Retry status probes with a bounded limit, observe already-installing workers and never advertise unverified readiness. | Four deterministic lifecycle/retry tests and real offline/update browser regression pass. |
| Exploration looked available before the preceding save had finished, so a fast click was ignored. | Enabled controls must reflect real save/load readiness without replacing the reading DOM. | Exploration browser regression passes after readiness controls were tied to pending state. |
| Case-variant local-route prefixes could lose a rejected destination in the readable view. | Unsupported prefixes stay literal and inactive. | Exact parser regression and hostile browser recheck pass at1440/390/320. |

| Shared source ordering compared ISO strings lexically, so valid UTC offsets could reverse real chronology outside FORT. | Sort by the actual instant with stable source-ID ties, preserving the original timestamp string. | A failing storage regression reproduced the bug. The fix passes all19 storage tests, the full210-test suite and the real browser Home/FORT offset-ordering case; exact timestamps survive a backup round trip. Release follow-up gates pending. |

## Further campaigns, still required

The FORT slice additionally executes a real browser1,000-original fixture with50 rendered cards, refused over-capacity capture with exact draft retention, invalidated-source removal and clearing hidden archive/draft projections on reset. Exact source offsets and whole-workspace entity limits still require the wider audit.

Model-based event sequences across save/edit/link/contact/reset/restore, real browser quota denial and process termination, source corruption between validation and commit, cached upgrade during pending input, 1,000-original scale, large exact-byte attachments, encoded and Unicode link variants, optional-provider permission/egress boundaries, and completion audit against native source. Use fixed seeds and save minimal failing fixtures. Record executed commands, actual failure evidence, patch and regression receipt rather than declaring a category safe from one example.
