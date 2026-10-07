'use strict';
// Run directly: node --test apps/backend/tests/media-safety.test.js
// Jest delegates to a fresh Node process because this adapter owns CJS cache entries.
if (process.env.JEST_WORKER_ID) {
  test('media dependency safety (isolated Node runner)', () => {
    const { execFileSync } = require('node:child_process');
    const env = { ...process.env }; delete env.JEST_WORKER_ID;
    execFileSync(process.execPath, ['--test', __filename], { env, stdio: 'pipe' });
  });
} else {
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../lib/media-safety.js');
const install = fs.existsSync(modulePath) ? require(modulePath).installMediaSafety : () => ({ restore() {} });
const dep = name => require('node-media-server/src/' + name);
const tick = () => new Promise(resolve => setImmediate(resolve));
function sink(slow = false) {
  return new Writable({ highWaterMark: 16, write(chunk, encoding, callback) { if (!slow) callback(); } });
}
function flv(res, name = 'mixed') {
  const req = new EventEmitter();
  Object.assign(req, { socket: new EventEmitter(), hostname: 'localhost', headers: {host: 'localhost'}, url: '/live/' + name + '.flv', params: {app: 'live', name}, query: {}, method: 'GET' });
  return new (dep('session/flv_session'))(req, res);
}
test('slow HTTP-FLV is disconnected without blocking fast viewer or counting rejected bytes', async () => {
  const safety = install({ maxQueuedBytes: 64, maxBlockedMs: 100 });
  const slow = flv(sink(true)), fast = flv(sink());
  const payload = Buffer.alloc(32);
  const sendSlow = slow.sendBuffer; // Class-field replacements must stay bound.
  for (let i = 0; i < 10; i++) { sendSlow(payload); fast.sendBuffer(payload); }
  assert.equal(slow.res.destroyed, true);
  assert.equal(slow.outBytes, 64);
  assert.equal(fast.outBytes, 320);
  fast.close(); await tick();
  assert.equal(safety.snapshot().activeSessions, 0);
  assert.equal(safety.snapshot().acceptedBytes, 384);
  assert.equal(safety.snapshot().rejectedBytes, 32);
  assert.equal(dep('core/context').broadcasts.size, 0);
  safety.restore();
});

test('recording cycles remove named donePublish listeners on stop, finish, error and backlog', async () => {
  const safety = install({ maxQueuedBytes: 128, maxBlockedMs: 30, recordMaxQueuedBytes: 64 });
  const Context = dep('core/context');
  const Record = dep('session/record_session');
  const tmp = fs.mkdtempSync(require('node:os').tmpdir() + '/media-safety-');
  const baseline = Context.eventEmitter.listenerCount('donePublish');
  let done = 0;
  const completed = () => done++;
  Context.eventEmitter.on('doneRecord', completed);
  for (let i = 0; i < 16; i++) {
    const record = new Record({ streamApp: 'live', streamName: 'record', streamPath: '/live/record' }, path.join(tmp, i + '.flv'));
    record.run(); record.run();
    assert.equal(Context.eventEmitter.listenerCount('donePublish'), baseline + 1);
    assert.ok(Context.eventEmitter.listeners('donePublish').every(fn => fn.name));
    record.sendBuffer(Buffer.from('payload'));
    if (i % 4 === 0) Context.eventEmitter.emit('donePublish', {streamPath: '/live/record'});
    if (i % 4 === 1) record.close();
    if (i % 4 === 2) record.fileStream.destroy(new Error('disk failed'));
    if (i % 4 === 3) record.fileStream.end();
    await new Promise(resolve => record.fileStream.once('close', resolve));
    assert.equal(Context.eventEmitter.listenerCount('donePublish'), baseline);
    if (i % 4 !== 2) assert.deepEqual(fs.readFileSync(path.join(tmp, i + '.flv')), Buffer.concat([dep('protocol/flv').createHeader(true, true), Buffer.from('payload')]));
    assert.equal(Context.broadcasts.size, 0);
  }
  assert.equal(done, 16);
  const record = new Record({ streamPath: '/live/backlog' }, path.join(tmp, 'backlog.flv'));
  record.run(); record.sendBuffer(Buffer.alloc(65));
  await new Promise(resolve => record.fileStream.once('close', resolve));
  assert.equal(record.fileStream.destroyed, true);
  assert.equal(record.recordingError, 'byteLimitCloses');
  assert.equal(safety.snapshot().recordingFailures, 5);
  assert.equal(safety.snapshot().recordingBytes, safety.snapshot().acceptedBytes);
  assert.equal(safety.snapshot().networkBytes, 0);
  assert.equal(safety.snapshot().recordingListeners, 0);
  assert.equal(safety.snapshot().activeRecordings, 0);
  assert.equal(safety.snapshot().activeSessions, 0);
  assert.equal(safety.snapshot().activeTimers, 0);
  assert.equal(Context.eventEmitter.listenerCount('donePublish'), baseline);
  Context.eventEmitter.removeListener('doneRecord', completed);
  safety.restore(); fs.rmSync(tmp, {recursive: true, force: true});
});

test('RTMP control and media writes both obey byte budget, timers do not retain closed clients', async () => {
  const safety = install({maxQueuedBytes: 64, maxBlockedMs: 20});
  const Rtmp = dep('session/rtmp_session');
  const session = new Rtmp(sink(true));
  session.run();
  session.onOutput(Buffer.alloc(32)); session.onOutput(Buffer.alloc(40));
  assert.equal(session.socket.destroyed, true);
  assert.equal(session.outBytes, 0, 'NMS outBytes excludes RTMP protocol control output');
  assert.equal(safety.snapshot().acceptedBytes, 32);
  const timed = new Rtmp(sink(true)); timed.run(); timed.sendBuffer(Buffer.alloc(8));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(timed.socket.destroyed, true);
  assert.equal(safety.snapshot().timeoutCloses, 1);
  assert.equal(safety.snapshot().activeTimers, 0);
  assert.equal(safety.snapshot().activeSessions, 0);
  safety.restore();
});

test('actual ws sender queue evicts only slow websocket and counts payload bytes', async () => {
  const safety = install({maxQueuedBytes: 64, maxBlockedMs: 20});
  const WebSocket = require('ws');
  const { Duplex } = require('node:stream');
  function ws(slow) {
    const socket = new Duplex({read() {}, write(chunk, encoding, cb) { if (!slow) cb(); }});
    const instance = new WebSocket(null, [], {});
    instance.setSocket(socket, Buffer.alloc(0), {});
    return instance;
  }
  const slow = flv(ws(true), 'ws'), fast = flv(ws(false), 'ws');
  for (let i = 0; i < 10; i++) { slow.sendBuffer(Buffer.alloc(32)); fast.sendBuffer(Buffer.alloc(32)); }
  assert.equal(slow.res._socket.destroyed, true);
  assert.equal(fast.outBytes, 320);
  assert.equal(slow.outBytes, 32); // WS frame headers also consume queue budget.
  fast.close(); await tick();
  assert.equal(safety.snapshot().activeSessions, 0);
  assert.equal(safety.snapshot().activeTimers, 0);
  safety.restore();
});

test('idempotency, option validation, cache restore and immutable metrics', async () => {
  const Original = dep('session/flv_session');
  assert.throws(() => install({maxQueuedBytes: 0}), /positive/);
  const safety = install({maxQueuedBytes: 64});
  assert.equal(install({maxQueuedBytes: 999}), safety);
  assert.notEqual(dep('session/flv_session'), Original);
  const session = flv(sink());
  assert.throws(() => safety.restore(), /Close all/);
  const snapshot = safety.snapshot(); snapshot.activeSessions = 100;
  assert.equal(safety.snapshot().activeSessions, 1);
  session.close(); await tick(); safety.restore();
  assert.equal(dep('session/flv_session'), Original);
  const next = install(); safety.restore();
  assert.equal(install(), next, "old restore cannot remove a newer installation");
  next.restore();
});

test('cached header eviction does not resurrect subscriber; pending viewers preserve broadcast identity', async () => {
  const safety = install({maxQueuedBytes: 8});
  const Context = dep('core/context');
  const first = flv(sink(true), 'pending'), second = flv(sink(), 'pending');
  const broadcast = first.broadcast;
  first.run(); Context.sessions.set(first.id, first);
  await tick();
  assert.equal(broadcast.subscribers.has(first.id), false);
  assert.equal(Context.sessions.has(first.id), false);
  assert.equal(Context.broadcasts.get('/live/pending'), second.broadcast);
  second.close(); await tick();
  assert.equal(Context.broadcasts.size, 0);
  safety.restore();
});

test('HTTP keepalive socket and request listeners are removed on finish', async () => {
  const safety = install();
  const session = flv(sink(), 'keepalive'); session.run();
  session.res.end(); await tick();
  assert.equal(session.req.socket.listenerCount('close'), 0);
  assert.equal(session.req.listenerCount('data'), 0);
  assert.equal(session.req.listenerCount('error'), 0);
  assert.equal(safety.snapshot().activeSessions, 0);
  safety.restore();
});

test('recording stop has a finite finish deadline even with an empty write queue', async () => {
  const safety = install({recordMaxBlockedMs: 20});
  class HungRecord extends dep('session/record_session') {
    createWriteStreamWithDirsSync() { return new Writable({write(b, e, cb) { cb(); }, final() {}}); }
  }
  const session = new HungRecord({streamPath: '/live/hung'}, 'unused');
  session.run(); session.close();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(session.fileStream.destroyed, true);
  assert.equal(session.recordingError, 'timeoutCloses');
  assert.equal(safety.snapshot().activeTimers, 0);
  safety.restore();
});

test('IPC metrics expose live queues and recording lifecycle without session references', async () => {
  const safety = install({maxQueuedBytes: 64});
  const viewer = flv(sink(true), 'metrics'); viewer.sendBuffer(Buffer.alloc(32));
  let metrics = safety.snapshot();
  assert.equal(metrics.queuedBytes, 32);
  assert.equal(metrics.activeRecordings, 0);
  assert.equal(metrics.recordingListeners, 0);
  viewer.sendBuffer(Buffer.alloc(64)); await tick();
  metrics = safety.snapshot();
  assert.equal(metrics.queuedBytes, 0);
  assert.equal(metrics.slowDisconnects, 1);
  assert.equal(metrics.recordingFailures, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(metrics)), metrics);
  assert.ok(Object.values(metrics).every(value => typeof value === 'number'));
  safety.restore();
});

