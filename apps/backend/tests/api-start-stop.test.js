require('./test-env');
const backend=require('../index');
test('stop during settings lookup prevents later listener creation',async()=>{
 const port=process.env.RTMP_PORT;delete process.env.RTMP_PORT;
 let release;const lookup=jest.spyOn(backend.prisma.setting,'findUnique').mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const start=backend.startServer();start.catch(()=>{});
 await backend.stopServer();
 process.env.RTMP_PORT=port;release({value:port,type:'number'});lookup.mockRestore();
 let runtime;
 try{runtime=await start;}catch(error){expect(error.message).toMatch(/stopp/i);}
 finally{
  if(runtime){await runtime.nms.stop();await new Promise(r=>runtime.server.close(r));}
  await backend.redis.quit();await backend.prisma.$disconnect();await backend.pool.end();
 }
 expect(runtime).toBeUndefined();
},20000);
