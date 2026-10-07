'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {WorkerPool}=require('./worker.cjs');
test('worker churn owns exact replacements, accounts retired viewers and stop is idempotent',async()=>{
 let created=0,disposed=0;
 const pool=new WorkerPool({create:o=>({...o,bytes:12,errors:0,disposed:false,socketClient:{connected:true,timeout(){return this;},emit(e,p,cb){cb(null,{ok:true});}}}),snapshot:c=>({id:c.id,bytes:c.bytes,errors:c.errors}),dispose:c=>{if(!c.disposed){c.disposed=true;disposed++;}}});
 await pool.start({n:3,rampMs:0,channel:'own'});created=pool.clients.length;
 const before=pool.snapshot();await pool.churn(2);
 const after=pool.snapshot();assert.equal(created,3);assert.equal(after.clients.length,3);assert.equal(after.retired.length,2);assert.equal(after.churned,2);
 assert.notEqual(before.clients[0].id,after.clients[0].id);assert.equal(disposed,2);
 await assert.rejects(pool.churn(4),/count/);
 pool.stop();pool.stop();assert.equal(disposed,5);
});
test('chat acknowledgements and failures are counted without containing content',async()=>{
 const pool=new WorkerPool({create:o=>({...o,socketClient:{connected:true,timeout(){return this;},emit(e,p,cb){cb(null,{ok:false});}}}),snapshot:c=>({id:c.id}),dispose:()=>{}});
 await pool.start({n:1,rampMs:0,channel:'own'});pool.chat();assert.deepEqual(pool.snapshot().chat,{sent:1,accepted:0,errors:1});pool.stop();
});

test('settle stops chat scheduling and expires dropped acknowledgements exactly once',async()=>{
 let ack;const pool=new WorkerPool({create:o=>({...o,socketClient:{connected:true,timeout(){return this;},emit(e,p,cb){ack=cb;}}}),snapshot:c=>({id:c.id}),dispose:()=>{}});
 await pool.start({n:1,rampMs:0,timeoutMs:10});pool.chat();
 await pool.settle();assert.deepEqual(pool.snapshot().chat,{sent:1,accepted:0,errors:1});
 ack(null,{ok:true});pool.chat();assert.deepEqual(pool.snapshot().chat,{sent:1,accepted:0,errors:1});pool.stop();
});
