# Loopback / private-LAN performance harness

Entrypoint: **`node scripts/performance/run.cjs`** from the repository root in Linux/WSL. Requires Node 22+, FFmpeg with libx264/AAC, `getconf`, and installed workspace dependencies (`socket.io-client` resolves from the frontend workspace). Start the backend, database, Redis, and media child yourself. The harness never starts, restarts, resets, or reconfigures those services.

Use an isolated test deployment: creating/deleting a temporary channel and generating load are deliberate side effects. No public Internet target or WAN speed test is supported. Unit/mock orchestration coverage is supplemented by an authorized isolated loopback run; see [validation evidence](../../docs/hardening-validation.md). Re-run against your own deployment before making capacity claims.

## Commands

Run unit tests and syntax checks, without application access:

```bash
node --test scripts/performance/*.test.cjs
for f in scripts/performance/*.cjs; do node --check "$f" || exit; done
node scripts/performance/run.cjs --help
```

Only when authorized to generate load:

```bash
mkdir -p "$HOME/.local/state/streaming-platform/performance"
export BENCHMARK_ADMIN_FILE="$HOME/.local/state/streaming-platform/admin.json"

# First smoke: one viewer, no slow-reader phase.
node scripts/performance/run.cjs --stages '1:15' --slow-viewers 0 \
  --output "$HOME/.local/state/streaming-platform/performance/smoke-$(date +%s).json"

# Default 1/100/250/500 stages, followed by 10 slow readers + 1 normal sentinel.
node scripts/performance/run.cjs \
  --output "$HOME/.local/state/streaming-platform/performance/run-$(date +%s).json"

# Explicit larger progression, chat, presence API polling, and churn.
node scripts/performance/run.cjs --stages '1:15,100:30,250:30,500:60,1000:60' \
  --slow-viewers 20 --slow-seconds 90 --churn 20 --chat-ms 2500 --presence-ms 1000 \
  --output "$HOME/.local/state/streaming-platform/performance/extended-$(date +%s).json"
```

Credential file: JSON object with `username` and `password`; keep owner-only, mode `0600`. Alternatively use **`BENCHMARK_USERNAME` / `BENCHMARK_PASSWORD`** through your secret manager. Legacy `BENCHMARK_ADMIN_USERNAME` / `BENCHMARK_ADMIN_PASSWORD` aliases also work. File takes precedence. Login must return the `ADMIN` role. No direct DB access or seed scripts. Credentials/token/stream key are not written to evidence or console; children receive a minimal environment without credentials. FFmpeg necessarily receives its temporary RTMP key in its process arguments, visible to privileged local users. Its stderr is suppressed to avoid logging that URL.

Defaults: API `http://127.0.0.1:3000`, HTTP-FLV `http://127.0.0.1:8000`, RTMP `rtmp://127.0.0.1:1935`. Private LAN requires explicit opt-in:

```bash
node scripts/performance/run.cjs --allow-lan \
  --api http://192.168.1.20:3000 --media http://192.168.1.20:8000 \
  --rtmp rtmp://192.168.1.20:1935 --stages '1:15,100:30' \
  --output "$HOME/.local/state/streaming-platform/performance/lan-$(date +%s).json"
```

`--allow-lan` admits only RFC1918 IPv4 / IPv6 ULA initial targets; public initial addresses are rejected. DNS answers are validated and pinned; mixed private/public results are rejected. HTTP redirects are not followed. Pinning can invalidate hostname-only TLS certificates: use an appropriately certified private-IP endpoint, never disable TLS verification. IPv6 scoped link-local addresses are unsupported. Use only trusted servers on these addresses. **FFmpeg is a separate RTMP/RTMPS transport implementation:** initial IP pinning does not establish whether the deployed build follows server-directed reconnects/redirects. This has not been network-verified. For an unconditional LAN-only execution boundary, restrict publisher egress with an OS/network firewall and verify the deployed FFmpeg behavior before running; the harness alone does not provide that guarantee.

## Options

CLI overrides environment. String/numeric options also accept `BENCHMARK_` + uppercase underscored name, e.g. `BENCHMARK_STAGES`. LAN permission requires the CLI flag.

