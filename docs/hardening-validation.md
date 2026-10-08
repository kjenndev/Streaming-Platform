# Hardening validation

## Stability follow-up candidate

The first session/login-limit stability slice is implemented and tested on `feature/streaming-stability` from merged main `463b88c`. See [session and login-limit stability](stability-auth.md) for the new 401/403/5xx contract, socket expiration, frontend recovery, limiter correction and exact validation scope. It is **not deployed or independently approved**. Recovery/operational work and independent security verification remain open. The previous checkpoint below is historical; its expired-session and successful-login charging caveats are addressed in this candidate, not yet in the running user services.

## Merged development checkpoint — 2026-10-07

Branch: `feature/streaming-performance-hardening`. This is a **DEVELOPMENT CHECKPOINT**, not production-readiness or independent security approval. The latest independent security review is incomplete because of a provider filter; it did not pass. The user authorized committing and pushing this checkpoint and will handle any merge. A merge to main does not automatically deploy.

Final checkpoint checks passed: 82 backend Jest tests, 42 frontend Vitest tests, 55 performance-harness tests, and 38 native media tests; frontend TypeScript/Vite build and lint; installed dependency-tree validity and whitespace checks. Fresh full and production npm audits each returned zero vulnerabilities. Tests used the dedicated `_test` PostgreSQL database, Redis DB1, isolated recording directories and test ports. The build went to an isolated output directory, not the served frontend build.

The playbackVersion migration and updated application have subsequently been deployed **locally for user-authorized testing**, with external evidence in `streaming-local-rollout.json`. A later authorized local account-maintenance operation and rate-limiter restart changed only database/runtime state, not this source checkpoint. Earlier statements below and in linked implementation reports about an undeployed migration or local authentication status describe their historical checkpoints, not current local state.

Remaining caveats: independent security approval is outstanding; physical-LAN capacity and multi-hour endurance remain unverified. Expired-session failures can still surface as generic UI errors, and the login rate limiter counts successful logins as well as failures. Local operation and passing automated tests do not establish public-network production readiness.

The original 126-file source union was verified against `streaming-security-final.json` before final checks. Only this documentation status was updated afterward; the exact revised hashes and commit/push evidence are recorded outside Git in `streaming-checkpoint-preflight.json` and `streaming-checkpoint-push.json`. No secrets, runtime recordings, database dumps, or external QA artifacts belong in this checkpoint.

## Historical validation — 2026-09-26

> Follow-up: see [resource security, dependency and video-only fixes](security-playback-follow-up.md). The sections below retain earlier evidence and limitations, superseded where noted by the current checkpoint above.

## Verified

- Backend Jest: 56 tests; frontend Vitest: 35 tests; performance harness: 55 tests passed. Production build, frontend lint and whitespace checks passed. Source hashes confirm only documentation changed after the integrated test seal.
- Four recording cycles: live decode, saved-recording decode, resource cleanup. Forced media-child termination: API stayed alive and playback decoded after child restart. Real finite HTTP publication/recording and graceful shutdown are covered by the integration suite.
- Chromium: actual FLV playback, chat, viewer detail, lost-join-ack timeout/retry, bounded 45-second pause, resume, membership cleanup. Forced network/socket interruption recovered through an **explicit user retry**, not proven automatic recovery.
- The browser console network error during deliberately offline testing was expected. Earlier strict browser runs failed; the final evidence passes after polling-transport join instrumentation was corrected.

## Local loopback measurements

Static black 720p30 H264 plus silent AAC. No Internet bandwidth benchmark. Chat every 2500 ms per worker, presence polling, ten connection replacements per stage (capped at stage size).

- 1 viewers, 15.0 measured seconds: 1 healthy, minimum 4.013 Mbps/viewer, aggregate 4.0 Mbps, public API p95 9.51 ms; zero viewer/API errors.
- 100 viewers, 30.0 measured seconds: 100 healthy, minimum 4.019 Mbps/viewer, aggregate 401.9 Mbps, public API p95 6.70 ms; zero viewer/API errors.
- 250 viewers, 30.0 measured seconds: 250 healthy, minimum 4.017 Mbps/viewer, aggregate 1004.2 Mbps, public API p95 5.43 ms; zero viewer/API errors.
- 500 viewers, 180.0 measured seconds: 500 healthy, minimum 4.014 Mbps/viewer, aggregate 2007.0 Mbps, public API p95 8.82 ms; zero viewer/API errors.

- Slow-reader phase: ten paused transports plus one normal viewer for 60.0 measured seconds. Server slow-disconnect counter increased by 10; the normal viewer maintained 4.015 Mbps, API p95 4.23 ms. Counters are global, but the QA deployment was isolated. Kernel buffers were not measured.
- Run-wide sampled peak RSS: API 175.65 MiB; media 516.07 MiB. Separate maxima, not a simultaneous sum, not a long-run leak bound.
- All benchmark workers/publisher stopped and the exact owned fixture was verified removed.
- An earlier chat-every-1000-ms run correctly failed the acknowledgement gate: it exceeded the five-messages-per-ten-seconds server policy. Later capacity stages were not reached in that run. The rerun preserved the rate limiter.

These are short synthetic loopback measurements, not a sustained physical-LAN capacity guarantee. The 500-viewer stage lasted three minutes; no 1000-viewer validation or multi-hour soak is claimed. Load workers share the server host, and receivers consume transports rather than decoding 500 browser videos.

## Preserved and running

Production configuration hashes and stable database content matched the pre-change snapshot (one user, one stream, nine settings, no recordings). Volatile live/timestamp fields are excluded from content hashes. The existing password was not reset. The saved local admin credential file does not authenticate; browser/runtime QA used an isolated test database.

After confirming zero live production streams, the production backend was gracefully restarted on the final source. API 3000 responded; media ports 8000/1935 listened. The production frontend preview at http://localhost:5175 returned HTTP 200; the dev frontend remains at http://localhost:5174. Loopback preview availability is not LAN deployment verification.

## Remaining limitations

- Four high production dependency-audit findings remain in the Prisma-related chain; no forced downgrade or untested override.
- Existing resource-authorization gaps and public channel-password metadata described in `performance-hardening.md` remain outside this performance scope. Do not deploy to an untrusted/public network as-is.
- Browser QA requires H264 plus AAC. Video-only FLV compatibility remains unresolved.
- No physical LAN soak or long-duration memory-stability guarantee.

## Evidence

Operational evidence is outside Git, under `~/.local/state/streaming-platform/`:

- `verification-final/results.json`, test/build/lint logs and `source-seal.json`
- `smoke-results.json`
- `performance/hardening-stages-1790462212.json`
- `preservation-before.json`, `preservation-final.json`

Chromium evidence: Windows Hermes cache `streaming-browser-evidence/results.json`. No credentials or stream keys are included in this report.


## Subsequent security checkpoint (undeployed)

See [Playback and current-principal security boundary](security-playback-boundary.md) for current-DB privilege checks, scoped admission at direct HTTP-FLV/WebSocket-FLV/RTMP boundaries, recording authorization, policy epochs, isolated protocol/browser tests and narrow dependency remediation. The frozen current union is recorded externally in `streaming-security-final.json`. Earlier benchmark and audit results in this document remain historical. The new playbackVersion schema migration was exercised only on the dedicated test database; production migration and deployment are not performed or approved here. No physical-LAN claim is made.
