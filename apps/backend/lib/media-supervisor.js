const {fork}=require('child_process');
const path=require('path');
function superviseMedia({env,onMessage,onUnavailable=()=>{}}){
 let child,stopping=false,restart,attempts=0,everReady=false,stopped;
 let readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 function launch(){
  try{child=fork(path.join(__dirname,'media-worker.js'),[],{detached:process.platform!=='win32',env:{...process.env,...env},stdio:['ignore','inherit','inherit','ipc']});}
  catch(error){readyReject(error);onUnavailable();return;}
  const launched=child;
  let finished=false,finishResolve;
  launched.finished=new Promise(resolve=>{finishResolve=resolve;});
  const timeout=setTimeout(()=>{launched.kill('SIGKILL');readyReject(new Error('Media startup timed out'));},15000);
  function finish(){
   if(finished)return;finished=true;
   clearTimeout(timeout);onUnavailable();finishResolve();
   // Only signal a real child process group, never the API group.
   if(process.platform!=='win32' && Number.isInteger(launched.pid) && launched.pid>0)try{process.kill(-launched.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error('[media] group cleanup failed:',error.code);}
   if(!everReady){readyReject(new Error('Media worker exited before readiness'));return;}
   if(!stopping){attempts++;restart=setTimeout(launch,Math.min(10000,500*2**Math.min(attempts,5)));}
  }
  launched.on('message',message=>{if(message.type==='ready'){everReady=true;clearTimeout(timeout);readyResolve();}onMessage(message);});
  launched.on('error',error=>{clearTimeout(timeout);readyReject(error);if(!launched.pid)finish();});
  launched.once('exit',finish);launched.once('close',finish);
 }
 launch();
 return {ready,get pid(){return child?.pid;},send(message){if(child?.connected)child.send(message,()=>{});},stop(){
  if(stopped)return stopped;
  stopping=true;clearTimeout(restart);
  stopped=(async()=>{
   const launched=child;
   if(!launched || launched.exitCode!==null || launched.signalCode!==null)return;
   let timer;
   const deadline=new Promise(resolve=>{timer=setTimeout(()=>{launched.kill('SIGKILL');resolve();},30000);});
   try{
    if(launched.connected)launched.send({type:'shutdown'},()=>{});else launched.kill('SIGTERM');
    await Promise.race([launched.finished,deadline]);
   }finally{clearTimeout(timer);}
  })();return stopped;
 }};
}
module.exports={superviseMedia};
