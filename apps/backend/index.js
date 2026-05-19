const Express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');
const nmsContext = require('node-media-server/src/core/context');
const NodeRecordSession = require('node-media-server/src/session/record_session');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const si = require('systeminformation');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
require('dotenv').config();

const VERBOSE = process.env.VERBOSE === 'true';
const logVerbose = (...args) => {
  if (VERBOSE) console.log(...args);
};

const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const redis = new Redis(process.env.REDIS_URL);
const sessionBitrates = new Map();
const activeRelays = new Map(); // Map<channelName, ChildProcess[]>
const activeRecordings = new Set(); // Set<sessionId>

// BigInt serialization fix for JSON.stringify
BigInt.prototype.toJSON = function() {
  return this.toString();
};

// Helper to get settings from DB with fallback to Env/Default
const getSetting = async (key, defaultValue) => {
  try {
    const setting = await prisma.setting.findUnique({ where: { key } });
    if (setting) {
      if (setting.type === 'number') return parseInt(setting.value);
      if (setting.type === 'boolean') return setting.value === 'true';
      return setting.value;
    }
  } catch (e) {}
  return defaultValue;
};

// Reset all live data on startup
async function resetOnStartup() {
  await redis.del('live_viewers');
  await redis.del('live_streams');
  const keys = await redis.keys('channel_users:*');
  if (keys.length > 0) await redis.del(keys);
  const userKeys = await redis.keys('usernames:*');
  if (userKeys.length > 0) await redis.del(userKeys);
  
  await prisma.stream.updateMany({
    data: { isLive: false }
  });
}
resetOnStartup();

const app = Express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- Security Helpers ---
const logSecurityEvent = async (event, { req, socket, details, userId, username } = {}) => {
  const ip = req ? req.ip : (socket ? socket.handshake.address : 'unknown');
  const uId = userId || (req && req.user ? req.user.id : (socket && socket.data ? socket.data.userId : null));
  const uName = username || (req && req.user ? req.user.username : (socket && socket.data ? socket.data.username : null));

  console.log(`[SECURITY] ${event} | User: ${uName || 'Anonymous'} | IP: ${ip} | Details: ${details || 'None'}`);
  
  try {
    const log = await prisma.securityLog.create({
      data: { event, userId: uId, username: uName, ip, details }
    });
    // Emit real-time log to all connected clients (Admin filtering happens on frontend or could be room-based)
    io.emit('new_security_log', log);
  } catch (e) {
    console.error('Failed to save security log:', e.message);
  }
};

const validatePasswordComplexity = (password) => {
  if (!password) return { valid: false, error: 'Password is required.' };
  if (password.length < 8) return { valid: false, error: 'Password must be at least 8 characters long.' };
  if (!/[A-Z]/.test(password)) return { valid: false, error: 'Password must contain at least one uppercase letter.' };
  if (!/[0-9]/.test(password)) return { valid: false, error: 'Password must contain at least one number.' };
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return { valid: false, error: 'Password must contain at least one special character.' };
  return { valid: true };
};

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors());
app.use(Express.json());
app.use('/recordings', Express.static(path.join(__dirname, 'recordings')));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
});

// Socket.io Auth Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    socket.data.roles = [];
    socket.data.isAnonymous = true;
    return next();
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error: Invalid token'));
    socket.data.userId = decoded.id;
    socket.data.username = decoded.username;
    socket.data.roles = decoded.roles || [];
    socket.data.isAnonymous = false;
    next();
  });
});

