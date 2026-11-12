import flvjs from 'flv.js';
import mpegts from 'mpegts.js';

// One recovery timer per mount; never reset the budget on a transient success.
export function startLivePlayback(video: HTMLVideoElement, url: string | (() => string), onSuspended?: (suspended: boolean) => void, onError?: (message: string) => void, headers?: () => Record<string,string>) {
  // Match the maintained library's constructor-based selection (including iOS 26).
  // Keep the existing desktop transport unchanged. Never alias browser globals.
  const managed = typeof (window as Window & { ManagedMediaSource?: unknown }).ManagedMediaSource === 'function'
    && typeof window.MediaSource !== 'function';
  const engine = managed ? mpegts : flvjs;
  let player: flvjs.Player | mpegts.Player | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let retries = 0;
  let suspended = false;
  const release = () => {
    if (!player) return;
    const previous = player;
    player = undefined;
    previous.off(engine.Events.ERROR, recover);
    if (!video.paused) video.pause();
    previous.destroy();
  };
  const formatFailed = () => {
    suspended = true;
    clearTimeout(timer);
    timer = undefined;
    release();
    // Never display native/library errors: they may contain capability URLs.
    onError?.('Live video format is unsupported or could not be decoded. Update your browser or ask the broadcaster to use H.264/AAC.');
  };
  const recover = (_type?: string, detail?: string) => {
    if (disposed || suspended || timer) return;
    if (detail === 'FormatUnsupported' || detail === 'CodecUnsupported') { formatFailed(); return; }
    if (retries >= 3) { onError?.('Live playback failed. Please retry.'); return; }
    const delay = 1000 * 2 ** retries++;
    timer = setTimeout(() => {
      timer = undefined;
      release();
      if (!disposed) create();
    }, delay);
  };
  const onMediaError = () => {
    if (disposed || !video.error) return;
    if (video.error.code === 3 || video.error.code === 4) {
      formatFailed();
    } else recover();
  };
  const create = () => {
    try {
      if (!engine.isSupported()) { onError?.('Live playback is not supported in this browser. Update your browser or ask the broadcaster to use H.264/AAC.'); return; }
      video.playsInline = true;
      // No AirPlay/HLS alternative exists. MMS otherwise never opens on iPhone.
      if (managed) video.disableRemotePlayback = true;
      player = engine.createPlayer({ type: 'flv', isLive: true, url: typeof url === 'function' ? url() : url }, {
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 10,
        enableStashBuffer: false,
        lazyLoad: false,
        ...(headers ? { headers: headers() } : {}),
      });
      player.on(engine.Events.ERROR, recover);
      player.attachMediaElement(video);
      player.load();
      const current = player;
      void player.play()?.catch(() => { if (!disposed && player === current) suspend(); });
    } catch { formatFailed(); }
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
    // A queued teardown pause may arrive after replacement play(), or load()
    // may discard it altogether. Native current state, not an event debt,
    // distinguishes a stale notification from a real user pause.
    if (!video.paused) return;
    suspend();
  };
  video.addEventListener('error', onMediaError);
  video.addEventListener('pause', onPause);
  video.addEventListener('play', resume);
  video.addEventListener('waiting', catchUp);
  create();
  const dispose = () => {
    disposed = true;
    video.removeEventListener('error', onMediaError);
    video.removeEventListener('waiting', catchUp);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('play', resume);
    clearTimeout(timer);
    timer = undefined;
    release();
  };
  dispose.resume = resume;
  dispose.refresh = () => {
    if (disposed || suspended) return;
    release();
    create();
  };
  return dispose;
}
