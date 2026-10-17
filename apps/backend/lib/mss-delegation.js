'use strict';
const crypto=require('crypto');
const exactOrigin=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&u.origin===value&&!u.username&&!u.password?value:null}catch{return null}};
const endpoint=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash?u.toString():null}catch{return null}};
const ingestEndpoint=value=>{try{if(/[\u0000-\u001f\u007f]/.test(value||''))return null;const u=new URL(value);return ['rtmp:','rtmps:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/live'?u.toString().replace(/\/$/,''):null}catch{return null}};
function createMssDelegation({env=process.env,fetch=global.fetch,now=Date.now}={}){
 let config=null;
 try{
  const issuer=exactOrigin(env.MSS_DELEGATION_ISSUER),parentOrigin=exactOrigin(env.MSS_DELEGATION_BROWSER_ORIGIN),introspectionUrl=endpoint(env.MSS_DELEGATION_INTROSPECTION_URL),ingestUrl=ingestEndpoint(env.MSS_DELEGATION_INGEST_URL),map=JSON.parse(env.MSS_DELEGATION_CHANNEL_MAP||'{}'),publicKey=crypto.createPublicKey(env.MSS_DELEGATION_PUBLIC_KEY||'');
  if(env.MSS_DELEGATION_ENABLED==='true'&&issuer&&parentOrigin&&introspectionUrl&&ingestUrl&&env.MSS_DELEGATION_AUDIENCE&&env.MSS_DELEGATION_INTROSPECTION_TOKEN?.length>=32&&publicKey.asymmetricKeyType==='ed25519'&&map&&!Array.isArray(map))config={issuer,parentOrigin,introspectionUrl,ingestUrl,audience:env.MSS_DELEGATION_AUDIENCE,token:env.MSS_DELEGATION_INTROSPECTION_TOKEN,map,publicKey};
 }catch{}
 const publicConfig=()=>config?{enabled:true,parentOrigin:config.parentOrigin}:{enabled:false,reason:'not_configured'};
 async function authorize(grant,channel){
  try{
   if(!config||typeof grant!=='string'||grant.length>8192)throw Error();
   const [body,signature,...rest]=grant.split('.');if(rest.length||!crypto.verify(null,Buffer.from(body),config.publicKey,Buffer.from(signature,'base64url')))throw Error();
   const claims=JSON.parse(Buffer.from(body,'base64url')),current=Math.floor(now()/1000);
   if(claims.iss!==config.issuer||claims.aud!==config.audience||claims.purpose!=='manager'||claims.channel!==channel||config.map[channel]!==claims.artistId||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp-claims.iat!==90||claims.iat>current||claims.exp<=current||typeof claims.jti!=='string'||typeof claims.sid!=='string')throw Error();
   const response=await fetch(config.introspectionUrl,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.token}`},body:JSON.stringify({grant}),signal:AbortSignal.timeout(4000)});
   if(!response.ok)throw Error();const result=await response.json();
   if(result?.active!==true||result.channel!==channel||result.artistId!==claims.artistId||typeof result.displayName!=='string'||!result.displayName.trim())throw Error();
   return {channel,artistId:claims.artistId,displayName:result.displayName,issuer:claims.iss,sessionId:claims.sid,grantId:claims.jti,expiresAt:claims.exp*1000};
  }catch{throw new Error('MSS delegation denied')}
 }
 const ingestUrl=()=>config?.ingestUrl;
 return {publicConfig,authorize,ingestUrl};
}
module.exports={createMssDelegation};
