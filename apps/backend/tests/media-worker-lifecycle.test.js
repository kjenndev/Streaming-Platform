const vm=require('vm');
const fs=require('fs');
const path=require('path');
const {EventEmitter}=require('events');
const flush=()=>new Promise(setImmediate);
async function worker(recover=async()=>{}){
 const handlers={},prisma={stream:{update:jest.fn().mockResolvedValue({}),updateMany:jest.fn().mockResolvedValue({})},setting:{findUnique:jest.fn().mockResolvedValue(null)}};
 const redis={pipeline:()=>({}),del:jest.fn().mockResolvedValue(0),hset:jest.fn().mockResolvedValue(1),hdel:jest.fn().mockResolvedValue(1)};
 const fakeProcess=Object.assign(new EventEmitter(),{env:{RTMP_PORT:'11936',MEDIA_HTTP_PORT:'18001'},connected:true,send:jest.fn(),exit:jest.fn()});
 class NMS{constructor(){this.httpServer={httpServer:new EventEmitter(),wsServer:new EventEmitter()};this.rtmpServer={tcpServer:new EventEmitter()};}on(name,fn){handlers[name]=fn;}run(){this.httpServer.httpServer.emit('listening');this.rtmpServer.tcpServer.emit('listening');}}
 const imports={'./recording-recovery':{createRecordingRecovery:()=>({recover,close:async()=>{}})},pg:{Pool:class{}},'@prisma/adapter-pg':{PrismaPg:class{}},'@prisma/client':{PrismaClient:class{constructor(){return prisma;}}},ioredis:class{constructor(){return redis;}},'./media-safety':{installMediaSafety:()=>({snapshot:()=>({networkBytes:0})})},'./publisher-auth':{gatePublisher:()=>{}},'./process-runtime':{ManagedProcesses:class{},processTelemetry:()=>({sample:()=>({})})},'./control-runtime':{serialCollector:collect=>({tick:()=>Promise.resolve().then(collect).catch(()=>{}),stop:async()=>{}})},'node-media-server':NMS,'node-media-server/src/core/context':{sessions:new Map()},'node-media-server/src/core/logger':{},'node-media-server/src/session/record_session':class{}};
 const load=name=>name in imports?imports[name]:name.startsWith('./')?require('../lib/'+name.slice(2)):require(name);
 load.resolve=x=>x;load.cache={};
 for(const name of ['rtmp_session','flv_session'])load.cache[`node-media-server/src/session/${name}`]={exports:class{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/media-worker.js'),'utf8'),{require:load,__dirname:path.join(__dirname,'../lib'),process:fakeProcess,console:{error:jest.fn()},setTimeout,clearTimeout,Buffer});
 await flush();
 function session(id){const s={id,authorizedStream:{id:'stream',channelName:'channel',restreamUrls:{}},socket:{destroyed:false},broadcast:{},inBytes:0};s.broadcast.publisher=s;s.close=jest.fn(()=>{s.socket.destroyed=true;s.broadcast.publisher=null;handlers.donePublish(s);});return s;}
 return {handlers,prisma,redis,session,process:fakeProcess};
}
test.each(['database','redis'])('publisher initialization fails closed on %s failure',async failure=>{
 const w=await worker(),s=w.session('failed');
 if(failure==='database')w.prisma.stream.update.mockRejectedValueOnce(new Error('database unavailable'));
 else w.redis.hset.mockRejectedValueOnce(new Error('redis unavailable'));
 w.handlers.postPublish(s);await s.lifecycle.catch(()=>{});await flush();
 expect(s.close).toHaveBeenCalledTimes(1);
 expect(w.redis.hdel).toHaveBeenCalledWith('live_streams','channel');
 expect(w.prisma.stream.updateMany).toHaveBeenLastCalledWith({where:{channelName:'channel'},data:{isLive:false}});
});

test('Redis outage does not skip database rollback after rejected initialization',async()=>{
 const w=await worker(),s=w.session('failed');
 w.redis.hset.mockRejectedValueOnce(new Error('redis unavailable'));
 w.redis.hdel.mockRejectedValueOnce(new Error('redis unavailable'));
 w.handlers.postPublish(s);await s.lifecycle.catch(()=>{});await flush();
 expect(s.close).toHaveBeenCalledTimes(1);
 expect(w.prisma.stream.updateMany).toHaveBeenLastCalledWith({where:{channelName:'channel'},data:{isLive:false}});
});
test('deferred old publisher teardown cannot clear replacement durable state',async()=>{
 const w=await worker(),old=w.session('old'),next=w.session('new');let release;
 w.prisma.stream.update.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 w.handlers.postPublish(old);await flush();old.close();w.handlers.postPublish(next);await flush();
 release({});await Promise.all([old.lifecycle,next.lifecycle]);await flush();
 expect(w.redis.hdel).not.toHaveBeenCalled();
 expect(JSON.parse(w.redis.hset.mock.calls.at(-1)[2]).id).toBe('new');
 expect(next.close).not.toHaveBeenCalled();
});

test('slow orphan recovery cannot block media readiness or trigger supervisor startup timeout',async()=>{
 let release;const recover=jest.fn(()=>new Promise(r=>{release=r;}));
 const w=await worker(recover);
 try{expect(w.process.send).toHaveBeenCalledWith({type:'ready'},expect.any(Function));expect(recover).toHaveBeenCalledTimes(1);}finally{release?.();await flush();}
});
test('delegated HTTP sessions retain a dedicated auth path but attach to the ordinary live broadcast',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../lib/media-worker.js'),'utf8');
 expect(source).toContain("this.streamApp==='mss-live'");
 expect(source).toContain('context.broadcasts.get(`/live/${this.streamName}`)');
});
