# Resource security and playback follow-up

**Historical checkpoint:** the subsequent [playback/current-principal security boundary](security-playback-boundary.md) supersedes the open raw-media, retained-JWT and dependency findings described below. The old results are retained as history, not current deployment approval.

This is an uncommitted follow-up on `feature/streaming-performance-hardening`, not a deployment. Existing production services were **not** restarted or reconfigured. The earlier `hardening-validation.md` results describe a historical checkpoint, not the current dependency graph.

## Resource contract

The schema has no creator/owner field. Resource assignment is the server-side `Stream.authorizedUsers` relation; IDs or owner fields supplied in mutation bodies cannot grant access.

- Administrators retain global access, including stream creation/deletion, enabling/disabling channels, and recording deletion.
- Assigned stream managers can edit their channels, but cannot create/delete channels, enable/disable channels, or assign users. A `CLIENT` role suppresses manager privileges unless `ADMIN` is also present, matching the existing dashboard.
- Recording rename/download authorization follows the recording's parent stream. Assigned clients retain the dashboard's existing rename/download functionality, but cannot access disabled streams. Managers may access assigned disabled streams; administrators may access all recordings.
- Resource mutation and recording-download middleware re-reads the principal's current roles from the database. Deleted users and revoked administrator tokens cannot retain these privileges. Catalog reads use the same current-principal check.

## Channel metadata and viewer entry

The anonymous stream endpoint selects only `channelName`, `isLive`, `isDisabled`, and `isPasswordProtected`. Client catalog DTOs exclude channel passwords, ingest keys and restream credentials; administrators and assigned managers retain editor/connection information.

The player sends the entered password with its Socket.IO join request instead of comparing a password downloaded in metadata. The server validates the channel/password and disabled state before membership acknowledgement. Pending joins cannot resurrect membership after leave/disconnect or a newer join. Socket join attempts are bounded per socket, not a comprehensive cross-IP abuse defence.

**Scope caveat:** This corrects metadata disclosure and the viewer-entry check, not every content-access surface. Direct HTTP-FLV/RTMP reads remain ungated by channel password; static recording paths and public recording share links retain the application's existing public-sharing contract. A password-protected viewer page is therefore **not a confidentiality boundary for raw media or shared recordings**. Do not advertise private-content protection or deploy to an untrusted network without a separately designed media/share authorization boundary. Other legacy token-only endpoints and persistent administrator sockets are not a global immediate-role-revocation solution.

## Video-only FLV compatibility

The maintained NMS 4.2.4 adapter tracks received audio/video sequence headers and sets the FLV header bits accordingly. It does not fabricate AAC or set a blanket `hasAudio:false` that would break paired sources. Unknown/early FLV subscribers reconnect when codec topology becomes known; added tracks and publisher teardown also close external FLV subscribers so a fresh MSE pipeline can negotiate the replacement. Internal recording sessions keep their normal finalization lifecycle. The existing bounded player recovery budget still applies.

Real Chromium tests use the actual `livePlayback.ts` implementation, transpiled for an isolated test page, and assert decoded video frames, dimensions and advancing playback. They cover H264-only, H264+AAC and a same-viewer video-only-to-paired publisher replacement with a new media request. Publishers are static black; audio is silent.

## Dependency review

A fresh online audit initially reported 25 findings: one critical, five high and nineteen moderate. Compatible `npm audit fix --ignore-scripts` updates removed the `proxy-addr` critical and `source-map-js` high. A scoped `prisma > mysql2` override to `^3.24.5` replaces Prisma's vulnerable pinned 3.15.3 with a compatible minor update. Prisma/client/config are 7.10.0, and the generated client was regenerated without migrations.

The remaining three production high entries are `deepmerge-ts`, `@prisma/config`, and `prisma`, all from the recursive-object stack-exhaustion advisory in deepmerge-ts <8. Prisma still requires the 7.x line. No forced Prisma downgrade, release-candidate upgrade, or unreviewed deepmerge major override is applied. Nineteen development-only moderate entries remain in the Jest/js-yaml/sprintf-js chain. Full and `--omit=dev` audit evidence is retained externally; development-only entries are a labelled set difference because npm audit has no supported `--omit=prod` mode. No Quill/major feature replacement was introduced.

## Validation boundary

All backend execution uses the dedicated `_test` database, Redis DB1, loopback-only isolated ports and a fresh temporary recording root. Browser credentials and reports stay outside Git. Production database access was limited to a read-only live-stream count before the modest soak. Physical LAN validation requires a known second-device endpoint; none was supplied, and no network scanning was performed.

Final evidence and source hashes: Windows Hermes cache `streaming-fixes-final.json`. Frontend build output is directed to an isolated directory, not the directory served by the existing production preview. No commit, push, deployment or production restart was performed.
