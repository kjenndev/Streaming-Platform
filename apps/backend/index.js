const Express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) require('./tests/test-env');
else require('dotenv').config({quiet:true});
const {pageQuery,scopedStats,Membership,chatAllowed,chatIdentity,serialCollector}=require('./lib/control-runtime');
const {processTelemetry}=require('./lib/process-runtime');
const {superviseMedia}=require('./lib/media-supervisor');
const playback=require('./lib/playback-auth');
const mssDelegation=require('./lib/mss-delegation').createMssDelegation({env:process.env});

const {createRecordingRecovery}=require('./lib/recording-recovery');
const recordingsRoot=path.resolve(process.env.RECORDINGS_ROOT || path.join(__dirname,'recordings'));
const recordingPath=value=>{
 if(typeof value!=='string' || !value.startsWith('/recordings/') || value.includes('\\'))throw new Error('Invalid recording path');
 const resolved=path.resolve(recordingsRoot,value.slice('/recordings/'.length));
 if(!resolved.startsWith(recordingsRoot+path.sep))throw new Error('Invalid recording path');
 // Reject symlink escapes as well as lexical traversal.
 if(!fs.existsSync(resolved))return resolved;
 const real=fs.realpathSync(resolved),root=fs.realpathSync(recordingsRoot);
 if(!real.startsWith(root+path.sep))throw new Error('Invalid recording path');
 return real;
};
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
const passwordBudget=require('./lib/password-budget').createPasswordBudget(redis);
const membership=new Membership();
const metadata=new Map();
const settingsCache=new Map();
let media,collector,authorizationCollector,meter,latest={streams:{},media:null,totalRestreams:0,totalRestreamThroughput:0},apiMetrics=null,started=false,stopping,starting;
const apiSockets=new Set();
let effectivePorts;
let apiEgressClosed=0,lastApiEgress=0,lastApiSample=Date.now();

// BigInt serialization fix for JSON.stringify
BigInt.prototype.toJSON = function() {
  return this.toString();
};

// Helper to get settings from DB with fallback to Env/Default
const getSetting = async (key, defaultValue) => {
  const cached=settingsCache.get(key);
  if(cached && Date.now()-cached.time<60000) return cached.value;
  try {
    const setting = await prisma.setting.findUnique({ where: { key } });
    if (setting) {
      const value=setting.type==='number'?parseInt(setting.value):setting.type==='boolean'?setting.value==='true':setting.value;
      settingsCache.set(key,{time:Date.now(),value});return value;
    }
  } catch (e) {}
  return defaultValue;
};

const app = Express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024,
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
    await emitDashboard('new_security_log',log);
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
app.use(cors({exposedHeaders:['X-Total-Count','X-Next-Offset','Retry-After']}));
app.use(Express.json());
// No anonymous static mount: resolve metadata, authorize its parent, then send.
app.use('/recordings',async(req,res)=>{
 if(!['GET','HEAD'].includes(req.method))return res.sendStatus(405);
 try{
  const filePath='/recordings'+decodeURIComponent(req.path);
  const rec=await prisma.recording.findFirst({where:{filePath},include:{stream:{include:playback.streamInclude}}});
  if(!rec)return res.sendStatus(404);
  if(!await recordingReadable(req,rec.stream))return res.sendStatus(403);
  res.set('Cache-Control','private, no-store');
  const file=recordingPath(rec.filePath);
  res.sendFile(path.basename(file),{root:path.dirname(file)});
 }catch{return res.sendStatus(404);}
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
});

// Socket.io Auth Middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  const delegatedGrant=socket.handshake.auth.mssGrant,delegatedChannel=socket.handshake.auth.channelName;
  if(delegatedGrant || delegatedChannel){
    try{const identity=await mssDelegation.authorize(delegatedGrant,delegatedChannel);socket.data.roles=[];socket.data.isAnonymous=false;socket.data.mssGrant=delegatedGrant;socket.data.mssIdentity=identity;return next();}
    catch{return next(Object.assign(new Error('Delegated session denied'),{data:{status:401,code:'DELEGATION_DENIED'}}));}
  }
  if (!token) {
    socket.data.roles = [];
    socket.data.isAnonymous = true;
    return next();
  }
  
  let decoded;
  const reject=(status,body)=>next(Object.assign(new Error(body.error),{data:{status,...body}}));
  try{decoded=verifySession(token);}catch(error){return reject(401,sessionError(error));}
  try {
    const user=await principal(decoded.id);
    if(!user)return reject(401,sessionError());
    socket.data.userId=user.id;socket.data.username=user.username;
    socket.data.sessionExpiresAt=decoded.exp?decoded.exp*1000:null;
    socket.data.roles=user.roles;socket.data.isAnonymous=false;next();
  }catch{return reject(503,{code:'AUTH_UNAVAILABLE',error:'Authentication service temporarily unavailable.'});}
});

