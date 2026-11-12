import {afterEach, expect, it, vi} from 'vitest';
import {startLivePlayback} from '../livePlayback';

// Capability-shaped MMS fixture, not WebKit: real library/source selection and
// HTTP loader, with synthetic MediaSource and pending FLV response.
class ManagedSource extends EventTarget {
 static instances: ManagedSource[] = [];
 static isTypeSupported = vi.fn(() => true);
 readyState = 'closed';
 streaming = true;
 constructor() { super(); ManagedSource.instances.push(this); }
 endOfStream() { this.readyState = 'ended'; }
 open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
}
afterEach(()=>{ vi.unstubAllGlobals(); vi.restoreAllMocks(); ManagedSource.instances=[]; ManagedSource.isTypeSupported.mockReset().mockReturnValue(true); });
function setup() {
 vi.stubGlobal('MediaSource',undefined);
 vi.stubGlobal('ManagedMediaSource',ManagedSource);
 const request = vi.fn((url: RequestInfo | URL, options?: RequestInit) => {
  void url; void options;
  return new Promise<Response>(()=>{});
 });
 vi.stubGlobal('fetch',request);
 const video=document.createElement('video');
 video.load=vi.fn(); video.play=vi.fn().mockResolvedValue(undefined); video.pause=vi.fn();
 return {video,request};
}
it('MMS-only starts the real FLV loader with header-only grants, refreshes and detaches',async()=>{
 const {video,request}=setup(); const error=vi.fn(); let cap='fixture-first';
 const dispose=startLivePlayback(video,'/mss-live/fixture.flv',undefined,error,()=>({'X-MSS-Playback':cap}));
 try {
 expect(ManagedSource.instances).toHaveLength(1);
 expect(video.playsInline).toBe(true);
 expect(video.disableRemotePlayback).toBe(true);
 expect(video.srcObject).toBe(ManagedSource.instances[0]);
 expect(window.MediaSource).toBeUndefined();
 ManagedSource.instances[0].open();
 await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(1));
 expect(request.mock.calls[0][0]).toBe('/mss-live/fixture.flv');
 expect(new Headers(request.mock.calls[0][1]?.headers).get('X-MSS-Playback')).toBe(cap);
 // mpegts explicitly keeps live transmuxing running across MMS hints.
 ManagedSource.instances[0].dispatchEvent(new Event('endstreaming'));
 ManagedSource.instances[0].dispatchEvent(new Event('startstreaming'));
 expect(request).toHaveBeenCalledTimes(1);
 cap='fixture-renewed'; dispose.refresh();
 expect(ManagedSource.instances).toHaveLength(2);
 ManagedSource.instances[0].dispatchEvent(new Event('startstreaming'));
 ManagedSource.instances[1].open();
 await vi.waitFor(()=>expect(request).toHaveBeenCalledTimes(2));
 expect(new Headers(request.mock.calls[1][1]?.headers).get('X-MSS-Playback')).toBe(cap);
 expect(error).not.toHaveBeenCalled();
 } finally {dispose();}
 expect(video.srcObject).toBeNull();
 ManagedSource.instances.at(-1)!.dispatchEvent(new Event('startstreaming'));
 expect(request).toHaveBeenCalledTimes(2);
});

it('rejects unsupported MMS codecs with an actionable message and no request',()=>{
 const {video,request}=setup(); ManagedSource.isTypeSupported.mockReturnValue(false);
 const error=vi.fn(); const dispose=startLivePlayback(video,'/fixture.flv',undefined,error);
 expect(error).toHaveBeenCalledWith(expect.stringMatching(/Update.*browser.*H\.264.*AAC/));
 expect(request).not.toHaveBeenCalled(); expect(ManagedSource.instances).toHaveLength(0); dispose();
});
it('reports native unsupported media without leaking URL or capability and stops ingestion',()=>{
 const {video}=setup(); const error=vi.fn();
 const dispose=startLivePlayback(video,'/fixture.flv?cap=secret-fixture',undefined,error);
 try {
 Object.defineProperty(video,'error',{value:{code:4,message:'secret-fixture'}});
 video.dispatchEvent(new Event('error'));
 expect(error).toHaveBeenCalledWith(expect.stringMatching(/format.*unsupported.*H\.264.*AAC/));
 expect(error.mock.calls.flat().join(' ')).not.toContain('secret-fixture');
 expect(video.srcObject).toBeNull();
 } finally {dispose();}
});

it('real MMS library reports invalid stream bytes as unsupported instead of silent black',async()=>{
 const {video,request}=setup();
 request.mockResolvedValue(new Response(new Uint8Array(4096),{status:200}));
 const failed=vi.fn();const dispose=startLivePlayback(video,'/invalid.flv',undefined,failed);
 try {
 ManagedSource.instances[0].open();
 await vi.waitFor(()=>expect(failed).toHaveBeenCalledWith(expect.stringMatching(/format.*unsupported/)));
 expect(video.srcObject).toBeNull();
 } finally {dispose();}
});
it('real MMS blocked play tears down and explicit resume creates a fresh live source',async()=>{
 const {video}=setup();vi.mocked(video.play).mockRejectedValueOnce(new DOMException('blocked','NotAllowedError'));
 const suspended=vi.fn();const dispose=startLivePlayback(video,'/fixture.flv',suspended);
 try {
 await vi.waitFor(()=>expect(suspended).toHaveBeenCalledWith(true));
 expect(video.srcObject).toBeNull();
 dispose.resume();
 expect(ManagedSource.instances).toHaveLength(2);
 expect(video.srcObject).toBe(ManagedSource.instances[1]);
 expect(suspended).toHaveBeenLastCalledWith(false);
 } finally {dispose();}
});
