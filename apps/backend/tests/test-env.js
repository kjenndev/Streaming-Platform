// This bootstrap is also loaded by index.js under Jest/NODE_ENV=test.
const path=require('path');
require('dotenv').config({path:path.join(__dirname,'../.env.test'),override:true,quiet:true});
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Tests require a dedicated *_test database');
if(new URL(process.env.REDIS_URL).pathname!=='/1') throw new Error('Tests require Redis database 1');
// Never inherit a production recording path into a test process.
process.env.RECORDINGS_ROOT=require('fs').mkdtempSync(path.join(require('os').tmpdir(),'streaming-recordings-test-'));
process.once('exit',()=>require('fs').rmSync(process.env.RECORDINGS_ROOT,{recursive:true,force:true}));
process.env.HTTP_PORT='13001';process.env.MEDIA_HTTP_PORT='18001';process.env.RTMP_PORT='11936';process.env.BIND_HOST='127.0.0.1';
