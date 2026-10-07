'use strict';
const {bounded}=require('./control.cjs');
async function listAll(request,route,options={}){
 const items=[],ids=new Set();let skip=0;
 const deadline=options.deadline??performance.now()+(options.timeoutMs??30000);
 const maxPages=options.maxPages??1000;let pages=0;
 const controller=new AbortController(),abort=()=>controller.abort();
 options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted)abort();
 const requestOptions={...options,signal:controller.signal};
 try{for(;;){
  if(++pages>maxPages)throw Error('Pagination page limit exceeded');
  if(performance.now()>=deadline)throw Error('Pagination deadline exceeded');
  const result=await bounded(()=>request(`${route}?skip=${skip}&take=100`,requestOptions),{timeoutMs:deadline-performance.now(),signal:controller.signal});
  if(!result.ok||!Array.isArray(result.data))throw Error('Fixture list failed');
  if(!Number.isSafeInteger(result.total)||result.total<0)throw Error('Invalid pagination total');
  for(const item of result.data){if(!item.id||ids.has(item.id))throw Error('Unstable pagination');ids.add(item.id);items.push(item);}
  skip+=result.data.length;
  if(skip===result.total)return items;
  if(!result.data.length||skip>result.total)throw Error('Incomplete pagination');
 }}finally{controller.abort();options.signal?.removeEventListener('abort',abort);}
}
async function cleanupFixture(request,name,id,settings={}){
 const options={...settings,cleanup:true,deadline:settings.deadline??performance.now()+(settings.timeoutMs??30000)};
 const progress=settings.progress||{};progress.channelRemoved=false;progress.recordingsRemoved=0;
 const original=request;request=(route,opts)=>bounded(()=>original(route,opts),{timeoutMs:Math.max(0,options.deadline-performance.now()),signal:options.signal});
 const exact=(await listAll(request,'/api/streams',options)).filter(s=>s.channelName===name);
 if(exact.length>1)throw Error('Ambiguous owned fixture');
 let recordingsRemoved=0;
 if(exact.length){
  const owned=exact[0];if(id&&owned.id!==id)throw Error('Created channel id mismatch');
  const route='/api/streams/'+encodeURIComponent(owned.id);
  const recordings=await listAll(request,route+'/recordings',options);
  if(recordings.some(r=>r.streamId!==owned.id))throw Error('Recording ownership mismatch');
  for(const recording of recordings){
   if(!(await request('/api/recordings/'+encodeURIComponent(recording.id),{...options,method:'DELETE'})).ok)throw Error('Recording cleanup failed');
   recordingsRemoved++;progress.recordingsRemoved=recordingsRemoved;
  }
  if((await listAll(request,route+'/recordings',options)).length)throw Error('Recording deletion verification failed');
  if(!(await request(route,{...options,method:'DELETE'})).ok)throw Error('Channel cleanup failed');
 }
 if((await listAll(request,'/api/streams',options)).some(s=>s.channelName===name))throw Error('Channel deletion verification failed');
 progress.channelRemoved=true;return {channelRemoved:true,recordingsRemoved};
}
module.exports={listAll,cleanupFixture};
