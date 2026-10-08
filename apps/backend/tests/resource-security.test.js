require('./test-env');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const backend = require('../index');
let runtime, admin, manager, client, stranger, stream, other, recording;
const auth = user => ({Authorization: `Bearer ${jwt.sign({id:user.id,roles:user.roles},process.env.JWT_SECRET)}`});
beforeAll(async () => {
 runtime = await backend.startServer();
 for (const [name, roles] of [['admin',['ADMIN']],['manager',['STREAM_MANAGER']],['client',['CLIENT']],['stranger',['STREAM_MANAGER']]]) {
  const u = await backend.prisma.user.create({data:{username:`security-${name}`,passwordHash:'unused-test',roles}});
  if(name==='admin')admin=u; if(name==='manager')manager=u; if(name==='client')client=u; if(name==='stranger')stranger=u;
 }
 stream=await backend.prisma.stream.create({data:{channelName:'security-assigned',streamKey:'security-test-key',authorizedUsers:{connect:[{id:manager.id},{id:client.id}]}}});
 other=await backend.prisma.stream.create({data:{channelName:'security-unassigned',streamKey:'security-other-key'}});
 recording=await backend.prisma.recording.create({data:{streamId:stream.id,fileName:'fixture.mp4',filePath:'/recordings/fixture.mp4',startedAt:new Date(),endedAt:new Date()}});
},20000);
afterAll(async()=>{
 await backend.prisma.stream.deleteMany({where:{id:{in:[stream?.id,other?.id].filter(Boolean)}}});
 await backend.prisma.user.deleteMany({where:{id:{in:[admin,manager,client,stranger].filter(Boolean).map(u=>u.id)}}});
 await backend.stopServer(); await backend.prisma.$disconnect();await backend.redis.quit();await backend.pool.end();
},20000);
test('stream mutation policy is admin or assigned manager, with admin-only lifecycle controls',async()=>{
 for(const user of [client,stranger]) expect((await request(runtime.app).put(`/api/streams/${stream.id}`).set(auth(user)).send({isRecordingEnabled:true,authorizedUserIds:[user.id]})).status).toBe(403);
 expect((await request(runtime.app).put(`/api/streams/${other.id}`).set(auth(manager)).send({password:'replacement'})).status).toBe(403);
 expect((await request(runtime.app).put(`/api/streams/${stream.id}`).set(auth(manager)).send({isRecordingEnabled:true})).status).toBe(200);
 expect((await request(runtime.app).put(`/api/streams/${stream.id}`).set(auth(manager)).send({isDisabled:true})).status).toBe(403);
 for(const user of [manager,client,stranger]) {
  expect((await request(runtime.app).post('/api/streams').set(auth(user)).send({channelName:'must-not-create'})).status).toBe(403);
  expect((await request(runtime.app).delete(`/api/streams/${other.id}`).set(auth(user))).status).toBe(403);
 }
 expect((await request(runtime.app).put(`/api/streams/${other.id}`).set(auth(admin)).send({isDisabled:true})).status).toBe(200);
});
test('recording access follows its parent stream; deletion remains admin-only',async()=>{
 for(const method of ['put','delete','get']) {
  const suffix=method==='get'?'/download':'';
  const response=await request(runtime.app)[method](`/api/recordings/${recording.id}${suffix}`).set(auth(stranger)).send({title:'unauthorized'});
  expect(response.status).toBe(403);
 }
 for(const user of [client,manager])expect((await request(runtime.app).delete(`/api/recordings/${recording.id}`).set(auth(user))).status).toBe(403);
 // Existing dashboard allows assigned viewers to rename and download recordings.
 for(const user of [client,manager,admin])expect((await request(runtime.app).put(`/api/recordings/${recording.id}`).set(auth(user)).send({title:'authorized'})).status).toBe(200);
 await backend.prisma.stream.update({where:{id:stream.id},data:{isDisabled:true}});
 expect((await request(runtime.app).put(`/api/recordings/${recording.id}`).set(auth(client)).send({title:'disabled'})).status).toBe(403);
 await backend.prisma.stream.update({where:{id:stream.id},data:{isDisabled:false}});
});
test('revoked administrator role and deleted principals cannot mutate resources',async()=>{
 const headers=auth(admin);
 await backend.prisma.user.update({where:{id:admin.id},data:{roles:['CLIENT']}});
 try {
  expect((await request(runtime.app).put(`/api/streams/${other.id}`).set(headers).send({isDisabled:false})).status).toBe(403);
  expect((await request(runtime.app).put(`/api/users/${admin.id}`).set(headers).send({roles:['ADMIN']})).status).toBe(403);
  expect((await backend.prisma.user.findUnique({where:{id:admin.id}})).roles).toEqual(['CLIENT']);
  expect((await request(runtime.app).put(`/api/streams/${other.id}`).set(headers).send({isDisabled:false})).status).toBe(403);
  for (const url of ['/api/users','/api/settings','/api/metrics','/api/logs',`/api/streams/${other.id}/viewers`,`/api/streams/${other.id}/recordings`]) expect((await request(runtime.app).get(url).set(headers)).status).toBe(403);
  expect((await request(runtime.app).post('/api/users').set(headers).send({username:'must-not-create',password:'Test-only!123',roles:['ADMIN']})).status).toBe(403);
  expect((await request(runtime.app).delete(`/api/users/${stranger.id}`).set(headers)).status).toBe(403);
  expect((await request(runtime.app).put('/api/settings/absent').set(headers).send({value:'bad'})).status).toBe(403);
 }
 finally {await backend.prisma.user.update({where:{id:admin.id},data:{roles:['ADMIN']}});}
 expect((await request(runtime.app).put(`/api/streams/${other.id}`).set(auth({id:'nonexistent',roles:['ADMIN']})).send({isDisabled:false})).status).toBe(401);
});
test('public channel metadata is an explicit secret-free DTO and viewer password is checked server-side',async()=>{
 await backend.prisma.stream.update({where:{id:stream.id},data:{isPasswordProtected:true,password:'isolated-viewer-secret'}});
 const response=await request(runtime.app).get(`/api/public/streams/${stream.channelName}`);
 expect(Object.keys(response.body).sort()).toEqual(['channelName','isDisabled','isLive','isPasswordProtected']);
 const {io}=require('socket.io-client');
 const socket=io(`http://127.0.0.1:${process.env.HTTP_PORT}`,{transports:['websocket'],reconnection:false});
 try{
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  const join=password=>new Promise((resolve,reject)=>socket.timeout(2000).emit('join_channel',{channelName:stream.channelName,username:'security-viewer',password},(e,v)=>e?reject(e):resolve(v)));
  expect((await join(undefined)).ok).toBe(false);
  expect((await join('wrong')).ok).toBe(false);
  expect((await join('isolated-viewer-secret')).ok).toBe(true);
 }finally{socket.disconnect();}
 const adminList=await request(runtime.app).get('/api/streams').set(auth(admin));
 expect(adminList.body.find(s=>s.id===stream.id).password).toBe('isolated-viewer-secret');
 const clientList=await request(runtime.app).get('/api/streams').set(auth(client));
 const row=clientList.body.find(s=>s.id===stream.id);
 for(const key of ['password','streamKey','restreamUrls'])expect(row).not.toHaveProperty(key);
});

