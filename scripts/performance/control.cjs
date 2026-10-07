'use strict';
const {isIP}=require('node:net');
const {execFile}=require('node:child_process');
function lookup(host,options){
 return new Promise((resolve,reject)=>execFile(process.execPath,['-e','require("node:dns").lookup(process.argv[1],{all:true},(e,a)=>{if(e)process.exit(1);else console.log(JSON.stringify(a));})',host],{timeout:options.timeoutMs,signal:options.signal,maxBuffer:65536,env:{PATH:process.env.PATH}},(error,out)=>{
  if(error)return reject(Error('DNS resolution failed'));
  try{resolve(JSON.parse(out));}catch{reject(Error('DNS resolution failed'));}
 }));
}
function bounded(operation,{timeoutMs=3000,signal}={}){
 return new Promise((resolve,reject)=>{
  let timer,done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>finish(Error('Operation aborted'));
  if(signal?.aborted)return abort();
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish(Error('Operation deadline exceeded')),Math.max(0,timeoutMs));
  Promise.resolve().then(operation).then(value=>finish(null,value),error=>finish(error));
 });
}
function batches(n){
 if(!Number.isSafeInteger(n)||n<1)throw Error('Viewers must be a positive integer');
 const result=[]; while(n){const size=Math.min(n,250);result.push(size);n-=size;} return result;
}
function parseStages(s){
 return s.split(',').map(part=>{
  if(!/^\d+:\d+(\.\d+)?$/.test(part))throw Error('Stages must be viewers:seconds,...');
  const [viewers,seconds]=part.split(':').map(Number); batches(viewers);
  if(!Number.isFinite(seconds)||seconds<=0)throw Error('Stage duration must be positive');
  return {viewers,seconds};
 });
}
function addressClass(address){
 address=address.toLowerCase();
 if(address.startsWith('::ffff:'))address=address.slice(7);
 if(address==='::1')return 'loopback';
 if(isIP(address)===4){
  const [a,b]=address.split('.').map(Number);
  if(a===127)return 'loopback';
  if(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168))return 'lan';
 }
 if(isIP(address)===6&&/^(fc|fd)/.test(address))return 'lan';
 return 'public';
}
async function validateTarget(raw,allowLan=false,resolver=lookup,protocols=['http:','https:'],options={}){
 const url=new URL(raw);
 if(!protocols.includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!=='')throw Error('Target must be an origin without credentials/path/query');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const addresses=isIP(host)?[{address:host}]:await bounded(()=>resolver(host,{all:true,timeoutMs:options.timeoutMs||3000,signal:options.signal}),options);
 if(!addresses.length||addresses.some(({address})=>{const type=addressClass(address);return type!=='loopback'&&!(allowLan&&type==='lan');}))throw Error('Only loopback targets allowed; --allow-lan admits private LAN addresses, never public hosts');
 // Pin resolved address: no later DNS rebinding or accidentally public redirect.
 url.hostname=addresses[0].address.includes(':')?`[${addresses[0].address}]`:addresses[0].address;
 return url.href.replace(/\/$/,'');
}
function rssMiB(value){
 const values=[];
 function visit(v){
  if(!v||typeof v!=='object')return;
  for(const [key,item] of Object.entries(v)){
   if(typeof item==='number'&&Number.isFinite(item)&&item>=0&&/^rss(bytes|mib|mb)?$/i.test(key))values.push(/mib|mb/i.test(key)?item:item/1048576);
   else if(typeof item==='object')visit(item);
  }
 }
 visit(value);return values.length?values.reduce((a,b)=>a+b,0):null;
}
function checkRss(data,limit){
 const rss={api:rssMiB(data.api),media:rssMiB(data.media)};
 for(const [name,value] of Object.entries(rss)){
  if(value===null)throw Error('Missing RSS telemetry for '+name+'; safety cannot be enforced');
  if(value>limit){const error=Error('HARNESS SAFETY STOP: '+name+' RSS exceeds '+limit+' MiB (not a server crash)');error.code='HARNESS_SAFETY_STOP';throw error;}
 }
 return rss;
}
module.exports={batches,parseStages,validateTarget,rssMiB,checkRss};

function checkFreshness(data,maxAgeMs,state,now=Date.now()){
 for(const name of ['api','media']){
  const sample=data[name],old=state[name];
  if(!Number.isFinite(sample?.sampledAt)||sample.sampledAt>now+1000||now-sample.sampledAt>maxAgeMs||!Number.isSafeInteger(sample.sampleSequence)||sample.sampleSequence<1)throw Error('Missing or stale telemetry for '+name);
  if(old&&(sample.sampleSequence<old.sequence||sample.sampledAt<old.sampledAt||(sample.sampleSequence===old.sequence&&now-old.advancedAt>maxAgeMs)))throw Error('Non-advancing telemetry for '+name);
  if(!old||sample.sampleSequence>old.sequence)state[name]={sequence:sample.sampleSequence,sampledAt:sample.sampledAt,advancedAt:now};
 }
}
module.exports.checkFreshness=checkFreshness;

module.exports.bounded=bounded;