// Bootstrap and Start Servers
async function startServer() {
  const rtmpPort = await getSetting('rtmp_port', parseInt(process.env.RTMP_PORT) || 1935);
  const mediaPort = await getSetting('media_http_port', parseInt(process.env.MEDIA_HTTP_PORT) || 8000);
  const apiPort = await getSetting('api_port', parseInt(process.env.HTTP_PORT) || 3000);

  // --- RTMP Server Configuration ---
  const nmsConfig = {
    rtmp: {
      port: rtmpPort,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60
    },
    http: {
      port: mediaPort,
      allow_origin: '*'
    }
  };

  const nms = new NodeMediaServer(nmsConfig);

  // --- RTMP Events & Authentication ---
  nms.on('prePublish', async (session) => {
    if (!session || !session.streamPath) return;
    const StreamPath = session.streamPath;
    const args = session.streamQuery;
    const pathParts = StreamPath.split('/');
    if (pathParts.length < 3 || pathParts[1] !== 'live') {
      session.close();
      return;
    }

    const channelName = pathParts[2];
    const streamKey = args ? (args.key || args.sign || args.token) : null;

    if (!streamKey) {
      if (session.socket) session.socket.destroy();
      session.close();
      return;
    }

    try {
      const stream = await prisma.stream.findUnique({ where: { channelName } });
      if (!stream || stream.streamKey !== streamKey || stream.isDisabled) {
        if (session.socket) session.socket.destroy();
        session.close();
        return;
      }

      console.log(`[RTMP] AUTHORIZED: ${channelName}`);
      
      await prisma.stream.update({
        where: { channelName },
        data: { isLive: true, lastStartedAt: new Date() }
      });

      await redis.hset('live_streams', channelName, JSON.stringify({
        id: session.id,
        startTime: Date.now(),
        bitrate: 0,
        viewers: 0,
        isPublishing: true
      }));
    } catch (error) {
      console.error('[RTMP Error] Auth failed:', error.message);
      session.close();
    }
  });

  nms.on('postPublish', async (session) => {
    if (!session || !session.streamPath) return;
    const channelName = session.streamPath.split('/')[2];
    
    console.log(`[Relay] Starting post-publish tasks for: ${channelName}`);
    
    try {
      const stream = await prisma.stream.findUnique({ where: { channelName } });
      if (!stream) return;

      // --- Automated Recording ---
      if (stream.isRecordingEnabled) {
        console.log(`[Recording] Starting recording for ${channelName}...`);
        const recordingsDir = path.join(__dirname, 'recordings');
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);
        
        const randomSuffix = crypto.randomBytes(4).toString('hex');
        const fileName = `${Date.now()}_${randomSuffix}.flv`;
        const filePath = path.join(recordingsDir, session.streamPath, fileName);
        
        const recordSession = new NodeRecordSession(session, filePath);
        recordSession.run();
        activeRecordings.add(session.id);
      }

      // --- Restreaming ---
      if (activeRelays.has(channelName)) {
        activeRelays.get(channelName).forEach(proc => proc.kill());
        activeRelays.delete(channelName);
      }

      if (stream.restreamUrls && typeof stream.restreamUrls === 'object' && !Array.isArray(stream.restreamUrls)) {
        const ffmpegPath = await getSetting('ffmpeg_path', '/usr/bin/ffmpeg');
        const currentRelays = [];

        for (const [platform, config] of Object.entries(stream.restreamUrls)) {
          const { key, enabled } = config;
          const baseUrl = await getSetting(`${platform}_ingest`, config.url);
          
          if (enabled === true && baseUrl && baseUrl.trim() && key && key.trim()) {
            const trimmedUrl = baseUrl.trim();
            const fullUrl = trimmedUrl.endsWith('/') ? `${trimmedUrl}${key.trim()}` : `${trimmedUrl}/${key.trim()}`;
            console.log(`[Relay] Spawning FFmpeg for ${platform}: ${trimmedUrl}`);
            
            const args = [
              '-re',
              '-i', `rtmp://127.0.0.1:${rtmpPort}/live/${channelName}`,
              '-c', 'copy', '-f', 'flv', '-max_interleave_delta', '0', fullUrl
            ];

            const ffmpeg = spawn(ffmpegPath, args);
            ffmpeg.on('close', (code) => {
              logVerbose(`[Relay] FFmpeg for ${platform} closed with code ${code}`);
              if (activeRelays.has(channelName)) {
                const remaining = activeRelays.get(channelName).filter(p => p !== ffmpeg);
                if (remaining.length === 0) activeRelays.delete(channelName);
                else activeRelays.set(channelName, remaining);
              }
            });
            currentRelays.push(ffmpeg);
          }
        }
        if (currentRelays.length > 0) activeRelays.set(channelName, currentRelays);
      }
    } catch (error) {
      console.error('[Relay Error] Failed to start restreams:', error.message);
    }
  });

  nms.on('donePublish', async (session) => {
    if (!session || !session.streamPath) return;
    const channelName = session.streamPath.split('/')[2];
    console.log(`[RTMP] Stream ended: ${channelName}`);

    if (activeRelays.has(channelName)) {
      activeRelays.get(channelName).forEach(proc => proc.kill());
      activeRelays.delete(channelName);
    }

    const wasRecorded = activeRecordings.has(session.id);
    activeRecordings.delete(session.id);

    let startTime = Date.now();
    const liveDataStr = await redis.hget('live_streams', channelName);
    if (liveDataStr) startTime = JSON.parse(liveDataStr).startTime;

    try {
      await prisma.stream.update({ where: { channelName }, data: { isLive: false } });
    } catch (e) {}

    await redis.hdel('live_streams', channelName);
    sessionBitrates.delete(session.id);

    if (wasRecorded) {
      const recordingsDir = path.join(__dirname, 'recordings', 'live', channelName);
      setTimeout(async () => {
        try {
          if (fs.existsSync(recordingsDir)) {
            const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.flv')).sort((a, b) => 
              fs.statSync(path.join(recordingsDir, b)).mtime.getTime() - fs.statSync(path.join(recordingsDir, a)).mtime.getTime()
            );
            if (files.length > 0) {
              const flvFile = files[0];
              const flvPath = path.join(recordingsDir, flvFile);
              const mp4File = flvFile.replace('.flv', '.mp4');
              const mp4Path = path.join(recordingsDir, mp4File);
              const ffmpegPath = await getSetting('ffmpeg_path', '/usr/bin/ffmpeg');
              
              const conv = spawn(ffmpegPath, ['-i', flvPath, '-c', 'copy', '-copyts', mp4Path]);
              conv.on('close', async (code) => {
                if (code === 0) {
                  const stats = fs.statSync(mp4Path);
                  const stream = await prisma.stream.findUnique({ where: { channelName } });
                  if (stream) {
                    await prisma.recording.create({
                      data: {
                        streamId: stream.id,
                        fileName: mp4File,
                        filePath: `/recordings/live/${channelName}/${mp4File}`,
                        fileSize: BigInt(stats.size),
                        startedAt: new Date(startTime),
                        endedAt: new Date(),
                        duration: Math.round((Date.now() - startTime) / 1000)
                      }
                    });
                    io.emit('recording_saved', { channelName, fileName: mp4File });
                    fs.unlinkSync(flvPath);
                  }
                }
              });
            }
          }
        } catch (e) {}
      }, 3000);
    }
  });

  // WebSocket Stat Loop
  setInterval(async () => {
    try {
      const liveStreams = await redis.hgetall('live_streams') || {};
      const viewerCounts = await redis.hgetall('live_viewers') || {};
      const stats = {};
      const now = Date.now();
      const allChannels = new Set([...Object.keys(liveStreams), ...Object.keys(viewerCounts)]);
      const sessions = Array.from(nmsContext.sessions.values());
      
      const dbStreams = await prisma.stream.findMany({ select: { channelName: true, isDisabled: true, lastStartedAt: true } });
      const dbDataMap = Object.fromEntries(dbStreams.map(s => [s.channelName, { isDisabled: s.isDisabled, lastStartedAt: s.lastStartedAt }]));
      
      for (const channel of allChannels) {
        let streamData = { viewers: 0, bitrate: 0, isPublishing: false };
        if (liveStreams[channel]) try { streamData = JSON.parse(liveStreams[channel]); } catch (e) {}
        const session = sessions.find(s => s.id === streamData.id);
        const channelUsers = await redis.hgetall(`channel_users:${channel}`);
        streamData.viewers = Math.max(0, parseInt(viewerCounts[channel]) || 0);

        if (session) {
          const lastInfo = sessionBitrates.get(session.id) || { time: now - 2000, bytes: session.inBytes || 0 };
          const deltaBytes = (session.inBytes || 0) - lastInfo.bytes;
          const deltaTime = (now - lastInfo.time) / 1000;
          let currentBitrate = deltaTime > 0 ? (deltaBytes * 8) / (deltaTime * 1024) : 0;
          sessionBitrates.set(session.id, { time: now, bytes: session.inBytes || 0 });
          streamData.bitrate = Math.max(0, Math.round(currentBitrate));
          streamData.isPublishing = true;
        }

        stats[channel] = {
          viewers: streamData.viewers,
          bitrate: streamData.bitrate,
          isPublishing: !!streamData.isPublishing,
          isDisabled: !!(dbDataMap[channel]?.isDisabled),
          lastStartedAt: dbDataMap[channel]?.lastStartedAt || null,
          usernames: Object.keys(channelUsers),
          startTime: streamData.startTime || 0
        };
      }
      
      const cpu = await si.currentLoad();
      const totalRestreams = Array.from(activeRelays.values()).reduce((acc, curr) => acc + curr.length, 0);
      let totalRestreamThroughput = 0;
      for (const [ch, s] of Object.entries(stats)) {
        if (activeRelays.has(ch)) totalRestreamThroughput += (s.bitrate || 0) * activeRelays.get(ch).length;
      }
      
      const totalIngress = Object.values(stats).reduce((acc, curr) => acc + (curr.bitrate || 0), 0);
      logVerbose(`[WS] In: ${totalIngress} | Out: ${totalRestreamThroughput} | CPU: ${Math.round(cpu.currentLoad)}%`);
      
      io.emit('live_stats', { streams: stats, totalRestreams, totalRestreamThroughput, system: { cpu: Math.round(cpu.currentLoad) } });
    } catch (error) {}
  }, 2000);

  server.listen(apiPort, () => console.log(`API/WebSocket server running on port ${apiPort}`));
  nms.run();
  return { app, server, nms };
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, prisma, redis };

