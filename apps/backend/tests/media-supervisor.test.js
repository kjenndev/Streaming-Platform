require('./test-env');
const {superviseMedia}=require('../lib/media-supervisor');
test('initial child failure rejects readiness and can be stopped without restart leaks',async()=>{
 const media=superviseMedia({env:{BIND_HOST:'256.256.256.256'},onMessage:()=>{}});
 let timer;
 try{await expect(Promise.race([media.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('readiness stayed pending')),2500);})])).rejects.toThrow('before readiness');}finally{clearTimeout(timer);await media.stop();}
},10000);
