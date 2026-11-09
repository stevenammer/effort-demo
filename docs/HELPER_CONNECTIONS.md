# Configured HTTPS companions and remembered pairing

Unpublished continuation: schema15 / backup17 imports1..16. Main remains869649e. Older strict readers are fenced from new HTTPS approval routes. The browser has a working HTTP loopback route and an explicit HTTPS route for a separately operated companion. This isn't automatic access to the owner's private stack.

## Operator configuration

For a service on another device, configure its reachable HTTPS origin and an existing certificate trusted by the visiting browser. Configure your own Ollama backend and installed model as in THREAD_REVIEW.md. Example placeholders below aren't live endpoints or credentials:

```sh
EFFORT_HELPER_SELF_HOSTED=1 \
EFFORT_HELPER_MODEL='YOUR_INSTALLED_MODEL_TAG' \
EFFORT_HELPER_ORIGIN='https://YOUR_COMPANION_HOST:4319' \
EFFORT_HELPER_TLS_CERT='/YOUR/CERTIFICATE.pem' \
EFFORT_HELPER_TLS_KEY='/YOUR/PRIVATE_KEY.pem' \
EFFORT_HELPER_LISTEN='YOUR_DEVICE_IP' \
npm run helper
```

EFFORT_HELPER_PORT still defaults to4319. The advertised origin must reach this listener with its exact Host header. Non-loopback listeners require explicit HTTPS. The default remains a127.0.0.1 HTTP listener, so existing local use needs no certificate. Certificate issuance, DNS, firewall access and deployment to someone's device aren't performed by this app. The browser can still ask for local-network permission. TLS/origin checks establish a configured connection, not an independent audit of the operator or model.

The companion terminates TLS directly, requires the exact configured Host and permitted browser Origin, and authenticates each non-preflight request. It doesn't trust X-Forwarded-Host to rewrite the reviewed route. The reviewed HTTPS origin, explicit private backend and installed model must match at dispatch and readback. Paths, embedded credentials, query tokens and insecure non-loopback HTTP origins are refused. Backend restrictions, zero tools, no automatic model fallback, capacity/context limits and explicit invitation/start boundaries continue to apply.

The static page and local preview CSP allow HTTPS connection requests as well as HTTP loopback. Application controls still require an explicit configured connection check and an approved start before source egress. The service worker's own connection policy remains same-origin only; helper requests and credentials aren't offline cache entries. This is a broader connection capability than the earlier loopback-only policy, not an endpoint allowlist or a substitute for preventing script injection.

## Browser pairing

A token stays in the current tab by default. After a successful check, the optional **Remember this connection in this browser** choice saves the exact endpoint and token as plaintext in that browser profile. It is off by default. On reload, saved fields are prefilled, but no request is sent and no model starts. Check again before approving or starting a helper. Remembering doesn't preserve a previously observed health claim.

Credentials live outside workspace records, drafts and exported backups. Reset clears them. **Forget connection** clears local credentials and current checked status; it doesn't revoke a server token or assert termination of a running request. Stop an owning attempt separately, or rotate the companion's token to revoke it. Unchecking Remember clears its saved copy. Storage/readback/deletion failures are reported without claiming persistence or erasure. Invalid remembered data is ignored and can be explicitly forgotten.

## Evidence and remaining work

Parent full suite passes290 tests;37 browser/worker modules pass syntax. The real TLS fixture trusts its generated temporary certificate through an explicit CA, verifies an accepted HTTPS result/receipt/backup and refuses bad Host, Origin and token before backend access. An untrusted forwarded Host doesn't alter the configured route. Pairing fixtures cover readback failure, unavailable storage, invalid origins, corrupt/oversized data and forgetting. The first tests exposed a null-URL validation hole in pairing/configured routes; string guards now refuse it.

Chrome acceptance passes1440/390/320 with the actual HTTPS companion and synthetic Ollama server: explicit check, remembered reload without requests, fresh recheck, two deliberate model calls, raw structured receipts, individual proposal/quote choice, forgetting, reset credential removal, backup17 restore and offline reading. Temporary self-signed fixture certificates are accepted only in these isolated test contexts. Production use still requires the visiting browser to trust its operator's certificate. Test certificates and private keys are generated under a private temporary directory and removed, never tracked.

Broader workflow/upgrade/fresh-checkout evidence is recorded in CURRENT_STATE.md as it completes. Actual cross-device connectivity on a user's network, real self-hosted inference, broader fault/permission campaigns and release/hosted gates remain. No private backend was changed, no model was loaded and this branch isn't deployed.
