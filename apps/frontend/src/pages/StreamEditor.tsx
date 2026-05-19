import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { Checkbox } from 'primereact/checkbox';
import { InputSwitch } from 'primereact/inputswitch';
import { Card } from 'primereact/card';
import { Toast } from 'primereact/toast';
import { confirmDialog } from 'primereact/confirmdialog';
import axios from 'axios';
import Header from '../components/Header';
import { API_BASE_URL, RTMP_INGEST_BASE } from '../config';

const INITIAL_RESTREAM_STATE = {
  twitch: { url: '', key: '', enabled: false },
  facebook: { url: '', key: '', enabled: false },
  tiktok: { url: '', key: '', enabled: false },
  instagram: { url: '', key: '', enabled: false },
  custom: { url: '', key: '', enabled: false }
};

const INITIAL_STREAM_STATE = { 
  channelName: '', 
  isPasswordProtected: false, 
  isRecordingEnabled: false,
  password: '', 
  restreamUrls: INITIAL_RESTREAM_STATE 
};

const StreamEditor = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [streamForm, setStreamForm] = useState<any>(INITIAL_STREAM_STATE);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const isEditMode = !!id;
  const token = localStorage.getItem('token');
  const toast = React.useRef<Toast>(null);

  useEffect(() => {
    if (isEditMode) {
      fetchStream();
    }
  }, [id]);

  const fetchStream = async () => {
    setFetching(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/api/streams`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const stream = response.data.find((s: any) => s.id === id);
      if (stream) {
        let restreamData = { ...INITIAL_RESTREAM_STATE };
        if (stream.restreamUrls && typeof stream.restreamUrls === 'object' && !Array.isArray(stream.restreamUrls)) {
          Object.keys(INITIAL_RESTREAM_STATE).forEach(platform => {
            const val = stream.restreamUrls[platform];
            if (typeof val === 'string') {
              restreamData[platform as keyof typeof INITIAL_RESTREAM_STATE] = { url: val, key: '', enabled: true };
            } else if (val && typeof val === 'object') {
              restreamData[platform as keyof typeof INITIAL_RESTREAM_STATE] = { 
                url: val.url || '', 
                key: val.key || '', 
                enabled: val.enabled !== false 
              };
            }
          });
        }
        setStreamForm({ ...stream, restreamUrls: restreamData, isRecordingEnabled: !!stream.isRecordingEnabled });
      }
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to fetch channel details', life: 3000 });
    } finally {
      setFetching(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.current?.show({ severity: 'success', summary: 'Copied', detail: 'Copied to clipboard', life: 2000 });
  };

  const saveStream = async () => {
    setLoading(true);
    try {
      if (isEditMode) {
        await axios.put(`${API_BASE_URL}/api/streams/${id}`, streamForm, {
          headers: { Authorization: `Bearer ${token}` }
        });
        toast.current?.show({ severity: 'success', summary: 'Updated', detail: 'Channel updated successfully', life: 3000 });
      } else {
        await axios.post(`${API_BASE_URL}/api/streams`, streamForm, {
          headers: { Authorization: `Bearer ${token}` }
        });
        toast.current?.show({ severity: 'success', summary: 'Created', detail: 'Channel created successfully', life: 3000 });
      }
      setTimeout(() => navigate('/dashboard'), 1000);
    } catch (err) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Error saving channel', life: 3000 });
    } finally {
      setLoading(false);
    }
  };

  const regenerateKey = async () => {
    confirmDialog({
      message: 'Are you sure you want to regenerate the channel key? The current one will stop working immediately.',
      header: 'Regenerate Key',
      icon: 'pi pi-refresh',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        try {
          const payload = { ...streamForm, regenerateKey: true };
          const res = await axios.put(`${API_BASE_URL}/api/streams/${id}`, payload, {
            headers: { Authorization: `Bearer ${token}` }
          });
          setStreamForm({ ...streamForm, streamKey: res.data.streamKey });
          toast.current?.show({ severity: 'success', summary: 'Regenerated', detail: 'New channel key generated', life: 3000 });
        } catch (err) {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Error regenerating key', life: 3000 });
        }
      }
    });
  };

  const updateRestreamField = (platform: string, field: string, value: any) => {
    setStreamForm({
      ...streamForm,
      restreamUrls: {
        ...streamForm.restreamUrls,
        [platform]: {
          ...streamForm.restreamUrls[platform],
          [field]: value
        }
      }
    });
  };

  const restreamPlatformInput = (platform: string, label: string, urlPlaceholder: string) => {
    const config = streamForm.restreamUrls[platform];
    const isEnabled = config.enabled !== false;
    const isCustom = platform === 'custom';
    
    return (
      <div className="col-12 mb-4" key={platform} style={{ opacity: isEnabled ? 1 : 0.6, transition: 'opacity 0.2s' }}>
        <div className="flex justify-content-between align-items-center mb-2">
          <label className="text-xs uppercase font-bold" style={{ color: isEnabled ? 'var(--blue)' : 'var(--base01)' }}>{label}</label>
          <div className="flex align-items-center gap-2">
            <small style={{ color: 'var(--base01)' }}>{isEnabled ? 'Enabled' : 'Disabled'}</small>
            <InputSwitch 
              checked={isEnabled} 
              onChange={(e) => updateRestreamField(platform, 'enabled', e.value)} 
              className="p-inputswitch-sm"
            />
          </div>
        </div>
        <div className="grid">
          {isCustom && (
            <div className="col-12 md:col-6">
              <InputText 
                disabled={!isEnabled}
                value={config.url || ''} 
                onChange={(e) => updateRestreamField(platform, 'url', e.target.value)} 
                placeholder={urlPlaceholder} 
                className="w-full p-inputtext-sm"
                style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} 
              />
              <small className="text-xs" style={{ color: 'var(--base01)' }}>Server URL</small>
            </div>
          )}
          <div className={isCustom ? "col-12 md:col-6" : "col-12"}>
            <InputText 
              disabled={!isEnabled}
              value={config.key || ''} 
              onChange={(e) => updateRestreamField(platform, 'key', e.target.value)} 
              placeholder="Channel Key" 
              className="w-full p-inputtext-sm"
              style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} 
            />
            <small className="text-xs" style={{ color: 'var(--base01)' }}>Channel Key</small>
          </div>
        </div>
      </div>
    );
  };

  if (fetching) return <div className="p-4 text-white">Loading...</div>;

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
      <Header />
      <div className="p-3 md:p-6" style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div className="flex align-items-center gap-3 mb-5">
            <Button icon="pi pi-arrow-left" className="p-button-text p-button-sm text-white" onClick={() => navigate('/dashboard')} />
            <h2 className="m-0" style={{ color: 'var(--text-h)' }}>{isEditMode ? 'Edit Channel' : 'New Channel'}</h2>
          </div>

          <div className="flex flex-column gap-5">
          <Card className="shadow-none border-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
            <div className="flex flex-column gap-3">
              <div className="flex flex-column gap-2">
                <label className="font-bold" style={{ color: 'var(--text-h)' }}>Channel Name</label>
                <InputText value={streamForm.channelName} onChange={(e) => setStreamForm({ ...streamForm, channelName: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
              </div>
              
              <div className="flex align-items-center gap-2">
                <Checkbox inputId="isProtected" checked={!!streamForm.isPasswordProtected} onChange={e => setStreamForm({ ...streamForm, isPasswordProtected: e.checked })} />
                <label htmlFor="isProtected" style={{ color: 'var(--text-h)' }}>Password Protected</label>
              </div>
              
              {streamForm.isPasswordProtected && (
                <div className="flex flex-column gap-2">
                  <label className="font-bold" style={{ color: 'var(--text-h)' }}>Channel Password</label>
                  <InputText type="password" value={streamForm.password || ''} onChange={(e) => setStreamForm({ ...streamForm, password: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
                </div>
              )}

              <div className="flex align-items-center gap-2 border-top-1 pt-3" style={{ borderColor: 'var(--base01)' }}>
                <InputSwitch inputId="isRecording" checked={!!streamForm.isRecordingEnabled} onChange={e => setStreamForm({ ...streamForm, isRecordingEnabled: e.value })} />
                <label htmlFor="isRecording" style={{ color: 'var(--text-h)', fontWeight: 'bold' }}>Enable Automated Recording</label>
              </div>
            </div>
          </Card>

          <Card title="Restream Settings" className="shadow-none border-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)', color: 'var(--text-h)' }}>
            <div className="grid">
              {restreamPlatformInput('twitch', 'Twitch', 'rtmp://live.twitch.tv/app/')}
              {restreamPlatformInput('facebook', 'Facebook', 'rtmps://live-api-s.facebook.com:443/rtmp/')}
              {restreamPlatformInput('tiktok', 'TikTok', 'rtmp://...')}
              {restreamPlatformInput('instagram', 'Instagram', 'rtmps://...')}
              {restreamPlatformInput('custom', 'Custom Channel URL', 'rtmp://...')}
            </div>
          </Card>

          {isEditMode && (
            <Card title="OBS Connection Details" className="shadow-none border-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)', color: 'var(--text-h)' }}>
              <div className="flex flex-column gap-3">
                <div className="flex flex-column gap-2">
                  <label className="text-sm font-bold">Server URL</label>
                  <div className="flex gap-2">
                    <InputText readOnly value={RTMP_INGEST_BASE} className="flex-grow-1 p-inputtext-sm" style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
                    <Button icon="pi pi-copy" onClick={() => copyToClipboard(RTMP_INGEST_BASE)} className="p-button-sm" tooltip="Copy URL" />
                  </div>
                </div>
                <div className="flex flex-column gap-2">
                  <label className="text-sm font-bold">Channel Key</label>
                  <div className="flex gap-2">
                    <InputText readOnly value={`${streamForm.channelName}?key=${streamForm.streamKey}`} className="flex-grow-1 p-inputtext-sm" style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
                    <Button icon="pi pi-copy" onClick={() => copyToClipboard(`${streamForm.channelName}?key=${streamForm.streamKey}`)} className="p-button-sm" tooltip="Copy Key" />
                  </div>
                </div>
                <div className="mt-2 border-top-1 pt-3" style={{ borderColor: 'var(--base01)' }}>
                  <label className="block mb-2 font-bold text-xs uppercase" style={{ color: 'var(--red)' }}>Danger Zone</label>
                  <Button label="Regenerate Channel Key" icon="pi pi-refresh" className="p-button-danger p-button-sm p-button-outlined w-full" onClick={regenerateKey} />
                  <small className="block mt-1 text-center" style={{ color: 'var(--base01)' }}>The current key will stop working immediately.</small>
                </div>
              </div>
            </Card>
          )}

          <div className="flex gap-2 justify-content-end mb-4">
            <Button label="Cancel" icon="pi pi-times" className="p-button-text text-white" onClick={() => navigate('/dashboard')} />
            <Button label={isEditMode ? 'Update Channel' : 'Create Channel'} icon="pi pi-check" onClick={saveStream} loading={loading} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default StreamEditor;
