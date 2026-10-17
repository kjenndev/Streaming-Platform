const crypto=require('crypto');
const {createMssDelegation}=require('../lib/mss-delegation');

const keys=crypto.generateKeyPairSync('ed25519');
const env={
 MSS_DELEGATION_ENABLED:'true',
 MSS_DELEGATION_ISSUER:'https://mss.example.test',
 MSS_DELEGATION_BROWSER_ORIGIN:'https://mss.example.test',
 MSS_DELEGATION_AUDIENCE:'streaming-platform',
 MSS_DELEGATION_PUBLIC_KEY:keys.publicKey.export({format:'pem',type:'spki'}),
 MSS_DELEGATION_INTROSPECTION_URL:'https://mss-api.example.test/api/stream-manager/introspect',
 MSS_DELEGATION_INTROSPECTION_TOKEN:'separate-backchannel-secret-with-32-bytes',
 MSS_DELEGATION_CHANNEL_MAP:JSON.stringify({'mapped-channel':7}),
 MSS_DELEGATION_INGEST_URL:'rtmps://ingest.example.test/live',
};
function grant(overrides={}){const iat=Math.floor(Date.now()/1000),claims={iss:env.MSS_DELEGATION_ISSUER,aud:env.MSS_DELEGATION_AUDIENCE,purpose:'manager',channel:'mapped-channel',artistId:7,sub:'mss-user:4',sid:'hash',jti:'unique',iat,exp:iat+90,...overrides};const body=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${body}.${crypto.sign(null,Buffer.from(body),keys.privateKey).toString('base64url')}`}

test('verifies exact asymmetric issuer audience purpose channel mapping then introspects fail closed',async()=>{
 const fetch=jest.fn(async(url,options)=>({ok:true,json:async()=>({active:true,channel:'mapped-channel',artistId:7,displayName:'Artist'})}));
 const trust=createMssDelegation({env,fetch});
 expect(trust.publicConfig()).toEqual({enabled:true,parentOrigin:'https://mss.example.test'});
 await expect(trust.authorize(grant(),'mapped-channel')).resolves.toEqual(expect.objectContaining({channel:'mapped-channel',artistId:7,displayName:'Artist',issuer:env.MSS_DELEGATION_ISSUER,sessionId:'hash',expiresAt:expect.any(Number)}));
 expect(fetch).toHaveBeenCalledWith(env.MSS_DELEGATION_INTROSPECTION_URL,expect.objectContaining({method:'POST',headers:expect.objectContaining({authorization:`Bearer ${env.MSS_DELEGATION_INTROSPECTION_TOKEN}`})}));
 for(const bad of [grant({purpose:'live'}),grant({channel:'other'}),grant({artistId:8}),grant({exp:1})])await expect(trust.authorize(bad,'mapped-channel')).rejects.toThrow();
});

test('issues a delegated media principal bounded by the manager grant and re-introspects it fail closed',async()=>{
 const playback=require('../lib/playback-auth');
 const token=grant();
 const fetch=jest.fn(async()=>({ok:true,json:async()=>({active:true,channel:'mapped-channel',artistId:7,displayName:'Artist'})}));
 const trust=createMssDelegation({env,fetch});
 const identity=await trust.authorize(token,'mapped-channel');
 const stream={id:'stream-1',channelName:'mapped-channel',isDisabled:false,isPasswordProtected:false,password:null,playbackVersion:2,authorizedUsers:[]};
 const cap=playback.issue(stream,{purpose:'delegated-live',delegation:{grant:token,...identity}});
 const claims=playback.decode(cap,'delegated-live');
 expect(claims.exp).toBeLessThanOrEqual(Math.floor(identity.expiresAt/1000));
 await expect(playback.allowed(stream,cap,'delegated-live',{db:{},authorizeDelegated:(managerGrant,channel)=>trust.authorize(managerGrant,channel)})).resolves.toBe(true);
 fetch.mockRejectedValueOnce(new Error('outage'));
 await expect(playback.allowed(stream,cap,'delegated-live',{db:{},authorizeDelegated:(managerGrant,channel)=>trust.authorize(managerGrant,channel)})).resolves.toBe(false);
 expect(await playback.allowed(stream,'','live',{db:{}})).toBe(true);
});

test('delegated identity is structured metadata and ordinary names remain ordinary',()=>{
 const {chatIdentity}=require('../lib/control-runtime');
 expect(chatIdentity({data:{username:'Artist ✓',mssIdentity:null}})).toEqual({displayName:'Artist ✓',identityType:'viewer',verified:false});
 expect(chatIdentity({data:{username:'Artist',mssIdentity:{issuer:'https://mss.example.test',artistId:7,displayName:'Artist'}}})).toEqual({displayName:'Artist',identityType:'mss-artist',verified:true,issuer:'https://mss.example.test',artistId:7});
});

test('media admission accepts delegated credentials only from the dedicated header and sweeps with current introspection',async()=>{
 const playback=require('../lib/playback-auth');
 const {createMediaPlaybackAuthorizer}=require('../lib/media-playback-auth');
 const token=grant(),trust=createMssDelegation({env,fetch:async()=>({ok:true,json:async()=>({active:true,channel:'mapped-channel',artistId:7,displayName:'Artist'})})});
 const identity=await trust.authorize(token,'mapped-channel');
 const stream={id:'stream-1',channelName:'mapped-channel',isDisabled:false,isPasswordProtected:false,password:null,playbackVersion:2,authorizedUsers:[]};
 const cap=playback.issue(stream,{purpose:'delegated-live',delegation:{grant:token,...identity}});
 const authorize=createMediaPlaybackAuthorizer({db:{stream:{findUnique:async()=>stream}},delegation:trust});
 const session={streamPath:'/mss-live/mapped-channel',streamQuery:{},req:{headers:{'x-mss-playback':cap}},protocol:'http'};
 await expect(authorize(session)).resolves.toBe(true);
 await expect(authorize({...session,req:{headers:{}},streamQuery:{cap}})).resolves.toBe(false);
 await expect(authorize({...session,streamPath:'/live/mapped-channel',req:{headers:{}},streamQuery:{}})).resolves.toBe(true); // ordinary public behavior is unchanged
});

test('missing setup and backchannel outages remain disabled or deny',async()=>{
 expect(createMssDelegation({env:{}}).publicConfig()).toEqual({enabled:false,reason:'not_configured'});
 const trust=createMssDelegation({env,fetch:async()=>{throw Error('down')}});
 await expect(trust.authorize(grant(),'mapped-channel')).rejects.toThrow(/denied/i);
});

test('ordinary public recording access remains anonymous while private recording access remains denied',async()=>{
 const playback=require('../lib/playback-auth');
 const base={id:'ordinary',channelName:'ordinary',isDisabled:false,password:null,playbackVersion:1,authorizedUsers:[]};
 await expect(playback.allowed({...base,isPasswordProtected:false},undefined,'recording',{db:{}})).resolves.toBe(true);
 await expect(playback.allowed({...base,isPasswordProtected:true},undefined,'recording',{db:{}})).resolves.toBe(false);
});

test.each(['rtmp://user:pass@host/live','https://host/live','rtmp://host/live?x=1','rtmp://host/live#x','rtmp://host/other','rtmp://bad host/live'])(
 'fails closed for unsafe ingest URL %s', value => {
  expect(createMssDelegation({env:{...env,MSS_DELEGATION_INGEST_URL:value}}).publicConfig()).toEqual({enabled:false,reason:'not_configured'});
 });
