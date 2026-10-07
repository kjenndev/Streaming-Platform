require('./test-env');
const {spawn}=require('child_process');
const fs=require('fs/promises');
const path=require('path');
const http=require('http');
const backend=require('../index');
let runtime,stream,relayStream,metricsUser;
const processes=new Set();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=10000){const start=Date.now();while(Date.now()-start<timeout){const result=await fn();if(result)return result;await wait(100);}throw new Error('Condition timed out');}
function publish(key){
 const child=spawn('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','color=c=black:s=160x90:r=10','-t','4','-c:v','libx264','-preset','ultrafast','-g','10','-f','flv',`rtmp://127.0.0.1:${process.env.RTMP_PORT}/live/${stream.channelName}?key=${key}`],{stdio:['ignore','ignore','pipe']});
 child.stderr.resume();processes.add(child);child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{processes.delete(child);resolve(code);});});return child;
}
beforeAll(async()=>{
 runtime=await backend.startServer();
 metricsUser=await backend.prisma.user.create({data:{username:'media-metrics-test',passwordHash:'unused-test',roles:['ADMIN']}});
 relayStream=await backend.prisma.stream.create({data:{channelName:'perf-media-relay',streamKey:'relay-test'}});
 stream=await backend.prisma.stream.create({data:{channelName:'perf-media-origin',streamKey:'origin-test',isPasswordProtected:true,password:'isolated-private-origin',isRecordingEnabled:true,restreamUrls:{test:{enabled:true,url:`rtmp://127.0.0.1:${process.env.RTMP_PORT}/live`,key:`${relayStream.channelName}?key=${relayStream.streamKey}`}}}});
},20000);
afterAll(async()=>{
 for(const child of processes)child.kill('SIGKILL');
 await backend.stopServer();
 if(stream){await backend.prisma.recording.deleteMany({where:{streamId:stream.id}});await backend.prisma.stream.delete({where:{id:stream.id}});}
 if(relayStream)await backend.prisma.stream.delete({where:{id:relayStream.id}});
 if(metricsUser)await backend.prisma.user.delete({where:{id:metricsUser.id}});
 await backend.prisma.$disconnect();await backend.redis.quit();await backend.pool.end();
 await fs.rm(process.env.RECORDINGS_ROOT,{recursive:true,force:true});
},40000);
test('bad RTMP keys cannot publish or create recordings',async()=>{
 const child=publish('invalid');expect(await child.done).not.toBe(0);
 expect(await backend.redis.hget('live_streams',stream.channelName)).toBeNull();
 expect(await backend.prisma.recording.count({where:{streamId:stream.id}})).toBe(0);
},10000);
test('child ingests relays delivers FLV and asynchronously finalizes exact recording',async()=>{
 const child=publish(stream.streamKey);
 await until(async()=>await backend.redis.hget('live_streams',stream.channelName));
 let received=0;const response=await new Promise((resolve,reject)=>{const req=http.get(`http://127.0.0.1:${process.env.MEDIA_HTTP_PORT}/live/${stream.channelName}.flv?cap=${require('../lib/playback-auth').issue(stream)}`,resolve);req.on('error',reject);});
 response.on('data',buffer=>{received+=buffer.length;});
 try{
  await until(async()=>await backend.redis.hget('live_streams',relayStream.channelName));
  expect(await child.done).toBe(0);await until(()=>received>1000);
  const token=require('jsonwebtoken').sign({id:metricsUser.id,roles:['ADMIN']},process.env.JWT_SECRET);
  const metrics=await (await fetch(`http://127.0.0.1:${process.env.HTTP_PORT}/api/metrics`,{headers:{Authorization:`Bearer ${token}`}})).json();
  expect(metrics.media.egressBytes).toBe(metrics.media.mediaSafety.networkBytes);
  const recording=await until(()=>backend.prisma.recording.findFirst({where:{streamId:stream.id}}));
  const file=await fs.stat(path.join(process.env.RECORDINGS_ROOT,recording.filePath.replace(/^\/recordings\//,'')));expect(file.size).toBeGreaterThan(1000);
  const download=await fetch(`http://127.0.0.1:${process.env.HTTP_PORT}${recording.filePath}?cap=${require('../lib/playback-auth').issue(stream,{purpose:'recording'})}`);
  expect(download.status).toBe(200);expect((await download.arrayBuffer()).byteLength).toBe(file.size);
 }finally{response.destroy();}
},20000);
test('supervisor restarts crashed media without losing API availability',async()=>{
 const previous=runtime.nms.pid;process.kill(previous,'SIGKILL');
 await until(()=>runtime.nms.pid!==previous);
 const response=await fetch(`http://127.0.0.1:${process.env.HTTP_PORT}/`);expect(response.status).toBe(200);
 await until(async()=>{try{const res=await fetch(`http://127.0.0.1:${process.env.MEDIA_HTTP_PORT}/not-found`);return res.status===404;}catch{return false;}});
},15000);

test('media has an isolated process group so crash cleanup can stop FFmpeg descendants',()=>{
 const group=Number(require('child_process').execFileSync('ps',['-o','pgid=','-p',String(runtime.nms.pid)],{encoding:'utf8'}).trim());
 expect(group).toBe(runtime.nms.pid);
});

test('finite HTTP-FLV POST keepalive saves every frame before publisher teardown',async()=>{
 const exec=require('util').promisify(require('child_process').execFile);
 const input=path.join(process.env.RECORDINGS_ROOT,'finite-input.flv');
 await exec('/usr/bin/ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=160x90:r=10','-t','1','-c:v','libx264','-preset','ultrafast','-g','100','-f','flv',input]);
 const payload=await fs.readFile(input),agent=new http.Agent({keepAlive:true,maxSockets:1});
 const previous=await backend.prisma.recording.findMany({where:{streamId:stream.id},select:{id:true}});
 try{
  await new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port:Number(process.env.MEDIA_HTTP_PORT),path:`/live/${stream.channelName}.flv?key=${stream.streamKey}`,method:'POST',agent,headers:{'Content-Type':'video/x-flv','Content-Length':payload.length}},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(new Error(`HTTP publish status ${res.statusCode}`)));});
   req.on('error',reject);req.end(payload);
  });
  const recording=await until(()=>backend.prisma.recording.findFirst({where:{streamId:stream.id,id:{notIn:previous.map(row=>row.id)}}}),4000);
  const filename=path.join(process.env.RECORDINGS_ROOT,recording.filePath.replace(/^\/recordings\//,''));
  const probe=await exec('/usr/bin/ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',filename]);
  expect(JSON.parse(probe.stdout).streams[0].nb_read_frames).toBe('10');
  const next=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:Number(process.env.MEDIA_HTTP_PORT),path:'/not-found',agent},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});
  expect(next).toBe(404);
 }finally{agent.destroy();await fs.rm(input,{force:true});}
},15000);

test('graceful shutdown drains an active recording before media exits',async()=>{
 const before=await backend.prisma.recording.count({where:{streamId:stream.id}});
 const child=publish(stream.streamKey);
 const token=require('jsonwebtoken').sign({id:metricsUser.id,roles:['ADMIN']},process.env.JWT_SECRET);
 await until(async()=>{
  const data=await (await fetch(`http://127.0.0.1:${process.env.HTTP_PORT}/api/metrics`,{headers:{Authorization:`Bearer ${token}`}})).json();
  return data.media?.mediaSafety.activeRecordings>0;
 });
 await backend.stopServer();await child.done;
 expect(await backend.prisma.recording.count({where:{streamId:stream.id}})).toBe(before+1);
},40000);
