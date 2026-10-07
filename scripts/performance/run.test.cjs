'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {run,config,prepareOutput}=require('./run.cjs');
function rig({highRss=false,createFailure=false,signal=false,probeFailure=false,cleanupFailure=false,rampSafety=false,lateReady=false,presenceTotal,retiredFailure=false,slowJoinFailure=false,pendingChat=false,stalledCleanup=false,staleTelemetry=false,neverReady=false,snapshotDelay=false,stalledProbe=false}={}){
 const streams=[],children=[],requests=[];let seq=1000000,metricCount=0;
 const child=()=>{const c=new EventEmitter();c.pid=seq++;c.exitCode=null;c.signalCode=null;c.kill=s=>{c.signalCode=s;queueMicrotask(()=>c.emit('exit',null,s));return true;};children.push(c);return c;};
 const spawn=()=>{const c=child();if(signal)queueMicrotask(()=>process.emit('SIGTERM'));return c;};
 const fork=()=>{const c=child();let options,bytes=0,snapshots=0;
  c.send=(m,cb)=>{cb?.();let result={};
   if(m.type==='start'){options=m;c.options=m;result.ready=true;}
   else {snapshots++;bytes+=1000000;result={at:performance.now(),cpu:{user:1,system:1},clients:Array.from({length:options.n},(_,i)=>({id:`${c.pid}:${i}`,bytes,status:200,errors:0,closed:false,socket:true,joined:(!lateReady||snapshots>1)&&!neverReady&&!(slowJoinFailure&&options.slow&&snapshots>1),slow:options.slow,transportPaused:options.slow,pausedMs:10000})),retired:retiredFailure?[{errors:1,status:200,bytes:1,socket:false,joined:false}]:[],chat:pendingChat?{sent:1,accepted:0,errors:0}:{sent:0,accepted:0,errors:0},churned:m.type==='churn'?m.n:0};}
   (snapshotDelay&&m.type!=='start'?fn=>setTimeout(fn,10):queueMicrotask)(()=>c.emit('message',{requestId:m.requestId,...result}));
  };return c;};
 const fetch=async(url,options)=>{
  const u=new URL(url);requests.push([u.pathname,options.method]);let data={},status=200;
  if(u.pathname==='/api/login')data={roles:['ADMIN'],token:'test-only-token'};
  else if(u.pathname==='/api/metrics')data={api:{sampledAt:staleTelemetry?1:Date.now(),sampleSequence:metricCount+1,memory:{rss:((highRss||(rampSafety&&children.length>1))?1300:20)*1048576}},media:{sampledAt:staleTelemetry?1:Date.now(),sampleSequence:metricCount+1,memory:{rss:30*1048576},mediaSafety:{slowDisconnects:metricCount++,currentQueuedBytes:0,queuedBytes:0}}};
  else if(u.pathname==='/api/streams'&&options.method==='POST'){const body=JSON.parse(options.body);data={...body,id:'owned',streamKey:'test-only-key'};streams.push(data);if(createFailure)status=503;}
  else if(u.pathname==='/api/streams')data=[...streams];
  else if(u.pathname.endsWith('/viewers')){data=[];}
  else if(u.pathname.endsWith('/recordings'))data=[];
  else if(u.pathname==='/api/streams/owned'&&options.method==='DELETE'){if(stalledCleanup)return {ok:true,status:200,headers:new Headers(),json:()=>new Promise(()=>{})};if(cleanupFailure)status=503;else streams.length=0;}
  else if(u.pathname.startsWith('/api/public/')&&stalledProbe)return {ok:true,status:200,headers:new Headers(),json:()=>new Promise(()=>{})};
  else if(u.pathname.startsWith('/api/public/')&&probeFailure)throw Error('test network failure');
  return {ok:status===200,status,headers:new Headers(Array.isArray(data)?{'x-total-count':String(u.pathname.endsWith('/viewers')?(presenceTotal??children.filter(c=>c.options&&c.signalCode===null).reduce((n,c)=>n+c.options.n,0)):data.length)}:{}),json:async()=>data};
 };
 return {fetch,spawn,fork,env:{BENCHMARK_USERNAME:'test',BENCHMARK_PASSWORD:'test'},children,requests,streams};
}
async function execute(t,options={},overrides={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const deps=rig(options),c={...config([],{}),output:path.join(dir,'result.json'),stages:[{viewers:1,seconds:.03}],warmup:0,publisherWarmup:.001,pollMs:1,timeoutMs:100,minMbps:0,latencyMs:1000,slowViewers:0,...overrides};
 await run(c,deps);process.exitCode=0;
 return {...deps,report:JSON.parse(fs.readFileSync(c.output))};
}
test('controller performs stages, owns cleanup and persists successful final evidence',async t=>{
 const r=await execute(t,{}, {churn:1,slowViewers:1,slowSeconds:.03,presenceMs:1});
 assert.equal(r.report.passed,true);assert.equal(r.report.stages.length,2);assert.equal(r.report.stages[1].kind,'slow-reader');assert.equal(r.report.stages[1].slowAssessment.evictionObserved,true);
 assert.equal(r.report.cleanup.channelRemoved,true);assert.equal(r.report.ownedFixture.channelName,r.report.channel.channelName);assert.equal(r.streams.length,0);assert.ok(r.children.every(c=>c.signalCode==='SIGTERM'));
 assert.ok(r.requests.some(([route])=>route==='/api/streams/owned/viewers'));
});
test('RSS harness safety stop never spawns load and is distinct from server crash',async t=>{
 const r=await execute(t,{highRss:true});assert.equal(r.report.stopReason,'HARNESS_SAFETY_STOP');assert.equal(r.children.length,0);assert.equal(r.report.passed,false);
});
test('failed committed creation recovers exact owned fixture and still fails run',async t=>{
 const r=await execute(t,{createFailure:true});assert.equal(r.report.passed,false);assert.equal(r.report.cleanup.channelRemoved,true);assert.equal(r.streams.length,0);
});
test('ramp safety failure retains the started incomplete stage checkpoint',async t=>{
 const r=await execute(t,{rampSafety:true});assert.equal(r.report.stopReason,'HARNESS_SAFETY_STOP');assert.equal(r.report.stages.length,1);
 assert.equal(r.report.stages[0].complete,false);assert.equal(r.report.stages[0].requested,1);assert.equal(r.report.cleanup.channelRemoved,true);
});
test('signal interruption cleans exact spawned processes and fixture',async t=>{
 const r=await execute(t,{signal:true});assert.equal(r.report.stopReason,'SIGNAL');assert.equal(r.report.passed,false);
 assert.equal(r.report.cleanup.channelRemoved,true);assert.ok(r.children.every(c=>c.signalCode==='SIGTERM'));
});
test('probe error checkpoints incomplete stage and cleanup failure cannot pass',async t=>{
 const r=await execute(t,{probeFailure:true});assert.equal(r.report.passed,false);assert.equal(r.report.stages[0].complete,false);assert.equal(r.report.stages[0].api.errors,1);assert.equal(r.report.cleanup.channelRemoved,true);
 const failed=await execute(t,{cleanupFailure:true});assert.equal(failed.report.passed,false);assert.match(failed.report.cleanup.error,/cleanup failed/);
});
test('output refuses repository paths, existing files and relative paths',()=>{
 assert.throws(()=>prepareOutput('relative.json'));
 assert.throws(()=>prepareOutput(path.join(__dirname,'forbidden.json')));
 assert.throws(()=>prepareOutput(__filename));
});

test('invalid target secrets never reach any persisted checkpoint',async t=>{
 const r=await execute(t,{}, {api:'http://user:UNIQUE_SECRET@127.0.0.1?token=OTHER_SECRET'});
 assert.equal(r.report.passed,false);assert.doesNotMatch(JSON.stringify(r.report),/UNIQUE_SECRET|OTHER_SECRET/);
});

test('measurement baseline waits for acknowledged exact membership',async t=>{
 const r=await execute(t,{lateReady:true});assert.equal(r.report.passed,true);
 assert.equal(r.report.stages[0].baselineSnapshots[0].clients[0].joined,true);
});

test('presence mismatch cannot pass despite healthy local sockets',async t=>{
 const r=await execute(t,{presenceTotal:0},{presenceMs:1});assert.equal(r.report.passed,false);assert.match(r.report.error,/Presence/);
});

test('pre-retirement churn failures remain fatal',async t=>{
 const r=await execute(t,{retiredFailure:true},{churn:1});assert.equal(r.report.passed,false);assert.match(r.report.error,/retired/i);
});
test('slow membership loss is not treated as expected media eviction',async t=>{
 const r=await execute(t,{slowJoinFailure:true},{slowViewers:1,slowSeconds:.03});assert.equal(r.report.passed,false);assert.match(r.report.error,/slow.*membership/i);
});

test('outstanding final chat acknowledgement cannot pass',async t=>{
 const r=await execute(t,{pendingChat:true},{chatMs:1});assert.equal(r.report.passed,false);assert.match(r.report.error,/Chat/);
});

test('cleanup cannot hang on response JSON that ignores abort', {timeout:1000},async t=>{
 const r=await execute(t,{stalledCleanup:true},{timeoutMs:10,cleanupMs:30});assert.equal(r.report.passed,false);assert.equal(r.report.cleanup.channelRemoved,false);
});
test('stale backend sample stops before spawning',async t=>{
 const r=await execute(t,{staleTelemetry:true});assert.equal(r.report.passed,false);assert.match(r.report.error,/telemetry/i);assert.equal(r.children.length,0);
});
test('readiness deadline fails rather than measuring missing membership',async t=>{
 const r=await execute(t,{neverReady:true},{readinessMs:5});assert.equal(r.report.passed,false);assert.match(r.report.error,/readiness/);
});
test('invalid presence totals fail closed',async t=>{
 for(const presenceTotal of ['bad',-1,0.5,'','1e0']){const r=await execute(t,{presenceTotal},{presenceMs:1});assert.equal(r.report.passed,false);}
});
test('IPC delivery delay does not become the worker bitrate denominator',async t=>{
 const r=await execute(t,{snapshotDelay:true});const s=r.report.stages[0];assert.equal(r.report.passed,true);
 assert.equal(s.workerSeconds[0],(s.workerSnapshots[0].at-s.baselineSnapshots[0].at)/1000);
 assert.equal(s.minMbps,s.viewers[0].bytesDelta*8/s.workerSeconds[0]/1e6);
});

test('request deadline bounds a stalled body as well as response headers',{timeout:500},async t=>{
 const r=await execute(t,{stalledProbe:true},{timeoutMs:10});assert.equal(r.report.passed,false);assert.equal(r.report.stages[0].api.timeouts,1);
});

test('overall cleanup budget includes uncertain-create recovery wait',async t=>{
 const start=performance.now();const r=await execute(t,{createFailure:true},{timeoutMs:1000,cleanupMs:10});
 assert.ok(performance.now()-start<500);assert.equal(r.report.passed,false);assert.ok(r.report.cleanup.error);
});

test('cleanup wrapper deadline aborts the DELETE body before disarming cleanup and returning',{timeout:1000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const deps=rig({signal:true}),fetch=deps.fetch,active=new Set(),setTimer=global.setTimeout,clearTimer=global.clearTimeout;
 let deleteSignal,cleanupTimer,cleanupTimerFired=false,abortedWhenDisarmed=false;
 t.mock.method(global,'setTimeout',(fn,ms,...args)=>{
  // Force the remaining-budget wrapper to win, independently of timer rounding/scheduling.
  if(ms===20){cleanupTimer=setTimer(()=>{cleanupTimerFired=true;fn(...args);},1000);return cleanupTimer;}
  const timer=setTimer(fn,ms,...args);if(ms>=60000)active.add(timer);return timer;
 });
 t.mock.method(global,'clearTimeout',timer=>{
  if(timer===cleanupTimer)abortedWhenDisarmed=deleteSignal?.aborted===true;
  active.delete(timer);return clearTimer(timer);
 });
 t.after(()=>{clearTimer(cleanupTimer);for(const timer of active)clearTimer(timer);process.exitCode=0;});
 deps.fetch=async(url,options)=>{
  if(new URL(url).pathname==='/api/streams/owned'&&options.method==='DELETE'){
   deleteSignal=options.signal;assert.equal(deleteSignal.aborted,false,'main-run cancellation must not cancel independent cleanup');
   return {ok:true,status:200,headers:new Headers(),json:()=>new Promise(()=>{})};
  }
  return fetch(url,options);
 };
 const c={...config([],{}),output:path.join(dir,'result.json'),timeoutMs:60000,cleanupMs:20,publisherWarmup:.001,pollMs:1};
 await run(c,deps);process.exitCode=0;
 const report=JSON.parse(fs.readFileSync(c.output));
 assert.equal(report.stopReason,'SIGNAL');assert.equal(report.passed,false);assert.equal(report.cleanup.channelRemoved,false);
 assert.match(report.cleanup.error,/deadline/i);assert.equal(cleanupTimerFired,false,'wrapper deadline must win the race');
 assert.ok(deleteSignal,'cleanup must reach the hanging DELETE body');
 assert.equal(deleteSignal.aborted,true,'underlying DELETE must be aborted before run returns');
 assert.equal(abortedWhenDisarmed,true,'abort outstanding cleanup before clearing its deadline');
 assert.equal(active.size,0,'no referenced 60-second request or bounded timers may survive run');
});

test('pagination deadline cancels the original body and request timers before independent cleanup',{timeout:1000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const deps=rig(),fetch=deps.fetch,active=new Set(),setTimer=global.setTimeout,clearTimer=global.clearTimeout;
 let originalSignal,abortedBeforeCleanup=false,cleanupSignal;
 t.mock.method(global,'setTimeout',(fn,ms,...args)=>{const timer=setTimer(fn,ms,...args);if(ms>=60000)active.add(timer);return timer;});
 t.mock.method(global,'clearTimeout',timer=>{active.delete(timer);return clearTimer(timer);});
 t.after(()=>{for(const timer of active)clearTimer(timer);});
 deps.fetch=async(url,options)=>{
  if(new URL(url).pathname==='/api/streams'&&options.method==='GET'){
   if(!originalSignal){originalSignal=options.signal;return {ok:true,status:200,headers:new Headers(),json:()=>new Promise(()=>{})};}
   if(!cleanupSignal){abortedBeforeCleanup=originalSignal.aborted;cleanupSignal=options.signal;assert.equal(cleanupSignal.aborted,false);}
  }
  return fetch(url,options);
 };
 const c={...config([],{}),output:path.join(dir,'result.json'),timeoutMs:60000,operationMs:10,cleanupMs:20};
 await run(c,deps);process.exitCode=0;
 const report=JSON.parse(fs.readFileSync(c.output));
 assert.equal(report.passed,false);assert.match(report.error,/deadline/i);
 assert.equal(report.cleanup.channelRemoved,true);assert.equal(deps.streams.length,0);assert.equal(deps.children.length,0);
 assert.equal(abortedBeforeCleanup,true,'original body must be aborted before cleanup starts');
 assert.notEqual(cleanupSignal,originalSignal);
 assert.equal(active.size,0,'no 60-second request or bounded timer may remain');
});
