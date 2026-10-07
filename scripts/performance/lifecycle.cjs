'use strict';
const {randomUUID}=require('node:crypto');
function ask(worker,message,timeoutMs){
 return new Promise((resolve,reject)=>{
  const requestId=randomUUID();let done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);worker.off('message',onMessage);worker.off('exit',onExit);error?reject(error):resolve(result);};
  const onMessage=m=>{if(m.requestId===requestId)finish(m.error?Error(m.error):null,m);};
  const onExit=()=>finish(Error('Viewer worker exited'));
  const timer=setTimeout(()=>finish(Error('Viewer worker response timeout')),timeoutMs);
  worker.on('message',onMessage);worker.once('exit',onExit);
  try{worker.send({...message,requestId},error=>{if(error)finish(Error('Viewer worker IPC failed'));});}
  catch{finish(Error('Viewer worker IPC failed'));}
 });
}
async function stopChild(child,graceMs=2000,killMs=2000){
 if(!child||child.exitCode!==null||child.signalCode!==null)return;
 await new Promise((resolve,reject)=>{
  let timer,killTimer;
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);child.off('exit',done);child.off('error',failed);};
  const done=()=>{cleanup();resolve();};
  const failed=()=>{cleanup();reject(Error('Child cleanup failed'));};
  child.once('exit',done);child.once('error',failed);
  timer=setTimeout(()=>{
   child.kill('SIGKILL');killTimer=setTimeout(failed,killMs);
  },graceMs);
  child.kill('SIGTERM');
 });
}
module.exports={ask,stopChild};
