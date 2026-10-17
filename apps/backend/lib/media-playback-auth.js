'use strict';
const playback=require('./playback-auth');

function createMediaPlaybackAuthorizer({db,delegation}){
 return async function authorizePlayback(session,ignoreExpiration=false){
  const match=/^\/(live|mss-live)\/([a-zA-Z0-9_-]{1,128})$/.exec(session.streamPath || '');
  if(!match)return false;
  const delegated=match[1]==='mss-live';
  const stream=await db.stream.findUnique({where:{channelName:match[2]},include:playback.streamInclude});
  const header=session.req?.headers?.['x-mss-playback'];
  const token=delegated?(Array.isArray(header)?header[0]:header):session.streamQuery?.cap;
  if(delegated)return playback.allowed(stream,token,'delegated-live',{db,ignoreExpiration,authorizeDelegated:(grant,channel)=>delegation.authorize(grant,channel)});
  const relay=playback.decode(token,'relay',ignoreExpiration);
  if(relay && (session.protocol!=='rtmp' || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(session.socket?.remoteAddress)))return false;
  return playback.allowed(stream,token,relay?'relay':'live',{db,ignoreExpiration,publisher:session.broadcast?.publisher?.id});
 };
}
module.exports={createMediaPlaybackAuthorizer};
