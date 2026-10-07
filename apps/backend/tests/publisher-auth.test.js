const { gatePublisher } = require('../lib/publisher-auth');
test('publish admission waits for auth and blocks packets while pending', async()=>{
 let resolve; const publish=jest.fn(); const packet=jest.fn();
 const session={streamPath:'/live/a',streamQuery:{key:'secret'},socket:{pause:jest.fn(),resume:jest.fn(),destroy:jest.fn()},onPush:publish,onPacket:packet};
 gatePublisher(session,()=>new Promise(r=>resolve=r));
 const pending=session.onPush(); session.onPacket({}); expect(publish).not.toHaveBeenCalled(); expect(packet).not.toHaveBeenCalled();
 resolve({channelName:'a'}); await pending; expect(publish).toHaveBeenCalledTimes(1);
 session.onPacket({}); expect(packet).toHaveBeenCalledTimes(2);
});
test('denied publish never executes downstream',async()=>{
 const publish=jest.fn();const socket={pause:jest.fn(),resume:jest.fn(),destroy:jest.fn()};
 const session={socket,onPush:publish,onPacket:jest.fn()};gatePublisher(session,async()=>null);
 await session.onPush();expect(publish).not.toHaveBeenCalled();expect(socket.destroy).toHaveBeenCalled();
});

test('pending publisher packet queue has a hard byte budget',async()=>{
 let resolve;const socket={pause:jest.fn(),resume:jest.fn(),destroy:jest.fn()};
 const session={socket,onPush:jest.fn(),onPacket:jest.fn()};
 gatePublisher(session,()=>new Promise(r=>resolve=r));const pending=session.onPush();
 session.onPacket({data:Buffer.alloc(1024*1024+1)});expect(socket.destroy).toHaveBeenCalled();
 resolve(null);await pending;
});

test('a competing publisher cannot forward packets into an admitted broadcast',async()=>{
 const socket={pause:jest.fn(),resume:jest.fn(),destroy:jest.fn()};
 const session={socket,broadcast:{publisher:{}},onPush:jest.fn(),onPacket:jest.fn()};
 gatePublisher(session,async()=>({channelName:'a'}));await session.onPush();
 expect(session.authorizedStream).toBeUndefined();expect(socket.destroy).toHaveBeenCalled();
});

const { EventEmitter } = require('node:events');
function pendingPublisher() {
 const socket=Object.assign(new EventEmitter(),{pause:jest.fn(),resume:jest.fn(),destroy:jest.fn()});
 const publish=jest.fn(),packet=jest.fn();
 const session={socket,onPush:publish,onPacket:packet};
 let resolve,reject;
 const authorization=new Promise((yes,no)=>{resolve=yes;reject=no;});
 gatePublisher(session,()=>authorization);
 const admission=session.onPush();
 session.onPacket({data:Buffer.alloc(512*1024)});
 return {session,socket,admission,resolve,reject,authorization,publish,packet};
}
test.each(['timeout','close'])('%s settles admission without authorization completing',async(reason)=>{
 jest.useFakeTimers();
 try {
  const {session,socket,admission,resolve,publish,packet}=pendingPublisher();
  let settled=false;admission.then(()=>{settled=true;});
  if(reason==='timeout')jest.advanceTimersByTime(5000);else socket.emit('close');
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(settled).toBe(true);
  expect(socket.listenerCount('close')).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  resolve({channelName:'late'});
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(session.authorizedStream).toBeUndefined();
  expect(session.onPush()).toBe(admission);
  expect(publish).not.toHaveBeenCalled();expect(packet).not.toHaveBeenCalled();
  expect(socket.resume).not.toHaveBeenCalled();
 } finally {jest.useRealTimers();}
});

