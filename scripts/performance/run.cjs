#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {parseArgs}=require('node:util');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {setTimeout:sleep}=require('node:timers/promises');
const {batches,parseStages,validateTarget,checkRss,checkFreshness,bounded}=require('./control.cjs');
const {summarizeApi,summarizeWorkers,qualityFailures,cpuPercent,slowEvidence}=require('./core.cjs');
const {saveEvidence}=require('./evidence.cjs');
const {listAll,cleanupFixture}=require('./fixture.cjs');
const root=path.resolve(__dirname,'../..');
function config(args=process.argv.slice(2),env=process.env){
 const names=['api','media','rtmp','stages','warmup','publisher-warmup','ramp-ms','poll-ms','timeout-ms','rss-mib','latency-ms','min-mbps','output','slow-viewers','slow-seconds','churn','chat-ms','presence-ms','readiness-ms','telemetry-max-age-ms','operation-ms','cleanup-ms'];
 const options=Object.fromEntries(names.map(k=>[k,{type:'string'}]));
 options['allow-lan']={type:'boolean',default:false};options.help={type:'boolean',default:false};
 const {values}=parseArgs({options,args});
 if(values.help){console.log('LAN/loopback benchmark. Read scripts/performance/README.md.\nRequired: --output /absolute/path/outside/repo.json\nOptions: '+names.map(n=>'--'+n).join(' ')+ ' --allow-lan\nCredentials: BENCHMARK_ADMIN_FILE or BENCHMARK_USERNAME/BENCHMARK_PASSWORD');return null;}
 const get=(key,fallback)=>values[key]??env['BENCHMARK_'+key.toUpperCase().replaceAll('-','_')]??fallback;
 const number=(key,fallback,zero=false)=>{const n=Number(get(key,fallback));if(!Number.isFinite(n)||(zero?n<0:n<=0))throw Error('Invalid --'+key);return n;};
 const count=(key,fallback)=>{const n=number(key,fallback,true);if(!Number.isSafeInteger(n))throw Error('Invalid --'+key);return n;};
 const slowSeconds=number('slow-seconds',60);if(slowSeconds<30)throw Error('--slow-seconds must be at least 30 to pressure socket buffers');
 return {slowViewers:count('slow-viewers',10),slowSeconds,churn:count('churn',0),chatMs:number('chat-ms',0,true),presenceMs:number('presence-ms',0,true),api:get('api','http://127.0.0.1:3000'),media:get('media','http://127.0.0.1:8000'),rtmp:get('rtmp','rtmp://127.0.0.1:1935'),
 stages:parseStages(get('stages','1:15,100:30,250:30,500:30')),warmup:number('warmup',5,true),publisherWarmup:number('publisher-warmup',6),
 operationMs:number('operation-ms',30000),cleanupMs:number('cleanup-ms',30000),telemetryMaxAgeMs:number('telemetry-max-age-ms',10000),readinessMs:number('readiness-ms',15000),rampMs:number('ramp-ms',25,true),pollMs:number('poll-ms',1000),timeoutMs:number('timeout-ms',3000),
 rssMiB:number('rss-mib',1200),latencyMs:number('latency-ms',500),minMbps:number('min-mbps',3.6,true),
 output:get('output',null),allowLan:values['allow-lan']};
}
function prepareOutput(filename){
 if(!filename||!path.isAbsolute(filename))throw Error('--output requires an absolute path outside the repository');
 const directory=fs.realpathSync(path.dirname(filename));
 const target=path.join(directory,path.basename(filename));
 const relative=path.relative(fs.realpathSync(root),target);
 if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('Evidence must be outside the repository');
 const fd=fs.openSync(target,'wx',0o600);fs.closeSync(fd);return target;
}
const {ask,stopChild}=require('./lifecycle.cjs');
async function run(c,dependencies={}){
 const fetch=dependencies.fetch||globalThis.fetch,spawn=dependencies.spawn||require('node:child_process').spawn,fork=dependencies.fork||require('node:child_process').fork,env=dependencies.env||process.env;
 const output=prepareOutput(c.output);
 const report={version:1,started:new Date().toISOString(),configuration:{},
 method:'Static black 720p30 H264 4Mbps CBR target + AAC 128kbps; HTTP-FLV plus WebSocket-only Socket.IO. No browser decoding or WAN test.',
 stages:[],metrics:[],cleanup:{},passed:false};
 const save=()=>saveEvidence(output,report);
 let token,channel,publisher,publisherError=false,workers=[],interrupted=null,creating=false;
 const channelName='benchmark_'+Date.now()+'_'+randomUUID().replaceAll('-','');
 const aborter=new AbortController();
 const signalHandler=signal=>{interrupted=signal;aborter.abort();};
 const onInt=()=>signalHandler('SIGINT'),onTerm=()=>signalHandler('SIGTERM');
 process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
 const check=()=>{if(interrupted)throw Error('Interrupted by '+interrupted);if(publisher&&(publisherError||publisher.exitCode!==null||publisher.signalCode!==null))throw Error('Publisher exited');};
 const pause=async ms=>{check();try{await sleep(ms,null,{signal:aborter.signal});}catch{check();throw Error('Sleep aborted');}check();};
 async function request(route,{method='GET',body,cleanup=false,signal}={}){
  const start=performance.now();let timeout=false;
  const controller=new AbortController();const timer=setTimeout(()=>{timeout=true;controller.abort();},c.timeoutMs);
  const parentSignal=signal||(!cleanup?aborter.signal:null);
  const abort=()=>controller.abort();parentSignal?.addEventListener('abort',abort,{once:true});
  try{
   if(parentSignal?.aborted)controller.abort();
   return await bounded(async()=>{
   const response=await fetch(c.api+route,{method,redirect:'error',signal:controller.signal,
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
   const data=await response.json();
   if(!response.ok)return {ok:false,status:response.status,timeout:false};
   return {ok:true,status:response.status,data,total:/^\d+$/.test(response.headers.get('x-total-count')||'')?Number(response.headers.get('x-total-count')):null,ms:performance.now()-start,timeout:false};
   },{timeoutMs:c.timeoutMs+1,signal:controller.signal});
  }catch{return {ok:false,timeout};}
  finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);}
 }
 async function required(route,options){const r=await request(route,options);if(!r.ok)throw Error(`API ${options?.method||'GET'} ${route.split('?')[0]} failed (${r.timeout?'timeout':r.status||'network/JSON error'})`);return r.data;}
 const freshness={};
 async function metrics(phase){
  const data=await required('/api/metrics');
  const sample={at:new Date().toISOString(),phase,data};report.metrics.push(sample);save();
  checkFreshness(data,c.telemetryMaxAgeMs,freshness);sample.rssMiB=checkRss(data,c.rssMiB);return data;
 }
 async function stopWorkers(graceMs=2000,killMs=2000){
  const current=workers;workers=[];const outcomes=await Promise.allSettled(current.map(w=>stopChild(w,graceMs,killMs)));
  workers=current.filter((_,i)=>outcomes[i].status==='rejected');
  const failed=workers.map(w=>w.pid);
  if(failed.length){report.cleanup.unstoppedWorkerPids=failed;throw Error('Worker cleanup failed');}
 }
 let hz;
 const publisherCpu=()=>{try{const fields=fs.readFileSync(`/proc/${publisher.pid}/stat`,'utf8').split(') ')[1].split(' ');return (Number(fields[11])+Number(fields[12]))/hz;}catch{return null;}};
 try{
  save();hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
  const targetOptions={timeoutMs:c.timeoutMs,signal:aborter.signal};
  c.api=await validateTarget(c.api,c.allowLan,dependencies.resolver,undefined,targetOptions);c.media=await validateTarget(c.media,c.allowLan,dependencies.resolver,undefined,targetOptions);c.rtmp=await validateTarget(c.rtmp,c.allowLan,dependencies.resolver,['rtmp:','rtmps:'],targetOptions);
  report.configuration={...c,output};
  let credentials;
  if(env.BENCHMARK_ADMIN_FILE){try{credentials=JSON.parse(fs.readFileSync(env.BENCHMARK_ADMIN_FILE,'utf8'));}catch{throw Error('Unable to read/parse ADMIN credential file');}}
  else credentials={username:env.BENCHMARK_USERNAME||env.BENCHMARK_ADMIN_USERNAME,password:env.BENCHMARK_PASSWORD||env.BENCHMARK_ADMIN_PASSWORD};
  if(typeof credentials.username!=='string'||!credentials.username||typeof credentials.password!=='string'||!credentials.password)throw Error('Supply ADMIN credentials via BENCHMARK_ADMIN_FILE or BENCHMARK_USERNAME/BENCHMARK_PASSWORD');
  const login=await required('/api/login',{method:'POST',body:{username:credentials.username,password:credentials.password}});
  credentials=null;
  if(!login.roles?.includes('ADMIN')||typeof login.token!=='string')throw Error('An ADMIN login is required');token=login.token;
  await metrics('baseline');
  report.ownedFixture={channelName};save();
  creating=true;
  channel=await required('/api/streams',{method:'POST',body:{channelName,isPasswordProtected:false,password:null,isRecordingEnabled:false,restreamUrls:{}}});
  if(!channel.id||channel.channelName!==channelName||!channel.streamKey)throw Error('Unexpected stream creation response');
  report.channel={id:channel.id,channelName};save();
  const listed=await listAll(request,'/api/streams',{timeoutMs:c.operationMs,signal:aborter.signal});
  if(!Array.isArray(listed)||!listed.some(s=>s.id===channel.id&&s.channelName===channelName))throw Error('Created stream read-back failed');
  publisher=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-re','-f','lavfi','-i','color=c=black:s=1280x720:r=30',
   '-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','2',
   '-pix_fmt','yuv420p','-b:v','4M','-minrate','4M','-maxrate','4M','-bufsize','8M','-x264-params','nal-hrd=cbr:force-cfr=1',
   '-g','60','-c:a','aac','-b:a','128k','-f','flv',`${c.rtmp}/live/${encodeURIComponent(channelName)}?key=${encodeURIComponent(channel.streamKey)}`],{stdio:'ignore',env:{PATH:process.env.PATH}});
  publisher.on('error',()=>{publisherError=true;});
  report.publisherPid=publisher.pid;
  for(let elapsed=0;elapsed<c.publisherWarmup*1000;elapsed+=c.pollMs){await metrics('publisher-warmup');await pause(Math.min(c.pollMs,c.publisherWarmup*1000-elapsed));}
  const stages=[...c.stages.map(s=>({...s,kind:'normal'})),...(c.slowViewers?[{viewers:1,slow:c.slowViewers,seconds:c.slowSeconds,kind:'slow-reader'}]:[])];
  for(const stage of stages){
   check();await stopWorkers();
   const row={kind:stage.kind,requested:stage.viewers,requestedTotal:stage.viewers+(stage.slow||0),slowRequested:stage.slow||0,churn:[],presenceSamples:[],workers:0,apiSamples:[],complete:false};report.stages.push(row);save();
   const metricStart=report.metrics.length;const baseline=await metrics('stage-baseline');
   // Fresh batches allow descending stages and avoid overshooting non-multiples of 250.
   const pending=[];
   const specifications=[...batches(stage.viewers).map(n=>({n,slow:false})),...(stage.slow?batches(stage.slow).map(n=>({n,slow:true})):[])];
   for(const {n,slow} of specifications){
    const worker=fork(path.join(__dirname,'worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV||'production'}});
    worker.on('error',()=>{});workers.push(worker);
    pending.push(ask(worker,{type:'start',n,slow,chatMs:c.chatMs,channel:channelName,api:c.api,media:c.media,rampMs:c.rampMs,timeoutMs:c.timeoutMs},Math.ceil(n*c.rampMs+c.timeoutMs+15000)));
   }
   // Poll safety while workers ramp, not just during steady-state measurement.
   let ready=false,startError;
   const ramp=Promise.all(pending).then(()=>{ready=true;},e=>{startError=e;ready=true;});
   while(!ready){await metrics('ramp');await pause(c.pollMs);}await ramp;if(startError)throw startError;
   for(let elapsed=0;elapsed<c.warmup*1000;elapsed+=c.pollMs){await metrics('viewer-warmup');await pause(Math.min(c.pollMs,c.warmup*1000-elapsed));}
   const churnEvidence=[];
   if(c.churn&&stage.kind==='normal'){
    let remaining=Math.min(c.churn,stage.viewers);
    for(let i=0;i<workers.length&&remaining;i++){
     const n=Math.min(remaining,specifications[i].n);remaining-=n;
     let done=false,failure,result;
     const operation=ask(workers[i],{type:'churn',n},n*c.rampMs+c.timeoutMs+15000).then(r=>{result=r;done=true;},e=>{failure=e;done=true;});
     while(!done){await metrics('churn');await pause(c.pollMs);}await operation;if(failure)throw failure;
     churnEvidence.push(result);
    }
    for(let elapsed=0;elapsed<c.warmup*1000;elapsed+=c.pollMs){await metrics('churn-warmup');await pause(Math.min(c.pollMs,c.warmup*1000-elapsed));}
   }
   let before;const readinessEnd=performance.now()+c.readinessMs;
   for(;;){
    check();before=await Promise.all(workers.map(w=>ask(w,{type:'snapshot',reset:true},c.timeoutMs)));
    row.baselineSnapshots=before;save();
    if(before.every((w,i)=>w.clients.length===specifications[i].n&&w.clients.every(v=>v.socket&&v.joined===true&&!v.errors&&v.status===200&&(v.slow?v.transportPaused:!v.closed&&v.bytes>0))))break;
    if(performance.now()>=readinessEnd)throw Error('Exact healthy viewer readiness deadline exceeded');
    await metrics('readiness');await pause(Math.min(c.pollMs,Math.max(0,readinessEnd-performance.now())));
   }
   const cpuBefore=process.cpuUsage(),ffBefore=publisherCpu(),start=performance.now(),apiSamples=[];
   Object.assign(row,{churn:churnEvidence,workers:workers.length,apiSamples});save();
   let stageError,lastPresence=0;
   try{while(performance.now()-start<stage.seconds*1000){
    check();const sample=await request('/api/public/streams/'+encodeURIComponent(channelName));
    // Intentionally discard public API body. Only successful requests have latency.
    apiSamples.push({at:new Date().toISOString(),ok:sample.ok,timeout:sample.timeout,status:sample.status,...(sample.ok?{ms:sample.ms}:{})});
    row.api=summarizeApi(apiSamples);
    if(!sample.ok)throw Error('API probe failed');
    if(sample.ms>c.latencyMs)throw Error('API latency safety limit exceeded');
    if(c.presenceMs&&performance.now()-lastPresence>=c.presenceMs){
     const presence=await request('/api/streams/'+encodeURIComponent(channel.id)+'/viewers?skip=0&take=1');
     row.presenceSamples.push({at:new Date().toISOString(),ok:presence.ok,total:presence.total,ms:presence.ms});lastPresence=performance.now();
     if(!presence.ok||!Number.isSafeInteger(presence.total)||presence.total!==row.requestedTotal)throw Error('Presence total mismatch or probe failed');
    }
    await metrics(stage.kind);await pause(Math.min(c.pollMs,Math.max(0,stage.seconds*1000-(performance.now()-start))));
   }}catch(error){stageError=error;row.error=error.message;}
   const after=await Promise.all(workers.map(w=>ask(w,{type:'settle'},c.timeoutMs+1000)));
   const seconds=(performance.now()-start)/1000,cpu=process.cpuUsage(cpuBefore),ffAfter=publisherCpu();
   Object.assign(row,{seconds,...summarizeWorkers(before,after),api:summarizeApi(apiSamples),
    generatorCpuPercentOneCore:{controller:cpuPercent({user:0,system:0},cpu,seconds),publisher:ffAfter!==null&&ffBefore!==null?(ffAfter-ffBefore)/seconds*100:null,
     workers:summarizeWorkers(before,after).workerCpu},complete:!stageError});
   row.slowViewers=after.flatMap(w=>w.clients).filter(v=>v.slow);
   row.workerSnapshots=after;
   row.failures=qualityFailures(row,c);
   if(row.slowViewers.some(v=>!v.socket||v.joined!==true||v.socketErrors||v.errors>(v.mediaErrors||0)))row.failures.push('Slow viewer membership failure');
   if(after.flatMap(w=>w.retired||[]).some(v=>v.errors||v.closed||v.status!==200||!v.bytes||!v.socket||v.joined!==true))row.failures.push('Retired viewer failure before intentional disposal');
   if(stage.slow){
    row.slowAssessment=slowEvidence(baseline.media?.mediaSafety,report.metrics.slice(metricStart).map(m=>m.data.media?.mediaSafety||{}));
    if(!row.slowAssessment.evictionObserved)row.failures.push('Slow-reader pressure inconclusive: no new slowDisconnects; increase --slow-seconds and inspect mediaSafety');
   }
   if(row.slowViewers.length!==row.slowRequested||row.slowViewers.some(v=>v.status!==200||!v.transportPaused||v.pausedMs<stage.seconds*1000))row.failures.push('Slow-reader transport pause not established for full measurement');
   if(after.some(w=>!w.chat||w.chat.errors||w.chat.sent!==w.chat.accepted+w.chat.errors||(c.chatMs&&!w.chat.accepted)))row.failures.push('Chat acknowledgement errors');
   save();
   if(stageError)throw stageError;
   if(row.failures.length)throw Error('Stage quality thresholds failed: '+row.failures.join('; '));
   console.log(JSON.stringify({viewers:stage.viewers,healthy:row.healthy,minMbps:row.minMbps,apiP95Ms:row.api.latencyMs.p95}));
  }
  report.passed=true;
 }catch(error){report.error=error.message;report.stopReason=error.code|| (interrupted?'SIGNAL':'HARNESS_ERROR');report.passed=false;}
 finally{
  aborter.abort();
  const cleanupAborter=new AbortController(),cleanupDeadline=performance.now()+c.cleanupMs;
  const cleanupTimer=setTimeout(()=>cleanupAborter.abort(),c.cleanupMs);
  const childGrace=Math.min(2000,c.cleanupMs/2),childKill=Math.min(2000,c.cleanupMs/2);
  await Promise.all([
   (async()=>{try{await stopWorkers(childGrace,childKill);report.cleanup.workersStopped=true;}catch{report.cleanup.workersStopped=false;report.passed=false;}})(),
   (async()=>{try{await stopChild(publisher,childGrace,childKill);report.cleanup.publisherStopped=true;}catch{report.cleanup.publisherStopped=false;report.passed=false;}})()
  ]);
  // A timed-out POST may still have committed. Recover only our exact UUID name.
  if(token&&creating){
   try{
    if(!channel)await sleep(c.timeoutMs,null,{signal:cleanupAborter.signal}); // Allow an aborted creation to finish before exact-name recovery.
    Object.assign(report.cleanup,await cleanupFixture(request,channelName,channel?.id,{deadline:cleanupDeadline,signal:cleanupAborter.signal,progress:report.cleanup}));
   }catch(error){report.cleanup.error=error.message;report.cleanup.channelName=channelName;report.passed=false;}
  }
  // A fixture wrapper can expire before this controller timer; cancel its underlying request too.
  cleanupAborter.abort();
  clearTimeout(cleanupTimer);
  if(interrupted)report.passed=false;
  report.ended=new Date().toISOString();
  try{save();}finally{process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);}
  process.exitCode=interrupted==='SIGINT'?130:interrupted==='SIGTERM'?143:report.passed?0:1;
  console.log(JSON.stringify({passed:report.passed,error:report.error,cleanup:report.cleanup,output}));
 }
}
module.exports={config,prepareOutput,run};
if(require.main===module){Promise.resolve().then(()=>{const c=config();if(c)return run(c);}).catch(()=>{console.error('Benchmark setup/evidence write failed. Check options, output directory, and README.');process.exitCode=1;});}
