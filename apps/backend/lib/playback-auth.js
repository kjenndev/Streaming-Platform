'use strict';
const crypto=require('crypto');
const jwt=require('jsonwebtoken');
const purposes=new Set(['live','recording','membership','relay']);
const TTL=120;
function key(){
 if(!process.env.JWT_SECRET)throw new Error('JWT_SECRET is required');
 return crypto.createHmac('sha256',process.env.JWT_SECRET).update('streaming-platform/playback/v1').digest();
}
function fingerprint(value){return crypto.createHmac('sha256',key()).update(JSON.stringify(value)).digest('base64url');}
function version(stream){return fingerprint([stream.id,stream.channelName,stream.isPasswordProtected,stream.password,stream.isDisabled,stream.playbackVersion]);}
function userVersion(user){return fingerprint([user.id,user.roles,user.passwordHash,user.updatedAt]);}
function assigned(stream,user){return !!user?.roles?.length && (user.roles.includes('ADMIN') || stream.authorizedUsers?.some(u=>u.id===user.id));}
function issue(stream,{user,purpose='live',publisher}={}){
 if(!purposes.has(purpose) || stream.isDisabled)throw new Error('Invalid playback grant');
 return jwt.sign({purpose,channel:stream.channelName,stream:stream.id,version:version(stream),...(user?{actor:user.id,actorVersion:userVersion(user)}:{}),...(publisher?{publisher}:{})},key(),{algorithm:'HS256',audience:'streaming-playback',issuer:'streaming-platform',expiresIn:TTL});
}
function decode(token,purpose,ignoreExpiration=false){
 if(typeof token!=='string' || token.length>4096 || !purposes.has(purpose))return null;
 try{
  const p=jwt.verify(token,key(),{algorithms:['HS256'],audience:'streaming-playback',issuer:'streaming-platform',ignoreExpiration});
  if(p.purpose!==purpose || !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp-p.iat!==TTL)return null;
  return p;
 }catch{return null;}
}
async function allowed(stream,token,purpose,{db,ignoreExpiration=false,publisher}={}){
 if(!stream || stream.isDisabled)return false;
 if(!stream.isPasswordProtected && !token && purpose!=='relay')return true;
 const p=decode(token,purpose,ignoreExpiration);
 if(!p || p.channel!==stream.channelName || p.stream!==stream.id)return false;
 if(purpose==='relay')return typeof publisher==='string' && p.publisher===publisher;
 if(p.version!==version(stream))return false;
 if(p.actor){
  const user=await db.user.findUnique({where:{id:p.actor}});
  if(!assigned(stream,user) || p.actorVersion!==userVersion(user))return false;
 }
 return true;
}
const streamInclude={authorizedUsers:{select:{id:true}}};
async function deadline(work,ms=5000){
 let timer;
 try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Authorization deadline')),ms);timer.unref?.();})]);}
 finally{clearTimeout(timer);}
}
module.exports={TTL,issue,allowed,decode,version,assigned,streamInclude,deadline};
