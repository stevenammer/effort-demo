# THREAD review and bounded helpers

Work in progress on feature/thread-review-20261109. Published main remains869649e until the new slice completes its release gates. CURRENT_STATE.md records actual evidence and pending work.

A THREAD request spends cognition, not execution authority. It preserves a saved source, an exact question, a requested result (ANSWER, DECISION, OPTIONS, RESEARCH, QUESTIONS, PROPOSAL, NO_ACTION or BLOCKED), CANDIDATE/REVIEW placement and zero to two public helper invitations. No invitation is selected by default. A request without helpers is useful offline and makes no model call. Existing originals and NOW remain intact.

Selected context is a sealed snapshot of at most twelve saved originals or prepared source-revision proposals, up to24,000 encoded bytes. Additional sources require exact IDs and manual selection. No People profile, attachment, other thread, latest correction or assistant answer is included implicitly. Each invited role sees the approved sources and question; helpers don't converse with each other. The public roles are Plan reviewer and First-step helper. Both have no tools. Output remains unverified model writing, not proof, a personality judgment or completed work.

A verified review is durable before starting a helper. Starting each invitation is a separate explicit action. A running attempt is committed and read back before dispatch. Only one attempt can run at a time in the workspace. Done attempts can't be rerun; failed/stopped attempts require explicit retry, with a twenty-attempt ceiling. A restart or ambiguous readback never silently repeats inference. Stop records an immutable choice, aborts the owning HTTP request when possible and refuses late persistence. It doesn't claim independently verified termination of a model worker. Reset epochs refuse old outcomes. Saving or preparing thought never commits work.

threadReviews and helperEvents are separate optional IndexedDB tables. Each attempt binds the full approved review checksum, role, previous event and attempt number. Malformed chains are quarantined with exact raw copies. An older restored prefix stays unknown while later recovered IDs are missing. Optional-table failure keeps primary capture/NOW usable and refuses an incomplete backup. Schema15 / backup17 imports1..16; all supported histories and request drafts travel through the exit door. Session tokens never enter the database, draft or backup. Optional remembered browser pairing can prefill credentials, but reload requires a fresh check before starting or retrying; see HELPER_CONNECTIONS.md.

## Optional companion

The browser reaches an explicitly checked HTTPS origin or an HTTP loopback companion at 127.0.0.1 or localhost. It verifies an installed model inventory without inference. The reviewed route shows companion address, self-hosted backend and model, with the observed time. Inventory proves configured availability, not model quality or an independent privacy audit. Browsers may request local-network permission. No helper starts because a connection check succeeded.

The included Node companion implements the documented Ollama [model listing](https://docs.ollama.com/api/tags) and [non-streaming chat API](https://docs.ollama.com/api/chat). It doesn't install/pull a model, run shell commands, change the existing private stack, use cloud APIs or silently substitute routes. The backend must be an explicit HTTP loopback/private numeric address. Configure that service with cloud disabled and an existing model before using it. Ollama documents OLLAMA_NO_CLOUD=1 and a service restart in its [FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).

For your own separately managed service, replace the model placeholder with its exact installed tag:

```sh
EFFORT_HELPER_SELF_HOSTED=1 EFFORT_HELPER_MODEL='YOUR_INSTALLED_MODEL_TAG' npm run helper
```

This starts only a loopback companion. Its terminal displays a fresh private session token. Paste the address/token into Engine Room, check the inventory, open a saved thread, review exact context, keep the approved request, then explicitly start an invitation. The hosted page doesn't supply a model or runtime. The token stays in tab memory/input by default; remembering it in this browser is an explicit plaintext-storage option, excluded from workspace backups. Don't save it in public examples.

Optional environment variables: EFFORT_HELPER_BACKEND (default http://127.0.0.1:11434), EFFORT_HELPER_PORT (default 4319), EFFORT_HELPER_CONTEXT (default 8192, bounded 2048..32768), EFFORT_HELPER_TOKEN (otherwise generated), EFFORT_HELPER_ORIGINS (comma-separated exact browser origins, default https://stevenammer.github.io). For local preview, explicitly add that preview origin. Origin/Host checks and the token are required before backend access. No prompt is put in a URL or server log. Inference refuses any resident model, remote-model metadata, route drift, redirects, tool calls and oversized/incomplete output. Requests are bounded; keep_alive 0 requests unloading afterward. This isn't a replacement for a shared model-generation scheduler. Don't invoke it concurrently with an existing managed local-model job.

## Acceptance and remaining work

Node tests use synthetic storage and real HTTP fixture servers, without loading any actual model. Browser acceptance uses the actual companion against a synthetic Ollama protocol server. These prove protocol, persistence, UI and failure handling, not actual-model answer quality. Source corruption, missing history, token/origin refusal, readback ambiguity, two-tab claims, stopped/reset late results, optional-store outage, exact backup restoration and draft recovery have dedicated tests.

Executed: full255 tests, fresh-clone offline install/255/syntax32/public guard117 plus all16 workflow/browser regressions and real published869649e DB11-to12 migration pass. Three-width companion browser acceptance passes, including preserved original reading and an earlier helper disclosure. No actual model was loaded.

Exact helper-result proposals, separate own-copy quote choice and an Engine Room orphan request/answer directory are implemented locally; see HELPER_PROPOSALS.md. Live provenance labels track storage availability without replacing original reading.

Structured actual results, exact raw JSON/execution receipts, input-origin attribution and individual proposal choices are implemented locally; see HELPER_RESULTS.md. Configured HTTPS access and optional remembered pairing are implemented locally; see HELPER_CONNECTIONS.md. Before release: finish actual-model, broader fault/permission and final release evidence; finish the broader helper fault/navigation campaign; inspect publication/hosted evidence. Actual self-hosted inference, richer explicit route/mode evidence and the full native parity map remain unproven. Don't label the complete port finished from this slice.