test('role revocation during password hashing cannot restore privileges in the write transaction',async()=>{
 const bcrypt=require('bcrypt');
 let entered,release;
 const waiting=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
 const hash=jest.spyOn(bcrypt,'hash').mockImplementation(async()=>{entered();await blocked;return 'unused-test-hash';});
 try{
  const pending=request(runtime.app).put(`/api/users/${admin.id}`).set(auth(admin)).send({roles:['ADMIN'],password:'FixtureOnly!123'}).then(r=>r);
  await waiting;
  await backend.prisma.user.update({where:{id:admin.id},data:{roles:['CLIENT']}});
  release();
  expect((await pending).status).toBe(403);
  expect((await backend.prisma.user.findUnique({where:{id:admin.id}})).roles).toEqual(['CLIENT']);
 }finally{release?.();hash.mockRestore();await backend.prisma.user.update({where:{id:admin.id},data:{roles:['ADMIN']}});}
});
test('disabled (empty-role) and deleted accounts cannot use any authenticated route',async()=>{
 const u=await backend.prisma.user.create({data:{username:'revoked-all-routes',passwordHash:'unused',roles:['ADMIN']}}),headers=auth(u);
 const routes=[['get','/api/users'],['post','/api/users'],['put',`/api/users/${u.id}`],['delete',`/api/users/${stranger.id}`],['get','/api/streams'],['get','/api/settings'],['put','/api/settings/missing'],['get','/api/metrics'],['get','/api/logs'],['put','/api/profile'],['get',`/api/streams/${stream.id}/viewers`],['get',`/api/streams/${stream.id}/recordings`],['put',`/api/streams/${stream.id}`],['post','/api/streams'],['delete',`/api/streams/${stream.id}`],['get',`/api/recordings/${recording.id}/download`],['put',`/api/recordings/${recording.id}`],['delete',`/api/recordings/${recording.id}`]];
 try{
  await backend.prisma.user.update({where:{id:u.id},data:{roles:[]}});
  for(const [method,url] of routes)expect((await request(runtime.app)[method](url).set(headers).send({roles:['ADMIN']})).status).toBe(401);
  await backend.prisma.user.delete({where:{id:u.id}});
  for(const [method,url] of routes)expect((await request(runtime.app)[method](url).set(headers).send({roles:['ADMIN']})).status).toBe(401);
 }finally{await backend.prisma.user.deleteMany({where:{id:u.id}});}
});
test('persistent socket administrator loses dashboard and kick privilege after downgrade',async()=>{
 const {io}=require('socket.io-client');
 const connect=auth=>new Promise((resolve,reject)=>{const socket=io(`http://127.0.0.1:${process.env.HTTP_PORT}`,{auth,transports:['websocket'],reconnection:false});socket.once('connect',()=>resolve(socket));socket.once('connect_error',reject);});
 const adminSocket=await connect({token:auth(admin).Authorization.slice(7)}),viewer=await connect({});
 const ack=(socket,event,payload)=>new Promise((resolve,reject)=>socket.timeout(2000).emit(event,payload,(e,v)=>e?reject(e):resolve(v)));
 try{
  expect((await ack(viewer,'join_channel',{channelName:stream.channelName,username:'socket-policy',password:'isolated-viewer-secret'})).ok).toBe(true);
  await backend.prisma.user.update({where:{id:admin.id},data:{roles:['CLIENT']}});
  // join_dashboard takes only an acknowledgement.
  const joined=await new Promise(resolve=>adminSocket.emit('join_dashboard',resolve));expect(joined.ok).toBe(false);
  adminSocket.emit('kick_user',{channelName:stream.channelName,username:'socket-policy'});
  await backend.collectStats();
  expect((await ack(viewer,'send_message',{channelName:stream.channelName,message:'still here'})).ok).toBe(true);
 }finally{adminSocket.disconnect();viewer.disconnect();await backend.prisma.user.update({where:{id:admin.id},data:{roles:['ADMIN']}});}
});

