# Mobile HTTP-FLV playback candidate

Reported device: iPhone, Chrome, iOS **26.6.2** (user-provided literal; not independently inspected).

## Selection and scope

Keep flv.js 1.6.2 on existing MediaSource browsers. Use pinned mpegts.js **1.8.2** only when ManagedMediaSource is a constructor and MediaSource is not a constructor. No user-agent sniffing, global alias, backend packaging, HLS URL, nginx change or autoplay policy change. The same grant suppliers, header-only delegated endpoint, retry budget, pause/resume and refresh/unmount interface serve both engines. This intentionally avoids migrating desktop playback during an iPhone repair; a later consolidated-engine migration needs independent regression evidence.

MMS is attached by the library via `srcObject`; ordinary MSE remains its existing blob URL path. Set playsInline before attachment. With no native HLS/AirPlay alternative, explicitly disable remote playback for MMS (AirPlay is consequently unavailable). Keep initial play policy unchanged: blocked play releases media and exposes existing Resume live, which recreates playback from a user action. Manager starts muted as before; ordinary watch does not become muted/autoplay-by-default.

The selected constructor's H264/AAC support is checked by the engine. Actual codec/format failures from the demuxer and native unsupported/decode events get safe actionable messages. Do not display raw errors/URLs/capabilities. There is no promise that every H264 profile or every encoder input works on every iPhone; the observed public stream was H264 High 3.2 plus AAC.

## Managed streaming and buffering

mpegts.js 1.8.2 registers/removes startstreaming/endstreaming/qualitychange listeners. Its supported LIVE implementation deliberately continues transmuxing across start/endstreaming hints; the pause/resume hint behavior is for seekable non-live input. Do not pretend it pauses live HTTP-FLV on those hints or patch private internals: restarting this non-seekable stream changes live-edge and grant semantics. Buffer cleanup remains enabled at 30 seconds maximum backward / 10 seconds minimum backward; no stash or lazy-loading. User pause, autoplay rejection, terminal UI failure and unmount destroy the player and ingestion. Refresh recreates the source with the current grant. Actual WebKit eviction, backgrounding, battery behavior and long-session resilience still require device testing.

Native browser QA exposed an existing stale teardown-pause counter: load() can discard the queued pause event, causing the next real user pause to be ignored. The candidate checks current native `paused` state instead. Both delivered and discarded teardown events have regression tests, plus real Edge pause/resume after grant refresh for both engines.

## Upstream research and supply chain

- https://webkit.org/blog/14735/webkit-features-in-safari-17-1/ — iPhone MMS since 17.1; requires AirPlay source alternative or disabled remote playback.
- https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/ — source selection and startstreaming example. Native HLS alternate is useful only when one actually exists.
- https://github.com/xqq/mpegts.js/releases/tag/v1.8.0 — introduces supported MMS.
- https://github.com/xqq/mpegts.js/releases/tag/v1.8.1 — iOS 26 constructor detection and Safari 26.5+ AAC timeline fix; removes GitHub webworkify dependency.
- https://github.com/xqq/mpegts.js/releases/tag/v1.8.2 — fixes shipped worker build regression. Registry reports release 2026-08-14, latest 1.8.2 when checked.

Exact install: mpegts.js 1.8.2 (Apache-2.0); events 3.3.0 (MIT); shared existing es6-promise 4.2.8 (MIT). Registry HTTPS tarball plus SHA512 integrity are locked. No Git dependency, no lifecycle install scripts, install performed with --ignore-scripts. Existing desktop flv.js remains unchanged. A fresh production audit currently reports three high and three moderate findings in the existing graph; none is attributed to mpegts.js. Advisory scanning is not proof of absence of vulnerabilities or a complete source audit. Preserve distributed third-party notices at /mobile-playback-licenses.txt. Future updates must explicitly change the pin, review release/source changes and lock delta, rerun audits, full tests, real decoding/header/lifecycle fixtures and physical iPhone checks. No auto-upgrade to latest.

## Evidence and activation gate

External evidence and the isolated LAN-configured candidate build are under Windows Hermes cache `streaming-lan-access/iphone-fix/`; the LAN dist was not replaced. Browser QA uses an ephemeral loopback static server and the existing LAN API/media. The MMS-shaped Chromium fixture runs the real mpegts library and real decoding but maps srcObject onto Chromium's MSE. It is **not WebKit or physical iPhone verification**. Synthetic fixtures are black/silent; live stream decoding is headless/muted, without screenshots or retained media.

Do not deploy this candidate until independent review of the frozen source/diff/build manifests. After review, activate only the LAN frontend by preserving the current LAN dist, copying the frozen candidate to an owned sibling directory and atomically swapping the frontend directory; read back exact served HTML/asset hashes. No API/media restart, nginx config, publisher change or local frontend dist replacement is required. Retest desktop first; then have the user hard-refresh Chrome on the reported iPhone 26.6.2, Join, Resume live if offered, verify moving picture/audio, pause/resume, rotate, background/foreground and playback beyond grant renewal. Retest embed/manager muted preview and audio handoff if used on that device. Roll back only the static directory if regressions occur. If the phone still cannot support the format, capture the safe displayed error and device capabilities; authenticated HLS is a separate backend project requiring explicit approval, not a guessed fallback endpoint.