// API owns membership and compact delivery; media owns ingest/live_streams.
server.on('connection',socket=>{
 apiSockets.add(socket);socket.once('close',()=>{apiEgressClosed+=socket.bytesWritten;apiSockets.delete(socket);});
});
async function collectStats(){
 const counts=membership.counts(),channels=[...new Set([...Object.keys(counts),...Object.keys(latest.streams)])];
 const missing=channels.filter(ch=>!metadata.has(ch) || Date.now()-metadata.get(ch).cachedAt>30000);
 if(missing.length){
  const rows=await prisma.stream.findMany({where:{channelName:{in:missing}},select:{channelName:true,isDisabled:true,lastStartedAt:true}});
  for(const row of rows) metadata.set(row.channelName,{...row,cachedAt:Date.now()});
 }
 const activeChannels=new Set(channels);
 for(const channel of metadata.keys()) if(!activeChannels.has(channel))metadata.delete(channel);
 const streams={};
 for(const channel of channels){const live=latest.streams[channel] || {};const meta=metadata.get(channel) || {};streams[channel]={viewers:counts[channel] || 0,bitrate:live.bitrate || 0,isPublishing:!!live.isPublishing,isDisabled:!!meta.isDisabled,lastStartedAt:meta.lastStartedAt || null,startTime:live.startTime || 0};}
 // One bounded Redis batch per tick, never per-viewer stats round trips.
 const batch=redis.pipeline().del('live_viewers');
 if(Object.keys(counts).length)batch.hset('live_viewers',counts);
 await batch.exec();
 if(stopping)return;
 const egressBytes=apiEgressClosed+[...apiSockets].reduce((sum,s)=>sum+s.bytesWritten,0);
 const now=Date.now();
 apiMetrics={...meter.sample(),sockets:io.engine.clientsCount,httpConnections:apiSockets.size,egressBytes,egressBitsPerSecond:Math.max(0,(egressBytes-lastApiEgress)*8000/Math.max(1,now-lastApiSample))};
 lastApiSample=now;lastApiEgress=egressBytes;
 const telemetry={api:apiMetrics,media:latest.media};
 await emitDashboard('live_stats',{streams,totalRestreams:latest.totalRestreams,totalRestreamThroughput:latest.totalRestreamThroughput,system:{cpu:apiMetrics.cpuPercent},telemetry});
 for(const channel of membership.channels.keys())io.to(`channel:${channel}`).emit('live_stats',scopedStats(streams,channel));
}
function startServer(){
 if(stopping)return Promise.reject(new Error('Server stopped; restart requires a new process'));
 if(starting)return starting;
 starting=startRuntime();return starting;
}
async function startRuntime(){
 if(started)return {app,server,nms:media,stop:stopServer};
 const rtmpPort=Number(process.env.RTMP_PORT) || await getSetting('rtmp_port',1935);
 const mediaPort=Number(process.env.MEDIA_HTTP_PORT) || await getSetting('media_http_port',8000);
 const apiPort=Number(process.env.HTTP_PORT) || await getSetting('api_port',3000);
 if(stopping)throw new Error('Server stopped during startup');
 effectivePorts={rtmpPort,mediaPort,apiPort};
 meter=processTelemetry();
 media=superviseMedia({env:{RTMP_PORT:String(rtmpPort),MEDIA_HTTP_PORT:String(mediaPort)},onMessage(message){
  if(message.type==='stats')latest=message;
  if(message.type==='invalidate')metadata.delete(message.channel);
  if(message.type==='recording_saved')void emitDashboard('recording_saved',{channelName:message.channelName,fileName:message.fileName}).catch(()=>{});
 },onUnavailable(){latest={streams:{},media:null,totalRestreams:0,totalRestreamThroughput:0};metadata.clear();}});
 try{
  await media.ready;
  if(stopping)throw new Error('Server stopped during startup');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(apiPort,process.env.BIND_HOST || '0.0.0.0',resolve);});
  if(stopping)throw new Error('Server stopped during startup');
  authorizationCollector=serialCollector(revalidateSockets,2000,error=>console.error('[API] authorization sweep failed:',error.name));
  collector=serialCollector(collectStats,2000,error=>console.error('[API] stats failed:',error.name));
  await collector.tick();
  if(stopping)throw new Error('Server stopped during startup');
  started=true;return {app,server,nms:media,stop:stopServer};
 }catch(error){await stopServer();throw error;}
}
function stopServer(){
 if(stopping)return stopping;
 stopping=(async()=>{
  const timeoutMs=Math.max(1,Number(process.env.API_SHUTDOWN_TIMEOUT_MS) || 32000);
  let timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);});
  const httpClosed=new Promise(resolve=>io.close(resolve));
  for(const socket of apiSockets)socket.destroy();
  const drain=Promise.all([collector?.stop(),authorizationCollector?.stop(),httpClosed,media?.stop()]).then(()=>redis.del('live_viewers'));
  try{await Promise.race([drain,deadline]);}
  finally{clearTimeout(timer);meter?.close();started=false;}
 })();return stopping;
}
// Legacy tests call server.close(); also release child/collector in that path.
server.on('close',()=>{if(!stopping && started)stopServer().catch(console.error);});
if(require.main===module){
 startServer().catch(error=>{console.error('[API] startup failed:',error.code || error.name);process.exit(1);});
 const shutdown=async()=>{const deadline=setTimeout(()=>process.exit(1),35000);await stopServer();await redis.quit();await prisma.$disconnect();await pool.end();clearTimeout(deadline);process.exit(0);};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
module.exports={startServer,stopServer,prisma,redis,pool,collectStats};

// --- API Endpoints ---
app.get('/', (req, res) => res.send('Streaming API is alive'));

app.get('/api/info', async (req, res) => {
  const hostname=await getSetting('server_hostname','localhost');
  res.json({hostname,rtmpPort:effectivePorts.rtmpPort,mediaPort:effectivePorts.mediaPort});
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  if (user?.roles.length && await bcrypt.compare(password, user.passwordHash)) {
    const token = jwt.sign({ id: user.id, username: user.username, roles: user.roles }, process.env.JWT_SECRET, { expiresIn: '1d' });
    logSecurityEvent('LOGIN_SUCCESS', { req, userId: user.id, username: user.username });
    return res.json({ token, username: user.username, roles: user.roles });
  }
  logSecurityEvent('LOGIN_FAILURE', { req, username, details: 'Invalid credentials' });
  res.status(401).json({ error: 'Invalid credentials' });
});

async function principal(id, db=prisma) {
 if(typeof id!=='string')return null;
 const user=await db.user.findUnique({where:{id},select:{id:true,username:true,roles:true}});
 return user?.roles.length ? user : null;
}
function sessionError(error) {
 return {code:error?.name==='TokenExpiredError'?'SESSION_EXPIRED':'SESSION_INVALID',error:'Your session has expired or is no longer valid. Please sign in again.'};
}
function verifySession(token) {
 return jwt.verify(token.replace(/^Bearer /,''),process.env.JWT_SECRET,{algorithms:['HS256']});
}
const authenticateUser = async (req, res, next) => {
 const token=req.headers.authorization;
 if(!token)return res.status(401).json(sessionError());
 let decoded;
 try{decoded=verifySession(token);}catch(error){return res.status(401).json(sessionError(error));}
 try {
  req.user=await principal(decoded.id);
  if(!req.user)return res.status(401).json(sessionError());
 }catch{return res.status(503).json({error:'Authentication service temporarily unavailable.'});}
 next();
};
// Lock the acting principal within privilege-changing transactions. Concurrent
// role updates/deletions must serialize with the authorization and write.
async function principalWrite(req, action, admin=true) {
 return prisma.$transaction(async db=>{
  await db.$queryRaw`SELECT id FROM "User" WHERE id = ${req.user.id} FOR UPDATE`;
  const user=await principal(req.user.id,db);
  if(!user)throw Object.assign(new Error('Session invalid'),{status:401});
  if(admin && !user.roles.includes('ADMIN'))throw Object.assign(new Error('Access denied'),{status:403});
  return action(db,user);
 },{isolationLevel:'Serializable'});
}

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.roles && req.user.roles.includes('ADMIN')) return next();
  res.status(403).json({ error: 'Access denied.' });
};

