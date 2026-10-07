require('./test-env');
const path=require('path');
test('tests allocate an isolated recording directory outside application files',()=>{
 expect(process.env.RECORDINGS_ROOT).toBeTruthy();
 expect(path.isAbsolute(process.env.RECORDINGS_ROOT)).toBe(true);
 expect(process.env.RECORDINGS_ROOT.startsWith(path.resolve(__dirname,'..'))).toBe(false);
});
