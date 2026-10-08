require('./test-env');
const request=require('supertest'),bcrypt=require('bcrypt');
const backend=require('../index');
let runtime,user;
beforeAll(async()=>{runtime=await backend.startServer();user=await backend.prisma.user.create({data:{username:'session-burst-fixture',roles:['CLIENT'],passwordHash:await bcrypt.hash('FixtureOnly!123',4)}});},20000);
afterAll(async()=>{await backend.prisma.user.deleteMany({where:{id:user?.id}});await backend.stopServer();await backend.redis.quit();await backend.prisma.$disconnect();await backend.pool.end();},20000);
test('in-flight login attempts remain bounded before successful responses release slots',async()=>{
 let release,entered=0,ready;
 const blocked=new Promise(r=>release=r),allEntered=new Promise(r=>ready=r);
 const compare=jest.spyOn(bcrypt,'compare').mockImplementation(async()=>{if(++entered===10)ready();await blocked;return true;});
 const pending=Array.from({length:10},()=>request(runtime.app).post('/api/login').send({username:user.username,password:'FixtureOnly!123'}).then(r=>r));
 try{
  await allEntered;
  expect((await request(runtime.app).post('/api/login').send({username:user.username,password:'FixtureOnly!123'})).status).toBe(429);
 }finally{release();const responses=await Promise.all(pending);compare.mockRestore();for(const response of responses)expect(response.status).toBe(200);}
 expect((await request(runtime.app).post('/api/login').send({username:user.username,password:'FixtureOnly!123'})).status).toBe(200);
});
