function pageQuery(query = {}) {
 const integer = (v, fallback) => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : fallback;
 return {take: Math.max(1,Math.min(100,integer(query.limit,50))),skip:Math.min(1000000,integer(query.offset,0))};
}
function scopedStats(stats, channel) {
 const s = stats[channel] || {};
 return {streams: {[channel]: {viewers:s.viewers || 0,isPublishing:!!s.isPublishing,isDisabled:!!s.isDisabled,lastStartedAt:s.lastStartedAt || null}}};
}
class Membership {
 constructor() { this.channels = new Map(); }
 join(socket, channel, username) {
  if (socket.data.currentChannel === channel && socket.data.username === username) return false;
  const taken = this.channels.get(channel)?.get(username);
  if (taken && taken !== socket.id) throw new Error('Username already in use');
  this.leave(socket);
  if (!this.channels.has(channel)) this.channels.set(channel,new Map());
  this.channels.get(channel).set(username,socket.id);
  socket.data.currentChannel=channel; socket.data.username=username; socket.join(`channel:${channel}`); return true;
 }
 leave(socket) {
  const channel=socket.data.currentChannel;
  if (!channel) return false;
  const users=this.channels.get(channel);
  users?.delete(socket.data.username);
  if (!users?.size) this.channels.delete(channel);
  socket.leave(`channel:${channel}`); socket.data.currentChannel=null; return true;
 }
 counts() { return Object.fromEntries([...this.channels].map(([ch,users])=>[ch,users.size])); }
 viewers(channel,skip,take) {
  const result=[]; let index=0;
  for (const username of this.channels.get(channel)?.keys() || []) { if(index++<skip) continue; if(result.length>=take) break; result.push({username}); }
  return result;
 }
}
function chatAllowed(socket, channel, message, now=Date.now()) {
 if(socket.data.currentChannel!==channel || typeof message!=='string' || !message.trim() || message.length>500) return false;
 let bucket=socket.data.chatBucket;
 if(!bucket || now-bucket.start>=10000) bucket=socket.data.chatBucket={start:now,count:0};
 if(bucket.count>=5) return false;
 bucket.count++; return true;
}
function serialCollector(collect, interval=2000, onError=console.error) {
 let pending=null, stopped=false;
 const tick=()=>{if(stopped || pending) return Promise.resolve(); pending=Promise.resolve().then(collect).catch(onError).finally(()=>{pending=null;});return pending;};
 const timer=setInterval(tick,interval); timer.unref?.();
 return {tick,async stop(){stopped=true;clearInterval(timer);await pending;}};
}
module.exports = {pageQuery, scopedStats, Membership, chatAllowed, serialCollector};
