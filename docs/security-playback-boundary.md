# Playback and current-principal security boundary

This is an **uncommitted, undeployed** security checkpoint. It supersedes the raw-media caveat in the earlier resource-security follow-up. No production database migration, service restart, public deployment, MSS edit, or physical-LAN test was performed. The new `Stream.playbackVersion` migration must be reviewed and applied through the normal deployment process **before starting this code against a production database**.

## Authoritative application privileges

`authenticateUser` verifies HS256 identity, then reads the current database principal. JWT role claims are not authorization. All authenticated HTTP endpoints, including user/role/assignment management, settings, metrics, logs, profile, stream details and recording operations, use this policy. Missing users and users with an empty roles array are denied; this schema does not have a separate user-disabled flag.

Privilege-changing transactions lock the acting `User` row, re-read its roles and use Serializable isolation. User creation/update/deletion, settings, profile, stream mutations and recording mutations revalidate within those transactions; non-admin stream/recording writers also recheck their current assignment. Serialization failures fail closed rather than being retried with stale authorization. Stream-stop side effects follow the authorized deletion transaction. Administrator password management and self-password changes remain supported; profile updates cannot change roles. Mutation responses no longer return password hashes.

There is **no owner column**. `Stream.authorizedUsers` is the existing assignment contract. Administrators have global management rights. Assigned managers can edit their streams but not create/delete/disable streams. CLIENT suppresses manager mutation privileges unless ADMIN is also present. Assigned clients retain recording rename/download rights for enabled streams. Assigned managers and administrators retain authenticated archive access to disabled streams; disabled channels cannot issue public playback grants. Admin-only recording deletion remains admin-only.

Socket handshakes resolve current principals. Dashboard joins, kick and stop commands recheck current admin status. Administrative broadcasts select current admins instead of trusting retained dashboard-room roles. An independent authorization collector disconnects removed/empty-role principals and invalid channel memberships; it is not blocked by a stalled telemetry collector.

## Public and protected content

Enabled public channels continue to allow anonymous HTTP-FLV, WebSocket-FLV and RTMP playback, including ordinary flv.js embeds. Public recording metadata, GET/HEAD/ranges and share pages remain anonymous. No MSS source or configuration was modified; browser tests exercise the anonymous flv.js request shape, not the MSS application itself.

For a protected channel, the server issues a capability only after a correct channel password or a current authorized account (administrator or assigned user):

- Socket.IO `join_channel` returns a live capability after authorized membership acknowledgement. Membership has a separately scoped server-held credential.
- `POST /api/public/streams/:channelName/playback` accepts a password in the JSON body or an authenticated current principal. Only `live`, `recording`, and `membership` purposes can be requested.
- `POST /api/public/recordings/:id/playback` exchanges the associated channel password/current account for a recording capability, without disclosing a private file path beforehand. An unexpired recording capability can be renewed, retaining its account binding when applicable.
- The React player propagates the returned live credential into the **actual FLV request**, not just the page or socket join. It renews from authorized socket membership; reconnect/resume resolves the latest credential. Share playback renews recording credentials and restores the playback position when its URL changes. Failed renewals return to authorization rather than bypassing it.

Capabilities are HS256 JWTs with a purpose allowlist, fixed issuer/audience, channel name and stream ID, and a 120-second admission lifetime. Their signing key is HMAC-derived from the existing `JWT_SECRET` with the domain `streaming-platform/playback/v1`; there is no new environment secret, fallback key, client-side signing key, or ingest-key reuse. Policy fingerprints are keyed hashes, not plaintext passwords. Account-backed grants additionally bind the current roles, password hash and account update timestamp. Playback tokens are not accepted as login JWTs.

The installed flv.js type definitions expose `Config.headers`, so HTTP-FLV can support custom headers. This implementation uses a scoped query capability to share a transport mechanism with browser WebSocket-FLV and native recording `<video>` requests, which cannot set arbitrary authorization headers. It does not use cross-origin cookies. Passwords and ingest keys are never substituted into viewer URLs. Application/NMS logs do not log capability queries; **reverse proxies and access-log collectors must redact `cap` and apply appropriate retention**. TLS is required for untrusted-network use. A bearer capability can be replayed by someone who obtains it during its admission lifetime; this is not DRM or protection against authorized redistribution.

## Actual protocol admission

`lib/playback-gate.js` wraps each safety-adapted NMS session's `onPlay` **before `run()` registers protocol callbacks**. The original NMS play function, cached GOP delivery, and subscriber registration are not called until authorization resolves. An async `prePlay` EventEmitter listener would not provide this boundary and is not used. Pending play has a five-second deadline; closure cancels the wait. Rebinding or switching to publish while play authorization is pending is rejected, including commands already parsed from the same RTMP buffer.

`lib/media-worker.js` installs this wrapper for both `flv_session` and `rtmp_session`, protecting direct media ports as well as API-assisted viewers. Existing publisher-key admission, packet buffering, bounded GOP caches and internal recording lifecycle flags remain intact. No per-media-packet database lookup or per-viewer media payload copy was added.

