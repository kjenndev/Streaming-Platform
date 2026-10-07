'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {saveEvidence}=require('./evidence.cjs');
test('atomic checkpoint replaces only owned output and retains last valid JSON on failed serialization',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evidence-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'result.json');fs.writeFileSync(file,'');saveEvidence(file,{stage:1});saveEvidence(file,{stage:2});
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{stage:2});const circular={};circular.self=circular;
 assert.throws(()=>saveEvidence(file,circular));assert.deepEqual(JSON.parse(fs.readFileSync(file)),{stage:2});
 assert.equal(fs.statSync(file).mode&0o777,0o600);assert.deepEqual(fs.readdirSync(dir),['result.json']);
});