test('current admins retain management and password flows, assigned clients retain real recording downloads',async()=>{
 let user;
 try{
  const created=await request(runtime.app).post('/api/users').set(auth(admin)).send({username:'managed-password-flow',password:'InitialTest!123',roles:['CLIENT'],authorizedStreamIds:[stream.id]});
  expect(created.status).toBe(200);expect(created.body).not.toHaveProperty('passwordHash');user=created.body;
  expect((await request(runtime.app).put(`/api/users/${user.id}`).set(auth(admin)).send({password:'AdminChanged!123',roles:['CLIENT'],authorizedStreamIds:[stream.id]})).status).toBe(200);
  const login=await request(runtime.app).post('/api/login').send({username:'managed-password-flow',password:'AdminChanged!123'});expect(login.status).toBe(200);
  const headers={Authorization:'Bearer '+login.body.token};
  expect((await request(runtime.app).put('/api/profile').set(headers).send({password:'SelfChanged!123',roles:['ADMIN']})).status).toBe(200);
  expect((await backend.prisma.user.findUnique({where:{id:user.id}})).roles).toEqual(['CLIENT']);
  expect((await request(runtime.app).post('/api/login').send({username:'managed-password-flow',password:'SelfChanged!123'})).status).toBe(200);
  require('fs').writeFileSync(require('path').join(process.env.RECORDINGS_ROOT,'fixture.mp4'),'assigned-client-download');
  expect((await request(runtime.app).get(`/api/recordings/${recording.id}/download`).set(headers)).status).toBe(200);
  expect((await request(runtime.app).get('/api/settings').set(auth(admin))).status).toBe(200);
 }finally{if(user)await backend.prisma.user.deleteMany({where:{id:user.id}});}
});

test('privacy revocation still disconnects membership while the telemetry collector is stalled',async()=>{
 const {io}=require('socket.io-client');
 const ch=await backend.prisma.stream.create({data:{channelName:'auth-independent-collector',streamKey:'isolated-collector-key',isPasswordProtected:true,password:'initial-collector-password'}});
 let entered,release;const waiting=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
 const original=backend.prisma.stream.findMany.bind(backend.prisma.stream);
 const lookup=jest.spyOn(backend.prisma.stream,'findMany').mockImplementation(async args=>{entered();await blocked;return original(args);});
 const socket=io(`http://127.0.0.1:${process.env.HTTP_PORT}`,{transports:['websocket'],reconnection:false});let timer;
 try{
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
  await new Promise(resolve=>socket.emit('join_channel',{channelName:ch.channelName,username:'stalled-telemetry',password:'initial-collector-password'},resolve));
  await waiting;
  const disconnected=new Promise(resolve=>socket.once('disconnect',()=>resolve(true)));
  await backend.prisma.stream.update({where:{id:ch.id},data:{playbackVersion:{increment:1}}});
  expect(await Promise.race([disconnected,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),7500);})])).toBe(true);
 }finally{clearTimeout(timer);lookup.mockRestore();release();socket.disconnect();await backend.prisma.stream.deleteMany({where:{id:ch.id}});}
},15000);
