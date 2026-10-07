import type { Recording } from '../models';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { Card } from 'primereact/card';
import { InputText } from 'primereact/inputtext';
import { Button } from 'primereact/button';
import StatusMessage from '../components/StatusMessage';
import { API_BASE_URL } from '../config';

const SharePlayerSession = () => {
  const { id } = useParams();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState('');
  const [cap, setCap] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [mediaCap, setMediaCap] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef<number | null>(null);
  const unlockRequest = useRef<AbortController | null>(null);
  useEffect(() => () => unlockRequest.current?.abort(), []);
  const unlock = async () => {
    unlockRequest.current?.abort();
    const controller = new AbortController(); unlockRequest.current = controller;
    setUnlocking(true);
    try {
      const result = await axios.post(`${API_BASE_URL}/api/public/recordings/${id}/playback`, { password }, { signal: controller.signal });
      if (!controller.signal.aborted) { setCap(result.data.cap); setPassword(''); setLocked(false); setError(false); setLoading(true); }
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setUnlocking(false); }
  };

  const fetchRecording = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`${API_BASE_URL}/api/public/recordings/${id}${cap ? `?cap=${encodeURIComponent(cap)}` : ''}`, { signal, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
      if (!signal.aborted) { setRecording(res.data); setMediaCap(cap || res.data.playbackCap || ''); setError(false); setLocked(false); }
    } catch (failure) {
      if (!signal.aborted) {
        if ((failure as {response?:{status:number}})?.response?.status === 403) setLocked(true);
        else setError(true);
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [id, cap]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => fetchRecording(controller.signal));
    return () => controller.abort();
  }, [fetchRecording]);



  useEffect(() => {
    if (!mediaCap || locked) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expiry = setTimeout(() => { controller.abort(); setLocked(true); }, 120000);
    const renew = () => {
      void axios.post(`${API_BASE_URL}/api/public/recordings/${id}/playback`, { cap: mediaCap }, { signal: controller.signal, timeout: 10000 })
        .then(result => {
          if (controller.signal.aborted) return;
          resumeAt.current = videoRef.current?.currentTime || 0;
          setMediaCap(result.data.cap);
        }).catch((failure: {response?:{status:number}}) => {
          if (controller.signal.aborted) return;
          if ([401, 403].includes(failure.response?.status || 0)) setLocked(true);
          else timer = setTimeout(renew, 10000);
        });
    };
    timer = setTimeout(renew, 60000);
    return () => { clearTimeout(timer); clearTimeout(expiry); controller.abort(); };
  }, [id, mediaCap, locked]);

  const formatFileSize = (bytes: string | number) => {
    if (!bytes) return '0 B';
    const s = ['B', 'KB', 'MB', 'GB', 'TB'];
    const e = Math.floor(Math.log(Number(bytes)) / Math.log(1024));
    return (Number(bytes) / Math.pow(1024, e)).toFixed(2) + " " + s[e];
  };

  if (loading) return <div className="p-4 text-white">Loading recording...</div>;

  if (locked) return <Card title="Protected recording">
    <InputText type="password" placeholder="Recording password" value={password} onChange={event => setPassword(event.target.value)} />
    <Button label="Unlock recording" disabled={unlocking} onClick={() => { void unlock(); }} />
    {error && <p>Unable to unlock this recording.</p>}
  </Card>;

  if (error || !recording) {
    return (
      <StatusMessage 
        title="Recording Unavailable"
        icon="pi pi-exclamation-circle"
        iconColor="var(--red)"
        message="The recording you are looking for does not exist or has been removed."
        actionLabel="Go to Login"
        onAction={() => window.location.href = '/login'}
      />
    );
  }

  const credential = mediaCap;
  const videoUrl = `${API_BASE_URL}${recording.filePath}${credential ? `?cap=${encodeURIComponent(credential)}` : ''}`;
  const title = recording.title || `Broadcast: ${new Date(recording.startedAt).toLocaleString()}`;

  return (
    <div className="min-h-screen flex flex-column" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="p-3 border-bottom-1 flex justify-content-between align-items-center shadow-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
        <h1 className="m-0 text-xl font-bold cursor-pointer" style={{ color: 'var(--blue)' }} onClick={() => window.location.href = '/'}>Streaming Platform</h1>
        <Button label="Login" icon="pi pi-sign-in" className="p-button-text text-white p-button-sm" onClick={() => window.location.href = '/login'} />
      </div>

      <div className="flex-grow-1 flex align-items-center justify-content-center p-3">
        <Card style={{ width: '100%', maxWidth: '1000px' }} className="shadow-8 border-1 border-white-alpha-10 bg-gray-900 overflow-hidden">
          <div className="flex flex-column gap-3">
            <div className="aspect-video" style={{ backgroundColor: '#000', borderRadius: '4px', overflow: 'hidden' }}>
              <video 
                ref={videoRef}
                onLoadedMetadata={() => { if (resumeAt.current !== null && videoRef.current) { videoRef.current.currentTime = resumeAt.current; resumeAt.current = null; } }}
                onError={() => { if (mediaCap) setLocked(true); }}
                src={videoUrl} 
                controls 
                autoPlay 
                className="w-full h-full"
                style={{ maxHeight: '70vh' }}
              />
            </div>
            
            <div className="px-2 pb-2">
              <div className="flex justify-content-between align-items-start mb-2">
                <div>
                  <h2 className="m-0 text-2xl" style={{ color: 'var(--text-h)' }}>{title}</h2>
                  <p className="m-0 text-sm mt-1" style={{ color: 'var(--base01)' }}>
                    Originally aired on <span className="font-bold" style={{ color: 'var(--blue)' }}>{recording.stream?.channelName}</span>
                  </p>
                </div>
                <div className="text-right text-xs" style={{ color: 'var(--base01)' }}>
                  <div>Recorded: {new Date(recording.startedAt).toLocaleString()}</div>
                  <div>Duration: {Math.floor(recording.duration / 60)}m {recording.duration % 60}s | {formatFileSize(recording.fileSize)}</div>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

const SharePlayer = () => {
  const { id } = useParams();
  return <SharePlayerSession key={id} />;
};
export default SharePlayer;
