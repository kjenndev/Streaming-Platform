require('./test-env');
const request=require('supertest'),http=require('http'),fs=require('fs'),path=require('path');
const {spawn}=require('child_process');
const backend=require('../index');
let runtime,stream,rec,publisher;
const media=(suffix='')=>new Promise(resolve=>{
 const req=http.get(`http://127.0.0.1:${process.env.MEDIA_HTTP_PORT}/live/security-private.flv${suffix}`,res=>{
  res.once('data',data=>{resolve({status:res.statusCode,magic:data.subarray(0,3).toString()});req.destroy();});
  res.once('end',()=>resolve({status:res.statusCode}));
 });
 req.on('error',error=>resolve({error:error.code}));req.setTimeout(2000,()=>{req.destroy();resolve({status:408});});
});
beforeAll(async()=>{
 runtime=await backend.startServer();
 stream=await backend.prisma.stream.create({data:{channelName:'security-private',streamKey:'test-publish-key',isPasswordProtected:true,password:'test-view-password'}});
 fs.writeFileSync(path.join(process.env.RECORDINGS_ROOT,'private.mp4'),'private-test-recording');
 rec=await backend.prisma.recording.create({data:{streamId:stream.id,fileName:'private.mp4',filePath:'/recordings/private.mp4',startedAt:new Date(),endedAt:new Date()}});
 publisher=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','color=c=black:s=160x90:r=15','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-f','flv',`rtmp://127.0.0.1:${process.env.RTMP_PORT}/live/security-private?key=test-publish-key`],{stdio:'ignore'});
 for(let i=0;i<60;i++){if((await backend.prisma.stream.findUnique({where:{id:stream.id}})).isLive)return;await new Promise(r=>setTimeout(r,50));}
 throw new Error('publisher readiness timeout');
},20000);
afterAll(async()=>{
 if(publisher && publisher.exitCode===null){publisher.kill('SIGTERM');await new Promise(r=>publisher.once('exit',r));}
 await backend.stopServer();
 if(stream)await backend.prisma.stream.deleteMany({where:{id:stream.id}});
 await backend.prisma.$disconnect();await backend.redis.quit();await backend.pool.end();
},20000);
test('private direct HTTP-FLV denies cached media before admission',async()=>{
 const response=await media();expect(response.magic).not.toBe('FLV');expect(response.status).not.toBe(200);
});
test('private recording metadata, static GET HEAD and range fail closed',async()=>{
 for(const method of ['get','head']){
  expect((await request(runtime.app)[method](`/api/public/recordings/${rec.id}`)).status).toBe(403);
  expect((await request(runtime.app)[method]('/recordings/private.mp4')).status).toBe(403);
 }
 expect((await request(runtime.app).get('/recordings/private.mp4').set('Range','bytes=0-5')).status).toBe(403);
});

