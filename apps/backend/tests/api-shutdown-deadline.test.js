require('./test-env');
jest.mock('../lib/control-runtime',()=>({...jest.requireActual('../lib/control-runtime'),serialCollector:fn=>({tick:fn,stop:()=>new Promise(()=>{})})}));
const backend=require('../index');
test('shutdown has a deadline even if collector drain hangs',async()=>{
 process.env.API_SHUTDOWN_TIMEOUT_MS='100';
 const runtime=await backend.startServer();let timer;
 try{
  await Promise.race([backend.stopServer(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('collector prevented bounded shutdown')),1000);})]);
  expect(runtime.server.listening).toBe(false);
 }finally{clearTimeout(timer);await runtime.nms.stop();await backend.redis.quit();await backend.prisma.$disconnect();await backend.pool.end();delete process.env.API_SHUTDOWN_TIMEOUT_MS;}
},20000);
