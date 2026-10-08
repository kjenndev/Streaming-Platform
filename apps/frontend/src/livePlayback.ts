import flvjs from 'flv.js';

// One recovery timer per mount; never reset the budget on a transient success.
export function startLivePlayback(video: HTMLVideoElement, url: string | (() => string), onSuspended?: (suspended: boolean) => void, onError?: (message: string) => void) {
  let player: flvjs.Player | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let retries = 0;
  let suspended = false;
  let teardownPauses = 0;
  const release = () => {
    if (!player) return;
    const previous = player;
    player = undefined;
    previous.off(flvjs.Events.ERROR, recover);
    // pause() changes paused synchronously but delivers its event later, possibly
    // after a replacement has started. Own precisely that queued event.
    if (!video.paused) {
      teardownPauses++;
      video.pause();
    }
    previous.destroy();
  };
  const recover = () => {
    if (disposed || suspended || timer) return;
    if (retries >= 3) { onError?.('Live playback failed. Please retry.'); return; }
    const delay = 1000 * 2 ** retries++;
    timer = setTimeout(() => {
      timer = undefined;
      release();
      if (!disposed) create();
    }, delay);
  };
  const create = () => {
    if (!flvjs.isSupported()) { onError?.('Live playback is not supported in this browser.'); return; }
    player = flvjs.createPlayer({ type: 'flv', isLive: true, url: typeof url === 'function' ? url() : url }, {
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 10,
      enableStashBuffer: false,
      lazyLoad: false,
    });
    player.on(flvjs.Events.ERROR, recover);
    player.attachMediaElement(video);
    player.load();
    const current = player;
    void player.play()?.catch(() => { if (!disposed && player === current) suspend(); });
  };
  const catchUp = () => {
    if (disposed || !video.buffered.length) return;
    const edge = video.buffered.end(video.buffered.length - 1);
    if (edge - video.currentTime > 15) video.currentTime = Math.max(0, edge - 2);
  };
  const suspend = () => {
    if (disposed || !player) return;
    suspended = true;
    clearTimeout(timer);
    timer = undefined;
    release();
    onSuspended?.(true);
  };
  const resume = () => {
    if (disposed || !suspended) return;
    suspended = false;
    onSuspended?.(false);
    create();
  };
  const onPause = () => {
    if (teardownPauses > 0) { teardownPauses--; return; }
    suspend();
  };
  video.addEventListener('pause', onPause);
  video.addEventListener('play', resume);
  video.addEventListener('waiting', catchUp);
  create();
  const dispose = () => {
    disposed = true;
    video.removeEventListener('waiting', catchUp);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('play', resume);
    clearTimeout(timer);
    timer = undefined;
    release();
  };
  dispose.resume = resume;
  return dispose;
}
