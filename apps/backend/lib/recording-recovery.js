const fs=require('fs/promises'),sync=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const boot=()=>sync.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const host=()=>crypto.createHash('sha256').update(sync.readFileSync('/etc/machine-id')).digest('hex');
const ticks=pid=>sync.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').at(-1).split(' ')[19];
function owner(){return {host:host(),boot:boot(),pid:process.pid,ticks:ticks(process.pid)};}
function alive(value){
 if(!value || value.host!==host())return true; // Other hosts are not ours to recover.
 if(value.boot!==boot())return false;
 try{return ticks(value.pid)===value.ticks;}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
async function directory(p){const s=await fs.lstat(p);if(!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode&0o022))throw Error('Unsafe recording directory');}
async function regular(p,max=Infinity){const h=await fs.open(p,sync.constants.O_RDONLY|sync.constants.O_NOFOLLOW);try{const s=await h.stat();if(!s.isFile() || s.uid!==process.getuid() || s.nlink!==1 || s.size>max)throw Error('Unsafe recording file');return {h,s};}catch(e){await h.close();throw e;}}
async function syncDir(p){const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
async function durable(p,value,initial=false){
 const temp=p+'.'+crypto.randomUUID()+'.tmp';const h=await fs.open(temp,'wx',0o600);
 try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}
 try{if(initial){await fs.link(temp,p);await fs.unlink(temp);}else await fs.rename(temp,p);await syncDir(path.dirname(p));}catch(e){await fs.unlink(temp).catch(()=>{});throw e;}
}
function command(args,fd,timeout=15000){return new Promise((resolve,reject)=>{
 const child=spawn('/usr/bin/ffmpeg',args,{stdio:['ignore','pipe','ignore',fd]});let out='',overflow=false;
 const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
 child.stdout.on('data',b=>{out+=b;if(out.length>65536){overflow=true;child.kill('SIGKILL');}});
 child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0 || overflow)reject(Error('Recording media validation failed'));else resolve(out);});
});}
const input=['-nostdin','-hide_banner','-loglevel','error','-threads','1','-protocol_whitelist','file,pipe','-probesize','1048576','-analyzeduration','2000000','-i','pipe:3'];
async function decodable(p){const {h,s}=await regular(p);try{if(!s.size)throw Error('Empty recording');const out=await command([...input,'-map','0:v:0','-frames:v','1','-threads','1','-f','framemd5','-'],h.fd);if(!/^0,/m.test(out))throw Error('No decoded video');return s;}finally{await h.close();}}
function createRecordingRecovery({root,prisma}){
 root=path.resolve(root);const intents=path.join(root,'recording-intents'),media=path.join(root,'managed-recordings');let ready;
 async function init(){if(!ready)ready=(async()=>{await fs.mkdir(root,{recursive:true,mode:0o700});await directory(root);if(await fs.realpath(root)!==root)throw Error('Symlink recording root');for(const d of [intents,media]){await fs.mkdir(d,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(d);}await syncDir(root);})();return ready;}
 const manifestPath=id=>path.join(intents,id+'.json');
 async function read(id){if(!UUID.test(id))throw Error('Invalid recording id');await init();await directory(intents);const {h}=await regular(manifestPath(id),8192);try{const m=JSON.parse(await h.readFile('utf8'));if(m.version!==1 || m.id!==id || !UUID.test(m.id) || typeof m.streamId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(m.channel) || !Number.isSafeInteger(m.startTime) || m.startTime<0 || !['pending','complete'].includes(m.state) || !Number.isSafeInteger(m.owner?.pid) || m.owner.pid<1 || typeof m.owner.ticks!=='string')throw Error('Invalid recording intent');return m;}finally{await h.close();}}
 async function begin(stream,startTime){
  await init();const id=crypto.randomUUID(),dir=path.join(media,id);await fs.mkdir(dir,{mode:0o700});await syncDir(media);
  const manifest={version:1,id,streamId:stream.id,channel:stream.channelName,startTime,owner:owner(),state:'pending'};
  await durable(manifestPath(id),manifest,true);
  return {id,filepath:path.join(dir,'source.flv'),streamId:stream.id,channel:stream.channelName,startTime};
 }
 // A separate monotonic marker cannot be overwritten by a late complete write.
 // Call only inside the authorized deletion transaction, before deleting its row.
 async function markDeleted(tx,rec){
  if(!UUID.test(rec.id))throw Error('Invalid recording id');
  const locks=await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${rec.id}, 0)) AS locked`;
  if(!locks[0].locked)throw Object.assign(Error('Recording finalization in progress; retry deletion'),{status:503});
  await init();await directory(intents);
  const current=await tx.recording.findUnique({where:{id:rec.id}});
  if(!current || current.streamId!==rec.streamId || current.filePath!==rec.filePath)throw Error('Recording changed');
  let m;try{m=await read(rec.id);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(m && (m.streamId!==rec.streamId || rec.filePath!==`/recordings/managed-recordings/${rec.id}/finished/video.mp4`))throw Error('Recording intent mismatch');
  // Fsync before SQL deletion: failures/rollbacks may retain an extra tombstone,
  // but can never acknowledge deletion without persistent anti-replay state.
  await durable(path.join(intents,rec.id+'.deleted'),{version:1,id:rec.id,streamId:rec.streamId});
 }
 async function deleted(id){
  try{await fs.lstat(path.join(intents,id+'.deleted'));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
 }
 async function finish(id,{owned=false}={}){
  if(!UUID.test(id))throw Error('Invalid recording id');
  await init();
  // Transaction-scoped advisory lock serializes recovery/finalization across workers.
  return prisma.$transaction(async tx=>{
   const locks=await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${id}, 0)) AS locked`;
   if(!locks[0].locked)return false;
   await directory(intents);if(await deleted(id))return false;
   const m=await read(id);if(m.state==='complete' || (!owned && alive(m.owner)))return false;
   if(owned && (m.owner.pid!==process.pid || m.owner.boot!==boot() || m.owner.ticks!==ticks(process.pid)))throw Error('Not recording owner');
   const stream=await tx.stream.findUnique({where:{id:m.streamId}});if(!stream || stream.channelName!==m.channel)return false;
   await directory(media);const dir=path.join(media,id);await directory(dir);
   const source=path.join(dir,'source.flv'),finished=path.join(dir,'finished'),output=path.join(finished,'video.mp4');
   const existing=await tx.recording.findUnique({where:{id}});
   if(!existing){
    const before=await decodable(source);let outputExists=false;
    try{await directory(finished);await fs.lstat(output);outputExists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!outputExists){
     const staging=path.join(dir,crypto.randomUUID()+'.staging');await fs.mkdir(staging,{mode:0o700});const temp=path.join(staging,'video.mp4');const {h}=await regular(source);
     try{
      await command([...input,'-map','0:v:0','-map','0:a?','-c','copy','-movflags','+faststart','-n',temp],h.fd,15000);
      await fs.chmod(temp,0o600);await decodable(temp);const out=await fs.open(temp,'r');try{await out.sync();}finally{await out.close();}
      await syncDir(staging);await fs.rename(staging,finished);await syncDir(dir);
     }finally{await h.close();await fs.unlink(temp).catch(()=>{});await fs.rmdir(staging).catch(()=>{});}
    }
    const stat=await decodable(output),after=await fs.lstat(source);
    if(before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || (!owned && alive(m.owner)))throw Error('Recording still changing');
    const endedAt=new Date(after.mtimeMs);
    await tx.recording.create({data:{id,streamId:m.streamId,fileName:'video.mp4',filePath:`/recordings/managed-recordings/${id}/finished/video.mp4`,fileSize:BigInt(stat.size),startedAt:new Date(m.startTime),endedAt,duration:Math.max(0,Math.round((endedAt.getTime()-m.startTime)/1000))}});
   }
   return true;
  },{timeout:60000,maxWait:2000}).then(async done=>{
   // Complete is only a replay optimization. The independent deletion marker
   // remains authoritative even if this write races with an authorized DELETE.
   if(done){const m=await read(id);await durable(manifestPath(id),{...m,state:'complete'});}return done;
  });
 }
 let scan;
 async function close(){if(scan){await scan.close().catch(()=>{});scan=null;}}
 async function recover(){
  await init();await directory(intents);if(!scan)scan=await fs.opendir(intents);let processed=0;
  // Keep the iterator between sweeps so corrupt/active/complete entries cannot
  // starve later intents. Bound BOTH enumeration and expensive media operations.
  try{for(let seen=0;seen<128 && processed<4;seen++){
   const entry=await scan.read();if(!entry){await close();break;}
   if(!entry.isFile() || !entry.name.endsWith('.json'))continue;
   const id=entry.name.slice(0,-5);if(!UUID.test(id))continue;
   const m=await read(id).catch(()=>null);if(!m || m.state==='complete' || alive(m.owner))continue;
   processed++;await finish(id).catch(()=>{});
  }}catch(e){await close();throw e;}return processed;
 }

 return {begin,finish,recover,close,markDeleted};
}
module.exports={createRecordingRecovery,alive};
