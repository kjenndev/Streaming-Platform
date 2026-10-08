import { afterEach, expect, it, vi } from 'vitest';
import flvjs from 'flv.js';
import { startLivePlayback } from '../livePlayback';
vi.mock('flv.js', () => ({ default: { isSupported: vi.fn(() => true), Events: { ERROR: 'error' }, createPlayer: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('bounds live buffers and coalesces error retries, disposing timers and listeners', () => {
  vi.useFakeTimers();
  const handlers: (() => void)[] = [];
  const players: { destroy: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> }[] = [];
  vi.mocked(flvjs.createPlayer).mockImplementation(() => {
    const player = { attachMediaElement: vi.fn(), load: vi.fn(), play: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(), off: vi.fn(), on: vi.fn((_event, handler) => handlers.push(handler)) };
    players.push(player);
    return player as unknown as flvjs.Player;
  });
  const dispose = startLivePlayback(document.createElement('video'), '/live/test.flv');
  expect(flvjs.createPlayer).toHaveBeenCalledWith(expect.objectContaining({ isLive: true }), expect.objectContaining({ autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 30, autoCleanupMinBackwardDuration: 10 }));
  for (let retry = 0; retry < 4; retry++) {
    for (let i = 0; i < 50; i++) handlers.at(-1)!();
    vi.advanceTimersByTime(10000);
  }
  expect(players).toHaveLength(4);
  dispose();
  vi.runAllTimers();
  expect(players.every(p => p.destroy.mock.calls.length === 1 && p.off.mock.calls.length === 1)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a pending retry when unmounted and recovers a lagged live edge', () => {
  vi.useFakeTimers();
  let error: () => void = () => {};
  const player = { attachMediaElement: vi.fn(), load: vi.fn(), play: vi.fn().mockResolvedValue(undefined), destroy: vi.fn(), off: vi.fn(), on: vi.fn((_event, handler) => { error = handler; }) };
  vi.mocked(flvjs.createPlayer).mockReturnValue(player as unknown as flvjs.Player);
  const video = document.createElement('video');
  Object.defineProperty(video, 'buffered', { value: { length: 1, end: () => 100 } });
  video.currentTime = 10;
  const dispose = startLivePlayback(video, '/live/test.flv');
  video.dispatchEvent(new Event('waiting'));
  expect(video.currentTime).toBe(98);
  error();
  expect(vi.getTimerCount()).toBe(1);
  dispose();
  vi.runAllTimers();
  expect(flvjs.createPlayer).toHaveBeenCalledTimes(1);
  video.currentTime = 1;
  video.dispatchEvent(new Event('waiting'));
  expect(video.currentTime).toBe(1);
});

it.each(['pause', 'autoplay'])('stops ingestion on %s and reconnects only on resume, cleaning all lifecycle handlers', async reason => {
 vi.useFakeTimers();
 const players: { destroy: ReturnType<typeof vi.fn> }[] = [];
 vi.mocked(flvjs.createPlayer).mockImplementation(() => {
  const player = { attachMediaElement: vi.fn(), load: vi.fn(), play: vi.fn().mockImplementation(() => reason === 'autoplay' && players.length === 1 ? Promise.reject(new Error('denied')) : Promise.resolve()), destroy: vi.fn(), off: vi.fn(), on: vi.fn() };
  players.push(player); return player as unknown as flvjs.Player;
 });
 const video = document.createElement('video');
 const dispose = startLivePlayback(video, '/live/test.flv');
 if (reason === 'pause') video.dispatchEvent(new Event('pause'));
 await Promise.resolve();
 expect(players[0].destroy).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(60000);
 expect(players).toHaveLength(1);
 video.dispatchEvent(new Event('play'));
 expect(players).toHaveLength(2);
 dispose();
 video.dispatchEvent(new Event('play'));
 vi.runAllTimers();
 expect(players).toHaveLength(2);
 expect(players[1].destroy).toHaveBeenCalledTimes(1);
 expect(vi.getTimerCount()).toBe(0);
});

it('exposes a resume action when detached native controls cannot play', async () => {
 const player = { attachMediaElement: vi.fn(), load: vi.fn(), play: vi.fn().mockRejectedValue(new Error('denied')), destroy: vi.fn(), off: vi.fn(), on: vi.fn() };
 vi.mocked(flvjs.createPlayer).mockReturnValue(player as unknown as flvjs.Player);
 const suspended = vi.fn();
 const dispose = startLivePlayback(document.createElement('video'), '/live/test.flv', suspended);
 await Promise.resolve();
 expect(suspended).toHaveBeenCalledWith(true);
 dispose.resume();
 expect(flvjs.createPlayer).toHaveBeenCalledTimes(2);
 dispose();
});

it('cancels a pending network recovery when paused and ignores old autoplay rejections', async () => {
 vi.useFakeTimers();
 let error!: () => void;
 let reject!: (error: Error) => void;
 const players: {destroy: ReturnType<typeof vi.fn>}[] = [];
 vi.mocked(flvjs.createPlayer).mockImplementation(() => {
  const player = {attachMediaElement: vi.fn(), load: vi.fn(), play: vi.fn().mockImplementation(() => players.length === 1 ? new Promise((_resolve, rejectPlay) => {reject = rejectPlay;}) : Promise.resolve()), destroy: vi.fn(), off: vi.fn(), on: vi.fn((_event, callback) => {error = callback;})};
  players.push(player); return player as unknown as flvjs.Player;
 });
 const video = document.createElement('video');
 const dispose = startLivePlayback(video, '/live/test.flv');
 error();
 video.dispatchEvent(new Event('pause'));
 vi.advanceTimersByTime(10000);
 expect(players).toHaveLength(1);
 dispose.resume();
 reject(new Error('old denial'));
 await Promise.resolve();
 expect(players[1].destroy).not.toHaveBeenCalled();
 dispose();
 expect(vi.getTimerCount()).toBe(0);
});

it('keeps replacement playback active after real flv destroy queues a native pause, then honors user pause', async () => {
 vi.useFakeTimers();
 const actual = await vi.importActual<typeof import('flv.js')>('flv.js');
 const video = document.createElement('video');
 let paused = true;
 Object.defineProperty(video, 'paused', {get: () => paused});
 video.play = vi.fn(async () => { paused = false; });
 video.pause = vi.fn(() => {
  if (paused) return;
  paused = true;
  setTimeout(() => video.dispatchEvent(new Event('pause')), 0);
 });
 const players: flvjs.Player[] = [];
 vi.mocked(flvjs.createPlayer).mockImplementation((source, config) => {
  const player = actual.default.createPlayer(source, config);
  // Isolate MSE/network, but execute flv.js's real play/unload/destroy path.
  const internals = player as unknown as {_mediaElement: HTMLMediaElement; _msectl: object; _transmuxer: object};
  player.attachMediaElement = element => {
   internals._mediaElement = element;
   internals._msectl = {seek: vi.fn(), detachMediaElement: vi.fn(), destroy: vi.fn()};
  };
  player.load = () => { internals._transmuxer = {close: vi.fn(), destroy: vi.fn()}; };
  players.push(player);
  return player;
 });
 const suspended = vi.fn();
 const dispose = startLivePlayback(video, '/live/test.flv', suspended);
 const emitter = players[0] as unknown as {_emitter: {emit: (event: string) => void}};
 emitter._emitter.emit(flvjs.Events.ERROR);
 await vi.advanceTimersByTimeAsync(1001);
 expect(players).toHaveLength(2);
 expect(video.paused).toBe(false);
 expect(suspended).not.toHaveBeenCalledWith(true);
 video.pause();
 await vi.advanceTimersByTimeAsync(1);
 expect(suspended).toHaveBeenCalledWith(true);
 dispose.resume();
 expect(video.paused).toBe(false);
 dispose();
 await vi.runAllTimersAsync();
 expect(vi.getTimerCount()).toBe(0);
});

it('reports unsupported playback and exhausted recovery to an optional embed error surface',()=>{
 const failed=vi.fn();
 vi.mocked(flvjs.isSupported).mockReturnValueOnce(false);
 const unsupported=startLivePlayback(document.createElement('video'),'/fixture.flv',undefined,failed);
 expect(failed).toHaveBeenCalledWith('Live playback is not supported in this browser.');
 unsupported();failed.mockClear();vi.useFakeTimers();
 let error:()=>void=()=>{};
 vi.mocked(flvjs.createPlayer).mockImplementation(()=>({attachMediaElement:vi.fn(),load:vi.fn(),play:vi.fn().mockResolvedValue(undefined),destroy:vi.fn(),off:vi.fn(),on:vi.fn((_event,handler)=>{error=handler;})}) as unknown as flvjs.Player);
 const dispose=startLivePlayback(document.createElement('video'),'/fixture.flv',undefined,failed);
 for(let i=0;i<4;i++){error();vi.advanceTimersByTime(10000);}
 expect(failed).toHaveBeenCalledWith('Live playback failed. Please retry.');
 dispose();
});
