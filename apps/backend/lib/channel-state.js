// Per-channel durable-state serialization. A newly admitted generation takes
// ownership immediately; queued work for an old generation becomes a no-op.
class ChannelState {
 constructor(){this.owners=new Map();this.pending=new Map();}
 get size(){return this.owners.size;}
 isOwner(channel,id){return this.owners.get(channel)===id;}
 enqueue(channel,id,operation,ending=false){
  const previous=this.pending.get(channel) || Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
   if(!this.isOwner(channel,id))return;
   try {await operation();}finally{if(ending && this.isOwner(channel,id))this.owners.delete(channel);}
  });
  this.pending.set(channel,next);
  next.finally(()=>{if(this.pending.get(channel)===next)this.pending.delete(channel);}).catch(()=>{});
  return next;
 }
 start(channel,id,operation){this.owners.set(channel,id);return this.enqueue(channel,id,operation);}
 end(channel,id,operation){return this.enqueue(channel,id,operation,true);}
}
module.exports={ChannelState};