// A child with explicit GC observes actual copied-buffer reachability, rather
// than assuming a closed socket or a zero accounting counter releases payloads.
test.each(['timeout','close'])('%s releases copied payload while auth remains externally rooted',reason=>{
 const {spawnSync}=require('node:child_process');
 const result=spawnSync(process.execPath,['--expose-gc','-e',`
  const assert=require('node:assert/strict');
  const {EventEmitter}=require('node:events');
  const {gatePublisher}=require(${JSON.stringify(require.resolve('../lib/publisher-auth'))});
  let expire;
  global.setTimeout=fn=>{expire=fn;return {unref(){}};};
  global.clearTimeout=()=>{};
  const socket=Object.assign(new EventEmitter(),{pause(){},resume(){throw Error('resumed');},destroy(){}});
  const session={socket,onPush(){throw Error('published');},onPacket(){throw Error('forwarded');}};
  const roots=[];
  gatePublisher(session,()=>new Promise(resolve=>roots.push(resolve)));
  session.onPush();
  let payload;
  const from=Buffer.from;
  Buffer.from=(...args)=>{const copy=from(...args);payload=new WeakRef(copy);return copy;};
  session.onPacket({data:Buffer.alloc(512*1024)});
  Buffer.from=from;
  assert.ok(payload.deref(),'queued copy exists before cancellation');
  if(${JSON.stringify(reason)}==='timeout')expire();else socket.emit('close');
  (async()=>{
   for(let i=0;i<8;i++){await new Promise(setImmediate);global.gc();}
   assert.equal(payload.deref()===undefined,true,'cancelled admission retained its copied payload');
   assert.equal(roots.length,1); // Keep auth resolver AND session strongly rooted.
   assert.ok(session.publisherAdmission);
  })().catch(error=>{console.error(error);process.exitCode=1;});
 `],{encoding:'utf8',timeout:10000});
 expect({status:result.status,stderr:result.stderr,error:result.error?.message}).toEqual({status:0,stderr:'',error:undefined});
});

test.each(['success','denied','rejection','competing','overflow'])('%s detaches admission cancellation listener and deadline',async(reason)=>{
 jest.useFakeTimers();
 try {
  const {session,socket,admission,resolve,reject}=pendingPublisher();
  expect(socket.listenerCount('close')).toBe(1);
  if(reason==='overflow')session.onPacket({data:Buffer.alloc(1024*1024)});
  else if(reason==='rejection')reject(new Error('auth failed'));
  else {
   if(reason==='competing')session.broadcast={publisher:{}};
   resolve(reason==='denied'?null:{channelName:'a'});
  }
  let settled=false;admission.then(()=>{settled=true;});
  for(let i=0;i<10;i++)await Promise.resolve();
  expect(settled).toBe(true);
  expect(socket.listenerCount('close')).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
 } finally {jest.useRealTimers();}
});

test('pending identity rejection settles admission before auth and never mutates identity',async()=>{
 const socket=Object.assign(new EventEmitter(),{pause:jest.fn(),resume:jest.fn(),destroy:jest.fn()});
 const session={socket,streamPath:'/live/a',onConnect:jest.fn(request=>{session.streamPath=request;}),onPush:jest.fn(),onPacket:jest.fn(),close:jest.fn()};
 const originalConnect=session.onConnect;
 let resolve;gatePublisher(session,()=>new Promise(r=>resolve=r));
 const admission=session.onPush();
 session.onConnect('/live/b');
 let settled=false;admission.then(()=>{settled=true;});
 for(let i=0;i<10;i++)await Promise.resolve();
 expect(settled).toBe(true);expect(originalConnect).not.toHaveBeenCalled();
 expect(session.streamPath).toBe('/live/a');expect(socket.listenerCount('close')).toBe(0);
 resolve({channelName:'a'});await admission;
 expect(session.authorizedStream).toBeUndefined();
});

test('late authorization rejection after cancellation is handled without publishing',async()=>{
 const {session,socket,admission,reject,publish,packet}=pendingPublisher();
 socket.emit('close');
 await admission;
 reject(new Error('late auth failure'));
 await new Promise(setImmediate);
 expect(session.authorizedStream).toBeUndefined();
 expect(publish).not.toHaveBeenCalled();expect(packet).not.toHaveBeenCalled();
 expect(socket.resume).not.toHaveBeenCalled();
});
