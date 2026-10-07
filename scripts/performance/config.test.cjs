'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {config}=require('./run.cjs');
test('safe defaults and explicit load options',()=>{
 const c=config([],{});
 assert.deepEqual(c.stages.map(s=>s.viewers),[1,100,250,500]);
 assert.equal(c.rssMiB,1200);assert.equal(c.allowLan,false);
 assert.equal(c.slowViewers,10);assert.equal(c.slowSeconds,60);
 const custom=config(['--stages','1:2,1000:5','--slow-viewers','0','--churn','3','--chat-ms','1000','--presence-ms','2000'],{});
 assert.equal(custom.churn,3);assert.equal(custom.chatMs,1000);assert.equal(custom.presenceMs,2000);
 assert.equal(config([],{BENCHMARK_STAGES:'1:9'}).stages[0].seconds,9);
});
test('bad counts, unsafe short slow phase and invalid flags fail before side effects',()=>{
 for(const args of [['--slow-viewers','1.5'],['--churn','-1'],['--slow-seconds','1'],['--poll-ms','NaN'],['--not-an-option']])assert.throws(()=>config(args,{}));
});
