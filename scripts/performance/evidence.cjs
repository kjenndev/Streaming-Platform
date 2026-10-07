'use strict';
const fs=require('node:fs');const {randomUUID}=require('node:crypto');
// filename must first be exclusively reserved by prepareOutput().
function saveEvidence(filename,report){
 const data=JSON.stringify(report,null,2),temporary=filename+'.'+randomUUID()+'.tmp';
 let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,filename);}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
module.exports={saveEvidence};
