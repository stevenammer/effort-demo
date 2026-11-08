# Public EFFORT parity and acceptance

This is the delivery map for the owner's public-centerpiece goal. It is not a list of features claimed complete. The existing Android implementation and its decisions are the reference; public examples contain no private workspace data or persona names.

| Requirement | Existing app reference | Evidence required in the public version | Current gap |
|---|---|---|---|
| Save first; exact originals | capture receipts, drafts, raw archive | Capture after corrupt history or failed organisation; exact string/hash readback; interrupted-draft recovery | Per-record transactions and recovery implemented; draft storage still needs multi-tab isolation |
| First-class Attention Spans | spans, SpansHome, SpanFeed | Create/find a named span, chronological posts, nested replies, unread/context information | Named searchable directory, chronological posts, nested replies and permalinks implemented; unread context, attachments and connected artifacts pending |
| THREAD, not a separate chat | threadflow, ThreadView | Explicit source-linked post/reply flow, visible invitation/egress choices, durable post before any helper failure | Human post/reply loop implemented; helper invocation and bounded runtime pending |
| Original and derived remain distinct | semantic, EF, rich reading | Original accessible from every derived view, reversible organisation, readable rich content with no source edits | Partial |
| Explicit commitments and one NOW | commit, home | Neutral states; idempotent promotion; completion receipt; chosen work survives unrelated capture | Only one raw quote pointer |
| Hold/resume, exploration | resumption packets, thinking, moves | Save return context, explore branches, preserve open tensions, deliberately promote, resume exact chosen work | Not represented |
| Connected depth | Proof, People, Workspace, spans | Inspect linked evidence/artifacts and related threads through named spans without cluttering home | Not represented |
| Portable, honest recovery | raw backup, store, startup recovery | Restore pre-upgrade data; idempotency; conflicts refused; damaged data preserved; capture still works | v1/v2 upgrades and v3 backup include named spans, nested reply links and recovery; future entity coverage pending |
| Storage/concurrency | native SQLite, inbox idempotency | Transactional browser data; actual multi-tab acceptance; fresh read/refresh; no lost or duplicate posts | IndexedDB transactions and actual two-tab acceptance implemented; scale and future entity coverage pending |
| Honest runtime surface | Engine Room, lane status, runner | Real browser/runtime evidence; explicit unavailable integrations; no fabricated live replies, quotas or side effects | Basic browser status only |
| Public release | source/provenance, tests, publication guard | Synthetic-only assets, pinned checks, fresh clone, accessibility/phone flows and hosted readback | Initial demo release exists |

The public app must be useful as an offline browser workspace, not merely a slideshow. Provider execution must remain explicit and bounded; private runtime access, paid calls and employer/family data are outside public authorization. These boundaries do not justify dropping the corresponding workflow: configured, example and unavailable states must be clear and usable.

Completion requires evidence for the full map, including user journeys, recovery and scale, rather than the number of tests or a polished landing page.