const capability=async(purpose='live',password='test-view-password',headers={})=>{
 const r=await request(runtime.app).post(`/api/public/streams/${stream.channelName}/playback`).set(headers).send({password,purpose});
 expect(r.status).toBe(200);expect(typeof r.body.cap).toBe('string');return r.body.cap;
};
function wsRead(cap){return new Promise(resolve=>{
 const WS=require('ws'),ws=new WS(`ws://127.0.0.1:${process.env.MEDIA_HTTP_PORT}/live/security-private.flv${cap?'?cap='+encodeURIComponent(cap):''}`);
 let done=false;const finish=result=>{if(done)return;done=true;clearTimeout(timer);ws.terminate();resolve(result);};
 const timer=setTimeout(()=>finish({timeout:true}),2500);
 ws.on('message',data=>finish({magic:data.subarray(0,3).toString()}));ws.on('close',()=>finish({denied:true}));ws.on('error',()=>finish({denied:true}));
});}
function rtmpRead(cap){return new Promise(resolve=>{
 const ff=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-analyzeduration','200000','-probesize','32768','-i',`rtmp://127.0.0.1:${process.env.RTMP_PORT}/live/security-private${cap?'?cap='+encodeURIComponent(cap):''}`,'-t','0.2','-f','null','-'],{stdio:'ignore'});
 const timer=setTimeout(()=>ff.kill('SIGKILL'),5000);ff.once('exit',code=>{clearTimeout(timer);resolve(code);});
});}
test('password grant reaches HTTP-FLV and is scoped, short-lived, secret-free, revocable',async()=>{
 expect((await request(runtime.app).post(`/api/public/streams/${stream.channelName}/playback`).send({password:'wrong'})).status).toBe(403);
 const cap=await capability();
 const claims=require('jsonwebtoken').decode(cap);
 expect(claims.exp-claims.iat).toBe(120);expect(JSON.stringify(claims)).not.toContain('test-view-password');expect(JSON.stringify(claims)).not.toContain('test-publish-key');
 expect((await media('?cap='+cap)).magic).toBe('FLV');
 expect((await media('?cap='+cap.slice(0,-4)+'xxxx')).magic).not.toBe('FLV');
 expect((await media('?cap='+await capability('recording'))).magic).not.toBe('FLV');
 await backend.prisma.stream.update({where:{id:stream.id},data:{password:'rotated'}});
 expect((await media('?cap='+cap)).magic).not.toBe('FLV');
 await backend.prisma.stream.update({where:{id:stream.id},data:{password:'test-view-password'}});
});
test('direct WebSocket-FLV and RTMP deny anonymous private reads but allow scoped capabilities',async()=>{
 expect((await wsRead()).magic).not.toBe('FLV');
 expect(await rtmpRead()).not.toBe(0);
 const cap=await capability();
 expect((await wsRead(cap)).magic).toBe('FLV');
 expect(await rtmpRead(cap)).toBe(0);
},15000);
test('public anonymous HTTP-FLV WebSocket-FLV RTMP and recording shares remain functional',async()=>{
 await backend.prisma.stream.update({where:{id:stream.id},data:{isPasswordProtected:false}});
 try{
  expect((await media()).magic).toBe('FLV');expect((await wsRead()).magic).toBe('FLV');expect(await rtmpRead()).toBe(0);
  expect((await request(runtime.app).get(`/api/public/recordings/${rec.id}`)).status).toBe(200);
  expect((await request(runtime.app).get('/recordings/private.mp4')).status).toBe(200);
 }finally{await backend.prisma.stream.update({where:{id:stream.id},data:{isPasswordProtected:true}});}
},15000);
test('recording capability authorizes metadata bytes HEAD and ranges, not other scopes or traversals',async()=>{
 const cap=await capability('recording');
 expect((await request(runtime.app).get(`/api/public/recordings/${rec.id}?cap=${cap}`)).status).toBe(200);
 expect((await request(runtime.app).get('/recordings/private.mp4?cap='+cap)).text || '').not.toContain('password');
 expect((await request(runtime.app).head('/recordings/private.mp4?cap='+cap)).status).toBe(200);
 const range=await request(runtime.app).get('/recordings/private.mp4?cap='+cap).set('Range','bytes=0-5');
 expect(range.status).toBe(206);expect(range.headers['content-range']).toBe('bytes 0-5/22');
 const live=await capability();expect((await request(runtime.app).get('/recordings/private.mp4?cap='+live)).status).toBe(403);
 for(const path of ['/recordings/%2e%2e%2f.env','/recordings/%2e%2e%5c.env','/recordings/private.mp4/extra'])expect((await request(runtime.app).get(path+'?cap='+cap)).status).not.toBe(200);
 const direct=await fetch(`http://127.0.0.1:${process.env.MEDIA_HTTP_PORT}/recordings/private.mp4?cap=${cap}`);expect(direct.status).toBe(404);
});
test('account-backed capabilities stop working after role, assignment, or account revocation',async()=>{
 const user=await backend.prisma.user.create({data:{username:'playback-assigned',passwordHash:'unused',roles:['CLIENT'],authorizedStreams:{connect:{id:stream.id}}}});
 const jwt=require('jsonwebtoken'),headers={Authorization:'Bearer '+jwt.sign({id:user.id,roles:['ADMIN']},process.env.JWT_SECRET)};
 try{
  const cap=await capability('live',null,headers);expect((await media('?cap='+cap)).magic).toBe('FLV');
  await backend.prisma.user.update({where:{id:user.id},data:{authorizedStreams:{set:[]}}});expect((await media('?cap='+cap)).magic).not.toBe('FLV');
  await backend.prisma.user.update({where:{id:user.id},data:{roles:[]}});expect((await media('?cap='+cap)).magic).not.toBe('FLV');
  await backend.prisma.user.delete({where:{id:user.id}});expect((await media('?cap='+cap)).magic).not.toBe('FLV');
 }finally{await backend.prisma.user.deleteMany({where:{id:user.id}});}
});

