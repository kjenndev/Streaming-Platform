'use strict';
// This wraps onPlay BEFORE NMS registers callbacks. An async prePlay listener is
// not an admission gate: NMS's EventEmitter does not await listener promises.
function gatePlayback(session,authorize){
 const play=session.onPlay,connect=session.onConnect,push=session.onPush;
 let state='idle',closed=false,timer,cancel;
 const cancelled=new Promise(resolve=>{cancel=()=>resolve(false);});
 const close=session.close;
 session.close=(...args)=>{closed=true;clearTimeout(timer);cancel();return close(...args);};
 session.socket?.once('close',()=>{closed=true;clearTimeout(timer);cancel();});
 if(connect)session.onConnect=(req)=>{
  if(state!=='idle' || closed){session.close();return;}
  return connect(req);
 };
 session.onPush=(...args)=>{if(state!=='idle' || closed){session.close();return;}state='publish';return push(...args);};
 session.onPlay=()=>{
  if(state!=='idle' || closed){session.close();return;}
  state='pending';
  const binding=session.streamPath;
  timer=setTimeout(()=>session.close(),5000);timer.unref?.();
  session.playbackAdmission=Promise.race([Promise.resolve().then(()=>authorize(session)),cancelled]).then(ok=>{
   clearTimeout(timer);
   if(!ok || closed || session.socket?.destroyed || session.streamPath!==binding){session.close();return;}
   state='play';session.playbackAdmitted=true;play();
  }).catch(()=>session.close());
 };
 return session;
}
module.exports={gatePlayback};
