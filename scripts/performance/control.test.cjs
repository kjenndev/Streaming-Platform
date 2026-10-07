'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const c=require('./control.cjs');
test('RSS safety is per process, requires both API and media, identifies harness stop',()=>{
 const data={api:{memory:{rss:800*1048576}},media:{memory:{rss:900*1048576}}};
 assert.deepEqual(c.checkRss(data,1200),{api:800,media:900});
 assert.throws(()=>c.checkRss({...data,media:{memory:{rss:1201*1048576}}},1200),e=>e.code==='HARNESS_SAFETY_STOP'&&/not a server crash/.test(e.message));
 assert.throws(()=>c.checkRss({api:data.api,media:null},1200),/missing.*media/i);
});
test('exact worker batches never exceed 250',()=>{
 assert.deepEqual(c.batches(501),[250,250,1]); assert.deepEqual(c.batches(1),[1]);
 for(const n of [0,-1,1.2,NaN])assert.throws(()=>c.batches(n));
});
test('network targets are loopback by default; LAN opt in never permits WAN',async()=>{
 const lookup=async()=>[{address:'8.8.8.8'}];
 assert.equal(await c.validateTarget('http://127.0.0.1:3000',false,lookup),'http://127.0.0.1:3000');
 await assert.rejects(c.validateTarget('http://192.168.1.20:3000',false,lookup));
 assert.equal(await c.validateTarget('http://192.168.1.20:3000',true,lookup),'http://192.168.1.20:3000');
 for(const u of ['http://8.8.8.8','http://public.example','http://user:secret@127.0.0.1','ftp://127.0.0.1','http://127.0.0.1/path'])await assert.rejects(c.validateTarget(u,true,lookup));
 await assert.rejects(c.validateTarget('http://mixed.example',true,async()=>[{address:'192.168.0.1'},{address:'1.1.1.1'}]));
});
test('RSS reads parent and media child with schema fallback and fails closed if absent',()=>{
 assert.equal(c.rssMiB({process:{rss:104857600},media:{rss:209715200}}),300);
 assert.equal(c.rssMiB({process:{memory:{rss:104857600}},media:{rssMiB:200}}),300);
 assert.equal(c.rssMiB({cpu:10}),null);
});
test('stage spec rejects malformed and nonpositive values',()=>{
 assert.deepEqual(c.parseStages('1:2,251:30'),[{viewers:1,seconds:2},{viewers:251,seconds:30}]);
 for(const s of ['','1:0','0:2','2.5:3','2:3:4','abc'])assert.throws(()=>c.parseStages(s));
});

test('telemetry freshness rejects old timestamps and stalled sequences',()=>{
 const state={};const sample=(at,seq)=>({api:{sampledAt:at,sampleSequence:seq},media:{sampledAt:at,sampleSequence:seq}});
 assert.throws(()=>c.checkFreshness(sample(100,1),100,{},1000),/telemetry/i);
 c.checkFreshness(sample(1000,1),100,state,1000);
 assert.throws(()=>c.checkFreshness(sample(1101,1),100,state,1101),/telemetry/i);
 assert.throws(()=>c.checkFreshness({api:{},media:{}},100,{},1000),/telemetry/i);
 c.checkFreshness(sample(1102,2),100,state,1102);
});

test('DNS wait has a deadline and responds to cancellation',async()=>{
 const stalled=()=>new Promise(()=>{});
 await assert.rejects(c.validateTarget('http://local.test',false,stalled,undefined,{timeoutMs:10}),/deadline/);
 const a=new AbortController();a.abort();
 await assert.rejects(c.validateTarget('http://local.test',false,stalled,undefined,{timeoutMs:10,signal:a.signal}),/abort/i);
});
