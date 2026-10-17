const path=require('path');
const fs=require('fs/promises');
const {Pool}=require('pg');
const {PrismaPg}=require('@prisma/adapter-pg');
const {PrismaClient}=require('@prisma/client');
const Redis=require('ioredis');
const {serialCollector}=require('./control-runtime');
const {ManagedProcesses,processTelemetry}=require('./process-runtime');
const {gatePublisher}=require('./publisher-auth');
const {gatePlayback}=require('./playback-gate');
const playback=require('./playback-auth');
const delegation=require('./mss-delegation').createMssDelegation({env:process.env});
const {ChannelState}=require('./channel-state');
const channelState=new ChannelState();
// Media owns live_streams and publisher lifecycle. API owns viewer membership.
// Credentials are inherited only in the child environment, never sent over IPC.
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const prisma=new PrismaClient({adapter:new PrismaPg(pool)});
const authorizePlayback=require('./media-playback-auth').createMediaPlaybackAuthorizer({db:prisma,delegation});
const redis=new Redis(process.env.REDIS_URL);
const context=require('node-media-server/src/core/context');
const safety=require('./media-safety').installMediaSafety();
const children=new ManagedProcesses(), telemetry=processTelemetry();
const publishers=new Map(), relays=new Map(), recordings=new Map(), tasks=new Set();
let egressBytes=0, lastEgress=0,lastTime=Date.now(),stopping=false,nms,collector,playbackCollector;
const send=message=>{if(process.connected) process.send(message,()=>{});};
const task=promise=>{tasks.add(promise);promise.catch(error=>console.error('[media] operation failed:',error.code || error.name)).finally(()=>tasks.delete(promise));return promise;};
async function setting(key,fallback){const item=await prisma.setting.findUnique({where:{key}});return item?.value || fallback;}
async function authorize(session){
 const match=/^\/live\/([a-zA-Z0-9_-]{1,128})$/.exec(session.streamPath || '');
 const key=session.streamQuery?.key || session.streamQuery?.sign || session.streamQuery?.token;
 if(!match || typeof key!=='string') return null;
 const stream=await prisma.stream.findUnique({where:{channelName:match[1]}});
 if(!stream || stream.isDisabled || stream.streamKey!==key || session.broadcast.publisher) return null;
 return stream;
}
// Extend safety-wrapped constructors before NMS servers import them.
for(const file of ['rtmp_session','flv_session']){
 const filename=require.resolve(`node-media-server/src/session/${file}`), Original=require(filename);
 require.cache[filename].exports=class AuthorizedSession extends Original {
 constructor(...args){super(...args);
   if(!this.socket) this.socket=this.req.socket;
   // Keep a distinct authorization path while consuming the existing live broadcast.
   if(this.streamApp==='mss-live' && !this.isPublisher){
    const live=context.broadcasts.get(`/live/${this.streamName}`);
    if(live)this.broadcast=live;
   }
   gatePublisher(this,authorize);
   gatePlayback(this,authorizePlayback);
  }
 };
}
const NodeMediaServer=require('node-media-server');
const BaseRecordSession=require('node-media-server/src/session/record_session');
class RecordSession extends BaseRecordSession {
 createWriteStreamWithDirsSync(filepath){return require('fs').createWriteStream(filepath,{flags:'wx',mode:0o600});}
}
const recovery=require('./recording-recovery').createRecordingRecovery({root:process.env.RECORDINGS_ROOT || path.join(__dirname,'../recordings'),prisma});
let recoveryCollector;
async function published(session){
 const stream=session.authorizedStream;if(!stream || stopping) return;
 const channel=stream.channelName, startTime=Date.now();
 // NMS emits postPublish before assigning publisher; defer lifecycle work.
 await Promise.resolve();
 if(session.broadcast.publisher!==session || session.socket.destroyed) return;
 publishers.set(session.id,{session,channel,startTime,bytes:session.inBytes || 0,time:startTime});
 await channelState.start(channel,session.id,async()=>{
  await prisma.stream.update({where:{id:stream.id},data:{isLive:true,lastStartedAt:new Date(startTime)}});
  await redis.hset('live_streams',channel,JSON.stringify({id:session.id,startTime,isPublishing:true,bitrate:0}));
 });
 send({type:'invalidate',channel});
 if(session.socket.destroyed || stopping) return;
 if(stream.isRecordingEnabled){
  const intent=await recovery.begin(stream,startTime);
  if(session.socket.destroyed || stopping)return;
  const record=new RecordSession(session,intent.filepath);
  const closed=new Promise(resolve=>record.fileStream.once('close',resolve));
  recordings.set(session.id,{record,closed,...intent});record.run();
 }
 const ffmpeg=await setting('ffmpeg_path','/usr/bin/ffmpeg');
 const active=[];relays.set(session.id,active);
 for(const [platform,config] of Object.entries(stream.restreamUrls || {})){
  if(stopping || session.socket.destroyed) break;
  if(!config || config.enabled!==true || !config.key?.trim()) continue;
  const base=await setting(`${platform}_ingest`,config.url);
  if(!base?.trim() || !/^rtmps?:\/\//.test(base)) continue;
  const target=`${base.trim().replace(/\/$/,'')}/${config.key.trim()}`;
  const proc=children.run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-analyzeduration','200000','-probesize','32768','-i',`rtmp://127.0.0.1:${process.env.RTMP_PORT}/live/${channel}?cap=${encodeURIComponent(playback.issue(stream,{purpose:'relay',publisher:session.id}))}`,'-c','copy','-f','flv',target]);
  active.push(proc);proc.done.catch(()=>console.error('[media] relay spawn failed'));
 }
}
async function finalize(item){
 await item.closed;
 if(item.record.recordingError) {console.error('[media] recording transport failed; source retained');return;}
 if(await recovery.finish(item.id,{owned:true}))send({type:'recording_saved',channelName:item.channel,fileName:'video.mp4'});
}
async function ended(session){
 // Serialize behind startup for this publisher: disconnect can happen during DB I/O.
 try{await session.lifecycle;}catch{} // Startup failure is logged; teardown must still run.
 const info=publishers.get(session.id);if(!info) return;
 publishers.delete(session.id);
 for(const proc of relays.get(session.id) || []) proc.kill('SIGTERM');relays.delete(session.id);
 await channelState.end(info.channel,session.id,async()=>{
  const results=await Promise.allSettled([
   redis.hdel('live_streams',info.channel),
   prisma.stream.updateMany({where:{channelName:info.channel},data:{isLive:false}})
  ]);
  for(const result of results)if(result.status==='rejected')console.error('[media] state cleanup failed:',result.reason.code || result.reason.name);
 });
 send({type:'invalidate',channel:info.channel});
 const recording=recordings.get(session.id);recordings.delete(session.id);
 if(recording) await finalize(recording);
}
async function revalidatePlayback(){
 // Revalidate active admissions outside the packet hot path. Memoize per sweep
 // so a channel/actor is read once, not once per viewer. Expiry gates reconnects;
 // active playback is revoked on privacy/password/assignment/account changes.
 const cache=new Map();
 const memo=(kind,args)=>{const k=kind+JSON.stringify(args);if(!cache.has(k))cache.set(k,prisma[kind].findUnique(args));return cache.get(k);};
 const db={stream:{findUnique:a=>memo('stream',a)},user:{findUnique:a=>memo('user',a)}};
 const viewers=[...context.sessions.values()].filter(s=>s.playbackAdmitted);
 await playback.deadline(Promise.all(viewers.map(async s=>{
  try{if(!await require('./media-playback-auth').createMediaPlaybackAuthorizer({db,delegation})(s,false))s.close();}catch{s.close();}
 }))).catch(()=>{for(const s of viewers)s.close();});
}
async function snapshot(){
 const now=Date.now(),pipeline=redis.pipeline(),streams={};let totalRestreams=0,totalRestreamThroughput=0;
 for(const [id,info] of publishers){
  if(!channelState.isOwner(info.channel,id) || info.session.socket.destroyed) continue;
  const bytes=info.session.inBytes || 0,bitrate=Math.max(0,Math.round((bytes-info.bytes)*8/Math.max(1,now-info.time)));
  info.bytes=bytes;info.time=now;
  const active=(relays.get(id)||[]).filter(p=>p.exitCode===null && !p.killed).length;
  totalRestreams+=active;totalRestreamThroughput+=bitrate*active;
  streams[info.channel]={id,startTime:info.startTime,isPublishing:true,bitrate};
  pipeline.hset('live_streams',info.channel,JSON.stringify(streams[info.channel]));
 }
 if(publishers.size) await pipeline.exec();
 const mediaSafety=safety.snapshot();egressBytes=mediaSafety.networkBytes;
 const media={...telemetry.sample(),sockets:context.sessions.size,publishers:publishers.size,ffmpegProcesses:children.size,egressBytes,egressBitsPerSecond:(egressBytes-lastEgress)*8000/Math.max(1,now-lastTime),mediaSafety};
 lastEgress=egressBytes;lastTime=now;
 send({type:'stats',streams,totalRestreams,totalRestreamThroughput,media});
}
async function shutdown(){
 if(stopping)return;stopping=true;
 // Bound shutdown even if a conversion or database operation never completes.
 // The source FLV is retained unless conversion and metadata persistence succeed.
 const deadline=setTimeout(()=>{children.stop(0).finally(()=>process.exit(1));},25000);
 await Promise.all([collector?.stop(),playbackCollector?.stop(),recoveryCollector?.stop()]);
 for(const session of [...context.sessions.values()]) session.close();
 for(const item of recordings.values()) item.record.close();
 const servers=[nms?.httpServer.httpServer,nms?.rtmpServer.tcpServer].filter(Boolean);
 await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));
 await Promise.allSettled([...tasks]);
 await children.stop();await recovery.close();telemetry.close();
 await redis.del('live_streams');await prisma.stream.updateMany({where:{isLive:true},data:{isLive:false}});
 await redis.quit();await prisma.$disconnect();await pool.end();clearTimeout(deadline);
 process.exit(0);
}
process.on('message',message=>{
 if(message.type==='stop_channel') for(const {session,channel} of publishers.values()) if(channel===message.channel) session.close();
 if(message.type==='shutdown') shutdown().catch(()=>process.exit(1));
});
const onShutdown=()=>shutdown().catch(()=>process.exit(1));
process.on('disconnect',onShutdown);process.on('SIGTERM',onShutdown);process.on('SIGINT',onShutdown);
(async()=>{
 await redis.del('live_streams');await prisma.stream.updateMany({where:{isLive:true},data:{isLive:false}});
 nms=new NodeMediaServer({bind:process.env.BIND_HOST || '0.0.0.0',rtmp:{port:Number(process.env.RTMP_PORT),chunk_size:60000,gop_cache:true,ping:30,ping_timeout:60},http:{port:Number(process.env.MEDIA_HTTP_PORT),allow_origin:'*'}});
 nms.httpServer.wsServer.on('error',()=>{}); // HTTP listener reports the same startup error.
 require('node-media-server/src/core/logger').level=process.env.VERBOSE==='true'?'debug':'warn';
 nms.on('postPublish',session=>{session.lifecycle=task(published(session).catch(error=>{
  // Admission alone is insufficient: durable state and child setup must succeed.
  // Close this exact session; donePublish serializes generation-safe cleanup.
  session.close();throw error;
 }));});
 nms.on('donePublish',session=>task(ended(session)));
 const ready=Promise.all([nms.httpServer.httpServer,nms.rtmpServer.tcpServer].map(s=>new Promise((resolve,reject)=>{s.once('listening',resolve);s.once('error',reject);})));nms.run();await ready;
 playbackCollector=serialCollector(revalidatePlayback,2000,error=>console.error('[media] authorization sweep failed:',error.name));
 collector=serialCollector(snapshot,2000,error=>console.error('[media] stats failed:',error.name));await snapshot();send({type:'ready'});
 // Orphan probing/conversion must not consume the supervisor startup deadline.
 // The serial collector bounds overlap and shutdown still drains its active sweep.
 recoveryCollector=serialCollector(()=>recovery.recover(),30000,()=>console.error('[media] recording recovery deferred'));
 void recoveryCollector.tick();
})().catch(error=>{console.error('[media] startup failed:',error.code || error.name);process.exit(1);});
