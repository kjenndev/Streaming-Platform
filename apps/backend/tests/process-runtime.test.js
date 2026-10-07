const { ManagedProcesses, processTelemetry } = require('../lib/process-runtime');
test('managed children drain stderr and reject spawn failures without crashing',async()=>{
 const manager=new ManagedProcesses();
 const child=manager.run(process.execPath,['-e','process.stderr.write("x".repeat(200000));']);
 expect(await child.done).toBe(0);
 expect(child.stderrTail.length).toBeLessThanOrEqual(4096);
 const bad=manager.run('/not-a-real-executable',[]);await expect(bad.done).rejects.toThrow();
 await manager.stop(); expect(manager.size).toBe(0);
});
test('telemetry measures process counters rather than host load',()=>{
 const meter=processTelemetry();const sample=meter.sample();
 expect(sample.pid).toBe(process.pid);expect(sample.memory.rss).toBeGreaterThan(0);
 expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);expect(sample.eventLoop.p99Ms).toBeGreaterThanOrEqual(0);meter.close();
});

test('telemetry identifies actual sample freshness independent of reads',()=>{
 const meter=require('../lib/process-runtime').processTelemetry();
 try{
  const before=Date.now(),first=meter.sample(),second=meter.sample();
  expect(first.sampledAt).toBeGreaterThanOrEqual(before);
  expect(second.sampledAt).toBeGreaterThanOrEqual(first.sampledAt);
  expect(first.sampleSequence).toBe(1);expect(second.sampleSequence).toBe(2);
 }finally{meter.close();}
});
