'use strict';
function createViewer(options,{get,io}){
 const {id,channel,api,media,timeoutMs,slow=false}=options;
 const c={id,bytes:0,status:0,errors:0,mediaErrors:0,socketErrors:0,unexpectedEnds:0,unexpectedCloses:0,closed:false,last:performance.now(),gap:0,socketEvents:0,socketBytes:0,mediaChunks:0,slow,joined:false,disposed:false,pausedAt:null};
 const error=(kind='mediaErrors')=>{if(!c.disposed){c.errors++;c[kind]++;}};
 const mediaError=()=>error();const socketError=()=>error('socketErrors');
 c.request=get(`${media}/live/${encodeURIComponent(channel)}.flv`,{agent:false},res=>{
  c.response=res;c.status=res.statusCode;if(c.status!==200)error();
  res.on('data',b=>{const now=performance.now();c.gap=Math.max(c.gap,now-c.last);c.last=now;c.bytes+=b.length;c.mediaChunks++;});
  res.on('error',mediaError);res.on('close',()=>{c.closed=true;if(!c.disposed)c.unexpectedCloses++;});res.on('end',()=>{c.closed=true;if(!c.disposed)c.unexpectedEnds++;});
  if(slow){res.pause();res.socket.pause();c.pausedAt=performance.now();}
 });
 c.request.on('error',()=>{error();c.closed=true;});
 c.socketClient=io(api,{transports:['websocket'],forceNew:true,reconnection:false,timeout:timeoutMs});
 c.socketClient.on('connect',()=>c.socketClient.timeout(timeoutMs).emit('join_channel',{channelName:channel,username:`benchmark_${id.replaceAll(':','_')}`},(err,result)=>{c.joined=!err&&result?.ok===true;if(!c.joined)socketError();}));
 c.socketClient.on('connect_error',socketError);c.socketClient.on('disconnect',()=>{c.joined=false;socketError();});
 c.socketClient.onAny((event,...args)=>{c.socketEvents++;c.socketBytes+=Buffer.byteLength(JSON.stringify([event,...args]));});
 return c;
}
function snapshot(c,reset=false){
 const now=performance.now();
 const result={id:c.id,bytes:c.bytes,status:c.status,errors:c.errors,mediaErrors:c.mediaErrors,socketErrors:c.socketErrors,unexpectedEnds:c.unexpectedEnds,unexpectedCloses:c.unexpectedCloses,closed:c.closed,socket:c.socketClient.connected,joined:c.joined,
  gap:Math.max(c.gap,now-c.last),socketEvents:c.socketEvents,socketBytes:c.socketBytes,mediaChunks:c.mediaChunks,slow:c.slow,
  pausedAt:c.pausedAt,pausedMs:c.pausedAt===null?0:now-c.pausedAt,transportPaused:!!c.response?.socket?.isPaused(),
  receiveBufferBytes:c.response?.socket?.readableLength??null};
 if(reset){c.gap=0;c.last=now;}
 return result;
}
function dispose(c){if(c.disposed)return;c.disposed=true;c.request.destroy();c.response?.destroy();c.socketClient.disconnect();}
module.exports={createViewer,snapshot,dispose};
