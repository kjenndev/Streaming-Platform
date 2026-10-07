'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fixture=require('./fixture.cjs');
test('pagination finds owned fixture beyond first page and cleanup verifies recording and channel deletion',async()=>{
 const streams=[{id:'unrelated',channelName:'existing'},{id:'own',channelName:'benchmark_uuid'}];
 let records=[{id:'record',streamId:'own'}];const deleted=[];
 const request=async(route,options={})=>{
  if(options.method==='DELETE'){
   deleted.push(route);
   if(route==='/api/recordings/record')records=[];
   if(route==='/api/streams/own')streams.pop();
   return {ok:true,data:{}};
  }
  const u=new URL(route,'http://localhost');
  const all=u.pathname==='/api/streams'?streams:records;
  const skip=Number(u.searchParams.get('skip')||0);
  return {ok:true,data:all.slice(skip,skip+1),total:all.length};
 };
 const all=await fixture.listAll(request,'/api/streams');assert.equal(all.length,2);
 const result=await fixture.cleanupFixture(request,'benchmark_uuid','own');
 assert.deepEqual(deleted,['/api/recordings/record','/api/streams/own']);assert.equal(result.channelRemoved,true);
 assert.deepEqual(streams,[{id:'unrelated',channelName:'existing'}]);
});
test('cleanup refuses wrong identity or foreign recording and failed API calls',async()=>{
 const request=async(route)=>({ok:true,total:1,data:route.startsWith('/api/streams?')?[{id:'own',channelName:'benchmark_uuid'}]:[{id:'foreign',streamId:'other'}]});
 await assert.rejects(fixture.cleanupFixture(request,'benchmark_uuid','wrong'),/mismatch/);
 await assert.rejects(fixture.cleanupFixture(request,'benchmark_uuid','own'),/ownership/);
 await assert.rejects(fixture.listAll(async()=>({ok:false}),'/api/streams'),/failed/);
 await assert.rejects(fixture.listAll(async()=>({ok:true,total:2,data:[]}),'/api/streams'),/pagination/);
});

test('growing pagination is bounded and stalled pagination can abort',async()=>{
 let i=0;
 await assert.rejects(fixture.listAll(async()=>({ok:true,data:[{id:++i}],total:i+1}),'/api/streams',{maxPages:3}),/page|pagination/i);
 assert.equal(i,3);
 const a=new AbortController();setTimeout(()=>a.abort(),10);
 await assert.rejects(fixture.listAll(()=>new Promise(()=>{}),'/api/streams',{signal:a.signal,timeoutMs:50}),/abort/i);
});

test('deadline preserves confirmed partial cleanup without broadening ownership',async()=>{
 const progress={};let deletes=0;
 const request=async(route,opts)=>{
  if(opts.method==='DELETE'){if(++deletes===2)return new Promise(()=>{});return {ok:true};}
  return {ok:true,total:route.startsWith('/api/streams?')?1:2,data:route.startsWith('/api/streams?')?[{id:'own',channelName:'benchmark_uuid'}]:[{id:'a',streamId:'own'},{id:'b',streamId:'own'}]};
 };
 await assert.rejects(fixture.cleanupFixture(request,'benchmark_uuid','own',{timeoutMs:10,progress}),/deadline/);
 assert.equal(progress.recordingsRemoved,1);assert.equal(progress.channelRemoved,false);assert.equal(deletes,2);
});

test('pagination deadline aborts its request without aborting the parent',async()=>{
 const parent=new AbortController();let requestSignal;
 await assert.rejects(fixture.listAll((route,options)=>{requestSignal=options.signal;return new Promise(()=>{});},'/api/streams',{signal:parent.signal,timeoutMs:10}),/deadline/i);
 assert.equal(requestSignal.aborted,true);assert.equal(parent.signal.aborted,false);
 assert.notEqual(requestSignal,parent.signal);
});