// --- API Endpoints ---
app.get('/', (req, res) => res.send('Streaming API is alive'));

app.get('/api/info', async (req, res) => {
  const [hostname, rtmpPort, mediaPort] = await Promise.all([
    getSetting('server_hostname', 'localhost'),
    getSetting('rtmp_port', 1935),
    getSetting('media_http_port', 8000)
  ]);
  res.json({ hostname, rtmpPort, mediaPort });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  if (user && await bcrypt.compare(password, user.passwordHash)) {
    const token = jwt.sign({ id: user.id, username: user.username, roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '1d' });
    logSecurityEvent('LOGIN_SUCCESS', { req, userId: user.id, username: user.username });
    return res.json({ token, username: user.username, roles: user.roles });
  }
  logSecurityEvent('LOGIN_FAILURE', { req, username, details: 'Invalid credentials' });
  res.status(401).json({ error: 'Invalid credentials' });
});

const authenticateUser = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token.split(' ')[1], process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Failed to authenticate token' });
    req.user = decoded;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.roles && req.user.roles.includes('ADMIN')) return next();
  res.status(403).json({ error: 'Access denied.' });
};

app.get('/api/users', authenticateUser, requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({ select: { id: true, username: true, roles: true, createdAt: true, authorizedStreams: { select: { id: true, channelName: true } } } });
  res.json(users);
});

