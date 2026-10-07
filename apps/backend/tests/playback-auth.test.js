require('./test-env');
const {EventEmitter}=require('events');
const {gatePlayback}=require('../lib/playback-gate');
const playback=require('../lib/playback-auth');
const stream={id:'test-stream',channelName:'private',isDisabled:false,isPasswordProtected:true,password:'fixture-only-password',playbackVersion:0};
const db={user:{findUnique:jest.fn()}};
test('play admission never invokes NMS synchronously or while authorization is unresolved',async()=>{
 let release;const auth=new Promise(r=>release=r),socket=new EventEmitter();
 const session={socket,streamPath:'/live/private',onPlay:jest.fn(),onPush:jest.fn(),onConnect:jest.fn(),close:jest.fn()};
 const play=session.onPlay;
 gatePlayback(session,()=>auth);
 session.onPlay();expect(play).not.toHaveBeenCalled();
 await Promise.resolve();expect(play).not.toHaveBeenCalled();
 release(true);await session.playbackAdmission;expect(play).toHaveBeenCalledTimes(1);session.close();
});
test('same-buffer RTMP rebinding or publish while play admission is pending cannot bypass it',async()=>{
 for(const attack of ['connect','push']){
  let release;const auth=new Promise(r=>release=r),socket=new EventEmitter();
  const session={socket,streamPath:'/live/private',onPlay:jest.fn(),onPush:jest.fn(),onConnect:jest.fn(),close:jest.fn()};
  const play=session.onPlay,connect=session.onConnect,push=session.onPush;
  gatePlayback(session,()=>auth);session.onPlay();
  if(attack==='connect')session.onConnect({app:'live',name:'other'});else session.onPush();
  release(true);await session.playbackAdmission;
  expect(play).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();expect(push).not.toHaveBeenCalled();
 }
});
test('grant signatures enforce purpose channel version expiry issuer audience and HS256 only',async()=>{
 const cap=playback.issue(stream);
 expect(await playback.allowed(stream,cap,'live',{db})).toBe(true);
 expect(await playback.allowed({...stream,channelName:'different'},cap,'live',{db})).toBe(false);
 expect(await playback.allowed({...stream,playbackVersion:1},cap,'live',{db})).toBe(false);
 expect(await playback.allowed({...stream,isDisabled:true},cap,'live',{db})).toBe(false);
 for(const purpose of ['recording','membership','relay','admin'])expect(await playback.allowed(stream,cap,purpose,{db})).toBe(false);
 const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+121000);
 try{expect(await playback.allowed(stream,cap,'live',{db})).toBe(false);expect(await playback.allowed(stream,cap,'live',{db,ignoreExpiration:true})).toBe(true);}
 finally{Date.now.mockRestore();}
 expect(playback.decode(require('jsonwebtoken').sign({purpose:'live',channel:'private'},process.env.JWT_SECRET),'live')).toBeNull();
});
test('relay grants require exact active publisher generation and never authorize browser or archive',async()=>{
 const cap=playback.issue(stream,{purpose:'relay',publisher:'generation-1'});
 expect(await playback.allowed(stream,cap,'relay',{db,publisher:'generation-1'})).toBe(true);
 expect(await playback.allowed(stream,cap,'relay',{db,publisher:'generation-2'})).toBe(false);
 expect(await playback.allowed(stream,cap,'relay',{db})).toBe(false);
 expect(await playback.allowed(stream,cap,'live',{db})).toBe(false);
 expect(await playback.allowed(stream,cap,'recording',{db})).toBe(false);
});

test('closed pending admission releases its wait even when the DB promise never resolves',async()=>{
 const session={socket:new EventEmitter(),streamPath:'/live/private',onPlay:jest.fn(),onPush:jest.fn(),close:jest.fn()};
 gatePlayback(session,()=>new Promise(()=>{}));session.onPlay();session.close();
 expect(await Promise.race([session.playbackAdmission.then(()=>true),new Promise(r=>setTimeout(()=>r(false),30))])).toBe(true);
});
