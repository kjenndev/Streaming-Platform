const {ChannelState}=require('../lib/channel-state');
test('delayed old publisher shutdown cannot clear replacement Redis or DB state',async()=>{
 const state=new ChannelState(),db={isLive:false},redis={};let release;
 const first=state.start('a','old',async()=>{await new Promise(r=>release=r);db.isLive=true;redis.id='old';});
 await Promise.resolve();await Promise.resolve();
 const replacement=state.start('a','new',async()=>{db.isLive=true;redis.id='new';});
 const oldEnd=state.end('a','old',async()=>{db.isLive=false;delete redis.id;});
 release();await Promise.all([first,replacement,oldEnd]);
 expect(db.isLive).toBe(true);expect(redis.id).toBe('new');expect(state.isOwner('a','new')).toBe(true);
 await state.end('a','new',async()=>{db.isLive=false;delete redis.id;});
 expect(db.isLive).toBe(false);expect(redis.id).toBeUndefined();expect(state.size).toBe(0);
});
