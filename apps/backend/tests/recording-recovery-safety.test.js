require('./test-env');
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const {Pool}=require('pg'),{PrismaPg}=require('@prisma/adapter-pg'),{PrismaClient}=require('@prisma/client');
const {createRecordingRecovery}=require('../lib/recording-recovery');
const pool=new Pool({connectionString:process.env.DATABASE_URL}),prisma=new PrismaClient({adapter:new PrismaPg(pool)});
const root=process.env.RECORDINGS_ROOT,recovery=createRecordingRecovery({root,prisma});let stream;
const manifest=i=>path.join(root,'recording-intents',i.id+'.json');
function orphan(i){const m=JSON.parse(fs.readFileSync(manifest(i)));m.owner.boot='previous-boot';fs.writeFileSync(manifest(i),JSON.stringify(m));}
async function fixture(){return recovery.begin(stream,Date.now());}
beforeAll(async()=>{stream=await prisma.stream.create({data:{channelName:'safety-'+crypto.randomUUID(),streamKey:crypto.randomUUID()}});});
afterAll(async()=>{await recovery.close();await prisma.stream.delete({where:{id:stream.id}});await prisma.$disconnect();await pool.end();});
test('active intent, arbitrary legacy, empty, corrupt, symlink and outside associations never imported',async()=>{
 const active=await fixture();fs.writeFileSync(active.filepath,'active bytes');const a=fs.readFileSync(manifest(active));
 const empty=await fixture();fs.writeFileSync(empty.filepath,'');orphan(empty);
 const corrupt=await fixture();fs.writeFileSync(corrupt.filepath,'broken');orphan(corrupt);
 const outside=path.join(root,'outside.flv');fs.writeFileSync(outside,'do not touch');const link=await fixture();fs.symlinkSync(outside,link.filepath);orphan(link);
 fs.writeFileSync(path.join(root,'legacy.flv'),'unknown');
 await recovery.recover();expect(await prisma.recording.count({where:{streamId:stream.id}})).toBe(0);expect(fs.readFileSync(manifest(active)).equals(a)).toBe(true);expect(fs.readFileSync(outside,'utf8')).toBe('do not touch');
});
test('concurrent recovery converges on stable primary key and complete tombstone survives catalog deletion',async()=>{
 const i=await fixture();execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=160x90:r=10','-t','0.5','-c:v','libx264','-threads','1','-f','flv',i.filepath],{timeout:10000});orphan(i);
 const before=fs.readFileSync(i.filepath);await Promise.all([recovery.finish(i.id),recovery.finish(i.id)]);expect(await prisma.recording.count({where:{id:i.id}})).toBe(1);expect(fs.readFileSync(i.filepath).equals(before)).toBe(true);
 await prisma.recording.delete({where:{id:i.id}});await recovery.finish(i.id);expect(await prisma.recording.count({where:{id:i.id}})).toBe(0);
});

test('commit-before-tombstone interruption preserves the stable catalog identity on replay',async()=>{
 const i=await fixture();execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=160x90:r=10','-t','0.5','-c:v','libx264','-threads','1','-f','flv',i.filepath],{timeout:10000});orphan(i);
 const pending=fs.readFileSync(manifest(i));await recovery.finish(i.id);
 const row=await prisma.recording.findUnique({where:{id:i.id}});fs.writeFileSync(manifest(i),pending);
 await recovery.finish(i.id);expect(await prisma.recording.findUnique({where:{id:i.id}})).toEqual(row);expect(await prisma.recording.count({where:{id:i.id}})).toBe(1);
 expect(JSON.parse(fs.readFileSync(manifest(i))).state).toBe('complete');
});
test('published output before SQL commit is reused without overwrite on replay',async()=>{
 const i=await fixture();execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=160x90:r=10','-t','0.5','-c:v','libx264','-threads','1','-f','flv',i.filepath],{timeout:10000});orphan(i);
 const pending=fs.readFileSync(manifest(i));await recovery.finish(i.id);
 const row=await prisma.recording.findUnique({where:{id:i.id}}),output=path.join(root,row.filePath.slice('/recordings/'.length));const bytes=fs.readFileSync(output),stat=fs.statSync(output);
 await prisma.recording.delete({where:{id:i.id}});fs.writeFileSync(manifest(i),pending);
 await recovery.finish(i.id);expect(await prisma.recording.count({where:{id:i.id}})).toBe(1);expect(fs.readFileSync(output).equals(bytes)).toBe(true);expect(fs.statSync(output).ino).toBe(stat.ino);
});