// Re-read mutation principals so signed but stale roles cannot retain privileges.
async function currentUser(req, res, next) {
 const user = await principal(req.user.id);
 if (!user) return res.status(401).json(sessionError());
 req.user=user; next();
}
function requireManager(req,res,next) {
 if (req.user.roles.includes('ADMIN') || (req.user.roles.includes('STREAM_MANAGER') && !req.user.roles.includes('CLIENT'))) return next();
 return res.status(403).json({error:'Access denied.'});
}
function adminControls(req,res,next) {
 if (!req.user.roles.includes('ADMIN') && req.body.isDisabled !== undefined) return res.status(403).json({error:'Access denied.'});
 next();
}
function pagingHeaders(res,total,skip,take){
 res.set('X-Total-Count',String(total));res.set('X-Next-Offset',skip+take<total?String(skip+take):'');
}
async function authorizedStream(req,res,next){
 const where={id:req.params.id};
 if(!req.user.roles.includes('ADMIN')){
  where.authorizedUsers={some:{id:req.user.id}};
  if(req.user.roles.includes('CLIENT'))where.isDisabled=false;
 }
 const stream=await prisma.stream.findFirst({where,select:{id:true,channelName:true}});
 if(!stream)return res.status(403).json({error:'Access denied.'});
 req.stream=stream;next();
}
async function authorizedRecording(req,res,next) {
 const where={id:req.params.id};
 if(!req.user.roles.includes('ADMIN')) {
  where.stream={authorizedUsers:{some:{id:req.user.id}}};
  if(req.user.roles.includes('CLIENT'))where.stream.isDisabled=false;
 }
 const recording=await prisma.recording.findFirst({where});
 if(!recording)return res.status(403).json({error:'Access denied.'});
 req.recording=recording;next();
}
async function requestUser(req){
 const header=req.headers.authorization;
 if(!header)return null;
 try{
  const p=jwt.verify(header.replace(/^Bearer /,''),process.env.JWT_SECRET,{algorithms:['HS256']});
  if(typeof p.id!=='string')return null;
  const u=await prisma.user.findUnique({where:{id:p.id}});
  return u?.roles.length?u:null;
 }catch{return null;}
}
async function recordingReadable(req,stream){
 const user=await requestUser(req);
 if(playback.assigned(stream,user) && (!stream.isDisabled || !user.roles.includes('CLIENT') || user.roles.includes('ADMIN')))return true;
 return playback.allowed(stream,req.query.cap,'recording',{db:prisma});
}
async function passwordAdmission(stream,authorized,password,address){
 if(!stream || stream.isDisabled)return {ok:false,status:403};
 if(!stream.isPasswordProtected || authorized)return {ok:true};
 const budget=await passwordBudget(address,stream.id);
 if(!budget.ok)return budget;
 return {ok:typeof password==='string' && password===stream.password,status:403};
}
function passwordDenied(res,result){
 if(result.retryAfter)res.set('Retry-After',String(result.retryAfter));
 return res.status(result.status).json({error:result.status===403?'Access denied.':'Password attempts temporarily unavailable. Please retry later.',...(result.code?{code:result.code,retryAfter:result.retryAfter}:{})});
}
const playbackLimiter=rateLimit({windowMs:60000,max:30});
app.post('/api/public/streams/:channelName/playback',playbackLimiter,async(req,res)=>{
 const stream=await prisma.stream.findUnique({where:{channelName:req.params.channelName},include:playback.streamInclude});
 const purpose=req.body.purpose || 'live';
 if(!['live','recording','membership'].includes(purpose))return res.sendStatus(400);
 const user=await requestUser(req);
 const authorized=playback.assigned(stream || {},user);
 const admission=await passwordAdmission(stream,authorized,req.body.password,req.socket.remoteAddress);
 if(!admission.ok)return passwordDenied(res,admission);
 res.set('Cache-Control','no-store');
 res.json({cap:playback.issue(stream,{purpose,user:authorized?user:undefined}),expiresIn:playback.TTL});
});
app.get('/api/integrations/mss/config',(req,res)=>res.json(mssDelegation.publicConfig()));
app.post('/api/integrations/mss/session',async(req,res)=>{
 try{
  const identity=await mssDelegation.authorize(req.body?.grant,req.body?.channelName);
  const stream=await prisma.stream.findUnique({where:{channelName:identity.channel},select:{id:true,channelName:true,streamKey:true,isDisabled:true,isLive:true}});
  if(!stream || stream.isDisabled)return res.status(403).json({error:'Delegated channel unavailable'});
  res.set('Cache-Control','private, no-store').json({channelName:stream.channelName,isLive:stream.isLive,displayName:identity.displayName});
 }catch{return res.status(403).json({error:'Delegated access denied'});}
});
app.get('/api/metrics',authenticateUser,requireAdmin,(req,res)=>res.json({api:apiMetrics,media:latest.media}));
app.get('/api/streams/:id/viewers',authenticateUser,authorizedStream,(req,res)=>{
 const {skip,take}=pageQuery(req.query),channel=req.stream.channelName;
 pagingHeaders(res,membership.channels.get(channel)?.size || 0,skip,take);
 res.json(membership.viewers(channel,skip,take));
});
app.get('/api/streams/:id/recordings',authenticateUser,authorizedStream,async(req,res)=>{
 const {skip,take}=pageQuery(req.query),where={streamId:req.stream.id};
 const [items,total]=await Promise.all([prisma.recording.findMany({where,skip,take,orderBy:[{createdAt:'desc'},{id:'asc'}]}),prisma.recording.count({where})]);
 pagingHeaders(res,total,skip,take);res.json(items);
});

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
    const user = await principalWrite(req,db=>db.user.create({ data: { username, passwordHash, roles: roles || ['STREAM_MANAGER'], authorizedStreams: { connect: (authorizedStreamIds || []).map(id => ({ id })) } } }));
    logSecurityEvent('USER_CREATED', { req, details: `Created user: ${username}` });
    const {passwordHash:omitted,...visible}=user;res.json(visible);
  } catch (e) { res.status(e.status || 400).json({ error: 'Failed to create user' }); }
});

