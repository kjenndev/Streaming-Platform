'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {ask,stopChild}=require('./lifecycle.cjs');
function child(){const c=new EventEmitter();c.exitCode=null;c.signalCode=null;return c;}
test('IPC replies correlate ids and detach listeners on success',async()=>{
 const c=child();c.send=(m,cb)=>{cb();queueMicrotask(()=>{c.emit('message',{requestId:'wrong'});c.emit('message',{requestId:m.requestId,ready:true});});};
 assert.equal((await ask(c,{type:'start'},100)).ready,true);
 assert.equal(c.listenerCount('message'),0);assert.equal(c.listenerCount('exit'),0);
});
test('IPC timeout and exit fail and remove listeners',async()=>{
 const c=child();c.send=(m,cb)=>cb();
 await assert.rejects(ask(c,{},5),/timeout/);assert.equal(c.listenerCount('message'),0);
 c.send=()=>queueMicrotask(()=>c.emit('exit',1));await assert.rejects(ask(c,{},50),/exited/);
});
test('cleanup awaits exact child exit and escalates to KILL',async()=>{
 const c=child(),signals=[];
 c.kill=s=>{signals.push(s);if(s==='SIGKILL'){c.signalCode=s;queueMicrotask(()=>c.emit('exit',null,s));}return true;};
 await stopChild(c,5);assert.deepEqual(signals,['SIGTERM','SIGKILL']);
 await stopChild(c,5);assert.equal(signals.length,2);
});