app.post('/api/users', authenticateUser, requireAdmin, async (req, res) => {
  const { username, password, roles, authorizedStreamIds } = req.body;
  
  const complexity = validatePasswordComplexity(password);
  if (!complexity.valid) return res.status(400).json({ error: complexity.error });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { username, passwordHash, roles: roles || ['STREAM_MANAGER'], authorizedStreams: { connect: (authorizedStreamIds || []).map(id => ({ id })) } } });
    logSecurityEvent('USER_CREATED', { req, details: `Created user: ${username}` });
    res.json(user);
  } catch (e) { res.status(400).json({ error: 'Failed to create user' }); }
});

app.put('/api/users/:id', authenticateUser, requireAdmin, async (req, res) => {
  const { username, password, roles, authorizedStreamIds } = req.body;
  const updateData = { username, roles, authorizedStreams: { set: (authorizedStreamIds || []).map(id => ({ id })) } };
  
  if (password) {
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) return res.status(400).json({ error: complexity.error });
    updateData.passwordHash = await bcrypt.hash(password, 10);
    logSecurityEvent('PASSWORD_CHANGED_ADMIN', { req, details: `Admin changed password for: ${username}` });
  }

  const user = await prisma.user.update({ where: { id: req.params.id }, data: updateData });
  logSecurityEvent('USER_UPDATED', { req, details: `Updated user: ${username}` });
  res.json(user);
});

app.delete('/api/users/:id', authenticateUser, requireAdmin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (user) {
    await prisma.user.delete({ where: { id: req.params.id } });
    logSecurityEvent('USER_DELETED', { req, details: `Deleted user: ${user.username}` });
  }
  res.json({ success: true });
});