app.put('/api/users/:id', authenticateUser, requireAdmin, async (req, res) => {
  const { username, password, roles, authorizedStreamIds } = req.body;
  const updateData = { username, roles, authorizedStreams: { set: (authorizedStreamIds || []).map(id => ({ id })) } };
  
  if (password) {
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) return res.status(400).json({ error: complexity.error });
    updateData.passwordHash = await bcrypt.hash(password, 10);

  }

  const user = await principalWrite(req,db=>db.user.update({ where: { id: req.params.id }, data: updateData }));
  if(password)logSecurityEvent('PASSWORD_CHANGED_ADMIN',{req,details:'Administrator changed a user password'});
  logSecurityEvent('USER_UPDATED', { req, details: `Updated user: ${username}` });
  const {passwordHash:omitted,...visible}=user;res.json(visible);
});

app.delete('/api/users/:id', authenticateUser, requireAdmin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (user) {
    await principalWrite(req,db=>db.user.delete({ where: { id: req.params.id } }));
    logSecurityEvent('USER_DELETED', { req, details: `Deleted user: ${user.username}` });
  }
  res.json({ success: true });
});

app.get('/api/streams', authenticateUser, currentUser, async (req, res) => {
  const where = {};
  if (!req.user.roles.includes('ADMIN')) {
    where.authorizedUsers = { some: { id: req.user.id } };
    if (req.user.roles.includes('CLIENT')) where.isDisabled = false;
  }
  const {take,skip}=pageQuery(req.query);
  if(typeof req.query.search==='string' && req.query.search.trim())where.channelName={contains:req.query.search.trim().slice(0,128),mode:'insensitive'};
  if(req.query.hideOffline==='true' || req.query.hideOffline==='1')where.isLive=true;
  const orderBy=req.query.sort==='name'?[{channelName:'asc'},{id:'asc'}]:[{isLive:'desc'},{channelName:'asc'},{id:'asc'}];
  const [streams,total]=await Promise.all([
    prisma.stream.findMany({where,take,skip,orderBy,include:{recordings:{take:5,orderBy:{createdAt:'desc'}},_count:{select:{recordings:true}}}}),
    prisma.stream.count({where})
  ]);
  const names=streams.map(s=>s.channelName);
  const live=names.length?await redis.hmget('live_streams',...names):[];
  pagingHeaders(res,total,skip,take);
  const counts=membership.counts();
  res.json(streams.map((s,index)=>{
    let data={};try{data=JSON.parse(live[index] || '{}');}catch{}
    const visible = req.user.roles.includes('ADMIN') || (req.user.roles.includes('STREAM_MANAGER') && !req.user.roles.includes('CLIENT')) ? s : {id:s.id,channelName:s.channelName,isLive:s.isLive,isDisabled:s.isDisabled,isPasswordProtected:s.isPasswordProtected,lastStartedAt:s.lastStartedAt,recordings:s.recordings};
    return {...visible,recordingsTotal:s._count.recordings,viewers:counts[s.channelName] || 0,isPublishing:s.isLive || !!data.isPublishing,startTime:data.startTime || 0};
  }));
});

