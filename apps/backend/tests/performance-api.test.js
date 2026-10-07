require('./test-env');
const request=require('supertest');
const jwt=require('jsonwebtoken');
const {io:client}=require('socket.io-client');
const backend=require('../index');
let runtime, stream, adminUser;
const token=()=>jwt.sign({id:adminUser.id,username:'perf-admin',roles:['ADMIN']},process.env.JWT_SECRET);
beforeAll(async()=>{
 expect(typeof backend.stopServer).toBe('function');
 runtime=await backend.startServer();
 adminUser=await backend.prisma.user.create({data:{username:'performance-test-admin',passwordHash:'unused',roles:['ADMIN']}});
 stream=await backend.prisma.stream.create({data:{channelName:'perf-control-test',streamKey:'isolated-test-key'}});
},20000);
afterAll(async()=>{
 if(adminUser) await backend.prisma.user.delete({where:{id:adminUser.id}});
 if(stream) await backend.prisma.stream.delete({where:{id:stream.id}});
 if(backend.stopServer) await backend.stopServer();
 await backend.prisma.$disconnect();await backend.redis.quit();await backend.pool.end();
},20000);
test('bounded REST arrays have pagination headers and authorized detail routes',async()=>{
 const auth={Authorization:`Bearer ${token()}`};
 const list=await request(runtime.app).get('/api/streams?limit=1').set(auth);
 expect(list.status).toBe(200);expect(list.body.length).toBeLessThanOrEqual(1);expect(list.headers['x-total-count']).toBeDefined();
 for(const suffix of ['viewers','recordings']){
 const detail=await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(auth);
 expect(detail.status).toBe(200);expect(Array.isArray(detail.body)).toBe(true);expect(detail.headers['x-total-count']).toBe('0');
 expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`)).status).toBe(401);
 }
 const metrics=await request(runtime.app).get('/api/metrics').set(auth);
 expect(metrics.body.api.pid).toBe(process.pid);expect(metrics.body.media.pid).not.toBe(process.pid);expect(metrics.body.media.pid).toBeGreaterThan(0);
 expect(Number.isFinite(metrics.body.api.egressBitsPerSecond)).toBe(true);
 expect(metrics.body.media.mediaSafety).toHaveProperty('acceptedBytes');
 for(const sample of [metrics.body.api,metrics.body.media]){expect(sample.sampledAt).toBeGreaterThan(Date.now()-10000);expect(sample.sampleSequence).toBeGreaterThan(0);}
 const cached=await request(runtime.app).get('/api/metrics').set(auth);
 expect(cached.body.api.sampleSequence).toBe(metrics.body.api.sampleSequence);
});
test('anonymous sockets see only joined channel, duplicate joins count once, admin gets telemetry without usernames',async()=>{
 const connect=auth=>new Promise((resolve,reject)=>{const s=client(`http://127.0.0.1:${process.env.HTTP_PORT}`,{auth,transports:['websocket'],reconnection:false});s.once('connect',()=>resolve(s));s.once('connect_error',reject);});
 const viewer=await connect({}),admin=await connect({token:token()});
 try {
 const join=()=>new Promise(resolve=>viewer.emit('join_channel',{channelName:stream.channelName,username:'test-viewer'},resolve));
 expect(await join()).toMatchObject({ok:true});expect(await join()).toMatchObject({ok:true});
 const [publicStats,privateStats]=await Promise.all([new Promise(r=>viewer.once('live_stats',r)),new Promise(r=>admin.once('live_stats',r))]);
 expect(Object.keys(publicStats.streams)).toEqual([stream.channelName]);expect(publicStats.streams[stream.channelName].viewers).toBe(1);
 expect(JSON.stringify(privateStats)).not.toContain('test-viewer');expect(privateStats.telemetry.api.pid).toBe(process.pid);
 const users=await request(runtime.app).get(`/api/streams/${stream.id}/viewers`).set('Authorization',`Bearer ${token()}`);expect(users.body).toEqual([{username:'test-viewer'}]);
 } finally {viewer.disconnect();admin.disconnect();}
},10000);

test('catalog search online filter and ordering execute before pagination',async()=>{
 const fixtures=[];
 try{
  for(const [name,isLive] of [['filter-only-z',false],['filter-only-a',true]])fixtures.push(await backend.prisma.stream.create({data:{channelName:name,isLive,streamKey:`test-only-${name}`}}));
  const auth={Authorization:`Bearer ${token()}`};
  const first=await request(runtime.app).get('/api/streams?search=FILTER-ONLY&sort=name&limit=1').set(auth);
  expect(first.body.map(s=>s.channelName)).toEqual(['filter-only-a']);expect(first.headers['x-total-count']).toBe('2');expect(first.headers['x-next-offset']).toBe('1');
  const second=await request(runtime.app).get('/api/streams?search=filter-only&sort=name&limit=1&offset=1').set(auth);
  expect(second.body.map(s=>s.channelName)).toEqual(['filter-only-z']);
  const live=await request(runtime.app).get('/api/streams?search=filter-only&hideOffline=true&sort=live-first').set(auth);
  expect(live.body.map(s=>s.channelName)).toEqual(['filter-only-a']);expect(live.headers['x-total-count']).toBe('1');
 }finally{await backend.prisma.stream.deleteMany({where:{id:{in:fixtures.map(s=>s.id)}}});}
});

test('malformed socket payloads are rejected without crashing API',async()=>{
 const socket=client(`http://127.0.0.1:${process.env.HTTP_PORT}`,{transports:['websocket'],reconnection:false});
 try{
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  const ack=await new Promise((resolve,reject)=>socket.timeout(1000).emit('join_channel',null,(error,result)=>error?reject(error):resolve(result)));
  expect(ack.ok).toBe(false);
  const chat=await new Promise((resolve,reject)=>socket.timeout(1000).emit('send_message',null,(error,result)=>error?reject(error):resolve(result)));
  expect(chat.ok).toBe(false);
 }finally{socket.disconnect();}
});

test('CLIENT detail visibility matches catalog for authorized disabled streams',async()=>{
 const user=await backend.prisma.user.create({data:{username:'detail-policy-test',passwordHash:'unused',roles:['CLIENT'],authorizedStreams:{connect:{id:stream.id}}}});
 const headers=roles=>({Authorization:`Bearer ${jwt.sign({id:user.id,roles},process.env.JWT_SECRET)}`});
 try{
  for(const suffix of ['viewers','recordings'])expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(headers(['CLIENT']))).status).toBe(200);
  await backend.prisma.stream.update({where:{id:stream.id},data:{isDisabled:true}});
  expect((await request(runtime.app).get('/api/streams').set(headers(['CLIENT']))).body).toEqual([]);
  for(const suffix of ['viewers','recordings']){
   expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(headers(['CLIENT']))).status).toBe(403);
   // Claims cannot replace the current CLIENT role.
   expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(headers(['STREAM_MANAGER']))).status).toBe(403);
   expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(headers(['ADMIN','CLIENT']))).status).toBe(403);
   await backend.prisma.user.update({where:{id:user.id},data:{roles:['STREAM_MANAGER']}});
   expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(headers(['CLIENT']))).status).toBe(200);
   await backend.prisma.user.update({where:{id:user.id},data:{roles:['ADMIN','CLIENT']}});
   expect((await request(runtime.app).get(`/api/streams/${stream.id}/${suffix}`).set(headers(['CLIENT']))).status).toBe(200);
   await backend.prisma.user.update({where:{id:user.id},data:{roles:['CLIENT']}});
  }
 }finally{await backend.prisma.stream.update({where:{id:stream.id},data:{isDisabled:false}});await backend.prisma.user.delete({where:{id:user.id}});}
});

test('info advertises effective environment listener ports',async()=>{
 const info=await request(runtime.app).get('/api/info');
 expect(info.body.rtmpPort).toBe(Number(process.env.RTMP_PORT));
 expect(info.body.mediaPort).toBe(Number(process.env.MEDIA_HTTP_PORT));
});
