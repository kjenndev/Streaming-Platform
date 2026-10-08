const {createHash}=require('crypto');
const {isIP}=require('net');
const {ipKeyGenerator}=require('express-rate-limit');
// One atomic reservation BEFORE password comparison, shared by every transport.
// Fixed window; successful guesses remain charged. Neither failures nor denials
// extend the window. Global cardinality cap fails closed rather than evicting debt.
const LUA=`
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local expired=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now,'LIMIT',0,256)
for _,key in ipairs(expired) do redis.call('HDEL',KEYS[2],key); redis.call('ZREM',KEYS[1],key) end
local ending=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]))
if ending and ending<=now then redis.call('HDEL',KEYS[2],ARGV[1]);redis.call('ZREM',KEYS[1],ARGV[1]);ending=nil end
if not ending then
 if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) then return {-1,ARGV[3]} end
 ending=now+tonumber(ARGV[3]);redis.call('ZADD',KEYS[1],ending,ARGV[1])
end
local count=tonumber(redis.call('HGET',KEYS[2],ARGV[1]) or '0')
if count>=tonumber(ARGV[2]) then return {0,ending-now} end
redis.call('HINCRBY',KEYS[2],ARGV[1],1)
redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[3])*2);redis.call('PEXPIRE',KEYS[2],tonumber(ARGV[3])*2)
return {1,ending-now}
`;
function createPasswordBudget(redis,{prefix='channel-password:v1',limit=20,windowMs=60000,maxEntries=10000,timeoutMs=1000}={}){
 return async(address,streamId)=>{
  if(typeof address!=='string' || !isIP(address) || typeof streamId!=='string')return {ok:false,status:503,code:'PASSWORD_LIMIT_UNAVAILABLE',retryAfter:1};
  const normalized=address.startsWith('::ffff:')&&isIP(address.slice(7))===4?address.slice(7):address;
  const key=createHash('sha256').update(JSON.stringify([ipKeyGenerator(normalized),streamId])).digest('hex');
  let timer;
  try{
   const result=await Promise.race([redis.eval(LUA,2,prefix+':expires',prefix+':counts',key,limit,windowMs,maxEntries),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('deadline')),timeoutMs);})]);
   const [allowed,remaining]=result;
   if(allowed===1)return {ok:true};
   return {ok:false,status:allowed===0?429:503,code:allowed===0?'PASSWORD_RATE_LIMITED':'PASSWORD_LIMIT_UNAVAILABLE',retryAfter:Math.max(1,Math.ceil(Number(remaining)/1000))};
  }catch{return {ok:false,status:503,code:'PASSWORD_LIMIT_UNAVAILABLE',retryAfter:1};}finally{clearTimeout(timer);}
 };
}
module.exports={createPasswordBudget};
