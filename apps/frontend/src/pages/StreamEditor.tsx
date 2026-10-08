import type { Stream } from '../models';
import { fetchStreamCatalog } from '../pagination';
import { sessionExpired, subscribeSession } from '../session';
import React, { useState, useCallback, useEffect } from 'react';
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

// One interrupted draft, in memory only (may contain channel/provider secrets).
// Never auto-submit it or persist it to browser storage.
type StreamForm = typeof INITIAL_STREAM_STATE & { streamKey?: string };
let interruptedDraft: { owner: string; id?: string; form: StreamForm } | undefined;
let unsubscribeDraft: (() => void) | undefined;
function discardInterruptedDraft() {
  interruptedDraft = undefined;
  unsubscribeDraft?.();
  unsubscribeDraft = undefined;
}
const StreamEditorSession = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const owner = localStorage.getItem('username') || '';
  const [restoredDraft] = useState(() => interruptedDraft?.owner === owner && interruptedDraft?.id === id ? interruptedDraft : undefined);
  const [streamForm, setStreamForm] = useState<StreamForm>(restoredDraft?.form || INITIAL_STREAM_STATE);
  const abandoned = React.useRef(false);
  useEffect(() => {
    abandoned.current = false;
    // Transfer recovery into this editor once; later navigation discards local edits.
    // Clear mismatched recovery too, so another account/route cannot revive it.
    discardInterruptedDraft();
    return () => {
      // A pending save may reject after unmount. Only expiry may retain its draft.
      abandoned.current = !sessionExpired() || !!localStorage.getItem('token');
    };
  }, []);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const isEditMode = !!id;
  const token = localStorage.getItem('token');
  const toast = React.useRef<Toast>(null);

  const fetchStream = useCallback(async (signal: AbortSignal) => {
    if (signal.aborted) return;
    setFetching(true);
    try {
      const catalog = await fetchStreamCatalog<Stream>(`${API_BASE_URL}/api/streams`, token, signal);
      if (signal.aborted) return;
      const stream = catalog.find((s: { id: string }) => s.id === id);
      if (stream) {
        const restreamData = { ...INITIAL_RESTREAM_STATE };
        if (stream.restreamUrls && typeof stream.restreamUrls === 'object' && !Array.isArray(stream.restreamUrls)) {
          Object.keys(INITIAL_RESTREAM_STATE).forEach(platform => {
            const val = stream.restreamUrls?.[platform];
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
        setStreamForm({ ...INITIAL_STREAM_STATE, ...stream, isPasswordProtected: !!stream.isPasswordProtected, password: stream.password || '', restreamUrls: restreamData, isRecordingEnabled: !!stream.isRecordingEnabled });
      }
    } catch {
      if (!signal.aborted) toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to fetch channel details', life: 3000 });
    } finally {
      if (!signal.aborted) setFetching(false);
    }
  }, [id, token]);

  useEffect(() => {
    const controller = new AbortController();
    if (isEditMode && !restoredDraft) {
      void Promise.resolve().then(() => fetchStream(controller.signal));
    }
    return () => controller.abort();
  }, [fetchStream, isEditMode, restoredDraft]);



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
      discardInterruptedDraft();
      setTimeout(() => navigate('/dashboard'), 1000);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401 && owner && !localStorage.getItem('token') && sessionExpired() && !abandoned.current) {
        discardInterruptedDraft();
        interruptedDraft = { owner, id, form: streamForm };
        // Keep this listener only while recovery awaits consumption. Identity changes
        // can happen on the login/dashboard routes where the editor is unmounted.
        unsubscribeDraft = subscribeSession(change => {
          if (change instanceof StorageEvent) {
            if (change.storageArea && change.storageArea !== localStorage) return;
            // Storage events describe remote transitions; this tab's expiry reason
            // cannot classify them. Use event values, not a later storage snapshot:
            // queued logout/account-switch events must still discard after re-login.
            if (change.key === null ||
                (change.key === 'token' && change.newValue === null) ||
                (change.key === 'username' && change.newValue !== owner)) discardInterruptedDraft();
          }
          const currentOwner = localStorage.getItem('username');
          if (currentOwner !== owner && (currentOwner || !sessionExpired())) discardInterruptedDraft();
        });
      }
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
        } catch {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Error regenerating key', life: 3000 });
        }
      }
    });
  };

  const updateRestreamField = (platform: keyof typeof INITIAL_RESTREAM_STATE, field: string, value: string | boolean) => {
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

  const restreamPlatformInput = (platform: keyof typeof INITIAL_RESTREAM_STATE, label: string, urlPlaceholder: string) => {
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

          {restoredDraft && <p role="status">Unsaved draft restored. Review it before saving.</p>}
          <div className="flex flex-column gap-5">
          <Card className="shadow-none border-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
            <div className="flex flex-column gap-3">
              <div className="flex flex-column gap-2">
                <label className="font-bold" style={{ color: 'var(--text-h)' }}>Channel Name</label>
                <InputText value={streamForm.channelName} onChange={(e) => setStreamForm({ ...streamForm, channelName: e.target.value })} style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }} />
              </div>
              
              <div className="flex align-items-center gap-2">
                <Checkbox inputId="isProtected" checked={!!streamForm.isPasswordProtected} onChange={e => setStreamForm({ ...streamForm, isPasswordProtected: !!e.checked })} />
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

const StreamEditor = () => {
  const { id } = useParams();
  return <StreamEditorSession key={id || "new"} />;
};
export default StreamEditor;
