require('./test-env');
const request=require('supertest');
const {io}=require('socket.io-client');
const backend=require('../index');
let runtime,stream;
const sockets=[];
async function connect(){const s=io(`http://127.0.0.1:${process.env.HTTP_PORT}`,{forceNew:true,reconnection:false,transports:['websocket']});sockets.push(s);await new Promise((r,j)=>{s.once('connect',r);s.once('connect_error',j);});return s;}
const join=(s,password)=>s.timeout(2000).emitWithAck('join_channel',{channelName:stream.channelName,username:'budget-viewer',password});
beforeAll(async()=>{runtime=await backend.startServer();stream=await backend.prisma.stream.create({data:{channelName:'budget-'+require('crypto').randomBytes(5).toString('hex'),streamKey:'synthetic',isPasswordProtected:true,password:'synthetic-password'}});},20000);
afterAll(async()=>{sockets.forEach(s=>s.close());await backend.stopServer();if(stream)await backend.prisma.stream.delete({where:{id:stream.id}});await backend.prisma.$disconnect();await backend.pool.end();await backend.redis.quit();},20000);
test('SEC-F1: twenty wrong guesses exhaust correct password across anonymous reconnect and HTTP',async()=>{
 const first=await connect();for(let i=0;i<20;i++)expect((await join(first,'wrong')).ok).toBe(false);
 expect((await join(first,stream.password)).ok).toBe(false);first.close();
 const next=await connect();const denied=await join(next,stream.password);expect(denied.ok).toBe(false);expect(denied.retryAfter).toBeGreaterThan(0);
 const response=await request(runtime.app).post(`/api/public/streams/${stream.channelName}/playback`).send({password:stream.password});expect(response.status).toBe(429);expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
});

test('recording exchange shares exhausted budget; forged headers cannot bypass; public and assigned access survive',async()=>{
 const rec=await backend.prisma.recording.create({data:{streamId:stream.id,fileName:'fixture.mp4',filePath:'/recordings/fixture.mp4',startedAt:new Date(),endedAt:new Date()}});
 const endpoint='/api/public/recordings/'+rec.id+'/playback';
 const limited=await request(runtime.app).post(endpoint).set('X-Forwarded-For','192.0.2.200').send({password:stream.password});expect(limited.status).toBe(429);
 const user=await backend.prisma.user.create({data:{username:'budget-'+require('crypto').randomUUID(),passwordHash:'synthetic',roles:['CLIENT'],authorizedStreams:{connect:{id:stream.id}}}});
 try{
  const token=require('jsonwebtoken').sign({id:user.id},process.env.JWT_SECRET);
  expect((await request(runtime.app).post(endpoint).set('Authorization','Bearer '+token).send({})).status).toBe(200);
  await backend.prisma.stream.update({where:{id:stream.id},data:{isPasswordProtected:false}});
  expect((await join(await connect(),null)).ok).toBe(true);
  expect((await request(runtime.app).post(endpoint).send({})).status).toBe(200);
 }finally{await backend.prisma.stream.update({where:{id:stream.id},data:{isPasswordProtected:true}});await backend.prisma.user.delete({where:{id:user.id}});}
});
test('Redis failure closes protected HTTP and socket exchange with retry, not 403',async()=>{
 const spy=jest.spyOn(backend.redis,'eval').mockRejectedValue(new Error('synthetic store outage'));
 try{
  const ack=await join(await connect(),stream.password);expect(ack).toMatchObject({ok:false,status:503,retryAfter:1});
  expect((await request(runtime.app).post('/api/public/streams/'+stream.channelName+'/playback').send({password:stream.password})).status).toBe(503);
 }finally{spy.mockRestore();}
});

test('concurrent fresh socket connections share atomic reservations and recover after the fixed TTL',async()=>{
 const original=stream;
 stream=await backend.prisma.stream.create({data:{channelName:'budget-concurrent-'+require('crypto').randomUUID(),streamKey:require('crypto').randomUUID(),isPasswordProtected:true,password:'synthetic-password'}});
 try{
  const clients=await Promise.all(Array.from({length:4},()=>connect()));
  const results=await Promise.all(clients.flatMap(s=>Array.from({length:6},()=>join(s,'wrong'))));
  expect(results.every(r=>!r.ok)).toBe(true);
  expect(results.filter(r=>r.code==='PASSWORD_RATE_LIMITED')).toHaveLength(4);
  clients.forEach(s=>s.close());
  expect((await join(await connect(),stream.password)).code).toBe('PASSWORD_RATE_LIMITED');
  await new Promise(r=>setTimeout(r,61000));
  expect((await join(await connect(),stream.password)).ok).toBe(true);
 }finally{await backend.prisma.stream.delete({where:{id:stream.id}});stream=original;}
},75000);
