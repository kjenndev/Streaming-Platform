'use strict';
function quantile(values,p){
 if(!values.length)return null;
 const a=[...values].sort((a,b)=>a-b);
 return a[Math.max(0,Math.ceil(a.length*p)-1)];
}
function summarizeApi(samples){
 const good=samples.filter(s=>s.ok&&!s.timeout&&Number.isFinite(s.ms));
 const values=good.map(s=>s.ms);
 return {requests:samples.length,successes:good.length,errors:samples.length-good.length,
 timeouts:samples.filter(s=>s.timeout).length,
 latencyMs:{p50:quantile(values,.5),p95:quantile(values,.95),max:values.length?Math.max(...values):null}};
}
function summarizeViewers(before,after,seconds){
 if(!(seconds>0))throw Error('Measurement duration must be positive');
 const prior=new Map(before.map(v=>[v.id,v]));
 const viewers=after.map(v=>{
  const b=prior.get(v.id); if(!b)throw Error('Viewer baseline missing');
  const bytes=Math.max(0,v.bytes-b.bytes);
  const media=v.status===200&&!v.closed&&bytes>0;
  return {...v,bytesDelta:bytes,mbps:bytes*8/seconds/1e6,media,healthy:media&&!!v.socket&&v.joined===true};
 });
 return {viewers,healthy:viewers.filter(v=>v.healthy).length,mediaConnections:viewers.filter(v=>v.media).length,
 socketConnections:viewers.filter(v=>v.socket).length,errors:viewers.reduce((n,v)=>n+v.errors,0),
 minMbps:viewers.length?Math.min(...viewers.map(v=>v.mbps)):0,
 aggregateMbps:viewers.reduce((n,v)=>n+v.mbps,0)};
}
function qualityFailures(row,limits){
 const failures=[];
 if(row.healthy!==row.requested)failures.push('Unhealthy or missing viewers');
 if(row.errors)failures.push('Viewer errors');
 if(row.api.errors||!row.api.successes)failures.push('API errors or no successful samples');
 if(row.api.latencyMs.p95>limits.latencyMs)failures.push('API latency limit');
 if(row.minMbps<limits.minMbps)failures.push('Viewer bitrate below minimum');
 return failures;
}
function cpuPercent(before,after,seconds){
 if(!(seconds>0))throw Error('CPU sample duration must be positive');
 return Math.max(0,after.user+after.system-before.user-before.system)/1e6/seconds*100;
}
function slowEvidence(before,samples){
 const last=samples.at(-1)||{};
 const delta=Number.isFinite(before?.slowDisconnects)&&Number.isFinite(last.slowDisconnects)?last.slowDisconnects-before.slowDisconnects:null;
 const queues=samples.flatMap(s=>[s.currentQueuedBytes,s.queuedBytes]).filter(Number.isFinite);
 return {slowDisconnectsDelta:delta,evictionObserved:delta!==null&&delta>0,maxObservedQueuedBytes:queues.length?Math.max(...queues):null,
  note:'Global server counters; kernel buffers not measured. Use isolated server for attribution.'};
}
module.exports={quantile,summarizeApi,summarizeViewers,qualityFailures,cpuPercent,slowEvidence};

function summarizeWorkers(before,after){
 if(before.length!==after.length)throw Error('Worker baseline missing');
 const summaries=after.map((w,i)=>{
  const seconds=(w.at-before[i].at)/1000;
  if(!Number.isFinite(seconds)||seconds<=0)throw Error('Invalid worker interval');
  return {...summarizeViewers(before[i].clients.filter(v=>!v.slow),w.clients.filter(v=>!v.slow),seconds),cpu:cpuPercent(before[i].cpu,w.cpu,seconds),seconds};
 });
 const viewers=summaries.flatMap(s=>s.viewers);
 return {viewers,healthy:viewers.filter(v=>v.healthy).length,mediaConnections:viewers.filter(v=>v.media).length,socketConnections:viewers.filter(v=>v.socket).length,errors:viewers.reduce((n,v)=>n+v.errors,0),minMbps:viewers.length?Math.min(...viewers.map(v=>v.mbps)):0,aggregateMbps:viewers.reduce((n,v)=>n+v.mbps,0),workerCpu:summaries.map(s=>s.cpu),workerSeconds:summaries.map(s=>s.seconds)};
}
module.exports.summarizeWorkers=summarizeWorkers;
