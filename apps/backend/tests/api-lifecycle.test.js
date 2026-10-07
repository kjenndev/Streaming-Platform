require('./test-env');
const net=require('net');
const backend=require('../index');
let socket;
afterAll(async()=>{socket?.destroy();await backend.stopServer();await backend.redis.quit();await backend.prisma.$disconnect();await backend.pool.end();},40000);
test('concurrent starts share readiness',async()=>{
 const first=backend.startServer(),second=backend.startServer();
 await first;
 expect(second).toBe(first);
},20000);
test('shutdown closes incomplete HTTP before waiting for server close',async()=>{
 const runtime=await backend.startServer();
 socket=net.connect(Number(process.env.HTTP_PORT),'127.0.0.1');
 await new Promise(r=>socket.once('connect',r));
 socket.write('POST /api/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 99999\r\n\r\n{');
 await new Promise(r=>setTimeout(r,30));
 const stop=backend.stopServer();let timer;
 try{await Promise.race([stop,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('shutdown blocked by incomplete HTTP')),1500);})]);}
 finally{clearTimeout(timer);socket.destroy();await stop;}
 expect(runtime.server.listening).toBe(false);
},10000);
test('restart after shutdown is explicitly rejected',async()=>{
 await expect(backend.startServer()).rejects.toThrow(/stopp|restart/i);
});
