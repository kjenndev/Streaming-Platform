require('./test-env');
const fs=require('fs'),path=require('path'),{spawn,execFileSync}=require('child_process');
const backend=require('../index');
let runtime,stream,publisher;const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=18000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(100);}throw Error('recovery deadline');}
const allFiles=()=>fs.readdirSync(process.env.RECORDINGS_ROOT,{recursive:true}).filter(f=>f.endsWith('.flv'));
beforeAll(async()=>{runtime=await backend.startServer();stream=await backend.prisma.stream.create({data:{channelName:'recover-'+require('crypto').randomBytes(4).toString('hex'),streamKey:require('crypto').randomUUID(),isRecordingEnabled:true}});},20000);
afterAll(async()=>{if(publisher && publisher.exitCode===null && !publisher.signalCode){publisher.kill('SIGKILL');await new Promise(r=>publisher.once('exit',r));}await backend.stopServer();if(stream)await backend.prisma.stream.delete({where:{id:stream.id}});await backend.prisma.$disconnect();await backend.pool.end();await backend.redis.quit();},30000);
test('owned worker kill recovers decodable interrupted recording once, retaining exact source',async()=>{
 publisher=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','color=c=black:s=160x90:r=10','-t','30','-c:v','libx264','-threads','1','-preset','ultrafast','-g','10','-f','flv',`rtmp://127.0.0.1:${process.env.RTMP_PORT}/live/${stream.channelName}?key=${stream.streamKey}`],{stdio:'ignore'});
 await until(()=>allFiles().some(f=>fs.statSync(path.join(process.env.RECORDINGS_ROOT,f)).size>1500));
 const children=fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).map(Number);
 const worker=children.find(pid=>fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('/lib/media-worker.js'));expect(worker).toBeTruthy();
 process.kill(worker,'SIGKILL');await pause(100);publisher.kill('SIGKILL');
 const file=path.join(process.env.RECORDINGS_ROOT,allFiles()[0]),original=fs.readFileSync(file);
 const rows=await until(async()=>{const rows=await backend.prisma.recording.findMany({where:{streamId:stream.id}});return rows.length?rows:null;});expect(rows).toHaveLength(1);
 const rec=rows[0],output=path.join(process.env.RECORDINGS_ROOT,rec.filePath.slice('/recordings/'.length));
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',output],{timeout:10000}));expect(Number(probe.streams[0].nb_read_frames)).toBeGreaterThan(0);
 expect(fs.readFileSync(file).equals(original)).toBe(true);
 const response=await fetch(`http://127.0.0.1:${process.env.HTTP_PORT}${rec.filePath}`);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(output))).toBe(true);
 const current=fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).map(Number).find(pid=>fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('/lib/media-worker.js'));
 expect(current).not.toBe(worker);process.kill(current,'SIGKILL');await pause(1800);expect(await backend.prisma.recording.count({where:{streamId:stream.id}})).toBe(1);
},30000);
