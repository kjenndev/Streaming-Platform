'use strict';
const {setTimeout:sleep}=require('node:timers/promises');
class WorkerPool{
 constructor(deps){this.deps=deps;this.clients=[];this.retired=[];this.sequence=0;this.churned=0;this.stopped=false;this.pending=new Set();this.chatSettled=false;this.chatCounts={sent:0,accepted:0,errors:0};}
 create(){return this.deps.create({...this.options,id:`${process.pid}:${this.sequence++}`});}
 async start(options){
  if(this.options||!Number.isSafeInteger(options.n)||options.n<1||options.n>250)throw Error('Invalid worker start');
  this.options=options;
  for(let i=0;i<options.n&&!this.stopped;i++){this.clients.push(this.create());await sleep(options.rampMs);}
  if(options.chatMs)this.chatTimer=setInterval(()=>this.chat(),options.chatMs);
 }
 chat(){
  const c=this.clients.find(c=>c.socketClient.connected);if(!c||this.stopped||this.chatSettled)return;
  this.chatCounts.sent++;
  let done=false;
  const finish=(error,result)=>{if(done)return;done=true;this.pending.delete(finish);if(error||result?.ok!==true)this.chatCounts.errors++;else this.chatCounts.accepted++;};
  this.pending.add(finish);
  try{c.socketClient.timeout(this.options.timeoutMs).emit('send_message',{channelName:this.options.channel,message:'benchmark static test'},finish);}catch{finish(true);}

 }
 async settle(){
  this.chatSettled=true;clearInterval(this.chatTimer);
  const end=performance.now()+this.options.timeoutMs;
  while(this.pending.size&&performance.now()<end)await sleep(Math.min(10,Math.max(1,end-performance.now())));
  for(const finish of this.pending)finish(true);
 }
 async churn(n){
  if(!Number.isSafeInteger(n)||n<0||n>this.clients.length)throw Error('Invalid churn count');
  for(let i=0;i<n&&!this.stopped;i++){
   this.retired.push(this.deps.snapshot(this.clients[i]));this.deps.dispose(this.clients[i]);
   this.clients[i]=this.create();this.churned++;await sleep(this.options.rampMs);
  }
 }
 snapshot(reset=false){return {cpu:process.cpuUsage(),memory:process.memoryUsage(),at:performance.now(),clients:this.clients.map(c=>this.deps.snapshot(c,reset)),retired:this.retired,churned:this.churned,chat:{...this.chatCounts}};}
 stop(){if(this.stopped)return;this.stopped=true;clearInterval(this.chatTimer);for(const c of this.clients)this.deps.dispose(c);}
}
if(require.main===module){
 const http=require('node:http'),https=require('node:https');
 const {createRequire}=require('node:module'),path=require('node:path');
 const {io}=createRequire(path.resolve(__dirname,'../../apps/frontend/package.json'))('socket.io-client');
 const {createViewer,snapshot,dispose}=require('./viewer.cjs');
 const pool=new WorkerPool({create:options=>createViewer(options,{io,get:(url,...args)=>(url.startsWith('https:')?https:http).get(url,...args)}),snapshot,dispose});
 const close=()=>{pool.stop();process.exit(0);};
 process.on('disconnect',close);process.on('SIGINT',close);process.on('SIGTERM',close);
 process.on('message',async message=>{
  try{
   if(message.type==='start'){await pool.start(message);process.send?.({requestId:message.requestId,ready:true});}
   else if(message.type==='churn'){await pool.churn(message.n);process.send?.({requestId:message.requestId,...pool.snapshot()});}
   else if(message.type==='settle'){await pool.settle();process.send?.({requestId:message.requestId,...pool.snapshot()});}
   else if(message.type==='snapshot')process.send?.({requestId:message.requestId,...pool.snapshot(message.reset)});
   else if(message.type==='stop')close();
   else throw Error('Unknown worker operation');
  }catch{process.send?.({requestId:message.requestId,error:'Worker operation failed'});pool.stop();process.exitCode=1;process.disconnect();}
 });
}
module.exports={WorkerPool};