| Option | Default | Meaning |
|---|---|---|
| `--stages` | `1:15,100:30,250:30,500:30` | Exact normal viewers:measured-seconds; descending stages supported; add `1000:60` explicitly |
| `--warmup` | `5` | Viewer warmup seconds, also repeated after churn |
| `--publisher-warmup` | `6` | Publisher startup seconds |
| `--ramp-ms` | `25` | Delay between connections/replacements within each worker |
| `--poll-ms` | `1000` | Probe/safety poll delay, plus request execution time |
| `--timeout-ms` | `3000` | API/snapshot/Socket.IO acknowledgement deadline |
| `--readiness-ms` | `15000` | Deadline after warmup/churn to obtain exact healthy baseline membership and media readiness |
| `--telemetry-max-age-ms` | `10000` | Maximum backend sample age and time without sequence advancement; synchronize LAN clocks |
| `--operation-ms` | `30000` | Overall fixture-list operation deadline; pagination also capped at 1000 pages |
| `--cleanup-ms` | `30000` | Shared cleanup budget including child termination, uncertain-create delay, all pages/deletions/read-back |
| `--rss-mib` | `1200` | **Per-process** API or media RSS harness stop limit, not their sum |
| `--latency-ms` | `500` | Immediate successful API-probe latency stop and final p95 ceiling |
| `--min-mbps` | `3.6` | Minimum measured bitrate of every normal viewer |
| `--slow-viewers` | `10` | Additional paused viewers in final phase; `0` disables it |
| `--slow-seconds` | `60` | Slow-phase measurement seconds; minimum `30`, plus ramp/warmup |
| `--churn` | `0` | Replace this many normal viewers once per normal stage, capped at stage size, before measured interval |
| `--chat-ms` | `0` | One message per worker per interval from its first connected viewer; all viewers receive broadcasts; `0` disables |
| `--presence-ms` | `0` | Poll authenticated viewer-list first page and total count; `0` disables; effective rate limited by poll loop |
| `--output` | required | New absolute JSON path outside repository, existing files refused; parent directory must exist |
| `--api`, `--media`, `--rtmp` | above | Origins only, no credentials/path/query |

The backend accepts at most five chat messages per socket per ten seconds. Use `--chat-ms 2500` for an ordinary chat workload. `--chat-ms 1000` exceeds that policy and is expected to fail the chat-acknowledgement quality gate; it is not a media capacity result.

## Workload and safety

One publisher: **constant black 1280x720, 30 fps**, H264 4 Mbps CBR using `nal-hrd=cbr:force-cfr=1` filler, two-second GOP, plus silent AAC 128 kbps. No flashing visuals. Recording is explicitly disabled and restream URLs are explicitly empty on the temporary UUID-named channel.

Each viewer consumes HTTP-FLV plus a separate WebSocket-only Socket.IO connection and acknowledged `join_channel`. Each child worker owns at most 250 viewers; stages recreate batches so sizes never round up. Controller, publisher, and worker CPU are measured separately. Every worker bitrate and CPU denominator uses its own monotonic baseline/final snapshot interval, not controller IPC wall time. Exact healthy baseline snapshots are retained; creating N connection objects does not establish readiness. Chat scheduling stops before the final snapshot; outstanding acknowledgements settle under the worker timeout, dropped replies count as errors, and enabled chat requires at least one accepted message per worker. Churn retires exact owned connections, preserves their counters, replaces them, and warms up again; its transient interval is separate from steady-state bitrate and API-latency measurements. Metrics safety polling continues during ramp, warmup, churn, and measurement.

The final slow phase uses `--slow-viewers` paused viewers **plus one normal sentinel**. Each slow viewer pauses both the HTTP response and the **underlying transport socket**, rather than merely omitting a JS data callback. The default minute is intended to fill typical kernel buffers at this bitrate. Snapshots retain transport pause state, pause duration and user-space receive-buffer size; they do not measure kernel buffer occupancy. Normal throughput thresholds apply to the sentinel, not intentionally stalled readers. Server eviction may not immediately appear as a local close while transport reads remain paused.

