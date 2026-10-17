const test=global.test || require('node:test').test;
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('delegated OBS key is directly publishable with encoded channel and secret, without rotation',()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../index.js'),'utf8');
 const expression=source.match(/delegatedCredentials\s*=\s*(\{server:mssDelegation\.ingestUrl\(\),streamKey:[^;]+\});/)[1];
 for(const [channelName,streamKey] of [['mapped-channel','secret'],['channel_name-2','a&b?c=+/%#']]){
  const stream={channelName,streamKey};const result=vm.runInNewContext('('+expression+')',{stream,mssDelegation:{ingestUrl:()=> 'rtmp://fixture.invalid/live'}});
  assert.equal(result.streamKey,encodeURIComponent(channelName)+'?key='+encodeURIComponent(streamKey));
  const url=new URL(result.server+'/'+result.streamKey);assert.equal(decodeURIComponent(url.pathname.split('/').pop()),channelName);assert.equal(url.searchParams.get('key'),streamKey);assert.equal(stream.streamKey,streamKey);
 }
});