FFmpeg restream input uses a separate `relay` credential. It is valid only for RTMP on loopback and the exact currently active publisher generation. It is never issued by the public API and cannot authorize browser FLV or archive access. Relay authority follows its publisher, not the viewer password; viewer privacy/password changes do not unnecessarily break an authorized producer's existing relay. Disable, publisher replacement/removal or channel identity change invalidate it. This is not a generic localhost bypass.

## Revocation and established-session semantics

Each new protected admission checks current channel policy and, for account grants, current account/assignment state. API changes to password, privacy, disabled state or channel identity increment `playbackVersion`. Restoring an old password or toggling a privacy setting back therefore does not revive earlier grants. Direct database maintenance that changes authorization policy must also increment `playbackVersion`; do not reset it. The policy fingerprint additionally detects current password/privacy/disable changes made outside the API, but a direct database change-and-restore without an epoch increment is not a durable revocation operation.

Active media and socket memberships are revalidated by **independent** two-second authorization collectors, with a five-second sweep deadline and fail-closed disconnection on lookup failure. Channel/account reads are memoized per sweep. These collectors do not depend on telemetry Redis writes or metadata collection completing. Under a responsive event loop, a failed/stalled authorization lookup closes affected sessions within the next sweep plus its deadline; this is not a hard real-time guarantee under an OS/event-loop stall.

The 120-second expiry governs new admission and recording HTTP/range requests. Established live sessions do not stop merely because their admission token expires; current policy/account revocation is checked separately. Recording requests are authorized before `sendFile`/`download`, including HEAD and ranges. Already admitted file transfers and bytes already downloaded cannot be retroactively recalled. New requests after expiry/revocation must obtain fresh authorization.

## Recording filesystem boundary

There is no anonymous `Express.static(RECORDINGS_ROOT)` mount. The API resolves recording metadata, authorizes the associated stream, verifies the path remains under the real recording root (including symlink resolution), and only then sends the file. Unknown paths, traversal and symlink escapes fail closed. Private anonymous metadata does not reveal recording paths. The media worker config does not expose a recording static root or enable an alternate NMS API/static mount. Tests also probe direct media-port recording URLs.

Authenticated download still follows the administrator/assignment policy above. Playback credentials authorize reads, never rename/delete or channel/user management.

## Dependencies

The promoted lock uses narrow scoped overrides:

- `@prisma/config > deepmerge-ts: 8.0.2` (Prisma/config/client remain 7.10.0).
- `@istanbuljs/load-nyc-config > js-yaml: 4.3.2`; its observed consumer uses `load`, not the removed `safeLoad`. This moves the chain to argparse 2.0.1 and removes sprintf-js rather than inventing a patched sprintf-js release.
- The existing `prisma > mysql2` compatible override is preserved.

Compatibility was evaluated in an isolated dependency copy. The accepted npm 10.9.9 targeted update changed only five lock entries: deepmerge-ts, js-yaml, argparse, and the npm-pruned esprima/sprintf-js entries. A broad regenerated candidate was rejected. Fresh `npm ci`, config load, Prisma validate/generate, migration deployment/status on the dedicated `_test` database, backend queries/tests, frontend tests/build/lint, native media tests, dependency-tree checks and full/production audits were exercised. Full and production candidate audits returned zero findings. No forced Prisma downgrade, nonexistent js-yaml patch, or blind major override was adopted.

## Reproducible checks and references

- `apps/backend/tests/resource-security.test.js`: exact stale-admin self-restoration chain, all-route removed/empty-role denial, revocation during password hashing, current privilege/password flows, socket downgrade, and revocation with stalled telemetry.
- `apps/backend/tests/playback-security.test.js`: actual direct HTTP-FLV/WS-FLV/RTMP denial and success, anonymous public compatibility, capability scope/rotation, active revocation, protected archive metadata/GET/HEAD/range, password exchange/renewal and traversal/symlink checks.
- `apps/backend/tests/playback-auth.test.js`: synchronous admission withholding, same-buffer rebinding/publish rejection, cancellation, token expiry/purpose/channel/epoch and relay-generation scope.
- `apps/backend/tests/media-runtime.test.js`: protected-channel internal RTMP relay, publish-key rejection, recording finalization, worker restart and finite HTTP-FLV frame preservation.
- Frontend `playerLifecycle`, `livePlayback`, and `routeRequests` suites cover capability propagation, stale acknowledgements, cleanup, password exchange and archive renewal position.
- Reviewed runtime sources: installed NMS 4.2.4 `src/session/{flv,rtmp}_session.js`, `src/server/{http,broadcast}_server.js`; flv.js `d.ts/flv.d.ts` (`Config.headers`); local `lib/media-safety.js` and `lib/publisher-auth.js`. The version-pinned constructor adapter must be reviewed again before changing NMS.

External artifacts are under the user's Hermes cache: `streaming-security-browser.json`, dependency evaluation reports, RED/GREEN logs, and the final `streaming-security-final.json` union/hash manifest. Real Chromium decoded static-black H264-only and H264+AAC through the actual protected React viewer, anonymous embed, and protected recorded MP4 share page. No real uploads, external restream providers, flashing test patterns, high-load soak, or physical-LAN capacity claims were used. Final independent approval belongs to the parent review of the frozen manifest, not this implementation report.