app.post('/api/streams', authenticateUser, currentUser, requireAdmin, async (req, res) => {
  const { channelName, isPasswordProtected, password, restreamUrls, isRecordingEnabled } = req.body;
  
  if (!/^[a-zA-Z0-9-_]+$/.test(channelName)) {
    return res.status(400).json({ error: 'Invalid channel name. Use alphanumeric characters, dashes, or underscores only.' });
  }

  const stream = await principalWrite(req,db=>db.stream.create({ data: { channelName, streamKey: crypto.randomBytes(24).toString('base64url'), isPasswordProtected, isRecordingEnabled: !!isRecordingEnabled, password, restreamUrls: restreamUrls || {} } }));
  metadata.delete(stream.channelName);
  res.json(stream);
});

app.put('/api/streams/:id', authenticateUser, currentUser, requireManager, authorizedStream, adminControls, async (req, res) => {
  const { channelName, isPasswordProtected, password, restreamUrls, regenerateKey, isDisabled, isRecordingEnabled } = req.body;

  if (channelName && !/^[a-zA-Z0-9-_]+$/.test(channelName)) {
    return res.status(400).json({ error: 'Invalid channel name. Use alphanumeric characters, dashes, or underscores only.' });
  }

  const updateData = { channelName, isPasswordProtected, isRecordingEnabled: isRecordingEnabled !== undefined ? !!isRecordingEnabled : undefined, password, restreamUrls, isDisabled };
  if (regenerateKey) updateData.streamKey = crypto.randomBytes(24).toString('base64url');
  if([channelName,isPasswordProtected,password,isDisabled].some(v=>v!==undefined))updateData.playbackVersion={increment:1};
  const stream = await principalWrite(req,async(db,user)=>{
   if(!user.roles.includes('ADMIN')){
    if(!user.roles.includes('STREAM_MANAGER') || user.roles.includes('CLIENT') || isDisabled!==undefined)throw Object.assign(new Error('Access denied'),{status:403});
    if(!await db.stream.findFirst({where:{id:req.params.id,authorizedUsers:{some:{id:user.id}}}}))throw Object.assign(new Error('Access denied'),{status:403});
   }
   return db.stream.update({where:{id:req.params.id},data:updateData});
  },false);
  if(isDisabled===true)media?.send({type:'stop_channel',channel:stream.channelName});
  metadata.delete(stream.channelName);
  res.json(stream);
});

