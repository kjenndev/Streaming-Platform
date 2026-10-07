'use strict';

const path = require('node:path');
let installation;

/**
 * NMS 4.2.4 CJS constructor adapter. Call BEFORE require('node-media-server').
 * Class-field callbacks cannot be fixed on prototypes: subclasses replace them
 * after super(), before run() registers callbacks. No dependency files are edited.
 * Repeated installation returns the same controller (first options win).
 *
 * Options (positive integer bytes / milliseconds):
 * maxQueuedBytes=4MiB, maxBlockedMs=5000: each network consumer's queue/deadline.
 * recordMaxQueuedBytes=8MiB, recordMaxBlockedMs=10000: each recording writer.
 * maxTotalQueuedBytes=128MiB: aggregate outstanding write reservations.
 * maxGopBytes=16MiB, maxTotalGopBytes=128MiB: retained FLV+RTMP GOP bytes,
 * per broadcast and across all broadcasts (separate from transport reservations).
 * A cache overflow discards both representations until the next keyframe; live
 * subscribers continue receiving packets. Keyframe replacement/publisher teardown
 * release reservations. No cache or consumer scan is added to packet accounting.
 * These GOP limits exclude codec/metadata headers and transient parser buffers.
 * maxActiveSessions=8192: admission cap, including idle publishers/recordings.
 * Over-budget consumers are disconnected, never resumed after skipping bytes.
 * Recording failures stop only that recording, set session.recordingError, and
 * emit doneRecord once. Callers must not finalize failed recordings as successes.
 * Successful close() ends and flushes the file, with a finite finish deadline.
 *
 * snapshot() is detached, numeric and JSON/IPC-safe:
 * - networkBytes: accepted network payload/control bytes (use for egress rates).
 * - recordingBytes: accepted disk bytes. acceptedBytes is the sum of both.
 * - session.outBytes: accepted media bytes; RTMP control output remains excluded.
 *   Accepted/enqueued does NOT mean delivered or durably written; no counter
 *   decrements on disconnect. rejectedBytes counts only the triggering buffer.
 * - currentGopBytes/peakGopBytes: retained GOP reservations/high-water mark.
 * - gopLimitEvictions/aggregateGopLimitEvictions count per-stream/global overflow;
 *   the per-stream counter includes NMS's 4096-packet ceiling.
 * - currentQueuedBytes: O(1) conservative reservations released on write callback
 *   or close; peakQueuedBytes is their high-water mark. Includes WS frame headers.
 * - queuedBytes: actual writableLength/bufferedAmount sampled O(N) ONLY on snapshot,
 *   not each write. Neither measure includes kernel socket buffers or filesystem
 *   cache; reservation bytes may exceed actual queues until callbacks execute.
 * - activeSessions includes publishers and recordings; activeRecordings is a subset.
 *   activeQueueEntries is the bounded live registry; admissionCloses counts rejects.
 * - recordingListeners counts this adapter's donePublish listeners, whereas
 *   donePublishListeners includes application listeners. broadcasts is map size.
 * - byteLimitCloses/aggregateLimitCloses/timeoutCloses/transportErrors are totals;
 *   slowDisconnects excludes recordings; recordingFailures counts failed files.
 * - activeTimers counts live queue/finish deadlines (all unref'd and cleared).
 * Metrics retain only weak transport references; closed entries are removed.
 * HTTP POST EOF waits for optional session.publisherAdmission (including queued
 * packet replay), then optional session.lifecycle (bounded by maxBlockedMs), before
 * emitting publisher teardown once and ending the response without destroying its
 * keepalive socket. EOF listeners are detached during cleanup.
 * RTMP reconnect before play/push prunes the old empty broadcast; reconnect after
 * play/push is rejected to avoid orphaning an active publisher/subscriber.
 * restore() is for isolated tests/shutdown with zero live adapted sessions; do not
 * reuse server constructors already loaded during an installation after restore.
 * Independent constructor wrappers (e.g. publisher auth) must extend the current
 * cached constructor before NMS server imports; never replace it with a stale one.
 */