Slow-phase evidence compares `mediaSafety.slowDisconnects` against a fresh pre-ramp baseline and reports sampled queue maxima. **No new slow-disconnect counter means inconclusive pressure and a failed run**, not a claim of server safety; inspect raw queues and increase duration if necessary. Counters are server-wide and can be confounded by other clients, so isolate the server. A positive delta does not prove that every slow reader was evicted, nor that all kernel buffers filled. Old lifetime peak queues and negative RSS deltas are not proof of backpressure safety. If an earlier stage fails, later stages including slow readers are skipped; isolate the slow phase with `--stages '1:15'` when needed.

Every metrics poll enforces API and media RSS separately. Missing either RSS fails closed. Both `api` and `media` must provide `sampledAt` (Unix milliseconds) and positive integer `sampleSequence` advancing on real samples. Missing/old/future timestamps, regressing sequences, or sequence stalls beyond `--telemetry-max-age-ms` fail closed even when HTTP stays responsive. The default tolerates collection cadence/jitter up to ten seconds; choose it against actual collection cadence and synchronized clocks, not response arrival time. A cap breach records **`stopReason: "HARNESS_SAFETY_STOP"`** and text **"not a server crash"**. This is a sampled harness guard, not an OS memory limit: allocation spikes between polls can exceed it. The API/media processes are never killed by the harness.

Exit `0` requires all requested stages and cleanup to succeed. Failures/quality violations/inconclusive slow pressure/cleanup errors exit `1`; SIGINT/SIGTERM exit `130`/`143` after cleanup. API timeouts/errors are counted but never included as successful latency observations. Viewer errors are cumulative for each connection, including warmup; retired churn connections remain in `churn`/worker snapshots rather than being merged into steady-state throughput; their pre-disposal errors or unhealthy membership still fail the run. Slow-viewer media eviction is assessed separately from fatal Socket.IO membership errors. Unexpected media end and close counts are separate from request/parser errors and intentional disposal. Missing/closed/ended/non-200/zero-byte streams or unacknowledged membership are not healthy.

## JSON fields and checkpoints

Unvalidated target strings never enter evidence; configuration is populated only after all targets are validated and pinned. Evidence is owner-only JSON, checkpointed atomically after metrics polls, stage start/completion, and final cleanup. A failed write leaves the previous complete checkpoint; disk failure can still prevent recording final cleanup. No outputs are stored in Git.

- Root: `version`, `started`, `ended`, `configuration`, `method`, `ownedFixture.channelName`, `channel.{id,channelName}`, `publisherPid`, `passed`, `error`, `stopReason`, `cleanup`.
- `stages[]`: `kind` (`normal` or `slow-reader`), `requested` (normal count), `requestedTotal`, `slowRequested`, `workers`, `seconds`, `complete`, `error`, `failures`, `healthy`, `mediaConnections`, `socketConnections`, `errors`, `minMbps`, `aggregateMbps`.
- `stages[].viewers[]`: `id`, cumulative `bytes`, measured `bytesDelta`, `mbps`, `status`, `errors`, `closed`, `socket`, `joined`, `media`, `healthy`, **`gap` (maximum observed/no-data-so-far gap in milliseconds)**, `mediaChunks`, `socketEvents`, `socketBytes`. Gaps are transport delivery gaps, not decoded playback stalls.
- `slowViewers[]`: separate intentionally stalled snapshots, with `slow`, `pausedAt` (worker monotonic milliseconds), `pausedMs`, `transportPaused`, `receiveBufferBytes`, and the cumulative viewer fields. `slowAssessment`: `slowDisconnectsDelta`, `evictionObserved`, `maxObservedQueuedBytes`, caveat `note`.
- `apiSamples[]`: `at`, `ok`, `status`, `timeout`, successful `ms`; `api`: `requests`, `successes`, `errors`, `timeouts`, `latencyMs.{p50,p95,max}` using nearest rank on successful requests only. Empty percentiles are null.
- `presenceSamples[]`: `at`, `ok`, `total`, `ms`. Only the first viewer-list item is fetched; the header must be a valid nonnegative decimal safe integer equal to `requestedTotal`, otherwise the stage fails. Full names/payloads are discarded.
- `generatorCpuPercentOneCore.{controller,publisher,workers}`; CPU can exceed 100%. `baselineSnapshots[]`, `workerSeconds[]`, and `workerSnapshots[]` retain worker-local interval evidence; final snapshots also preserve `memory`, cumulative `cpu`, `clients`, `retired`, `churned`, `chat.{sent,accepted,errors}`. `churn[]` retains pre-measurement replacement snapshots.
- `metrics[]`: `at`, `phase`, `rssMiB.{api,media}` and **raw** `data.api` / `data.media`: PID, `memory` (RSS/heap/external), `cpuPercent`, event-loop statistics, egress and **`mediaSafety`** queues/counters as provided by `/api/metrics`. A failing RSS sample still retains raw data. `currentQueuedBytes`, `queuedBytes`, `peakQueuedBytes`, `slowDisconnects`, `byteLimitCloses`, `timeoutCloses`, `aggregateLimitCloses` remain distinct. No absent telemetry is fabricated.
- `cleanup`: `workersStopped`, `publisherStopped`, `channelRemoved`, `recordingsRemoved`; failures include `error`, owned `channelName`, or `unstoppedWorkerPids`.

