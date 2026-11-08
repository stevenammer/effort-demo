# Source and boundaries

The organisation, sentence-classification and display-reading functions in `public/core/ef.js`, `public/core/semantic.js` and `public/core/readable.js` come from the existing EFFORT Android app at source revision `9b5d5cd` (October 17, 2026).

Changes for this demonstration:

- CommonJS exports/imports become browser-native ES modules.
- Private person and agent aliases become generic roles such as assistant and reviewer. No private corpus, captures or communication history is included.
- The classifier header describes this extract rather than absent private-app modules.

Classification rules and exact quote/offset behavior otherwise come from that source. JavaScript offsets count UTF-16 code units, not UTF-8 bytes. Classification is a conservative heuristic, not a claim of understanding intent. A category never authorizes action.

The browser interface, named Attention Span directory, nested post/reply adapter, isolated browser-storage adapter and demo export format are new demonstration code. The post and reply model follows the existing app's decisions, while its browser persistence is separate. They don't replace or modify the Android app. Native SQLite, audio, cloud sync, agents and phone backup/restore are outside this demo. Browser exports are not native EFFORT backups.

The original app's current offline baseline passed 41 suites and 393 tests on November 7, 2026. That is a source-level result. It doesn't establish the installed phone version. Demo test results are reported separately.

Implementation is AI-assisted. Steven Ammer defines the product requirements and makes the product decisions. This demonstration uses fabricated sample content and doesn't show employer, customer or family records.

The browser continuity adapter follows the existing app's explicit promotion, one-NOW, self-reported completion and resumption rules. Its immutable, checksum-checked event histories and browser migrations are new browser code. Browser receipts are user assertions; integrity checks don't independently verify that work occurred. No private commitments or return notes were imported.

`public/core/readable.js` preserves the native parser function bodies, with only its module header and CommonJS export adapted. The browser DOM adapter in `public/reading.js` is new code. It builds text and a small set of semantic elements, never evaluates source HTML, never fetches images, and only enables explicit HTTP(S) links without embedded credentials. Supported formatting is a bounded Markdown subset, not full CommonMark. A heading already shown as the post title is not duplicated in the body; originals, source ranges, downloads and hashes remain unchanged.

The draft shelf is new browser code, not a port of native persistence. It keeps sealed revisions for each composer and tab, uses optional Web Locks to distinguish reloads from cloned tabs, and retains emergency copies when draft writes fail. Workspace epochs fence delayed writes after a reset. Browser backup version 5 includes drafts and bounded raw recovery copies; versions 1 through 4 remain accepted. A checksum confirms local bytes, not authorship or independent evidence.

The offline shell is new browser code. Its generated manifest hashes a bounded list of public app files. A worker caches a complete verified release, keeps older caches for existing tabs, and waits for explicit update application. It never caches captures, generated backups, arbitrary requests or external resources. This improves browser resilience; it does not provide cloud synchronization or a durable backup guarantee.