app.get('/api/streams', authenticateUser, async (req, res) => {
  const where = {};
  if (!req.user.roles.includes('ADMIN')) {
    where.authorizedUsers = { some: { id: req.user.id } };
    if (req.user.roles.includes('CLIENT')) where.isDisabled = false;
  }
  const [streams, viewerCounts, liveStreams] = await Promise.all([
    prisma.stream.findMany({ where, include: { recordings: { orderBy: { createdAt: 'desc' } } } }),
    redis.hgetall('live_viewers'),
    redis.hgetall('live_streams')
  ]);
  res.json(streams.map(s => {
    const live = liveStreams[s.channelName] ? JSON.parse(liveStreams[s.channelName]) : null;
    return { ...s, viewers: parseInt(viewerCounts[s.channelName]) || 0, isPublishing: s.isLive || (live ? !!live.isPublishing : false), startTime: live ? live.startTime : 0 };
  }));
});

app.post('/api/streams', authenticateUser, async (req, res) => {
  const { channelName, isPasswordProtected, password, restreamUrls, isRecordingEnabled } = req.body;
  
  if (!/^[a-zA-Z0-9-_]+$/.test(channelName)) {
    return res.status(400).json({ error: 'Invalid channel name. Use alphanumeric characters, dashes, or underscores only.' });
  }

  const stream = await prisma.stream.create({ data: { channelName, streamKey: Math.random().toString(36).substring(2), isPasswordProtected, isRecordingEnabled: !!isRecordingEnabled, password, restreamUrls: restreamUrls || {} } });
  res.json(stream);
});

app.put('/api/streams/:id', authenticateUser, async (req, res) => {
  const { channelName, isPasswordProtected, password, restreamUrls, regenerateKey, isDisabled, isRecordingEnabled } = req.body;

  if (channelName && !/^[a-zA-Z0-9-_]+$/.test(channelName)) {
    return res.status(400).json({ error: 'Invalid channel name. Use alphanumeric characters, dashes, or underscores only.' });
  }

  const updateData = { channelName, isPasswordProtected, isRecordingEnabled: isRecordingEnabled !== undefined ? !!isRecordingEnabled : undefined, password, restreamUrls, isDisabled };
  if (regenerateKey) updateData.streamKey = Math.random().toString(36).substring(2);
  const stream = await prisma.stream.update({ where: { id: req.params.id }, data: updateData });
  if (isDisabled === true) {
    const live = await redis.hget('live_streams', stream.channelName);
    if (live) {
      const sess = Array.from(nmsContext.sessions.values()).find(s => s.id === JSON.parse(live).id);
      if (sess) { sess.socket?.destroy(); sess.res?.end(); sess.close(); }
    }
  }
  res.json(stream);
});

app.delete('/api/streams/:id', authenticateUser, async (req, res) => {
  const stream = await prisma.stream.findUnique({ where: { id: req.params.id } });
  await prisma.stream.delete({ where: { id: req.params.id } });
  logSecurityEvent('STREAM_DELETED', { req, details: `Deleted channel: ${stream?.channelName}` });
  res.json({ success: true });
});

app.get('/api/settings', authenticateUser, requireAdmin, async (req, res) => {
  res.json(await prisma.setting.findMany({ orderBy: { key: 'asc' } }));
});

app.put('/api/settings/:key', authenticateUser, requireAdmin, async (req, res) => {
  const { value, description } = req.body;
  const setting = await prisma.setting.update({ where: { key: req.params.key }, data: { value, description } });
  logSecurityEvent('SETTING_UPDATED', { req, details: `Updated setting ${req.params.key} to ${value}` });
  res.json(setting);
});

app.get('/api/logs', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const logs = await prisma.securityLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500 // Limit to last 500 logs for performance
    });
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.delete('/api/recordings/:id', authenticateUser, async (req, res) => {
  const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
  if (rec) {
    const p = path.join(__dirname, rec.filePath);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    await prisma.recording.delete({ where: { id: req.params.id } });
  }
  res.json({ success: true });
});

app.get('/api/recordings/:id/download', authenticateUser, async (req, res) => {
  const rec = await prisma.recording.findUnique({ where: { id: req.params.id } });
  if (rec) res.download(path.join(__dirname, rec.filePath), rec.title ? `${rec.title}.mp4` : rec.fileName);
  else res.status(404).send('Not found');
});

app.put('/api/recordings/:id', authenticateUser, async (req, res) => {
  const { title } = req.body;
  try {
    const recording = await prisma.recording.update({
      where: { id: req.params.id },
      data: { title }
    });
    res.json(recording);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update recording' });
  }
});