## Ownership and cleanup

`finally` cleanup stops **only child objects spawned by this run** (TERM, then KILL if needed), never server processes or PID-name matches. Workers also exit on parent IPC disconnect. Cleanup paginates `/api/streams` using `X-Total-Count`, finds only the generated exact UUID name, verifies its ID, removes any recordings whose `streamId` equals that owned ID through the recording API, verifies the recording list is empty, deletes the owned channel, and reads back all pages to verify removal. DNS resolution runs in a timeout/abort-controlled helper process so a stalled native resolver cannot keep the controller alive; it receives no benchmark credentials. API deadlines cover headers and JSON bodies. Fixture pagination has both an overall deadline and page cap; cleanup uses one shared deadline and retains confirmed partial deletion counts plus the exact owned name on failure. Child termination attempts run concurrently within that budget. These are event-loop deadlines, not hard real-time OS guarantees. Foreign recording ownership, identity mismatch, duplicate names, unstable pagination and failed requests abort deletion rather than broadening its scope.

A timed-out creation can still commit: recovery waits one request timeout and searches for the exact name, which is checkpointed **before** POST. Database operations longer than that recovery window, unavailable API, concurrent modifications, SIGKILL, host crash, lost permissions or storage failure can prevent cleanup. SIGKILL/host failure can also leave FFmpeg alive; inspect the recorded owned PID/fixture rather than using wildcard process/channel deletion. No force cleanup of unrelated data is offered.

## Test scope and limitations

Existing core/control/lifecycle tests are retained and extended. Unit tests cover configuration, per-process RSS safety, network scope, batching, API/throughput/gap accounting, ownership/pagination/recording deletion, IPC/child termination, atomic checkpoints, paused-socket method calls, exact churn replacements, chat acknowledgements, and mocked controller success/API failure/SIGTERM/cleanup failure. Controller tests inject fake fetch/processes, do not contact ports 3000/8000/1935, do not read real ADMIN credentials, and their numerical values are **test fixtures, not benchmark results**.

Loopback is not physical LAN throughput; this is transport consumption, not browser decoding/rendering, A/V correctness or playback-stall validation. WebSocket-only mode omits polling negotiation. FFmpeg/controller/workers share the generator: CPU/NIC/FD saturation can create a false server ceiling. API latency covers the public channel detail endpoint; authenticated metrics and presence timings are separate. Safety checks and presence polling are serial with request time, not hard real-time guarantees. WSL forwarding/firewall/TLS topology affects results. Recording, restart/reconnect durability, long-run leak tests and WAN capacity are not validated here.

Regression coverage additionally exercises delayed readiness, worker timestamp/IPC skew, malformed/mismatched presence totals, retired errors, failed slow membership, dropped final chat acknowledgements, stale/non-advancing samples, stalled DNS/body reads, unbounded pagination, cleanup budget exhaustion, and partial cleanup evidence. All test figures are synthetic doubles, not capacity measurements.
