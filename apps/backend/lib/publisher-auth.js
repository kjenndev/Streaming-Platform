// NMS v4 emits prePublish synchronously. Admission must precede onPush,
// not be an async EventEmitter listener; pending packets are never forwarded.
function gatePublisher(session, authorize) {
 const push=session.onPush, packet=session.onPacket;
 const socket=session.socket || session.req?.socket;
 let pending=false, admitted=false, rejected=false,queuedBytes=0;
 const queued=[];
 let cancelWait;
 const clearQueue=()=>{queued.length=0;queuedBytes=0;};
 const cancelAdmission=()=>{rejected=true;clearQueue();cancelWait?.();};
 // A paused socket still parses commands already in the current RTMP buffer.
 // Reject a second binding before NMS can mutate the pending auth identity.
 const connect=session.onConnect;
 if(connect)session.onConnect=(request)=>{
  if(pending || admitted || rejected){
   cancelAdmission();session.close?.();socket?.destroy();return;
  }
  return connect(request);
 };
 session.onPacket=(data)=>{
  if(rejected)return;
  if(admitted)return packet(data);
  if(!pending || rejected)return;
  const size=data.size ?? data.data?.length ?? 0;
  queuedBytes+=size+64;
  if(queuedBytes>1024*1024){cancelAdmission();socket?.destroy();return;}
  // NMS reuses its parser backing store for the next tag/chunk.
  queued.push({...data, ...(data.data ? {data:Buffer.from(data.data.subarray(0,size))} : {})});
 };
 // FLV normally binds this in onPush, too late for data parsed during auth.
 if(session.flv)session.flv.onPacketCallback=session.onPacket;
 const admit=async()=>{
  if(pending || admitted || rejected) return;
  pending=true;
  // Cancellation must not depend on a potentially externally rooted auth promise.
  const cancelled=new Promise(resolve=>{cancelWait=()=>resolve(null);});
  socket?.once?.('close',cancelAdmission);
  const timeout=setTimeout(()=>{cancelAdmission();socket?.destroy();},5000); timeout.unref?.();
  try {
   socket?.pause();
   if(socket?.destroyed){cancelAdmission();return;}
   const stream=await Promise.race([authorize(session),cancelled]);
   if(!stream || rejected || socket?.destroyed || session.broadcast?.publisher) {cancelAdmission();socket?.destroy();return;}
   session.authorizedStream=stream; admitted=true; push();
   for(const data of queued){if(rejected)break;packet(data);}
   if(!rejected)socket?.resume();
  } catch {cancelAdmission();socket?.destroy();}
  finally {
   clearQueue();pending=false;cancelWait=undefined;
   clearTimeout(timeout);socket?.removeListener?.('close',cancelAdmission);
  }
 };
 session.onPush=()=>session.publisherAdmission ||= admit();
 return session;
}
module.exports={gatePublisher};
