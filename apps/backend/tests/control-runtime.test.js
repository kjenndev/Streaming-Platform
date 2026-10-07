const { pageQuery, scopedStats, Membership, chatAllowed, serialCollector } = require('../lib/control-runtime');
test('pagination is bounded and rejects pathological inputs', () => {
 expect(pageQuery({limit:'999999',offset:'-1'})).toEqual({take:100,skip:0});
 expect(pageQuery({})).toEqual({take:50,skip:0});
});
test('viewer stats contain only its channel compact public fields', () => {
 expect(scopedStats({a:{viewers:2,isPublishing:true,isDisabled:false,lastStartedAt:null,usernames:['secret'],bitrate:42},b:{viewers:99}},'a')).toEqual({streams:{a:{viewers:2,isPublishing:true,isDisabled:false,lastStartedAt:null}}});
});

test('membership is idempotent across duplicates switches and disconnect', async () => {
 const m = new Membership();
 const socket = {id:'1',data:{},join:jest.fn(),leave:jest.fn()};
 expect(m.join(socket,'a','one')).toBe(true);
 expect(m.join(socket,'a','one')).toBe(false);
 expect(m.counts()).toEqual({a:1});
 m.join(socket,'b','one');
 expect(m.counts()).toEqual({b:1});
 expect(m.viewers('b',0,10)).toEqual([{username:'one'}]);
 m.leave(socket); m.leave(socket);
 expect(m.counts()).toEqual({});
});

test('chat enforces membership length and five messages per ten seconds', () => {
 const s={data:{currentChannel:'a'}};
 expect(chatAllowed(s,'b','hi',0)).toBe(false);
 expect(chatAllowed(s,'a','x'.repeat(501),0)).toBe(false);
 for(let i=0;i<5;i++) expect(chatAllowed(s,'a','hi',0)).toBe(true);
 expect(chatAllowed(s,'a','hi',1)).toBe(false);
 expect(chatAllowed(s,'a','hi',10000)).toBe(true);
});

test('collector skips overlapping ticks and can be drained', async () => {
 let finish; let calls=0;
 const collector=serialCollector(async()=>{calls++;await new Promise(r=>finish=r);},100000);
 const first=collector.tick(); await Promise.resolve();
 await collector.tick(); expect(calls).toBe(1);
 finish(); await first; await collector.stop();
 await collector.tick(); expect(calls).toBe(1);
});
