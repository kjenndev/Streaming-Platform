'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('./core.cjs');
test('slow-reader evidence uses counter deltas, not old lifetime peaks',()=>{
 const s=core.slowEvidence({slowDisconnects:5,peakQueuedBytes:9999},[{slowDisconnects:7,currentQueuedBytes:100,queuedBytes:80},{slowDisconnects:7,currentQueuedBytes:0,queuedBytes:0}]);
 assert.equal(s.slowDisconnectsDelta,2);assert.equal(s.maxObservedQueuedBytes,100);assert.equal(s.evictionObserved,true);
 assert.equal(core.slowEvidence({slowDisconnects:5},[{slowDisconnects:5}]).evictionObserved,false);
});
test('connected socket without accepted presence membership is unhealthy',()=>{
 const s=core.summarizeViewers([{id:'x',bytes:0}],[{id:'x',bytes:10,status:200,socket:true,joined:false,errors:0}],1);
 assert.equal(s.healthy,0);
 const missing=core.summarizeViewers([{id:'x',bytes:0}],[{id:'x',bytes:10,status:200,socket:true,errors:0}],1);assert.equal(missing.healthy,0);
});
test('generator CPU uses microseconds and elapsed seconds, can exceed one core',()=>{
 assert.equal(core.cpuPercent({user:100000,system:50000},{user:2100000,system:2050000},2),200);
 assert.throws(()=>core.cpuPercent({user:0,system:0},{user:1,system:1},0));
});
test('viewer health requires new bytes, open media, and connected socket',()=>{
 const before=[0,0,0,0].map((bytes,id)=>({id,bytes,errors:0}));
 const after=[{id:0,bytes:1000000,status:200,closed:false,socket:true,joined:true,errors:0},{id:1,bytes:0,status:200,socket:true,errors:0},{id:2,bytes:1000000,status:200,closed:true,socket:true,errors:0},{id:3,bytes:1000000,status:200,socket:false,errors:1}];
 const s=core.summarizeViewers(before,after,2);
 assert.equal(s.healthy,1); assert.equal(s.mediaConnections,2); assert.equal(s.socketConnections,3);
 assert.equal(s.viewers[0].mbps,4); assert.equal(s.viewers[1].mbps,0); assert.equal(s.errors,1);
 assert.throws(()=>core.summarizeViewers(before,after,0));
});
test('quality failure is non-success even with clean process termination',()=>{
 const row={requested:2,healthy:2,errors:0,api:core.summarizeApi([{ok:true,ms:50}]),minMbps:4};
 assert.deepEqual(core.qualityFailures(row,{minMbps:3.6,latencyMs:500}),[]);
 assert.ok(core.qualityFailures({...row,healthy:1},{minMbps:3.6,latencyMs:500}).length);
 assert.ok(core.qualityFailures({...row,api:core.summarizeApi([{timeout:true}])},{minMbps:3.6,latencyMs:500}).length);
});
test('latency excludes errors/timeouts and empty data stays null',()=>{
 const s=core.summarizeApi([{ms:10,ok:true},{ms:30,ok:true},{ms:3000,timeout:true},{ms:40,ok:false}]);
 assert.deepEqual(s,{requests:4,successes:2,errors:2,timeouts:1,latencyMs:{p50:10,p95:30,max:30}});
 assert.equal(core.summarizeApi([{timeout:true}]).latencyMs.p95,null);
});

test('each worker uses its own monotonic counter interval',()=>{
 const client={id:'x',bytes:0,status:200,socket:true,joined:true,errors:0};
 const before=[{at:100,cpu:{user:0,system:0},clients:[client]}];
 const after=[{at:2100,cpu:{user:1000000,system:0},clients:[{...client,bytes:1000000}]}];
 assert.equal(core.summarizeWorkers(before,after).minMbps,4);
 assert.deepEqual(core.summarizeWorkers(before,after).workerCpu,[50]);
});

test('asymmetric worker scheduling cannot share a controller denominator',()=>{
 const client=id=>({id,bytes:0,status:200,socket:true,joined:true,errors:0});
 const before=[{at:100,cpu:{user:0,system:0},clients:[client('a')]},{at:900,cpu:{user:0,system:0},clients:[client('b')]}];
 const after=before.map((b,i)=>({...b,at:b.at+(i+1)*2000,cpu:{user:1000000,system:0},clients:b.clients.map(v=>({...v,bytes:1000000}))}));
 const result=core.summarizeWorkers(before,after);
 assert.deepEqual(result.viewers.map(v=>v.mbps),[4,2]);assert.deepEqual(result.workerCpu,[50,25]);
});