test('privacy changes through API revoke previous grants even when the old password is restored',async()=>{
 const u=await backend.prisma.user.create({data:{username:'playback-rotate-admin',passwordHash:'unused',roles:['ADMIN']}});
 const headers={Authorization:'Bearer '+require('jsonwebtoken').sign({id:u.id},process.env.JWT_SECRET)};
 try{
  const cap=await capability();
  expect((await request(runtime.app).put(`/api/streams/${stream.id}`).set(headers).send({password:'temporary-password'})).status).toBe(200);
  expect((await request(runtime.app).put(`/api/streams/${stream.id}`).set(headers).send({password:'test-view-password'})).status).toBe(200);
  expect((await media('?cap='+cap)).magic).not.toBe('FLV');
 }finally{await backend.prisma.user.delete({where:{id:u.id}});}
});

test('private recording share password exchange does not disclose metadata before authorization',async()=>{
 const endpoint=`/api/public/recordings/${rec.id}/playback`;
 expect((await request(runtime.app).post(endpoint).send({password:'wrong'})).status).toBe(403);
 const grant=await request(runtime.app).post(endpoint).send({password:'test-view-password'});
 expect(grant.status).toBe(200);expect(Object.keys(grant.body).sort()).toEqual(['cap','expiresIn']);
 expect((await request(runtime.app).get(`/api/public/recordings/${rec.id}?cap=${grant.body.cap}`)).status).toBe(200);
});

test('recording grants renew before expiry without retaining passwords and remain account-bound',async()=>{
 const cap=await capability('recording');
 const response=await request(runtime.app).post(`/api/public/recordings/${rec.id}/playback`).send({cap});
 expect(response.status).toBe(200);
 expect((await request(runtime.app).get('/recordings/private.mp4?cap='+response.body.cap)).status).toBe(200);
});

test('active direct media is disconnected after privacy revocation outside the packet hot path',async()=>{
 const cap=await capability();let req,res;
 try{
  res=await new Promise((resolve,reject)=>{req=http.get(`http://127.0.0.1:${process.env.MEDIA_HTTP_PORT}/live/security-private.flv?cap=${cap}`,resolve);req.on('error',reject);});
  res.resume();
  const closed=new Promise(resolve=>{res.once('close',()=>resolve(true));});
  await backend.prisma.stream.update({where:{id:stream.id},data:{playbackVersion:{increment:1}}});
  let timeout;
  try{expect(await Promise.race([closed,new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),7500);})])).toBe(true);}finally{clearTimeout(timeout);}
 }finally{req?.destroy();res?.destroy();}
},10000);
test('recording symlinks cannot escape RECORDINGS_ROOT even with a valid grant',async()=>{
 const os=require('os'),outside=fs.mkdtempSync(path.join(os.tmpdir(),'recording-outside-test-'));
 const target=path.join(outside,'secret.mp4'),link=path.join(process.env.RECORDINGS_ROOT,'escape.mp4');let record;
 try{
  fs.writeFileSync(target,'must-not-expose');fs.symlinkSync(target,link);
  record=await backend.prisma.recording.create({data:{streamId:stream.id,fileName:'escape.mp4',filePath:'/recordings/escape.mp4',startedAt:new Date(),endedAt:new Date()}});
  const cap=await capability('recording');
  expect((await request(runtime.app).get('/recordings/escape.mp4?cap='+cap)).status).toBe(404);
 }finally{if(record)await backend.prisma.recording.delete({where:{id:record.id}});fs.rmSync(link,{force:true});fs.rmSync(outside,{recursive:true,force:true});}
});
