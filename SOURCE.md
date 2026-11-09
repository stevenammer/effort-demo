# Source and boundaries

The organisation, sentence-classification and display-reading functions in `public/core/ef.js`, `public/core/semantic.js` and `public/core/readable.js` come from the existing EFFORT Android app at source revision `9b5d5cd` (October 17, 2026).

Changes for this demonstration:

- CommonJS exports/imports become browser-native ES modules.
- Private person and agent aliases become generic roles such as assistant and reviewer. No private corpus, captures or communication history is included.
- The classifier header describes this extract rather than absent private-app modules.
- The display parser additionally recognizes strict local thought/file/branch/person/FORT UUID links for browser workspace cross-references.

Classification rules and exact quote/offset behavior otherwise come from that source. JavaScript offsets count UTF-16 code units, not UTF-8 bytes. Classification is a conservative heuristic, not a claim of understanding intent. A category never authorizes action.

The browser interface, named Attention Span directory, nested post/reply adapter, isolated browser-storage adapter and demo export format are new demonstration code. The post and reply model follows the existing app's decisions, while its browser persistence is separate. They don't replace or modify the Android app. The current browser build does not yet provide every native voice, sync, agent or optional executor workflow; their parity requirements remain in docs/PARITY.md. Native SQLite and phone backup/restore stay platform-specific. Browser exports are not native EFFORT backups.

The original app's current offline baseline passed 41 suites and 393 tests on November 7, 2026. That is a source-level result. It doesn't establish the installed phone version. Demo test results are reported separately.

Implementation is AI-assisted. Steven Ammer defines the product requirements and makes the product decisions. This demonstration uses fabricated sample content and doesn't show employer, customer or family records.

The browser continuity adapter follows the existing app's explicit promotion, one-NOW, self-reported completion and resumption rules. Its immutable, checksum-checked event histories and browser migrations are new browser code. Browser receipts are user assertions; integrity checks don't independently verify that work occurred. No private commitments or return notes were imported.

`public/core/readable.js` starts from the native parser function bodies, adapts its module header/exports, and extends the safe-link predicate for strict local thought/file/branch/person/FORT UUID routes. The browser DOM adapter in `public/reading.js` is new code. It builds text and a small set of semantic elements, never evaluates source HTML, never fetches images, and enables explicit HTTP(S) links without embedded credentials plus strict same-workspace thought/file/branch/person/FORT references. Supported formatting is a bounded Markdown subset, not full CommonMark. A heading already shown as the post title is not duplicated in the body; originals, source ranges, downloads and hashes remain unchanged.

The draft shelf is new browser code, not a port of native persistence. It keeps sealed revisions for each composer and tab, uses optional Web Locks to distinguish reloads from cloned tabs, and retains emergency copies when draft writes fail. Workspace epochs fence delayed writes after a reset. Browser backup version 11 includes drafts, exploration, distillations, files, thinking and opening histories, People context, self-reported contact receipts and bounded raw recovery copies; versions 1 through 10 remain accepted. A checksum confirms local bytes, not authorship or independent evidence.

The offline shell is new browser code. Its generated manifest hashes a bounded list of public app files. A worker caches a complete verified release, keeps older caches for existing tabs, and waits for explicit update application. It never caches captures, generated backups, arbitrary requests or external resources. This improves browser resilience; it does not provide cloud synchronization or a durable backup guarantee.

Safe exploration is new browser code built against the existing product decisions, not a port of a native execution engine. Branches preserve exact self-authored text, parent/source links, dial and a return point. Distillation labels preserve interpretation and uncertainty. No model is invoked. Preparing a proposal copies exact distillation writing into a separate, metadata-sealed reply with a derivation link. Preparing it does not choose work. Choosing an exact proposal detail is a separate explicit action through the existing commitment history. Sandbox writing has no promotion control.

Connected-file persistence is new browser code. It stores exact selected bytes and sealed metadata independently of source thoughts, supports passive text previews/downloads, and includes originals and damaged raw records in portable browser backup/recovery. It does not import or publish any private native files. See docs/ARTIFACTS.md.

The browser reader additionally rejects credential-bearing and malformed HTTP references before display tokenization, retaining rejected references as literal text. People uses the native field meanings and optional contact cadence while replacing mutable native profile rows with sealed browser revisions and separate self-reported contact receipts. Public fixtures contain no actual contacts. Native authored context, private backend configuration and account data are not copied.

FORT and live capture projection follow native RawDumps, core/rawArchive and core/ef. Browser paging uses a verified source-ID snapshot, numeric timestamp ordering and explicit refresh for arrivals; it does not copy private SQL data. Exact source strings remain unchanged. Separate append-only corrections/transcripts remain pending. See docs/FORT.md.