app.delete('/api/streams/:id', authenticateUser, currentUser, requireAdmin, async (req, res) => {
  const stream = await principalWrite(req,db=>db.stream.delete({ where: { id: req.params.id } }));
  if(stream){media?.send({type:'stop_channel',channel:stream.channelName});metadata.delete(stream.channelName);}
  logSecurityEvent('STREAM_DELETED', { req, details: `Deleted channel: ${stream?.channelName}` });
  res.json({ success: true });
});

app.get('/api/settings', authenticateUser, requireAdmin, async (req, res) => {
  res.json(await prisma.setting.findMany({ orderBy: { key: 'asc' } }));
});

app.put('/api/settings/:key', authenticateUser, requireAdmin, async (req, res) => {
  const { value, description } = req.body;
  const setting = await principalWrite(req,db=>db.setting.update({ where: { key: req.params.key }, data: { value, description } }));
  settingsCache.delete(req.params.key);
  logSecurityEvent('SETTING_UPDATED', { req, details: `Updated setting ${req.params.key}` });
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

app.delete('/api/recordings/:id', authenticateUser, currentUser, requireAdmin, authorizedRecording, async (req, res) => {
  const rec = req.recording;
  if (rec) {
    const p=recordingPath(rec.filePath);
    await principalWrite(req,async db=>{
      await createRecordingRecovery({root:recordingsRoot,prisma}).markDeleted(db,rec);
      await db.recording.delete({where:{id:rec.id}});
    });
    if(fs.existsSync(p))fs.unlinkSync(p);
  }
  res.json({ success: true });
});

app.get('/api/recordings/:id/download', authenticateUser, currentUser, authorizedRecording, async (req, res) => {
  const rec = req.recording;
  if (rec) res.download(recordingPath(rec.filePath), rec.title ? `${rec.title}.mp4` : rec.fileName);
  else res.status(404).send('Not found');
});

app.put('/api/recordings/:id', authenticateUser, currentUser, authorizedRecording, async (req, res) => {
  const { title } = req.body;
  try {
    const recording = await principalWrite(req,async(db,user)=>{
      const where={id:req.params.id};
      if(!user.roles.includes('ADMIN'))where.stream={authorizedUsers:{some:{id:user.id}},...(user.roles.includes('CLIENT')?{isDisabled:false}:{})};
      if(!await db.recording.findFirst({where}))throw Object.assign(new Error('Access denied'),{status:403});
      return db.recording.update({where:{id:req.params.id},data:{title}});
    },false);
    res.json(recording);
  } catch (error) {
    res.status(error.status || 400).json({ error: 'Failed to update recording' });
  }
});

app.put('/api/profile', authenticateUser, async (req, res) => {
  const { username, password } = req.body;
  const updateData = { username };
  
  if (password) {
    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) return res.status(400).json({ error: complexity.error });
    updateData.passwordHash = await bcrypt.hash(password, 10);

  }
  
  try {
    const user = await principalWrite(req,db=>db.user.update({
      where: { id: req.user.id },
      data: updateData
    }),false);
    if(password)logSecurityEvent('PASSWORD_CHANGED_SELF',{req});
    logSecurityEvent('PROFILE_UPDATED', { req });
    res.json({ username: user.username });
  } catch (error) {
    res.status(error.status || 400).json({ error: 'Failed to update profile' });
  }
});

app.get('/api/public/streams/:channelName', async (req, res) => {
  const s = await prisma.stream.findUnique({ where: { channelName: req.params.channelName }, select: { channelName: true, isLive: true, isDisabled: true, isPasswordProtected: true } });
  if (s) res.json(s); else res.status(404).send('Not found');
});

app.post('/api/public/recordings/:id/playback',playbackLimiter,async(req,res)=>{
 const rec=await prisma.recording.findUnique({where:{id:req.params.id},include:{stream:{include:playback.streamInclude}}});
 const stream=rec?.stream,user=await requestUser(req);
 const authorized=playback.assigned(stream || {},user);
 const renewing=!!req.body.cap && await playback.allowed(stream,req.body.cap,'recording',{db:prisma});
 const admission=await passwordAdmission(stream,authorized || renewing,req.body.password,req.socket.remoteAddress);
 if(!admission.ok)return passwordDenied(res,admission);
 const actor=renewing?playback.decode(req.body.cap,'recording').actor:null;
 const grantUser=actor?await prisma.user.findUnique({where:{id:actor}}):authorized?user:undefined;
 res.set('Cache-Control','no-store');
 res.json({cap:playback.issue(stream,{purpose:'recording',user:grantUser}),expiresIn:playback.TTL});
});

app.get('/api/public/recordings/:id', async (req, res) => {
  try {
    const recording = await prisma.recording.findUnique({
      where: { id: req.params.id },
      include: {
        stream: {
          include: playback.streamInclude
        }
      }
    });

    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    if(!await recordingReadable(req,recording.stream))return res.status(403).json({error:'Access denied.'});
    res.set('Cache-Control','private, no-store');
    const user=await requestUser(req);
    const playbackCap=!recording.stream.isDisabled && playback.assigned(recording.stream,user)?playback.issue(recording.stream,{purpose:'recording',user}):undefined;
    res.json({...recording,stream:{channelName:recording.stream.channelName},...(playbackCap?{playbackCap}:{})});
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recording' });
  }
});

// --- WebSockets for Chat & Dashboard ---
io.on('connection',socket=>{
 const isAdmin=async()=>{
  if(!socketSessionActive(socket))return false;
  const user=await principal(socket.data.userId);
  if(socket.data.userId && !user){invalidateSocket(socket);return false;}
  const ok=!!user?.roles.includes('ADMIN');
  if(!ok)socket.leave('dashboard');
  return ok;
 };
 if(socket.data.roles.includes('ADMIN'))socket.join('dashboard');
 socket.on('join_dashboard',async callback=>{let ok=false;try{ok=await isAdmin();if(ok && socket.connected)socket.join('dashboard');}catch{socket.leave('dashboard');}if(typeof callback==='function')callback({ok});});
 socket.on('leave_dashboard',()=>socket.leave('dashboard'));
 const valid=(channel,username)=>typeof channel==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(channel) && typeof username==='string' && username.trim().length>0 && username.length<=64;
 socket.on('check_username',(input={},callback)=>{input=input || {};if(typeof callback==='function')callback({available:valid(input.channelName,input.username) && !membership.channels.get(input.channelName)?.has(input.username)});});
 let joinGeneration=0;
 socket.on('join_channel',async(input={},callback)=>{input=input || {};
  const generation=++joinGeneration;
  let ok=false,cap,admission,delegatedCredentials;
  const delegated=socket.data.mssIdentity;
  if(((delegated && input.channelName===delegated.channel) || (!delegated && valid(input.channelName,input.username))) && socketSessionActive(socket)){
   try{
    if(delegated)socket.data.mssIdentity=await mssDelegation.authorize(socket.data.mssGrant,delegated.channel);
    const stream=await prisma.stream.findUnique({where:{channelName:input.channelName},include:playback.streamInclude});
    const user=socket.data.userId?await prisma.user.findUnique({where:{id:socket.data.userId}}):null;
    const authorized=playback.assigned(stream || {},user);
    admission=delegated?{ok:!!stream&&!stream.isDisabled}:await passwordAdmission(stream,authorized,input.password,socket.request.socket.remoteAddress);
    if(admission.ok && (!socket.data.userId || user?.roles.length) && generation===joinGeneration && socket.connected){
     cap=delegated?playback.issue(stream,{purpose:'delegated-live',delegation:{grant:socket.data.mssGrant,...socket.data.mssIdentity}}):playback.issue(stream,{user:authorized?user:undefined});
     membership.join(socket,input.channelName,delegated?socket.data.mssIdentity.displayName:input.username);
     socket.data.membershipCap=playback.issue(stream,{purpose:'membership',user:authorized?user:undefined});
     socket.data.playbackChannel=stream.channelName;ok=true;
     if(delegated)delegatedCredentials={server:mssDelegation.ingestUrl(),streamKey:`${encodeURIComponent(stream.channelName)}?key=${encodeURIComponent(stream.streamKey)}`};
    }
   }catch{}
  }
  if(typeof callback==='function')callback(ok?{ok:true,cap,expiresIn:playback.TTL,...(delegated?{credentials:delegatedCredentials}:{})}:{ok:false,error:'Invalid password, channel or unavailable username',...(admission?.code?{code:admission.code,retryAfter:admission.retryAfter,status:admission.status}:{})});
 });
 socket.on('renew_playback',async(_input,callback)=>{
  let response={ok:false};
  try{
   const channel=socket.data.playbackChannel;
   if(channel && socketSessionActive(socket)){
    if(socket.data.mssIdentity)socket.data.mssIdentity=await mssDelegation.authorize(socket.data.mssGrant,channel);
    const stream=await prisma.stream.findUnique({where:{channelName:channel},include:playback.streamInclude});
    if(await playback.allowed(stream,socket.data.membershipCap,'membership',{db:prisma,ignoreExpiration:true}) && socket.connected && socket.data.playbackChannel===channel){
     const claims=playback.decode(socket.data.membershipCap,'membership',true);
     const user=claims.actor?await prisma.user.findUnique({where:{id:claims.actor}}):undefined;
     response={ok:true,cap:socket.data.mssIdentity?playback.issue(stream,{purpose:'delegated-live',delegation:{grant:socket.data.mssGrant,...socket.data.mssIdentity}}):playback.issue(stream,{user}),expiresIn:playback.TTL};
    }
   }
  }catch{}
  if(typeof callback==='function')callback(response);
 });
 socket.on('refresh_delegation',async(input={},callback)=>{
  let response={ok:false};
  try{
   const channel=socket.data.playbackChannel;
   const current=socket.data.mssIdentity;
   if(current&&channel&&typeof input.grant==='string'&&socketSessionActive(socket)){
    const identity=await mssDelegation.authorize(input.grant,channel);
    const stream=await prisma.stream.findUnique({where:{channelName:channel},include:playback.streamInclude});
    if(identity.issuer===current.issuer&&identity.artistId===current.artistId&&identity.sessionId===current.sessionId&&stream&&!stream.isDisabled&&socket.connected&&socket.data.playbackChannel===channel){socket.data.mssGrant=input.grant;socket.data.mssIdentity=identity;response={ok:true,cap:playback.issue(stream,{purpose:'delegated-live',delegation:{grant:input.grant,...identity}}),expiresIn:playback.TTL};}
   }
  }catch{}
  if(typeof callback==='function')callback(response);
 });
 socket.on('send_message',(input={},callback)=>{input=input || {};
  const ok=socketSessionActive(socket) && chatAllowed(socket,input.channelName,input.message);
  if(ok)io.to(`channel:${input.channelName}`).emit('receive_message',{username:socket.data.username,identity:chatIdentity(socket),message:input.message,time:Date.now()});
  if(typeof callback==='function')callback({ok});
 });
 socket.on('leave_channel',()=>{joinGeneration++;membership.leave(socket);delete socket.data.membershipCap;delete socket.data.playbackChannel;});
 socket.on('disconnect',()=>{joinGeneration++;membership.leave(socket);});
 socket.on('kick_user',async(input={})=>{input=input || {};
  try{if(!await isAdmin())return;}catch{return;}
  const id=membership.channels.get(input.channelName)?.get(input.username);
  const target=io.sockets.sockets.get(id);if(target){target.emit('kicked');target.disconnect(true);}
 });
 socket.on('stop_publishing',async(input={})=>{input=input || {};try{if(await isAdmin() && typeof input.channelName==='string')media?.send({type:'stop_channel',channel:input.channelName});}catch{}});
});

async function emitDashboard(event,payload){
 const sockets=[...(io.sockets.adapter.rooms.get('dashboard') || [])].map(id=>io.sockets.sockets.get(id)).filter(Boolean);
 if(!sockets.length)return;
 const users=await prisma.user.findMany({where:{id:{in:sockets.map(s=>s.data.userId)},roles:{has:'ADMIN'}},select:{id:true}});
 const allowed=new Set(users.map(u=>u.id));
 for(const socket of sockets){if(socketSessionActive(socket) && allowed.has(socket.data.userId))socket.emit(event,payload);else socket.leave('dashboard');}
}
function invalidateSocket(socket,error) {
 socket.emit('session_invalid',sessionError(error));socket.disconnect(true);
}
function socketSessionActive(socket) {
 if(socket.data.userId && socket.data.sessionExpiresAt && Date.now()>=socket.data.sessionExpiresAt){
  invalidateSocket(socket,{name:'TokenExpiredError'});return false;
 }
 return socket.connected;
}
async function revalidateSockets(){
 const users=new Map(),streams=new Map();
 const db={user:{findUnique:args=>{const id=args.where.id;if(!users.has(id))users.set(id,prisma.user.findUnique(args));return users.get(id);}}};
 const sockets=[...io.sockets.sockets.values()];
 await playback.deadline(Promise.all(sockets.map(async socket=>{
  try{
   if(!socketSessionActive(socket))return;
   const user=socket.data.userId?await db.user.findUnique({where:{id:socket.data.userId}}):null;
   if(socket.data.userId && !user?.roles.length){invalidateSocket(socket);return;}
   if(!user?.roles.includes('ADMIN'))socket.leave('dashboard');
   const channel=socket.data.playbackChannel;
   if(channel){
    if(socket.data.mssIdentity)socket.data.mssIdentity=await mssDelegation.authorize(socket.data.mssGrant,channel);
    if(!streams.has(channel))streams.set(channel,prisma.stream.findUnique({where:{channelName:channel},include:playback.streamInclude}));
    if(!await playback.allowed(await streams.get(channel),socket.data.membershipCap,'membership',{db,ignoreExpiration:true}))socket.disconnect(true);
   }
  }catch{socket.disconnect(true);}
 }))).catch(()=>{for(const s of sockets)s.disconnect(true);});
}
// Async Express errors fail closed without returning database details.
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status || 500).json({error:'Request denied or failed.'});});
