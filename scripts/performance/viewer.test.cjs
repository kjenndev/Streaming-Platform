'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {createViewer,snapshot,dispose}=require('./viewer.cjs');
function setup(slow=false){
 const req=new EventEmitter();req.destroy=()=>req.emit('error',Error('intentional'));
 const res=new EventEmitter();res.statusCode=200;res.pause=()=>{res.paused=true;};res.destroy=()=>{};
 res.socket={pause(){this.paused=true;},isPaused(){return !!this.paused;},readableLength:0};
 const socket=new EventEmitter();socket.connected=true;socket.onAny=()=>{};socket.disconnect=()=>socket.emit('disconnect');socket.timeout=()=>socket;
 socket.emit=(event,...args)=>{if(event==='join_channel'||event==='send_message'){args.at(-1)(null,{ok:true});return true;}return EventEmitter.prototype.emit.call(socket,event,...args);};
 const c=createViewer({id:'v',channel:'owned',api:'http://127.0.0.1',media:'http://127.0.0.1',timeoutMs:500,slow}, {get:(_,opts,cb)=>{queueMicrotask(()=>cb(res));return req;},io:()=>socket});
 return {c,req,res,socket};
}
test('slow readers pause response AND actual transport socket and retain evidence',async()=>{
 const {c,res,socket}=setup(true);await Promise.resolve();socket.emit('connect');
 assert.equal(res.paused,true);assert.equal(res.socket.paused,true);
 const s=snapshot(c);assert.equal(s.slow,true);assert.equal(s.transportPaused,true);assert.equal(s.joined,true);assert.ok(s.pausedAt>0);
 dispose(c);assert.equal(c.errors,0);
});
test('normal bytes, gaps and closure are accurately accounted',async()=>{
 const {c,res,socket}=setup();await Promise.resolve();socket.emit('connect');
 res.emit('data',Buffer.alloc(123));res.emit('data',Buffer.alloc(77));
 const s=snapshot(c);assert.equal(s.bytes,200);assert.equal(s.mediaChunks,2);assert.equal(s.socket,true);assert.ok(s.gap>=0);
 res.emit('end');assert.equal(snapshot(c).closed,true);dispose(c);
});

test('unexpected media end and close are distinct from intentional disposal',async()=>{
 const {c,res}=setup();await Promise.resolve();res.emit('end');res.emit('close');
 assert.equal(snapshot(c).unexpectedEnds,1);assert.equal(snapshot(c).unexpectedCloses,1);
 dispose(c);res.emit('close');assert.equal(snapshot(c).unexpectedCloses,1);
});

test('slow media eviction errors remain separate from membership failures',async()=>{
 const {c,res,socket}=setup(true);await Promise.resolve();socket.emit('connect');res.emit('error',Error('evicted'));
 assert.equal(snapshot(c).mediaErrors,1);assert.equal(snapshot(c).socketErrors,0);
 socket.emit('disconnect');assert.equal(snapshot(c).socketErrors,1);dispose(c);
});
