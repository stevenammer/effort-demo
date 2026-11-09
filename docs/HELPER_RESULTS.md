# Structured helper results and exact input receipts

This is the unpublished schema14 / backup16 continuation on feature/thread-review-20261109. Published main remains869649e. See CURRENT_STATE.md for verification and release gaps.

A checked v2 companion returns an actual result type, display text, source-attributed claims, assumptions, uncertainties, a recommendation, optional proposals and an uncalibrated confidence label. The actual type may differ from the requested type. NO_ACTION and BLOCKED remain valid. Claims cite only IDs in the approved context; those links establish attribution, not independent factual truth. Unknown confidence is valid. These fields appear inside the existing thread or request directory, without adding controls to Home.

Every accepted structured answer preserves the exact model JSON alongside its parsed result. Its sealed attempt also carries the exact prompt and checksum, prompt-contract version, role/model, declared context window, stop reason, available token counts and provider timestamp. The raw response and execution receipt have an explicit disclosure and exact download. This records the bridge's observation; it doesn't prove model attention, provider honesty, calibrated confidence or process isolation.

New approved source snapshots preserve whether the input is captured writing, a prepared model answer, a separate revision proposal or a distillation proposal. Captured writing's authorship isn't verified. Model-derived input is identified in both the approval UI and actual prompt. Metadata seals bind that origin to the selected capture. Old approvals and answers remain byte-for-byte unchanged, with unknown legacy attribution or absent structured metadata stated explicitly. No retrospective confidence, claims or execution receipt is invented.

A person may prepare the whole exact answer or one exact item from its proposals array. Each choice has an immutable, canonical identity tied to the answer ID/checksum and optional field/index. Preparation creates a source-linked model proposal and leaves NOW unchanged. A subsequent explicit quote choice uses that new proposal's own text offsets. Retry and backup restoration reuse the accepted proposal.

## Runtime contract

The companion uses Ollama's documented [structured outputs](https://docs.ollama.com/capabilities/structured-outputs) format parameter and validates the result after generation. Its [chat API](https://docs.ollama.com/api/chat) request is non-streaming, with thinking disabled, an explicit context window, a bounded output allowance and keep_alive0. A complete stop reason is required. Tool calls, foreign source IDs, malformed JSON, excessive payloads, incomplete output and protocol downgrades are refused. Explicit v1 requests remain supported for compatibility; they don't acquire invented v2 metadata.

EFFORT_HELPER_CONTEXT defaults to8192 and accepts2048 through32768. A non-inference model-information request must confirm the configured window. Before generation, the bridge conservatively compares encoded prompt bytes plus output/reserve allowance against it. Excess context is refused, never silently trimmed. This byte-based preflight isn't a measured tokenizer or a guarantee about model templates. Real-model boundary verification remains required.

Any resident model causes refusal, including the same model, because the bridge can't infer whether it is idle. This bridge doesn't replace the owner's shared generation lease. No model was loaded by this continuation's tests.

Before starting inference, the workspace reserves196608 bytes per running attempt within its helper-history budget. Other approvals can't consume that reservation. The structured envelope itself is limited to160000 encoded bytes. Capacity refusal occurs before dispatch and preserves earlier writing, answers and choices. Legacy imported history isn't silently discarded to make room.

## Evidence and remaining work

The parent full suite passes282 tests. Contract tests cover exact raw JSON and receipt backup, model input attribution, selected-item identity/retry/quote choice, genuine legacy restoration, forbidden source IDs, malformed embedded receipt refusal, strict protocol agreement and ambiguous readback recovery without another inference. Capacity fixtures fill history near its limit and test competing approval writes. Real HTTP fixture tests cover declared context, non-truncation, resident-model refusal, stop reasons, malformed output and authentication/origin boundaries.

The new browser suite passes1440/390/320 using the actual companion and a synthetic Ollama server. It checks attributed claims, actual type, raw downloads, separate proposal choice, model-derived input in the next prompt, literal hostile text, backup16/reset/restore and offline reading. Broader browser and old-client upgrade evidence is recorded in CURRENT_STATE.md as it completes.

Cross-device HTTPS/pairing continuity, actual self-hosted inference, wider permission/fault campaigns and publication/hosted gates remain. The full native parity map also remains active. This checkpoint isn't a complete port or a release claim.
