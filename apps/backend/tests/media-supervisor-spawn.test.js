const {EventEmitter}=require('events');
jest.mock('child_process',()=>({fork:jest.fn()}));
const {fork}=require('child_process');
const {superviseMedia}=require('../lib/media-supervisor');
test('spawn error and close without exit cannot leave stop pending',async()=>{
 jest.useFakeTimers();
 const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,connected:false,kill:jest.fn()});
 fork.mockReturnValue(child);
 const media=superviseMedia({env:{},onMessage:()=>{}});const ready=expect(media.ready).rejects.toThrow('spawn failed');
 child.emit('error',new Error('spawn failed'));await ready;
 let stopped=false;const stop=media.stop().then(()=>{stopped=true;});
 child.emit('close',-2);await jest.advanceTimersByTimeAsync(31000);
 try{expect(stopped).toBe(true);await stop;}finally{jest.clearAllTimers();jest.useRealTimers();}
});