function installMediaSafety(options = {}) {
  if (installation) return installation;
  const root = path.dirname(require.resolve('node-media-server/package.json'));
  const version = require(path.join(root, 'package.json')).version;
  if (version !== '4.2.4') throw new Error(`Media safety requires reviewed node-media-server 4.2.4; found ${version}`);
  const settings = {
    maxActiveSessions: options.maxActiveSessions ?? 8192,
    maxQueuedBytes: options.maxQueuedBytes ?? 4 * 1024 * 1024,
    maxBlockedMs: options.maxBlockedMs ?? 5000,
    maxTotalQueuedBytes: options.maxTotalQueuedBytes ?? 128 * 1024 * 1024,
    maxGopBytes: options.maxGopBytes ?? 16 * 1024 * 1024,
    maxTotalGopBytes: options.maxTotalGopBytes ?? 128 * 1024 * 1024,
    recordMaxQueuedBytes: options.recordMaxQueuedBytes ?? 8 * 1024 * 1024,
    recordMaxBlockedMs: options.recordMaxBlockedMs ?? 10000,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive safe integer`);
  }
  for (const file of ['index.js', 'server/http_server.js', 'server/rtmp_server.js', 'server/record_server.js']) {
    if (require.cache[path.join(root, 'src', file)]) throw new Error('Install media safety before requiring node-media-server or its servers');
  }
  const Context = require(path.join(root, 'src/core/context.js'));
  if (Context.sessions.size || Context.broadcasts.size) throw new Error('Install media safety before creating sessions');
  const WebSocket = require(require.resolve('ws', { paths: [root] }));
  const counters = { activeSessions: 0, admissionCloses: 0, activeTimers: 0, acceptedBytes: 0, rejectedBytes: 0, byteLimitCloses: 0, timeoutCloses: 0, transportErrors: 0 };
  Object.assign(counters, { activeRecordings: 0, recordingListeners: 0, slowDisconnects: 0, recordingFailures: 0 });
  Object.assign(counters, { currentQueuedBytes: 0, peakQueuedBytes: 0, aggregateLimitCloses: 0, networkBytes: 0, recordingBytes: 0 });
  Object.assign(counters, { currentGopBytes: 0, peakGopBytes: 0, gopLimitEvictions: 0, aggregateGopLimitEvictions: 0 });
  // Entries contain weak transport references only, never sessions or closures.
  const queues = new Set();
  const replacements = [];
  function replace(file, make) {
    const filename = path.join(root, 'src/session', file + '.js');
    const Original = require(filename);
    const Adapted = make(Original);
    require.cache[filename].exports = Adapted;
    replacements.push({ filename, Original, Adapted });
  }

  // Instrument only the retained GOP sets: no packet-time viewer/cache scans.
  const guardedBroadcasts = new WeakSet();
  function protectGop(broadcast) {
    if (guardedBroadcasts.has(broadcast)) return;
    guardedBroadcasts.add(broadcast);
    let bytes = 0;
    let overflow = false;
    const caches = { flvGopCache: null, rtmpGopCache: null };
    class GopSet extends Set {
      bytes = 0;
      add(buffer) {
        if (overflow || this.has(buffer)) return this;
        // Enforce NMS's packet ceiling here, before its clear() can retain a suffix.
        const reason = this.size >= 4096 || bytes + buffer.length > settings.maxGopBytes ? 'gopLimitEvictions'
          : counters.currentGopBytes + buffer.length > settings.maxTotalGopBytes ? 'aggregateGopLimitEvictions' : null;
        if (reason) {
          overflow = true;
          counters[reason]++;
          caches.flvGopCache?.clear(); caches.rtmpGopCache?.clear();
          return this;
        }
        super.add(buffer);
        this.bytes += buffer.length; bytes += buffer.length;
        counters.currentGopBytes += buffer.length;
        counters.peakGopBytes = Math.max(counters.peakGopBytes, counters.currentGopBytes);
        return this;
      }
      clear() {
        bytes -= this.bytes; counters.currentGopBytes -= this.bytes;
        this.bytes = 0; super.clear();
      }
    }
    for (const key of Object.keys(caches)) {
      Object.defineProperty(broadcast, key, {
        configurable: true,
        get: () => caches[key],
        set: value => { caches[key]?.clear(); caches[key] = value === null ? null : new GopSet(); },
      });
    }
    // NMS hardcodes both FLV track bits. flv.js then waits forever for absent AAC.
    // Advertise only codec tracks actually received, never synthesize media.
    let trackMask = 0;
    const refreshHeader = () => {
      broadcast.flvHeader = require('node-media-server/src/protocol/flv').createHeader(!!(trackMask & 4), !!(trackMask & 1));
    };
    const reconnectFlvViewers = () => {
      for (const viewer of [...broadcast.subscribers.values()]) {
        // Internal recording sessions use ip="" and must finalize normally.
        if (viewer.protocol === 'flv' && viewer.ip !== '') viewer.close();
      }
    };
    const donePublish = broadcast.donePublish;
    broadcast.donePublish = session => {
      const ownsPublisher = broadcast.publisher === session;
      try { return donePublish(session); }
      finally {
        if (ownsPublisher) {
          if (trackMask) reconnectFlvViewers();
          trackMask = 0;
          // Unknown until a sequence header arrives; early viewers are reconnected
          // when it does, before receiving media with a different track topology.
          broadcast.flvHeader = require('node-media-server/src/protocol/flv').createHeader(true, true);
          broadcast.flvGopCache = null; broadcast.rtmpGopCache = null;
          overflow = false;
        }
      }
    };
    const message = broadcast.broadcastMessage;
    broadcast.broadcastMessage = packet => {
      const nextMask = trackMask | (packet.flags === 0 ? 4 : packet.flags === 2 ? 1 : 0);
      if (nextMask !== trackMask) {
        reconnectFlvViewers();
        trackMask = nextMask;
        refreshHeader();
      }
      // NMS 4.2.4 labels AVC sequence-end as a keyframe. Preserve the last GOP:
      // a finite HTTP publisher may finish before its recorder has subscribed.
      if (packet.codec_type === 9 && packet.codec_id === 7 && packet.data[1] === 2)
        packet = {...packet, flags: 4};
      if (packet.flags === 3) overflow = false;
      try { return message(packet); }
      finally {
        // Discard the entire GOP, not a prefix/suffix that a new viewer cannot decode.
        if (overflow) { broadcast.flvGopCache = null; broadcast.rtmpGopCache = null; }
      }
    };
  }

  // Weak keys do not retain empty broadcasts; counts include not-yet-playing sessions.
  const references = new WeakMap();
  function prune(session) {
    const broadcast = session.broadcast;
    if (broadcast && !broadcast.publisher && !broadcast.subscribers.size && !references.get(broadcast)
      && Context.broadcasts.get(session.streamPath) === broadcast) Context.broadcasts.delete(session.streamPath);
  }
  function protect(session, transport, isWs, recording = false) {
    const byteLimit = recording ? settings.recordMaxQueuedBytes : settings.maxQueuedBytes;
    const timeLimit = recording ? settings.recordMaxBlockedMs : settings.maxBlockedMs;
    let closed = false;
    let timer = null;
    let outstanding = 0;
    let finishing = false;
    const admitted = counters.activeSessions < settings.maxActiveSessions;
    if (admitted) counters.activeSessions++;
    if (recording && admitted) counters.activeRecordings++;
    const queueEntry = { ref: new WeakRef(transport), isWs };
    if (admitted) queues.add(queueEntry);
    let heldBroadcast;
    let heldPath;
    const retain = () => {
      if (heldBroadcast === session.broadcast) return;
      if (heldBroadcast) {
        references.set(heldBroadcast, references.get(heldBroadcast) - 1);
        prune({ broadcast: heldBroadcast, streamPath: heldPath });
      }
      protectGop(session.broadcast);
      heldBroadcast = session.broadcast;
      heldPath = session.streamPath;
      references.set(heldBroadcast, (references.get(heldBroadcast) || 0) + 1);
    };
    retain();
    if (session.onConnect) {
      const originalConnect = session.onConnect;
      session.onConnect = request => {
        if (closed) return;
        // NMS sessions represent one active stream. Rebinding a playing/pushing
        // session would orphan its old subscriber/publisher and defeat the cap.
        if (heldBroadcast.publisher === session || heldBroadcast.subscribers.has(session.id)) {
          abort('transportErrors');
          return;
        }
        originalConnect(request);
        retain();
      };
    }
    // NMS continues into onPlay/onPush after onConnect even if rejected there.
    for (const callback of ['onPlay', 'onPush', 'onPacket', 'onData']) {
      const original = session[callback];
      if (original) session[callback] = (...args) => { if (!closed) return original(...args); };
    }
    const originalOnClose = session.onClose;
    const cancelTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; counters.activeTimers--; }
    };
    const onDrain = () => { if (!finishing) cancelTimer(); };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      cancelTimer();
      if (admitted) counters.activeSessions--;
      if (recording && admitted) counters.activeRecordings--;
      queues.delete(queueEntry);
      counters.currentQueuedBytes -= outstanding;
      outstanding = 0;
      transport.removeListener('close', onTransportClose);
      transport.removeListener('finish', cleanup);
      transport.removeListener('drain', onDrain);
      references.set(heldBroadcast, references.get(heldBroadcast) - 1);
      session.req?.removeListener('end', onRequestEnd);
      session.req?.removeListener('data', session.onData);
      session.req?.removeListener('error', session.onError);
      session.req?.socket.removeListener('close', cleanup);
      session.socket?.removeListener('data', session.onData);
      session.socket?.removeListener('close', cleanup);
      session.socket?.removeListener('error', session.onError);
      if (isWs) {
        transport.removeListener('message', session.onData);
        transport.removeListener('close', cleanup);
        transport.removeListener('error', session.onError);
      }
      originalOnClose?.();
      prune(session);
      // NMS registers sessions AFTER run(); postPlay can synchronously evict
      // while sending cached headers, before its subscribers.set() as well.
      queueMicrotask(() => {
        Context.sessions.delete(session.id);
        session.broadcast.subscribers.delete(session.id);
        prune(session);
      });
    };
    let requestEnded = false;
    const onRequestEnd = async () => {
      if (requestEnded || closed) return;
      requestEnded = true;
      // The gate resolves only after admission AND queued packet replay. Node's
      // end event follows the final data callback; keepalive socket close does not.
      try {
        await session.publisherAdmission;
        if (closed) return;
        // postPublish starts asynchronous recorder/relay setup. Teardown before
        // it completes clears the cached GOP and misses the recorder's listener.
        if (session.lifecycle) {
          finishing = true; // A transport drain must not cancel startup's deadline.
          cancelTimer();
          await Promise.race([session.lifecycle, new Promise((resolve, reject) => {
            counters.activeTimers++;
            timer = setTimeout(() => {
              timer = null; counters.activeTimers--;
              reject(new Error('publisher lifecycle deadline'));
            }, timeLimit);
            timer.unref();
          })]);
          cancelTimer();
        }
      } catch { abort('transportErrors'); return; }
      if (closed) return;
      cleanup();
      transport.end();
    };
    session.onClose = cleanup;
    const abort = reason => {
      if (closed) return;
      if (reason) counters[reason]++;
      if (recording && reason) { session.recordingError = reason; counters.recordingFailures++; }
      if (!recording && (reason === 'byteLimitCloses' || reason === 'timeoutCloses' || reason === 'aggregateLimitCloses')) counters.slowDisconnects++;
      cleanup();
      // Graceful end/WS close can retain a blocked queue indefinitely.
      if (isWs) transport.terminate(); else transport.destroy();
    };
    const onTransportClose = () => {
      if (recording && !transport.writableFinished) abort('transportErrors');
      else cleanup();
    };
    const onError = () => {
      // fs can finish writes, then report an fd-close error. Cleanup has already
      // run, but callers waiting for close must still see a failed recording.
      if (recording && closed && !session.recordingError) {
        session.recordingError = 'transportErrors';
        counters.recordingFailures++; counters.transportErrors++;
      } else abort('transportErrors');
    };
    transport.on('error', onError);
    transport.once('close', () => transport.removeListener('error', onError));
    transport.on('close', onTransportClose);
    transport.on('finish', cleanup);
    transport.on('drain', onDrain);
    const queued = () => isWs ? transport.bufferedAmount : transport.writableLength;
    const arm = (finish = false) => {
      finishing ||= finish;
      if (!closed && !timer && (finishing || queued() > 0)) {
        counters.activeTimers++;
        timer = setTimeout(() => {
          timer = null; counters.activeTimers--;
          if (finishing || queued() > 0) abort('timeoutCloses');
        }, timeLimit);
        timer.unref();
      }
    };
    const send = (buffer, media = true) => {
      if (closed) return;
      if (transport.destroyed || transport.writableEnded || (isWs && transport.readyState !== WebSocket.OPEN)) { abort(); return; }
      // Server WebSocket frames are unmasked. Include their framing overhead.
      const charge = buffer.length + (isWs ? (buffer.length < 126 ? 2 : buffer.length <= 65535 ? 4 : 10) : 0);
      const reason = queued() + charge > byteLimit ? 'byteLimitCloses'
        : counters.currentQueuedBytes + charge > settings.maxTotalQueuedBytes ? 'aggregateLimitCloses' : null;
      if (reason) { counters.rejectedBytes += buffer.length; abort(reason); return; }
      // O(1) reservations per write, released by completion OR cleanup, never both.
      // This is conservative until callbacks run, including writes already flushed
      // to the kernel. No all-viewer scan occurs in the broadcast hot path.
      outstanding += charge;
      counters.currentQueuedBytes += charge;
      counters.peakQueuedBytes = Math.max(counters.peakQueuedBytes, counters.currentQueuedBytes);
      let completed = false;
      const complete = error => {
        if (completed) return;
        completed = true;
        if (!closed) { outstanding -= charge; counters.currentQueuedBytes -= charge; }
        if (error) onError(); else if (!queued() && !finishing) cancelTimer();
      };
      try {
        if (isWs) transport.send(buffer, complete);
        else transport.write(buffer, complete);
        if (media) session.outBytes += buffer.length;
        counters.acceptedBytes += buffer.length;
        if (recording) counters.recordingBytes += buffer.length;
        else counters.networkBytes += buffer.length;
        if (!queued() && !finishing) cancelTimer(); else arm();
      } catch { complete(new Error('transport write failed')); }
    };
    session.sendBuffer = buffer => send(buffer);
    if (session.onOutput) session.onOutput = buffer => send(buffer, false);
    session.close = () => abort();
    const originalRun = session.run;
    let running = false;
    session.run = () => {
      if (closed || running) return;
      running = true;
      if (session.req?.method === 'POST' && !isWs) session.req.once('end', onRequestEnd);
      return originalRun();
    };
    if (!admitted) abort('admissionCloses');
    return { isClosed: () => closed, abort, arm };
  }
  replace('flv_session', Original => class SafeFlvSession extends Original {
    constructor(...args) { super(...args); protect(this, this.res, this.res instanceof WebSocket); }
  });
  replace('rtmp_session', Original => class SafeRtmpSession extends Original {
    constructor(...args) { super(...args); protect(this, this.socket, false); }
  });
  replace('record_session', Original => class SafeRecordSession extends Original {
    constructor(...args) {
      super(...args);
      let started = false;
      let stopping = false;
      let listening = false;
      const detach = () => {
        Context.eventEmitter.removeListener('donePublish', onDonePublish);
        if (listening) { listening = false; counters.recordingListeners--; }
        this.broadcast.subscribers.delete(this.id);
      };
      const stop = () => {
        if (stopping || guard.isClosed()) return;
        stopping = true;
        detach();
        this.fileStream.end();
        guard.arm(true);
      };
      const onDonePublish = publisher => {
        if (publisher.streamPath === this.streamPath) stop();
      };
      this.onClose = () => {
        detach();
        this.endTime = Date.now();
        if (started) Context.eventEmitter.emit('doneRecord', this);
      };
      const guard = protect(this, this.fileStream, false, true);
      const send = this.sendBuffer;
      this.sendBuffer = buffer => { if (!stopping) send(buffer); };
      this.close = stop;
      this.run = () => {
        if (started || guard.isClosed()) return;
        started = true;
        Context.eventEmitter.on('donePublish', onDonePublish);
        listening = true; counters.recordingListeners++;
        const error = this.broadcast.postPlay(this);
        if (error) { guard.abort('transportErrors'); return; }
        if (guard.isClosed()) { detach(); return; }
        Context.eventEmitter.emit('postRecord', this);
      };
    }
  });
  let restored = false;
  installation = {
    snapshot() {
      let queuedBytes = 0;
      for (const entry of queues) {
        const transport = entry.ref.deref();
        if (transport) queuedBytes += (entry.isWs ? transport.bufferedAmount : transport.writableLength) || 0;
        else queues.delete(entry);
      }
      return { ...counters, activeQueueEntries: queues.size, queuedBytes, broadcasts: Context.broadcasts.size, donePublishListeners: Context.eventEmitter.listenerCount('donePublish') };
    },
    restore() {
      if (restored) return;
      if (counters.activeSessions) throw new Error('Close all media sessions before restore');
      for (const { filename, Original, Adapted } of replacements) {
        if (require.cache[filename]?.exports === Adapted) require.cache[filename].exports = Original;
      }
      restored = true;
      installation = undefined;
    },
  };
  return installation;
}
module.exports = { installMediaSafety };
