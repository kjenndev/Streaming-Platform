const {spawn}=require('child_process');
const {monitorEventLoopDelay,performance}=require('perf_hooks');
class ManagedProcesses {
 constructor(){this.children=new Set();this.stopping=false;}
 get size(){return this.children.size;}
 run(command,args){
  if(this.stopping) throw new Error('Process manager is stopping');
  const child=spawn(command,args,{stdio:['ignore','ignore','pipe']});
  child.stderrTail='';this.children.add(child);
  child.stderr.on('data',data=>{child.stderrTail=(child.stderrTail+data.toString()).slice(-4096);});
  child.done=new Promise((resolve,reject)=>{
   child.once('error',error=>{this.children.delete(child);reject(error);});child.once('close',code=>{this.children.delete(child);resolve(code);});
  });
  // Attach immediately: consumers can await later without unhandled rejections.
  child.done.catch(()=>{});return child;
 }
 async stop(graceMs=5000){
  this.stopping=true;const children=[...this.children];
  for(const child of children) child.kill('SIGTERM');
  const timer=setTimeout(()=>{for(const child of children) if(child.exitCode===null) child.kill('SIGKILL');},graceMs);
  try {await Promise.allSettled(children.map(c=>c.done));} finally {clearTimeout(timer);}
 }
}
function processTelemetry(){
 const delay=monitorEventLoopDelay({resolution:20});delay.enable();
 let sampleSequence=0;
 let cpu=process.cpuUsage(),time=performance.now(),elu=performance.eventLoopUtilization();
 return {sample(){
  const now=performance.now(),usage=process.cpuUsage(),nextElu=performance.eventLoopUtilization();
  const result={pid:process.pid,sampledAt:Date.now(),sampleSequence:++sampleSequence,cpuPercent:Math.max(0,((usage.user-cpu.user)+(usage.system-cpu.system))/((now-time)*1000)*100),memory:process.memoryUsage(),eventLoop:{p99Ms:delay.percentile(99)/1e6,maxMs:delay.max/1e6,utilization:performance.eventLoopUtilization(nextElu,elu).utilization}};
  cpu=usage;time=now;elu=nextElu;delay.reset();return result;
 },close(){delay.disable();}};
}
module.exports={ManagedProcesses,processTelemetry};
