require('./test-env');
const Redis=require('ioredis'),crypto=require('crypto');
const {createPasswordBudget}=require('../lib/password-budget');
const redis=new Redis(process.env.REDIS_URL),prefix='budget-test:'+crypto.randomUUID();
afterAll(async()=>{await redis.del(prefix+':counts',prefix+':expires');await redis.quit();});
test('atomic concurrent budget, independent client/channel, bounded state, expiry and no sliding denial',async()=>{
 const take=createPasswordBudget(redis,{prefix,windowMs:200,limit:2,maxEntries:3});
 const results=await Promise.all(Array.from({length:8},()=>take('192.0.2.1','one')));expect(results.filter(x=>x.ok)).toHaveLength(2);
 expect((await take('192.0.2.2','one')).ok).toBe(true);expect((await take('192.0.2.1','two')).ok).toBe(true);
 expect((await take('192.0.2.3','three')).status).toBe(503);expect(await redis.zcard(prefix+':expires')).toBe(3);
 await new Promise(r=>setTimeout(r,230));expect((await take('192.0.2.1','one')).ok).toBe(true);expect(await redis.zcard(prefix+':expires')).toBe(1);
 expect((await take('::ffff:192.0.2.1','one')).ok).toBe(true);expect((await take('192.0.2.1','one')).status).toBe(429);
});
test('failure, stalled Redis and invalid address fail closed with retry',async()=>{
 for(const evalFn of [()=>Promise.reject(Error('offline')),()=>new Promise(()=>{})]){
 const take=createPasswordBudget({eval:evalFn},{timeoutMs:10});expect(await take('192.0.2.1','one')).toMatchObject({ok:false,status:503,retryAfter:1});
 }
 expect(await createPasswordBudget(redis)('spoofed','one')).toMatchObject({ok:false,status:503});
});