app.put('/api/profile', authenticateUser, async (req, res) => {
  const { username, password } = req.body;
  const updateData = { username };
  
  if (password) {
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) return res.status(400).json({ error: complexity.error });
    updateData.passwordHash = await bcrypt.hash(password, 10);
    logSecurityEvent('PASSWORD_CHANGED_SELF', { req });
  }
  
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData
    });
    logSecurityEvent('PROFILE_UPDATED', { req });
    res.json({ username: user.username });
  } catch (error) {
    res.status(400).json({ error: 'Failed to update profile' });
  }
});

app.get('/api/public/streams/:channelName', async (req, res) => {
  const s = await prisma.stream.findUnique({ where: { channelName: req.params.channelName }, select: { channelName: true, isLive: true, isDisabled: true, isPasswordProtected: true, password: true } });
  if (s) res.json(s); else res.status(404).send('Not found');
});

app.get('/api/public/recordings/:id', async (req, res) => {
  try {
    const recording = await prisma.recording.findUnique({
      where: { id: req.params.id },
      include: {
        stream: {
          select: { channelName: true }
        }
      }
    });

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    res.json(recording);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recording' });
  }
});

// --- WebSockets for Chat & Dashboard ---
io.on('connection', (socket) => {
  logVerbose('A user connected:', socket.id, socket.data.username || 'Anonymous');

  socket.on('check_username', async ({ channelName, username }, callback) => {
    const isTaken = await redis.hexists(`channel_users:${channelName}`, username);
    callback({ available: !isTaken });
  });

  socket.on('join_channel', async ({ channelName, username }) => {
    socket.join(channelName);
    socket.data.currentChannel = channelName;
    socket.data.username = username;
    
    await redis.hset(`channel_users:${channelName}`, username, socket.id);
    await redis.hset(`usernames:${socket.id}`, 'username', username);
    await redis.hset(`usernames:${socket.id}`, 'channel', channelName);
    
    const count = await redis.hincrby('live_viewers', channelName, 1);
    
    io.to(channelName).emit('receive_message', {
      isSystem: true,
      message: `${username} joined the channel`
    });
    
    logVerbose(`[Socket] ${username} joined ${channelName}. Total: ${count}`);
  });

  socket.on('send_message', ({ channelName, username, message }) => {
    io.to(channelName).emit('receive_message', { username, message, time: Date.now() });
  });

  socket.on('leave_channel', async () => {
    const { currentChannel, username } = socket.data;
    if (currentChannel && username) {
      await redis.hdel(`channel_users:${currentChannel}`, username);
      await redis.hdel(`usernames:${socket.id}`, 'username', 'channel');
      const count = await redis.hincrby('live_viewers', currentChannel, -1);
      
      io.to(currentChannel).emit('receive_message', {
        isSystem: true,
        message: `${username} left the channel`
      });
      socket.leave(currentChannel);
      socket.data.currentChannel = null;
      logVerbose(`[Socket] ${username} left ${currentChannel}. Remaining: ${count}`);
    }
  });

  socket.on('kick_user', async ({ channelName, username }) => {
    if (!socket.data.roles.includes('ADMIN')) return;
    const targetSocketId = await redis.hget(`channel_users:${channelName}`, username);
    if (targetSocketId) {
      logSecurityEvent('USER_KICKED', { socket, details: `Kicked ${username} from ${channelName}` });
      io.to(targetSocketId).emit('kicked');
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) targetSocket.disconnect();
    }
  });

  socket.on('stop_publishing', async ({ channelName }) => {
    if (!socket.data.roles.includes('ADMIN')) return;
    const liveDataStr = await redis.hget('live_streams', channelName);
    if (liveDataStr) {
      const { id } = JSON.parse(liveDataStr);
      const sess = Array.from(nmsContext.sessions.values()).find(s => s.id === id);
      if (sess) {
        logSecurityEvent('STREAM_STOPPED_FORCE', { socket, details: `Force stopped channel: ${channelName}` });
        sess.socket?.destroy();
        sess.close();
      }
    }
  });

  socket.on('disconnect', async () => {
    const { currentChannel, username } = socket.data;
    if (currentChannel && username) {
      await redis.hdel(`channel_users:${currentChannel}`, username);
      await redis.hdel(`usernames:${socket.id}`, 'username', 'channel');
      await redis.hincrby('live_viewers', currentChannel, -1);
      io.to(currentChannel).emit('receive_message', {
        isSystem: true,
        message: `${username} disconnected`
      });
    }
    logVerbose('User disconnected:', socket.id);
  });
});
