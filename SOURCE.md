# Source and boundaries

The organisation and sentence-classification functions in `public/core/ef.js` and `public/core/semantic.js` come from the existing EFFORT Android app at source revision `9b5d5cd` (October 17, 2026).

Changes for this demonstration:

- CommonJS exports/imports become browser-native ES modules.
- Private person and agent aliases become generic roles such as assistant and reviewer. No private corpus, captures or communication history is included.
- The classifier header describes this extract rather than absent private-app modules.

Classification rules and exact quote/offset behavior otherwise come from that source. JavaScript offsets count UTF-16 code units, not UTF-8 bytes. Classification is a conservative heuristic, not a claim of understanding intent. A category never authorizes action.

The browser interface, named Attention Span directory, nested post/reply adapter, isolated browser-storage adapter and demo export format are new demonstration code. The post and reply model follows the existing app's decisions, while its browser persistence is separate. They don't replace or modify the Android app. Native SQLite, audio, cloud sync, agents and phone backup/restore are outside this demo. Browser exports are not native EFFORT backups.

The original app's current offline baseline passed 41 suites and 393 tests on November 7, 2026. That is a source-level result. It doesn't establish the installed phone version. Demo test results are reported separately.

Implementation is AI-assisted. Steven Ammer defines the product requirements and makes the product decisions. This demonstration uses fabricated sample content and doesn't show employer, customer or family records.
