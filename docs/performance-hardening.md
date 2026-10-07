# Streaming performance hardening

> Follow-up: see [resource security, dependency and video-only fixes](security-playback-follow-up.md). This document retains the earlier checkpoint and its historical limitations. The follow-up is not deployed.

## Runtime ownership

The API/control service supervises a **separate Node media process**. The API owns authentication, administration, chat membership and Socket.IO delivery. The media process owns RTMP/FLV sessions, publisher state, recording and FFmpeg relay/conversion children. Small control/telemetry messages cross IPC; encoded media does not travel through the API process.

This separates their event loops, not their network interface or host capacity. It is not a distributed media cluster: run **one API instance** for this deployment. Starting several copies with PM2 cluster mode would contend for the same media ports and shared state. A multi-origin/edge deployment needs explicit publisher routing and distributed ownership.

## Slow clients and dependency maintenance

`apps/backend/lib/media-safety.js` is a maintained adapter for **node-media-server 4.2.4**, pinned exactly in the backend manifest. It adds bounded transport handling and recording lifecycle cleanup without making disposable edits inside `node_modules`. Load it before media sessions are constructed. Do not upgrade the dependency without updating and exercising the compatibility guard and regression suite.

Slow consumers must not pause the shared publisher or cause arbitrary FLV packet drops. The overload policy disconnects an offending consumer so healthy viewers can continue. Recording write failures are treated separately from viewer congestion. Transport queue limits are not a promise that every source of process or kernel memory is capped.

Default adapter limits:

- Transport reservations: 4 MiB per network session, 8 MiB per recording, 128 MiB aggregate. Slow network writes have a 5-second deadline; recording writes have a 10-second deadline.
- Retained GOP media: 16 MiB per broadcast and 128 MiB aggregate across both FLV and RTMP representations. Cache overflow drops the cached GOP until the next keyframe, not packets being delivered to active viewers.
- Active-session admission: 8,192 entries, including publishers and recordings. This is a registry bound, not a supported-viewer capacity claim.

GOP and transport limits are separate budgets. Codec/metadata headers, transient parser allocations, application heap, kernel buffers and filesystem cache are not included; these settings are **not a total RSS cap**.

## Presence, statistics and pagination

- A viewer receives a compact snapshot for its joined channel, not every channel's username list.
- The authenticated admin dashboard receives aggregate statistics. Detailed viewer lists are fetched on demand from an authorized endpoint.
- Joining, switching channels and disconnecting update a single membership registry. Socket presence is **not proof of video decoding or successful playback**.
- Stream, viewer and recording lists use `offset` and `limit`, return JSON arrays, and expose `X-Total-Count` and `X-Next-Offset`. An empty next-offset header means there is no next page.
- Stream search/filter/order happen before pagination. Do not fetch one page and present a local filter as a search over the whole catalog.
- Statistics collection is serialized rather than overlapping when Redis or PostgreSQL is slow. Changes to channel settings invalidate cached metadata.

Custom clients that depended on globally broadcast username arrays must move to the scoped event and authorized detail APIs.

## Observability

`GET /api/metrics` requires an administrator bearer token. It reports API and media process measurements separately. The admin statistics payload also carries process telemetry. Each process sample has `sampledAt` (Unix milliseconds) and `sampleSequence`; repeated HTTP reads do not create a fresh sample. The load harness rejects missing, stale or non-advancing samples instead of trusting an old RSS value.

Interpret the units carefully:

- Process CPU is expressed in **percent of one logical core**, not percent of the entire host. Combined process CPU can exceed 100%.
- RSS, JavaScript heap and external/buffer memory describe different allocations. RSS that remains elevated after a run is not, by itself, proof of a leak.
- HTTP-FLV media egress is separate from ingest bitrate and estimated restream traffic. Presence sockets and media connections are different counts.
- Event-loop delay, queued data, slow-client disconnects, errors and child-process availability matter alongside throughput.

Use long-duration measurements to establish whether memory stabilizes. When comparing old and new versions, include **both** Node processes; reporting only the API's now-smaller CPU/RSS would be misleading.

## Reproducing tests and load measurements

Use the root README for setup and isolated test configuration. `npm test` runs workspace suites and `npm run build` creates the production frontend build. Test ports, PostgreSQL/Redis state, and recording files must be isolated from the running application. Use a dedicated temporary recording root; a separate database alone does not protect production files.

The repeatable load harness and its safety/cleanup options are documented in [`scripts/performance`](../scripts/performance/). Run its unit tests before using it. Load tests create a uniquely owned temporary channel and must remove only their own fixtures and processes. Keep generated reports and credentials outside Git.

For a capacity claim, validate all of the following:

1. Real encoded media reaches every healthy receiver at the expected bitrate.
2. Slow/stalled consumers are isolated without harming fast consumers.
3. API latency and errors stay acceptable while media traffic is high.
4. Memory, queue depth and connection counts stabilize during a sustained run and repeated connect/disconnect cycles.
5. Repeated recording start/stop, finalization, media-child recovery and application shutdown do not leak resources.
6. Real browsers can play, pause/resume, reconnect and receive chat without unbounded buffer or DOM growth.
7. A wired-LAN test checks the actual server NIC, switch and client paths.

Loopback results exercise software on one machine. They are not measurements of the physical LAN, Wi-Fi, WAN or ISP bandwidth, and a short successful stage does not establish a sustained supported viewer limit. Multiple load workers reduce a single-generator bottleneck but still share host resources with the server.

## Playback compatibility limitation

The browser QA publisher uses H264 video plus silent AAC. A video-only publisher stalled in the browser check, while adding AAC allowed playback. The pinned NMS dependency advertises both audio and video in its HTTP-FLV header even when input has no audio; video-only compatibility needs separate work. Transport decoding with FFmpeg does not establish browser MSE playback compatibility.

## Dependency/security scope

Compatible dependency updates are included; node-media-server is deliberately pinned for the adapter contract. At the implementation's dependency-review checkpoint, npm audit fell from 36 findings to 4 high findings in the Prisma tooling dependency chain. The production-only audit also reports these four findings because the installed dependency graph retains the tooling chain; moving a manifest entry to devDependencies does not prove it is absent from the production graph. The reported packages are `prisma`, `@prisma/config`, `deepmerge-ts`, and `mysql2`. A forced major Prisma downgrade or untested transitive overrides were not applied. Rerun `npm audit` against the lockfile before deployment; advisory status can change.

This work is performance and lifecycle hardening, not a complete security assessment or a public-production deployment approval. Existing access-control behavior outside the changed paths must be reviewed separately. In particular, the independent review identified existing stream/recording mutation routes without resource-level authorization and a public stream metadata response that includes the channel password. These are not remedied by scoped telemetry or queue limits; do not treat this branch as approval for an untrusted/public deployment.


## Subsequent security checkpoint (undeployed)

See [Playback and current-principal security boundary](security-playback-boundary.md) for current-DB privilege checks, scoped admission at direct HTTP-FLV/WebSocket-FLV/RTMP boundaries, recording authorization, policy epochs, isolated protocol/browser tests and narrow dependency remediation. The frozen current union is recorded externally in `streaming-security-final.json`. Earlier benchmark and audit results in this document remain historical. The new playbackVersion schema migration was exercised only on the dedicated test database; production migration and deployment are not performed or approved here. No physical-LAN claim is made.
