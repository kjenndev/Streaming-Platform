import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import StatusMessage from '../components/StatusMessage';
import { API_BASE_URL } from '../config';

const SharePlayer = () => {
  const { id } = useParams();
  const [recording, setRecording] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetchRecording();
  }, [id]);

  const fetchRecording = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/public/recordings/${id}`);
      setRecording(res.data);
    } catch (err) {
      console.error('Recording not found');
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: any) => {
    if (!bytes) return '0 B';
    const s = ['B', 'KB', 'MB', 'GB', 'TB'];
    const e = Math.floor(Math.log(Number(bytes)) / Math.log(1024));
    return (Number(bytes) / Math.pow(1024, e)).toFixed(2) + " " + s[e];
  };

  if (loading) return <div className="p-4 text-white">Loading recording...</div>;

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

  const videoUrl = `${API_BASE_URL}${recording.filePath}`;
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

export default SharePlayer;