test('aggregate reservation cap closes offending consumer and releases once after late callbacks', async () => {
  const safety = install({maxQueuedBytes: 128, maxTotalQueuedBytes: 64});
  let complete;
  const delayed = new Writable({write(b, e, cb) { complete = cb; }});
  const first = flv(delayed, 'aggregate'), second = flv(sink(true), 'aggregate');
  first.sendBuffer(Buffer.alloc(40)); second.sendBuffer(Buffer.alloc(40));
  assert.equal(second.res.destroyed, true);
  assert.equal(first.res.destroyed, false);
  assert.equal(safety.snapshot().currentQueuedBytes, 40);
  assert.equal(safety.snapshot().peakQueuedBytes, 40);
  first.close(); complete(); await tick();
  assert.equal(safety.snapshot().currentQueuedBytes, 0);
  assert.equal(safety.snapshot().aggregateLimitCloses, 1);
  safety.restore();
});

test('real TCP mixed readers: paused consumer is evicted, fast peer receives full stream', async () => {
  const net = require('node:net');
  const { once } = require('node:events');
  const safety = install({maxQueuedBytes: 128 * 1024, maxBlockedMs: 300});
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function pair() {
    const connected = once(server, 'connection');
    const client = net.connect(server.address().port, '127.0.0.1');
    const [socket] = await connected;
    return { client, session: new (dep('session/rtmp_session'))(socket) };
  }
  const slow = await pair(), fast = await pair();
  slow.client.pause();
  let received = 0;
  fast.client.on('data', data => received += data.length);
  slow.session.run(); fast.session.run();
  const payload = Buffer.alloc(32 * 1024, 0x5a);
  let sent = 0;
  try {
    for (let i = 0; i < 1024 && !slow.session.socket.destroyed; i++) {
      slow.session.sendBuffer(payload); fast.session.sendBuffer(payload); sent += payload.length;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(slow.session.socket.destroyed, true);
    assert.equal(fast.session.socket.destroyed, false);
    const deadline = Date.now() + 1000;
    while (received < sent && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(received, sent);
    assert.equal(fast.session.outBytes, sent);
    assert.equal(safety.snapshot().slowDisconnects, 1);
  } finally {
    slow.session.close(); fast.session.close();
    slow.client.destroy(); fast.client.destroy();
    await new Promise(resolve => server.close(resolve)); await tick();
    assert.equal(safety.snapshot().currentQueuedBytes, 0);
    assert.equal(safety.snapshot().activeTimers, 0);
    safety.restore();
  }
});

test('active admission bounds idle registry and rejected sessions cannot run or leak', async () => {
  const safety = install({maxActiveSessions: 2});
  const first = flv(sink(), 'admitted');
  const second = new (dep('session/rtmp_session'))(sink());
  const rejected = flv(sink(), 'rejected');
  try {
    assert.equal(rejected.res.destroyed, true);
    rejected.run(); rejected.run(); rejected.close(); rejected.onClose();
    await tick();
    assert.equal(rejected.req.listenerCount('data'), 0);
    assert.equal(safety.snapshot().activeSessions, 2);
    assert.equal(safety.snapshot().admissionCloses, 1);
    assert.equal(safety.snapshot().activeQueueEntries, 2);
    first.close(); await tick();
    const replacement = flv(sink(), 'replacement');
    assert.equal(replacement.res.destroyed, false);
    replacement.close(); replacement.close();
  } finally {
    first.close(); second.close(); rejected.close(); await tick();
    assert.equal(safety.snapshot().activeSessions, 0);
    assert.equal(safety.snapshot().currentQueuedBytes, 0);
    safety.restore();
  }
});

test('repeated RTMP connect releases old empty broadcast references', async () => {
  const safety = install();
  const Context = dep('core/context');
  const session = new (dep('session/rtmp_session'))(sink());
  try {
    for (let i = 0; i < 20; i++) session.onConnect({app: 'live', name: 'reconnect-' + i, host: 'localhost', query: {}});
    assert.equal(Context.broadcasts.size, 1);
    session.close(); session.close(); await tick();
    assert.equal(Context.broadcasts.size, 0);
    assert.equal(safety.snapshot().activeQueueEntries, 0);
  } finally {
    session.close(); await tick(); Context.broadcasts.clear(); safety.restore();
  }
});

test('RTMP rebinding after play cannot strand a subscriber on its old broadcast', async () => {
  const safety = install();
  const Context = dep('core/context');
  const session = new (dep('session/rtmp_session'))(sink());
  session.onConnect({app: 'live', name: 'bound', host: 'localhost', query: {}});
  session.onPlay();
  const original = session.broadcast;
  try {
    session.onConnect({app: 'live', name: 'other', host: 'localhost', query: {}});
    session.close(); await tick();
    assert.equal(original.subscribers.size, 0);
    assert.equal(Context.broadcasts.size, 0);
  } finally {
    session.close(); await tick(); Context.broadcasts.clear(); safety.restore();
  }
});

test('default aggregate cap is 128MiB even when per-client budget is larger', async () => {
  const safety = install({maxQueuedBytes: 256 * 1024 * 1024});
  const viewer = flv(sink(true), 'default-budget');
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 128; i++) viewer.sendBuffer(chunk);
  assert.equal(safety.snapshot().currentQueuedBytes, 128 * chunk.length);
  viewer.sendBuffer(chunk); viewer.close(); viewer.onClose(); await tick();
  assert.equal(safety.snapshot().aggregateLimitCloses, 1);
  assert.equal(safety.snapshot().currentQueuedBytes, 0);
  assert.equal(safety.snapshot().activeQueueEntries, 0);
  safety.restore();
});

test('completion reopens aggregate budget without scanning unrelated queues', async () => {
  const safety = install({maxQueuedBytes: 128, maxTotalQueuedBytes: 64});
  let complete;
  const first = flv(new Writable({write(b, e, cb) {complete = cb;}}), 'completion');
  const other = flv(sink(), 'unrelated');
  const length = Object.getOwnPropertyDescriptor(Writable.prototype, 'writableLength');
  Object.defineProperty(other.res, 'writableLength', {configurable: true, get() {throw new Error('hot path scanned another consumer');}});
  first.sendBuffer(Buffer.alloc(64)); complete(); await tick();
  first.sendBuffer(Buffer.alloc(64)); complete(); await tick();
  delete other.res.writableLength;
  assert.ok(length);
  assert.equal(first.outBytes, 128);
  assert.equal(safety.snapshot().currentQueuedBytes, 0);
  assert.equal(safety.snapshot().aggregateLimitCloses, 0);
  first.close(); first.onClose(); other.close(); await tick();
  assert.equal(safety.snapshot().activeQueueEntries, 0);
  safety.restore();
});

test('HTTP and WS slow deadlines release reservations and transport listeners', async () => {
  const safety = install({maxQueuedBytes: 128, maxBlockedMs: 20});
  const WebSocket = require('ws');
  const { Duplex } = require('node:stream');
  const socket = new Duplex({read() {}, write() {}});
  const ws = new WebSocket(null, [], {}); ws.setSocket(socket, Buffer.alloc(0), {});
  const http = flv(sink(true), 'http-deadline'), websocket = flv(ws, 'ws-deadline');
  http.run(); websocket.run();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(http.res.destroyed, true); assert.equal(socket.destroyed, true);
  assert.equal(safety.snapshot().timeoutCloses, 2);
  assert.equal(safety.snapshot().currentQueuedBytes, 0);
  assert.equal(safety.snapshot().activeTimers, 0);
  assert.equal(safety.snapshot().activeQueueEntries, 0);
  assert.equal(http.req.socket.listenerCount('close'), 0);
  assert.equal(ws.listenerCount('message'), 0);
  assert.equal(ws.listenerCount('error'), 0);
  http.close(); websocket.close(); safety.restore();
});

test('recordings share aggregate admission and failure removes only their own listener', async () => {
  const safety = install({maxQueuedBytes: 128, maxTotalQueuedBytes: 32});
  const Context = dep('core/context');
  class Record extends dep('session/record_session') {
    createWriteStreamWithDirsSync() {return sink(true);}
  }
  const record = new Record({streamPath: '/live/shared-budget'}, 'unused'); record.run();
  const viewer = flv(sink(true), 'shared-budget'); viewer.sendBuffer(Buffer.alloc(16));
  assert.ok(safety.snapshot().currentQueuedBytes > 16);
  record.sendBuffer(Buffer.alloc(32));
  assert.equal(record.recordingError, 'aggregateLimitCloses');
  assert.equal(viewer.res.destroyed, false);
  record.close(); record.onClose(); await tick();
  assert.equal(safety.snapshot().currentQueuedBytes, 16);
  assert.equal(safety.snapshot().recordingFailures, 1);
  assert.equal(safety.snapshot().recordingListeners, 0);
  assert.equal(Context.eventEmitter.listenerCount('donePublish'), 0);
  viewer.close(); await tick(); safety.restore();
});

test('record admission rejection never starts a listener and allows close twice', async () => {
  const safety = install({maxActiveSessions: 1});
  const viewer = flv(sink(), 'admission');
  class Record extends dep('session/record_session') {
    createWriteStreamWithDirsSync() {return sink(true);}
  }
  const record = new Record({streamPath: '/live/reject-record'}, 'unused');
  record.run(); record.close(); record.close(); await tick();
  assert.equal(record.fileStream.destroyed, true);
  assert.equal(record.recordingError, 'admissionCloses');
  assert.equal(safety.snapshot().activeRecordings, 0);
  assert.equal(safety.snapshot().recordingListeners, 0);
  assert.equal(safety.snapshot().activeQueueEntries, 1);
  viewer.close(); await tick(); safety.restore();
});

test('all budget and admission options reject negative, noninteger and infinite limits', () => {
  for (const key of ['maxGopBytes', 'maxTotalGopBytes', 'maxActiveSessions', 'maxTotalQueuedBytes', 'maxQueuedBytes', 'maxBlockedMs', 'recordMaxQueuedBytes', 'recordMaxBlockedMs']) {
    for (const value of [-1, 0, 0.5, Infinity, NaN, '64']) assert.throws(() => install({[key]: value}), /positive safe integer/);
  }
});

test('recording backlog timeout leaves publisher and fast viewer running', async () => {
  const safety = install({recordMaxBlockedMs: 20});
  const publisher = new (dep('session/rtmp_session'))(sink());
  publisher.onConnect({app: 'live', name: 'disk-stall', host: 'localhost', query: {}});
  publisher.onPush();
  class Record extends dep('session/record_session') {
    createWriteStreamWithDirsSync() {return sink(true);}
  }
  const record = new Record({streamPath: '/live/disk-stall'}, 'unused'); record.run();
  const viewer = flv(sink(), 'disk-stall'); viewer.run();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(record.recordingError, 'timeoutCloses');
  assert.equal(record.fileStream.destroyed, true);
  assert.equal(publisher.broadcast.publisher, publisher);
  assert.equal(publisher.socket.destroyed, false);
  viewer.sendBuffer(Buffer.alloc(16));
  assert.equal(viewer.res.destroyed, false);
  assert.equal(safety.snapshot().recordingListeners, 0);
  assert.equal(safety.snapshot().recordingFailures, 1);
  publisher.close(); viewer.close(); record.close(); await tick();
  assert.equal(safety.snapshot().activeQueueEntries, 0);
  assert.equal(safety.snapshot().currentQueuedBytes, 0);
  assert.equal(safety.snapshot().activeTimers, 0);
  safety.restore();
});

test('version mismatch and late installation fail closed, without editing dependency files', () => {
  const packageJson = require('node-media-server/package.json');
  const version = packageJson.version;
  try { packageJson.version = '4.2.5'; assert.throws(() => install(), /requires reviewed/); }
  finally { packageJson.version = version; }
  const filename = require.resolve('node-media-server/src/server/rtmp_server');
  require(filename);
  try { assert.throws(() => install(), /before requiring/); }
  finally { delete require.cache[filename]; }
});

test('safety composes with publisher admission before protocol callbacks are bound', async () => {
  const safety = install({maxQueuedBytes: 64});
  const { gatePublisher } = require('../lib/publisher-auth');
  const { Duplex } = require('node:stream');
  const transport = new Duplex({read() {}, write(b, e, cb) { cb(); }});
  const publisher = new (dep('session/rtmp_session'))(transport);
  publisher.onConnect({app: 'live', name: 'gated', host: 'localhost', query: {}});
  gatePublisher(publisher, async () => ({id: 'allowed'})); publisher.run();
  assert.equal(publisher.rtmp.onPushCallback, publisher.onPush);
  await publisher.rtmp.onPushCallback();
  const viewer = flv(sink(true), 'gated'); viewer.run();
  viewer.sendBuffer(Buffer.alloc(64)); await tick();
  assert.equal(viewer.res.destroyed, true);
  assert.equal(publisher.broadcast.publisher, publisher);
  assert.equal(transport.destroyed, false);
  publisher.close(); await tick();
  assert.equal(dep('core/context').broadcasts.size, 0);
  assert.equal(safety.snapshot().activeSessions, 0);
  safety.restore();
});

test('premature recording close is a failure and removes all reservations/listeners', async () => {
  const safety = install();
  class Record extends dep('session/record_session') {
    createWriteStreamWithDirsSync() { return sink(true); }
  }
  const record = new Record({streamPath: '/live/premature'}, 'unused'); record.run();
  record.fileStream.destroy(); await tick();
  assert.equal(record.recordingError, 'transportErrors');
  assert.equal(safety.snapshot().recordingFailures, 1);
  assert.equal(safety.snapshot().currentQueuedBytes, 0);
  assert.equal(safety.snapshot().recordingListeners, 0);
  safety.restore();
});

test('file close error after finish is still reported as recording failure', async () => {
  const safety = install();
  class Record extends dep('session/record_session') {
    createWriteStreamWithDirsSync() { return new Writable({autoDestroy: false, write(b, e, cb) {cb();}}); }
  }
  const record = new Record({streamPath: '/live/late-error'}, 'unused'); record.run(); record.close();
  await tick();
  record.fileStream.destroy(new Error('close failed')); await tick();
  assert.equal(record.recordingError, 'transportErrors');
  assert.equal(safety.snapshot().recordingFailures, 1);
  assert.equal(safety.snapshot().activeSessions, 0);
  safety.restore();
});

test('publisher replacement cache waits for its own keyframe with existing viewers', async () => {
  const safety = install();
  const make = () => {
    const session = new (dep('session/rtmp_session'))(sink());
    session.run(); session.rtmp.streamApp = 'live'; session.rtmp.streamHost = 'localhost';
    session.rtmp.onPublish({streamName: 'replacement-gop'}); return session;
  };
  const first = make(), keep = flv(sink(), 'replacement-gop'); keep.run();
  const packet = flags => ({flags, codec_type: 9, dts: 0, data: Buffer.alloc(6), size: 6});
  let replacement, viewer;
  try {
    first.rtmp.onPacketCallback(packet(3)); first.close(); await tick();
    replacement = make(); replacement.rtmp.onPacketCallback(packet(4));
    const chunks = [];
    viewer = flv(new Writable({write(b, e, cb) {chunks.push(Buffer.from(b)); cb();}}), 'replacement-gop'); viewer.run();
    assert.deepEqual(Buffer.concat(chunks), dep('protocol/flv').createHeader(true, true));
    assert.equal(replacement.broadcast.flvGopCache, null);
    assert.equal(replacement.broadcast.rtmpGopCache, null);
    assert.equal(safety.snapshot().currentGopBytes, 0);
    replacement.rtmp.onPacketCallback(packet(3));
    assert.equal(replacement.broadcast.flvGopCache.size, 1);
  } finally {first.close(); replacement?.close(); keep.close(); viewer?.close(); await tick(); safety.restore();}
});

test('GOP packet-count overflow stays disabled until the next keyframe', async () => {
  const safety = install();
  const publisher = new (dep('session/rtmp_session'))(sink());
  publisher.run(); publisher.rtmp.streamApp = 'live'; publisher.rtmp.streamHost = 'localhost';
  publisher.rtmp.onPublish({streamName: 'count-gop'});
  const packet = flags => ({flags, codec_type: 9, dts: 0, data: Buffer.alloc(6), size: 6});
  let viewer;
  try {
    publisher.rtmp.onPacketCallback(packet(3));
    for (let i = 0; i < 4096; i++) publisher.rtmp.onPacketCallback(packet(i % 2 ? 1 : 4));
    publisher.rtmp.onPacketCallback(packet(4));
    const chunks = [];
    viewer = flv(new Writable({write(b, e, cb) {chunks.push(Buffer.from(b)); cb();}}), 'count-gop'); viewer.run();
    assert.deepEqual(Buffer.concat(chunks), dep('protocol/flv').createHeader(true, true), 'new viewer must not receive a keyframe-less suffix');
    assert.equal(publisher.broadcast.flvGopCache, null);
    assert.equal(publisher.broadcast.rtmpGopCache, null);
    assert.equal(safety.snapshot().currentGopBytes, 0);
    publisher.rtmp.onPacketCallback(packet(3));
    assert.equal(publisher.broadcast.flvGopCache.size, 1);
    assert.ok(safety.snapshot().currentGopBytes > 0);
  } finally {publisher.close(); viewer?.close(); await tick(); safety.restore();}
});

test('AVC end-of-sequence preserves the final decodable GOP for delayed recorders', async () => {
  const safety = install();
  const publisher = new (dep('session/rtmp_session'))(sink());
  publisher.onConnect({app: 'live', name: 'avc-eos', host: 'localhost', query: {}});
  publisher.onPush();
  const Flv = dep('protocol/flv');
  const keyData = Buffer.from([0x17, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
  const eosData = Buffer.from([0x17, 2, 0, 0, 0]);
  const key = Flv.parserTag(9, 0, keyData.length, keyData);
  const eos = Flv.parserTag(9, 1000, eosData.length, eosData);
  try {
    publisher.onPacket(key);
    publisher.onPacket(eos);
    assert.equal(publisher.broadcast.flvGopCache.size, 2, 'EOS is not a new keyframe');
    assert.deepEqual([...publisher.broadcast.flvGopCache][0], Flv.createMessage(key));
  } finally {publisher.close(); await tick(); safety.restore();}
});

test('GOP retention has a per-broadcast byte ceiling with zero viewers', async () => {
  const safety = install({maxGopBytes: 256, maxTotalGopBytes: 512});
  const publisher = new (dep('session/rtmp_session'))(sink());
  publisher.onConnect({app: 'live', name: 'gop', host: 'localhost', query: {}});
  publisher.onPush();
  const packet = flags => ({flags, codec_type: 0, type: 9, timestamp: 0, data: Buffer.alloc(60), size: 60});
  try {
    publisher.onPacket(packet(3));
    const expected = dep('protocol/flv').createMessage(packet(3)).length + dep('protocol/rtmp').createMessage(packet(3)).length;
    assert.equal(safety.snapshot().currentGopBytes, expected);
    publisher.onPacket(packet(4));
    assert.equal(safety.snapshot().currentGopBytes, 0);
    assert.equal(safety.snapshot().gopLimitEvictions, 1);
    assert.equal(publisher.broadcast.flvGopCache, null);
    assert.equal(publisher.broadcast.rtmpGopCache, null);
    publisher.onPacket(packet(4));
    assert.equal(safety.snapshot().currentGopBytes, 0, 'do not cache an undecodable partial GOP');
    publisher.onPacket(packet(3));
    assert.equal(safety.snapshot().currentGopBytes, expected);
    publisher.close(); await tick();
    assert.equal(safety.snapshot().currentGopBytes, 0);
  } finally { publisher.close(); await tick(); safety.restore(); }
});


test('HTTP publisher EOF waits for admission and records the last payload on keepalive', async () => {
  const safety = install();
  const Context = dep('core/context');
  const req = new EventEmitter();
  const socket = new EventEmitter(); Object.assign(socket, {pause() {}, resume() {}, destroy() {this.destroyed = true;}});
  Object.assign(req, {socket, hostname: 'localhost', params: {app: 'live', name: 'eof'}, query: {}, method: 'POST'});
  const publisher = new (dep('session/flv_session'))(req, sink());
  const tmp = fs.mkdtempSync(require('node:os').tmpdir() + '/media-eof-');
  const filename = path.join(tmp, 'record.flv');
  let authorize;
  require('../lib/publisher-auth').gatePublisher(publisher, () => new Promise(resolve => { authorize = resolve; }));
  let done = 0;
  const onDone = session => { if (session === publisher) done++; };
  Context.eventEmitter.on('donePublish', onDone);
  const record = new (dep('session/record_session'))({streamPath: '/live/eof'}, filename);
  const closed = new Promise(resolve => record.fileStream.once('close', resolve));
  record.run(); publisher.run();
  const Flv = dep('protocol/flv');
  const payload = Buffer.from([0xaf, 1, 11, 22, 33, 44, 55]);
  const last = Flv.createMessage({codec_type: 8, dts: 7, data: payload, size: payload.length});
  try {
    const first = Flv.createMessage({codec_type: 8, dts: 1, data: Buffer.from([0xaf, 1, 99]), size: 3});
    req.emit('data', Buffer.concat([Flv.createHeader(true, true), first, last]));
    req.emit('end');
    await tick();
    assert.equal(done, 0);
    assert.equal(publisher.res.writableEnded, false);
    authorize({id: 'allowed'}); await tick();
    assert.equal(publisher.res.writableEnded, true, 'finite POST must finish response without a socket close');
    await closed;
    assert.deepEqual(fs.readFileSync(filename), Buffer.concat([Flv.createHeader(true, true), first, last]));
    assert.equal(done, 1);
    assert.notEqual(socket.destroyed, true, 'keepalive connection stays open');
    req.emit('end'); socket.emit('close'); publisher.onClose(); await tick();
    assert.equal(done, 1);
    assert.equal(req.listenerCount('end'), 0);
    assert.equal(socket.listenerCount('close'), 0);
    assert.equal(safety.snapshot().activeSessions, 0);
  } finally {
    publisher.close(); record.close(); await closed;
    Context.eventEmitter.removeListener('donePublish', onDone);
    await tick(); safety.restore(); fs.rmSync(tmp, {recursive: true, force: true});
  }
});


test('pending FLV packets retain only owned payload bytes, not the reusable parser buffer', async () => {
  let resolve;
  const forwarded = [];
  const socket = {pause() {}, resume() {}, destroy() {this.destroyed = true;}};
  const session = {socket, onPush() {}, onPacket(packet) {forwarded.push(packet);}};
  require('../lib/publisher-auth').gatePublisher(session, () => new Promise(r => resolve = r));
  const pending = session.onPush();
  const data = Buffer.alloc(1024 * 1024, 0x11);
  session.onPacket({size: 3, data});
  data.fill(0x22);
  session.onPacket({size: 3, data});
  resolve({id: 'ok'}); await pending;
  assert.notEqual(socket.destroyed, true);
  assert.deepEqual(forwarded.map(p => [...p.data]), [[0x11, 0x11, 0x11], [0x22, 0x22, 0x22]]);
});


test('pending RTMP admission rejects a second synchronous protocol publish before rebinding', async () => {
  const safety = install();
  const Context = dep('core/context');
  const {Duplex} = require('node:stream');
  const session = new (dep('session/rtmp_session'))(new Duplex({read() {}, write(b, e, cb) {cb();}}));
  let resolve, broadcast, pushes = 0;
  const onPush = () => pushes++;
  Context.eventEmitter.on('postPublish', onPush);
  require('../lib/publisher-auth').gatePublisher(session, () => {
    broadcast = session.broadcast;
    return new Promise(r => resolve = r);
  });
  session.run(); session.rtmp.streamApp = 'live'; session.rtmp.streamHost = 'localhost';
  try {
    // Real encoded commands share one parser buffer; socket.pause() cannot
    // prevent the second onConnect/onPush continuation in this buffer.
    const encoder = new (dep('protocol/rtmp'))(), commands = [];
    encoder.onOutputCallback = data => commands.push(data);
    for (const streamName of ['allowed?key=valid', 'unauthorized']) {
      encoder.sendInvokeMessage(1, {cmd: 'publish', transId: 0, cmdObj: null, streamName, type: 'live'});
    }
    session.socket.emit('data', Buffer.concat([Buffer.from([3]), Buffer.alloc(3072), ...commands]));
    resolve({channelName: 'allowed'}); await session.publisherAdmission;
    assert.equal(pushes, 0, 'authorization of A must never publish B');
    assert.equal(session.streamPath, '/live/allowed');
    assert.equal(session.broadcast, broadcast);
    assert.equal(session.socket.destroyed, true);
    assert.equal(Context.broadcasts.has('/live/unauthorized'), false);
    await tick(); assert.equal(Context.broadcasts.size, 0);
  } finally {
    session.close(); await tick(); Context.eventEmitter.removeListener('postPublish', onPush);
    Context.broadcasts.clear(); safety.restore();
  }
});

test('RTMP real protocol callback continuation cannot revive a rejected rebind', async () => {
  const safety = install();
  const Context = dep('core/context');
  const session = new (dep('session/rtmp_session'))(sink());
  let plays = 0, pushes = 0;
  const onPlay = () => plays++;
  const onPush = () => pushes++;
  Context.eventEmitter.on('postPlay', onPlay); Context.eventEmitter.on('postPublish', onPush);
  session.run(); session.rtmp.streamApp = 'live'; session.rtmp.streamHost = 'localhost';
  try {
    session.rtmp.onPlay({streamName: 'bound'});
    const broadcast = session.broadcast;
    session.rtmp.onPlay({streamName: 'other'});
    session.rtmp.onPublish({streamName: 'revive'});
    assert.equal(plays, 1, 'onPlayCallback follows rejected onConnectCallback synchronously');
    assert.equal(pushes, 0);
    assert.equal(broadcast.publisher, null);
    assert.equal(broadcast.subscribers.size, 0);
    await tick(); assert.equal(Context.broadcasts.size, 0);
  } finally {
    session.close(); await tick();
    Context.eventEmitter.removeListener('postPlay', onPlay); Context.eventEmitter.removeListener('postPublish', onPush);
    Context.broadcasts.clear(); safety.restore();
  }
});


test('aggregate GOP ceiling releases on keyframes and close without scanning consumers', async () => {
  const safety = install({maxGopBytes: 1024, maxTotalGopBytes: 350});
  const make = name => {
    const publisher = new (dep('session/rtmp_session'))(sink());
    publisher.onConnect({app: 'live', name, host: 'localhost', query: {}}); publisher.onPush(); return publisher;
  };
  const first = make('cache-one'), second = make('cache-two');
  const unrelated = flv(sink(), 'unrelated-cache');
  Object.defineProperty(unrelated.res, 'writableLength', {configurable: true, get() {throw new Error('packet accounting scanned a consumer');}});
  const packet = flags => ({flags, codec_type: 9, dts: 0, data: Buffer.alloc(60), size: 60});
  try {
    first.onPacket(packet(3)); second.onPacket(packet(3));
    // Repeated keyframes replace rather than accumulate reservations.
    for (let i = 0; i < 10; i++) first.onPacket(packet(3));
    second.onPacket(packet(4));
    delete unrelated.res.writableLength;
    assert.equal(safety.snapshot().aggregateGopLimitEvictions, 1);
    assert.equal(safety.snapshot().currentGopBytes, 147);
    assert.ok(safety.snapshot().peakGopBytes <= 350);
    first.close(); first.onClose(); await tick();
    assert.equal(safety.snapshot().currentGopBytes, 0);
    second.onPacket(packet(3));
    assert.equal(safety.snapshot().currentGopBytes, 147);
    second.close(); await tick();
    assert.equal(safety.snapshot().currentGopBytes, 0);
  } finally {
    delete unrelated.res.writableLength;
    first.close(); second.close(); unrelated.close(); await tick(); safety.restore();
  }
});

test('HTTP EOF lifecycle deadline survives drain and closes a stalled startup once', async () => {
  const safety = install({maxBlockedMs: 20});
  const req = new EventEmitter(), socket = new EventEmitter();
  Object.assign(req, {socket, hostname: 'localhost', params: {app: 'live', name: 'stalled-eof'}, query: {}, method: 'POST'});
  const publisher = new (dep('session/flv_session'))(req, sink());
  let done = 0;
  const listener = session => {if(session === publisher) done++;};
  dep('core/context').eventEmitter.on('donePublish', listener);
  try {
    publisher.run(); publisher.lifecycle = new Promise(() => {});
    req.emit('end'); await tick(); publisher.res.emit('drain');
    await new Promise(r => setTimeout(r, 45));
    assert.equal(publisher.res.destroyed, true);
    assert.equal(done, 1);
    assert.equal(safety.snapshot().activeTimers, 0);
    assert.equal(safety.snapshot().activeSessions, 0);
  } finally {
    publisher.close(); await tick(); dep('core/context').eventEmitter.removeListener('donePublish', listener); safety.restore();
  }
});

test('HTTP EOF waits for asynchronous publisher lifecycle before recorder teardown', async () => {
  const safety = install();
  const Context = dep('core/context');
  const req = new EventEmitter(), socket = new EventEmitter();
  Object.assign(req, {socket, hostname: 'localhost', params: {app: 'live', name: 'lifecycle-eof'}, query: {}, method: 'POST'});
  const publisher = new (dep('session/flv_session'))(req, sink());
  let release, record, done = 0;
  const chunks = [];
  class Record extends dep('session/record_session') {
    createWriteStreamWithDirsSync() {return new Writable({write(b, e, cb) {chunks.push(Buffer.from(b)); cb();}});}
  }
  const start = session => {
    if(session !== publisher) return;
    session.lifecycle = new Promise(r => release = r).then(() => {record = new Record(session, 'unused'); record.run();});
  };
  const stop = session => {if(session === publisher) done++;};
  Context.eventEmitter.on('postPublish', start); Context.eventEmitter.on('donePublish', stop);
  try {
    publisher.run();
    const packet = {flags: 3, codec_type: 9, dts: 0, data: Buffer.from([0x17, 1, 0, 0, 0, 42]), size: 6};
    publisher.flv.onPacketCallback(packet); req.emit('end'); await tick();
    assert.equal(done, 0, 'EOF must not clear the GOP before the asynchronous recorder starts');
    assert.equal(publisher.res.writableEnded, false);
    release(); await publisher.lifecycle; await tick();
    assert.equal(done, 1); assert.equal(publisher.res.writableEnded, true);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([dep('protocol/flv').createHeader(true, true), dep('protocol/flv').createMessage(packet)]));
    assert.equal(record.fileStream.writableFinished, true);
  } finally {
    release?.(); await publisher.lifecycle; publisher.close(); record?.close(); await tick();
    Context.eventEmitter.removeListener('postPublish', start); Context.eventEmitter.removeListener('donePublish', stop); safety.restore();
  }
});

test('HTTP publisher EOF without an auth gate completes once and preserves final bytes', async () => {
  const safety = install();
  const req = new EventEmitter(); const socket = new EventEmitter();
  Object.assign(req, {socket, hostname: 'localhost', params: {app: 'live', name: 'direct-eof'}, query: {}, method: 'POST'});
  const publisher = new (dep('session/flv_session'))(req, sink());
  const chunks = [];
  const viewer = flv(new Writable({write(chunk, enc, cb) {chunks.push(Buffer.from(chunk)); cb();}}), 'direct-eof');
  const Flv = dep('protocol/flv'); const header = Flv.createHeader(true, true);
  const last = Flv.createMessage({codec_type: 8, dts: 9, data: Buffer.from([0xaf, 1, 123]), size: 3});
  let done = 0; const listener = () => done++;
  dep('core/context').eventEmitter.on('donePublish', listener);
  try {
    viewer.run(); publisher.run(); req.emit('data', Buffer.concat([header, last])); req.emit('end'); await tick();
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([header, last]));
    assert.equal(publisher.res.writableFinished, true);
    assert.equal(done, 1);
    socket.emit('close'); publisher.onClose(); assert.equal(done, 1);
  } finally {
    publisher.close(); viewer.close(); await tick();
    dep('core/context').eventEmitter.removeListener('donePublish', listener); safety.restore();
  }
});

test('FLV header advertises observed codec tracks and forces a fresh connection on track changes', async () => {
 const safety=install();
 const publisher=flv(sink(),'track-contract');
 publisher.isPublisher=true; publisher.onPush();
 const packet=(flags,codec_type)=>({flags,codec_type,codec_id:codec_type===9?7:10,dts:0,data:Buffer.from([codec_type===9?0x17:0xaf,0,0,0,0,0]),size:6});
 const chunks=[];
 let viewer;
 try {
  publisher.onPacket(packet(2,9));
  viewer=flv(new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback();}}),'track-contract');
  viewer.onPlay();
  assert.equal(chunks[0][4],1,'video-only must not advertise missing audio');
  publisher.onPacket(packet(0,8));
  assert.equal(viewer.res.destroyed,true,'late audio requires new MSE track negotiation');
  const paired=[];
  viewer=flv(new Writable({write(chunk,_encoding,callback){paired.push(Buffer.from(chunk));callback();}}),'track-contract');
  viewer.onPlay();assert.equal(paired[0][4],5);
  publisher.close();await tick();
  assert.equal(viewer.res.destroyed,true,'publisher replacement must not reuse old track topology');
 }finally{publisher.close();viewer?.close();await tick();safety.restore();}
});
}
