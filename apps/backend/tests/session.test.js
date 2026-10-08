require('./test-env');
const request=require('supertest'),jwt=require('jsonwebtoken'),bcrypt=require('bcrypt');
const backend=require('../index');
let runtime,user;
const token=(options={})=>jwt.sign({id:user.id},process.env.JWT_SECRET,options);
beforeAll(async()=>{runtime=await backend.startServer();user=await backend.prisma.user.create({data:{username:'session-fixture',roles:['CLIENT'],passwordHash:await bcrypt.hash('FixtureOnly!123',4)}});},20000);
afterAll(async()=>{await backend.prisma.user.deleteMany({where:{id:user?.id}});await backend.stopServer();await backend.redis.quit();await backend.prisma.$disconnect();await backend.pool.end();},20000);
test('expired dashboard session is 401, permission denial 403, DB failure 503',async()=>{
 const expired=await request(runtime.app).get('/api/streams').set('Authorization','Bearer '+token({expiresIn:-1}));
 expect(expired.status).toBe(401);expect(expired.body.code).toBe('SESSION_EXPIRED');
 expect((await request(runtime.app).get('/api/users').set('Authorization','Bearer '+token())).status).toBe(403);
 const lookup=jest.spyOn(backend.prisma.user,'findUnique').mockRejectedValueOnce(new Error('DB unavailable'));
 try{expect((await request(runtime.app).get('/api/streams').set('Authorization','Bearer '+token())).status).toBe(503);}finally{lookup.mockRestore();}
});

test('socket expiry is explicit while anonymous public connections remain connected',async()=>{
 const {io}=require('socket.io-client');
 const connect=auth=>new Promise((resolve,reject)=>{const socket=io(`http://127.0.0.1:${process.env.HTTP_PORT}`,{auth,transports:['websocket'],reconnection:false});socket.once('connect',()=>resolve(socket));socket.once('connect_error',error=>{socket.disconnect();reject(error);});});
 const account=await connect({token:token({expiresIn:1})}),anonymous=await connect({});
 let timeout;
 try{
  const invalid=await Promise.race([new Promise(resolve=>account.once('session_invalid',resolve)),new Promise(resolve=>{timeout=setTimeout(()=>resolve(null),4500);})]);
  expect(invalid).toMatchObject({code:'SESSION_EXPIRED'});expect(anonymous.connected).toBe(true);
 }finally{clearTimeout(timeout);account.disconnect();anonymous.disconnect();}
},8000);
test('socket handshake distinguishes invalid login from a database outage',async()=>{
 const {io}=require('socket.io-client');
 const failure=auth=>new Promise(resolve=>{const socket=io(`http://127.0.0.1:${process.env.HTTP_PORT}`,{auth,transports:['websocket'],reconnection:false});socket.once('connect_error',e=>{socket.disconnect();resolve(e.data);});});
 expect(await failure({token:token({expiresIn:-1})})).toMatchObject({code:'SESSION_EXPIRED',status:401});
 const lookup=jest.spyOn(backend.prisma.user,'findUnique').mockRejectedValueOnce(new Error('DB unavailable'));
 try{expect(await failure({token:token()})).toMatchObject({code:'AUTH_UNAVAILABLE',status:503});}finally{lookup.mockRestore();}
});
test('successful logins release allowance; failures stay counted and Retry-After is readable',async()=>{
 for(let i=0;i<12;i++)expect((await request(runtime.app).post('/api/login').send({username:user.username,password:'FixtureOnly!123'})).status).toBe(200);
 for(let i=0;i<10;i++)expect((await request(runtime.app).post('/api/login').send({username:i%2?user.username:'missing-fixture',password:'wrong'})).status).toBe(401);
 const limited=await request(runtime.app).post('/api/login').send({username:user.username,password:'FixtureOnly!123'});
 expect(limited.status).toBe(429);expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
 expect(limited.headers['access-control-expose-headers']).toContain('Retry-After');
 expect(runtime.app.get('trust proxy')).toBe(false);
 const spoofed=await request(runtime.app).post('/api/login').set('X-Forwarded-For','203.0.113.7').send({username:user.username,password:'wrong'});
 expect(spoofed.status).toBe(429);
});

test('missing and malformed account credentials are consistently 401',async()=>{
 expect((await request(runtime.app).get('/api/streams')).status).toBe(401);
 expect((await request(runtime.app).get('/api/streams').set('Authorization','Bearer malformed')).status).toBe(401);
});
