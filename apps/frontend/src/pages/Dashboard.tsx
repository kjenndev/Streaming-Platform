import { mergeStats } from '../dashboardStats';
import type { Stream, Recording, Restream, ChannelStats, LiveStats } from '../models';
import type { Socket } from 'socket.io-client';
import type { DataTableExpandedRows } from 'primereact/datatable';
import { fetchPage } from '../pagination';
import PagedItems from '../components/PagedItems';
import { useState, useCallback, useEffectEvent, useEffect, useRef } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Checkbox } from 'primereact/checkbox';
import { TabView, TabPanel } from 'primereact/tabview';
import { io } from 'socket.io-client';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { Toast } from 'primereact/toast';
import { confirmDialog } from 'primereact/confirmdialog';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import Header from '../components/Header';
import StatCard from '../components/StatCard';
import ConnectionInfoCard from '../components/ConnectionInfoCard';
import { API_BASE_URL, SOCKET_URL } from '../config';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const Dashboard = () => {
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const [streamOffset, setStreamOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [streamTotal, setStreamTotal] = useState(0);
  const [recordingGeneration, setRecordingGeneration] = useState(0);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [liveStats, setLiveStats] = useState<Record<string, ChannelStats>>({});
  const [totalRestreams, setTotalRestreams] = useState(0);
  const [showOffline, setShowOffline] = useState(true);
  const [telemetry, setTelemetry] = useState<LiveStats["telemetry"]>();
  const [throughputHistory, setThroughputHistory] = useState<(number | null)[]>(new Array(30).fill(null));
  const [restreamThroughputHistory, setRestreamThroughputHistory] = useState<number[]>(new Array(30).fill(0));
  const [cpuHistory, setCpuHistory] = useState<(number | null)[]>(new Array(30).fill(null));
  const [expandedRows, setExpandedRows] = useState<DataTableExpandedRows | Stream[] | null>(null);
  const [displayInfoDialog, setDisplayInfoDialog] = useState(false);
  const [displayRecordingDialog, setDisplayRecordingDialog] = useState(false);
  const [displayRenameDialog, setDisplayRenameDialog] = useState(false);
  const [selectedStream, setSelectedStream] = useState<Stream | null>(null);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);
  const [newRecordingTitle, setNewRecordingTitle] = useState('');
  const [sort, setSort] = useState<'live-first' | 'name'>('live-first');
  const [globalFilter, setGlobalFilter] = useState<string>('');
  const [serverInfo, setServerInfo] = useState({ hostname: 'localhost', rtmpPort: 1935, mediaPort: 8000 });
  
  const toast = useRef<Toast>(null);
  const token = localStorage.getItem('token');
  const rolesStr = localStorage.getItem('roles');
  
  let roles: string[] = [];
  if (rolesStr) {
    try {
      roles = JSON.parse(rolesStr);
    } catch {
      roles = [];
    }
  }

  // Fallback for legacy sessions
  if (roles.length === 0) {
    const oldRole = localStorage.getItem('role');
    if (oldRole) roles = [oldRole];
  }

  const normalizedRoles = roles.map(r => r.toUpperCase());
  const isAdmin = normalizedRoles.includes('ADMIN');
  const isClient = normalizedRoles.includes('CLIENT');
  
  const socketRef = useRef<Socket | null>(null);
  const invalidatePage = useRef<(() => void) | null>(null);
  const streamRequest = useRef<AbortController | null>(null);

  const fetchServerInfo = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/info`);
      setServerInfo(response.data);
    } catch {
      console.error('Failed to fetch server info');
    }
  }, []);

  const fetchStreams = useCallback(async (offset = streamOffset) => {
    streamRequest.current?.abort();
    const controller = new AbortController();
    streamRequest.current = controller;
    try {
      const page = await fetchPage<Stream>(`${API_BASE_URL}/api/streams`, token, offset, controller.signal, { search: globalFilter, hideOffline: !showOffline, sort });
      if (controller.signal.aborted) return;
      const data = page.items;
      setStreamOffset(offset);
      setNextOffset(page.next);
      setStreamTotal(page.total);
      setStreams(data);
      setNow(Date.now());
    } catch {
      if (controller.signal.aborted) return;
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to fetch streams', life: 3000 });
    }
  }, [token, streamOffset, globalFilter, showOffline, sort]);

  const refreshStreams = useEffectEvent(() => { void fetchStreams(); });
  useEffect(() => {
    let active = true;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let dirty = false;
    const load = async () => {
      poll = undefined;
      if (!active) return;
      loading = true;
      dirty = false;
      await fetchStreams();
      loading = false;
      if (!active) return;
      if (dirty) poll = setTimeout(load, 250);
      else if (!isAdmin) poll = setTimeout(load, 5000);
    };
    invalidatePage.current = () => {
      if (!active || !isAdmin || (showOffline && sort === 'name')) return;
      dirty = true;
      if (!loading && !poll) poll = setTimeout(load, 250);
    };
    void Promise.resolve().then(() => { if (active) { void load(); void fetchServerInfo(); } });
    return () => { active = false; invalidatePage.current = null; clearTimeout(poll); streamRequest.current?.abort(); };
  }, [fetchStreams, fetchServerInfo, isAdmin, showOffline, sort]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      auth: { token }
    });
    socketRef.current = socket;

    let publishingSignature: string | undefined;
    socket.on('live_stats', (data: LiveStats) => {
      if (!data) return;
      const stats = data.streams || {};
      if (data.streams) {
        // Admin snapshots cover the whole catalog, including rows off this page.
        // Server live-first ordering is publishing status followed by name.
        const signature = JSON.stringify(Object.keys(stats).filter(name => stats[name].isPublishing).sort());
        if (signature !== publishingSignature) invalidatePage.current?.();
        publishingSignature = signature;
      }
      const metrics = data.telemetry;
      setTelemetry(metrics);

      setLiveStats(stats);
      setTotalRestreams(data.totalRestreams || 0);

      const totalThroughput = metrics?.media?.egressBitsPerSecond == null ? null : metrics.media.egressBitsPerSecond / 1000;
      setThroughputHistory(prev => [...prev.slice(1), totalThroughput]);
      setRestreamThroughputHistory(prev => [...prev.slice(1), data.totalRestreamThroughput || 0]);
      setCpuHistory(prev => [...prev.slice(1), metrics?.api?.cpuPercent == null || metrics.media?.cpuPercent == null ? null : metrics.api.cpuPercent + metrics.media.cpuPercent]);

      setStreams(previous => mergeStats(previous, stats));
      setNow(Date.now());
    });

    let recordingRefresh: ReturnType<typeof setTimeout> | undefined;
    socket.on('recording_saved', () => {
      if (recordingRefresh) return;
      recordingRefresh = setTimeout(() => { recordingRefresh = undefined; setRecordingGeneration(v => v + 1); refreshStreams(); }, 500);
    });

    return () => {
      clearTimeout(recordingRefresh);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [token]);





  const openNew = () => {
    navigate('/dashboard/stream');
  };

  const editStream = (stream: Stream) => {
    navigate(`/dashboard/stream/${stream.id}`);
  };

  const showInfo = (stream: Stream) => {
    setSelectedStream(stream);
    setDisplayInfoDialog(true);
  };

  const deleteStream = async (id: string) => {
    confirmDialog({
      message: 'Are you sure you want to delete this channel?',
      header: 'Delete Confirmation',
      icon: 'pi pi-exclamation-triangle',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        try {
          await axios.delete(`${API_BASE_URL}/api/streams/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          toast.current?.show({ severity: 'success', summary: 'Deleted', detail: 'Channel deleted successfully', life: 3000 });
          fetchStreams();
        } catch {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to delete channel', life: 3000 });
        }
      }
    });
  };

  const playRecording = (recording: Recording) => {
    setSelectedRecording(recording);
    setDisplayRecordingDialog(true);
  };

  const deleteRecording = async (recording: Recording) => {
    confirmDialog({
      message: 'Are you sure you want to PERMANENTLY delete this recording? This cannot be undone.',
      header: 'Delete Recording',
      icon: 'pi pi-trash',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        try {
          await axios.delete(`${API_BASE_URL}/api/recordings/${recording.id}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          toast.current?.show({ severity: 'success', summary: 'Deleted', detail: 'Recording removed', life: 3000 });
          setRecordingGeneration(v => v + 1);
          fetchStreams();
        } catch {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to delete recording', life: 3000 });
        }
      }
    });
  };

  const editRecording = (recording: Recording) => {
    setSelectedRecording(recording);
    setNewRecordingTitle(recording.title || '');
    setDisplayRenameDialog(true);
  };

  const saveRecordingTitle = async () => {
    try {
      await axios.put(`${API_BASE_URL}/api/recordings/${selectedRecording!.id}`, {
        title: newRecordingTitle
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.current?.show({ severity: 'success', summary: 'Updated', detail: 'Recording renamed', life: 2000 });
      setDisplayRenameDialog(false);
      setRecordingGeneration(v => v + 1);
      fetchStreams();
    } catch {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to rename recording', life: 3000 });
    }
  };

  const downloadRecording = async (recording: Recording) => {
    try {
      toast.current?.show({ severity: 'info', summary: 'Starting Download', detail: 'Preparing your file...', life: 2000 });
      
      const response = await axios.get(`${API_BASE_URL}/api/recordings/${recording.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob'
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      
      const downloadName = recording.title ? `${recording.title}.mp4` : recording.fileName;
      link.setAttribute('download', downloadName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.current?.show({ severity: 'error', summary: 'Download Failed', detail: 'Could not download recording', life: 3000 });
    }
  };

  const formatFileSize = (bytes: string | number) => {
    if (!bytes) return '0 B';
    const s = ['B', 'KB', 'MB', 'GB', 'TB'];
    const e = Math.floor(Math.log(Number(bytes)) / Math.log(1024));
    return (Number(bytes) / Math.pow(1024, e)).toFixed(2) + " " + s[e];
  };

  const kickUser = (channelName: string, username: string) => {
    confirmDialog({
      message: `Are you sure you want to kick ${username} from ${channelName}?`,
      header: 'Kick User',
      icon: 'pi pi-user-minus',
      acceptClassName: 'p-button-danger',
      accept: () => {
        socketRef.current?.emit('kick_user', { channelName, username });
        toast.current?.show({ severity: 'info', summary: 'User Kicked', detail: `${username} was removed from the channel`, life: 3000 });
      }
    });
  };

  const rowExpansionTemplate = (data: Stream) => {
    
    return (
      <div className="p-2" style={{ backgroundColor: 'var(--base03)' }}>
        <TabView className="compact-tabs">
          <TabPanel header={`Viewers (${data.viewers || 0})`} leftIcon="pi pi-users mr-2">
            <PagedItems<{ username: string }> url={`${API_BASE_URL}/api/streams/${data.id}/viewers`} token={token}>{users => (
            <div className="p-3">
              {users.length === 0 ? (
                <div className="text-sm italic" style={{ color: 'var(--base01)' }}>No active viewers.</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {users.map((user, i: number) => (
                    <div key={i} className="flex align-items-center gap-3 p-2 border-round border-1" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
                      <span className="text-sm font-bold" style={{ color: 'var(--blue)' }}>{user.username}</span>
                      {isAdmin && (
                        <Button 
                          icon="pi pi-user-minus" 
                          className="p-button-danger p-button-sm p-button-text" 
                          tooltip="Kick User" 
                          onClick={() => kickUser(data.channelName, user.username)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}</PagedItems>
          </TabPanel>
          <TabPanel header="Recordings" leftIcon="pi pi-video mr-2">
            <PagedItems<Recording> generation={recordingGeneration} url={`${API_BASE_URL}/api/streams/${data.id}/recordings`} token={token}>{recordings => (
            <div className="p-3">
              {recordings.length === 0 ? (
                <div className="text-sm italic" style={{ color: 'var(--base01)' }}>No recordings available.</div>
              ) : (
                <div className="grid">
                  {recordings.map((rec: Recording) => (
                    <div key={rec.id} className="col-12 md:col-6 lg:col-4">
                      <div 
                        className="p-3 border-round border-1" 
                        style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}
                      >
                        <div className="flex align-items-center gap-3">
                          <i 
                            className="pi pi-play-circle text-2xl cursor-pointer hover:text-blue-400" 
                            style={{ color: 'var(--blue)' }}
                            onClick={() => playRecording(rec)}
                            title="Play Recording"
                          ></i>
                          <div className="flex-grow-1 overflow-hidden">
                            <div className="font-bold text-sm truncate" style={{ color: 'var(--text-h)' }}>
                              {rec.title || new Date(rec.startedAt).toLocaleString()}
                            </div>
                            <div className="text-xs" style={{ color: 'var(--base01)' }}>
                              {Math.floor(rec.duration / 60)}m {rec.duration % 60}s | {formatFileSize(rec.fileSize)}
                            </div>
                          </div>
                          <div className="flex gap-1">
                            <Button icon="pi pi-pencil" className="p-button-text p-button-secondary p-button-xs" onClick={() => editRecording(rec)} tooltip="Rename" />
                            <Button icon="pi pi-share-alt" className="p-button-text p-button-help p-button-xs" onClick={() => {
                              const link = `${window.location.origin}/share/${rec.id}`;
                              copyToClipboard(link);
                            }} tooltip="Share Recording" />
                            <Button icon="pi pi-download" className="p-button-text p-button-info p-button-xs" onClick={() => downloadRecording(rec)} tooltip="Download" />
                            {isAdmin && (
                              <Button icon="pi pi-trash" className="p-button-text p-button-danger p-button-xs" onClick={() => deleteRecording(rec)} tooltip="Delete" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}</PagedItems>
          </TabPanel>
        </TabView>
      </div>
    );
  };

  const statusBody = (rowData: Stream) => {
    if (rowData.isDisabled) {
      return (
        <span style={{ color: 'var(--base01)', fontWeight: 'bold', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <i className="pi pi-ban" style={{ fontSize: '0.5rem' }}></i>
          DISABLED
        </span>
      );
    }
    const isLive = rowData.isPublishing;
    return (
      <span className={`status-badge ${isLive ? 'status-live' : 'status-offline'}`}
            style={{ 
              color: isLive ? 'var(--green)' : 'var(--red)',
              fontWeight: 'bold',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'center',
              gap: '5px'
            }}>
        <i className="pi pi-circle-fill" style={{ fontSize: '0.5rem' }}></i>
        {isLive ? 'LIVE' : 'OFFLINE'}
      </span>
    );
  };

  const watchersBody = (rowData: Stream) => {
    const count = rowData.viewers || 0;
    return (
      <div className="flex align-items-center gap-2">
        <i className="pi pi-users" style={{ color: count > 0 ? 'var(--blue)' : 'var(--base01)' }}></i>
        <span>{count}</span>
      </div>
    );
  };

  const formatDuration = (startTime: number) => {
    if (!startTime) return '00:00:00';
    const seconds = Math.floor((now - startTime) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
  };

  const onAirBody = (rowData: Stream) => {
    if (!rowData.isPublishing || !rowData.startTime) return <span style={{ color: 'var(--base01)' }}>--:--:--</span>;
    return <span className="font-mono" style={{ color: 'var(--blue)' }}>{formatDuration(rowData.startTime)}</span>;
  };

  const lastStartedBody = (rowData: Stream) => {
    const time = rowData.lastStartedAt;
    if (!time) return <span style={{ color: 'var(--base01)' }}>Never</span>;
    return <span>{new Date(time).toLocaleString()}</span>;
  };

  const restreamsBody = (rowData: Stream) => {
    const restreams = rowData.restreamUrls || {};
    if (typeof restreams !== 'object' || Array.isArray(restreams)) return <span>0</span>;
    
    // Count enabled restreams with necessary info
    const count = Object.entries(restreams).filter(([platform, config]: [string, Restream]) => {
      const isEnabled = config.enabled === true;
      const hasKey = !!config.key?.trim();
      const hasUrl = platform === 'custom' ? !!config.url?.trim() : true; 
      return isEnabled && hasKey && hasUrl;
    }).length;

    return (
      <div className="flex align-items-center gap-2">
        <i className="pi pi-external-link" style={{ color: count > 0 ? 'var(--green)' : 'var(--base01)' }}></i>
        <span>{count}</span>
      </div>
    );
  };

  const stopStream = (stream: Stream) => {
    confirmDialog({
      message: `Are you sure you want to FORCE STOP the channel for ${stream.channelName}? This will disconnect the broadcaster immediately.`,
      header: 'Force Stop Channel',
      icon: 'pi pi-power-off',
      acceptClassName: 'p-button-danger',
      accept: () => {
        socketRef.current?.emit('stop_publishing', { channelName: stream.channelName });
        toast.current?.show({ severity: 'warn', summary: 'Channel Stopped', detail: `Sent stop signal to ${stream.channelName}`, life: 3000 });
      }
    });
  };

  const toggleStreamEnabled = async (stream: Stream) => {
    try {
      const newState = !stream.isDisabled;
      await axios.put(`${API_BASE_URL}/api/streams/${stream.id}`, {
        ...stream,
        isDisabled: newState
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.current?.show({ 
        severity: 'info', 
        summary: newState ? 'Channel Disabled' : 'Channel Enabled', 
        detail: `${stream.channelName} has been ${newState ? 'disabled' : 'enabled'}`, 
        life: 3000 
      });
      fetchStreams();
    } catch {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to toggle channel status', life: 3000 });
    }
  };

  const actionBody = (rowData: Stream) => {
    if (isClient) {
      const isOffline = !rowData.isPublishing || rowData.isDisabled;
      return (
        <div className="flex justify-content-end pr-2">
          <Button 
            icon="pi pi-play" 
            label="Watch Channel"
            disabled={isOffline}
            tooltip={rowData.isDisabled ? 'Channel is disabled' : (isOffline ? 'Channel is currently offline' : '')}
            tooltipOptions={{ position: 'left' }}
            className="p-button-primary p-button-sm" 
            onClick={() => window.open(`/watch/${rowData.channelName}`, '_blank')} 
          />
        </div>
      );
    }

    return (
      <div className="flex gap-2 justify-content-end pr-2">
        {isAdmin && rowData.isPublishing && (
          <Button 
            icon="pi pi-power-off" 
            tooltip="Force Stop Channel" 
            tooltipOptions={{ position: 'top' }}
            className="p-button-danger p-button-sm p-button-text" 
            onClick={() => stopStream(rowData)} 
          />
        )}
        {isAdmin && (
          <Button 
            icon={`pi ${rowData.isDisabled ? 'pi-check-circle' : 'pi-ban'}`}
            tooltip={rowData.isDisabled ? "Enable Channel" : "Disable Channel"}
            tooltipOptions={{ position: 'top' }}
            className={`p-button-sm p-button-text ${rowData.isDisabled ? 'p-button-success' : 'p-button-secondary'}`} 
            onClick={() => toggleStreamEnabled(rowData)} 
          />
        )}
        <Button 
          icon="pi pi-play" 
          tooltip="Watch Channel" 
          tooltipOptions={{ position: 'top' }}
          className="p-button-primary p-button-sm p-button-text" 
          onClick={() => window.open(`/watch/${rowData.channelName}`, '_blank')} 
        />
        <Button 
          icon="pi pi-info-circle" 
          tooltip="Connection Info" 
          tooltipOptions={{ position: 'top' }}
          className="p-button-info p-button-sm p-button-text" 
          onClick={() => showInfo(rowData)} 
        />
        <Button 
          icon="pi pi-pencil" 
          tooltip="Edit Channel" 
          tooltipOptions={{ position: 'top' }}
          className="p-button-warning p-button-sm p-button-text" 
          onClick={() => editStream(rowData)} 
        />
        {isAdmin && (
          <Button 
            icon="pi pi-trash" 
            tooltip="Delete Channel" 
            tooltipOptions={{ position: 'top' }}
            className="p-button-danger p-button-sm p-button-text" 
            onClick={() => deleteStream(rowData.id)} 
          />
        )}
      </div>
    );
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.current?.show({ severity: 'success', summary: 'Copied', detail: 'Copied to clipboard', life: 2000 });
  };

  const throughputChartData = {
    labels: new Array(30).fill(''),
    datasets: [
      {
        label: 'Media network egress (accepted Kbps)',
        data: throughputHistory,
        borderColor: '#268bd2',
        backgroundColor: 'rgba(38, 139, 210, 0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      },
    ],
  };

  const restreamThroughputChartData = {
    labels: new Array(30).fill(''),
    datasets: [
      {
        label: 'Estimated restream throughput',
        data: restreamThroughputHistory,
        borderColor: '#d33682',
        backgroundColor: 'rgba(211, 54, 130, 0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      },
    ],
  };

  const cpuChartData = {
    labels: new Array(30).fill(''),
    datasets: [
      {
        label: 'API + media core CPU',
        data: cpuHistory,
        borderColor: '#859900',
        backgroundColor: 'rgba(133, 153, 0, 0.1)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
      },
    ],
  };

  const commonChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true }
    },
    scales: {
      y: {
        display: true,
        beginAtZero: true,
        grid: { color: 'rgba(147, 161, 161, 0.05)' },
        ticks: { 
          color: '#ffffff',
          font: { size: 9 },
          maxTicksLimit: 3
        }
      },
      x: {
        display: false
      }
    }
  };

  const renderHeader = () => {
    return (
      <div className="flex justify-content-between align-items-center p-3" style={{ backgroundColor: '#1f2937', borderBottom: 'none' }}>
        <div className="flex gap-2">
          {isAdmin && (
            <Button label="New Channel" icon="pi pi-plus" className="p-button-sm" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={openNew} />
          )}
        </div>
        <div className="flex align-items-center gap-4">
          <select aria-label="Sort channels" value={sort} onChange={e => { setStreamOffset(0); setExpandedRows(null); setSort(e.target.value as 'live-first' | 'name'); }}>
            <option value="live-first">Live first</option>
            <option value="name">Channel name</option>
          </select>
          <div className="flex align-items-center gap-2">
            <Checkbox inputId="showOffline" checked={showOffline} onChange={e => { setStreamOffset(0); setExpandedRows(null); setShowOffline(e.checked || false); }} />
            <label htmlFor="showOffline" className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Show Offline</label>
          </div>
          <span className="p-input-icon-left">
            <i className="pi pi-search" style={{ color: 'var(--base01)', left: '0.75rem' }} />
            <InputText 
              type="search" 
              value={globalFilter} 
              onChange={(e) => { setStreamOffset(0); setExpandedRows(null); setGlobalFilter(e.target.value); }}
              placeholder="Search Channels..." 
              className="p-inputtext-sm"
              style={{ 
                backgroundColor: 'var(--bg)', 
                color: 'var(--text)', 
                borderColor: 'var(--base01)', 
                width: '250px',
                paddingLeft: '2.5rem' 
              }}
            />
          </span>
        </div>
      </div>
    );
  };

  const metric = (value: number | undefined, divisor = 1) => value == null ? '—' : (value / divisor).toFixed(1);

  const rtmpIngestUrl = `rtmp://${serverInfo.hostname}:${serverInfo.rtmpPort}/live`;
  const webPlayerUrl = `${window.location.protocol}//${serverInfo.hostname}${window.location.port ? ':'+window.location.port : ''}/watch/${selectedStream?.channelName}`;

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
      <Toast ref={toast} />
      <Header />
      
      <div className="p-4">
        {isAdmin && (
          <div className="grid m-0 px-2">
            <div className="col-12 md:col-2">
              <StatCard 
                label="Active Channels" 
                value={Object.values(liveStats || {}).filter((s: ChannelStats) => s.isPublishing).length}
                valueColor="var(--blue)" 
              />
            </div>
            <div className="col-12 md:col-2">
              <StatCard 
                label="Active Restreams" 
                value={totalRestreams} 
                valueColor="var(--green)" 
              />
            </div>
            <div className="col-12 md:col-2">
              <StatCard 
                label="Total Channels" 
                value={streamTotal}
              />
            </div>
            <div className="col-12 md:col-2">
              <StatCard 
                label="API + Media CPU (100% = 1 core)"
                chart={<Line data={cpuChartData} options={{...commonChartOptions, scales: {...commonChartOptions.scales, y: {...commonChartOptions.scales.y, ticks: {...commonChartOptions.scales.y.ticks, callback: (v: string | number) => `${v}%`}}}}} />}
                chartValue={cpuHistory.at(-1) == null ? "Unavailable" : `${cpuHistory.at(-1)!.toFixed(1)}%`}
                chartColor="var(--green)"
              />
            </div>
            <div className="col-12 md:col-2">
              <StatCard 
                label="Media network egress (accepted)"
                chart={<Line data={throughputChartData} options={{...commonChartOptions, scales: {...commonChartOptions.scales, y: {...commonChartOptions.scales.y, ticks: {...commonChartOptions.scales.y.ticks, callback: (v: string | number) => `${v}k`}}}}} />}
                chartValue={throughputHistory.at(-1) == null ? "Unavailable" : `${throughputHistory.at(-1)!.toFixed(1)} Kbps`}
                chartColor="var(--blue)"
              />
            </div>
            <div className="col-12 md:col-2">
              <StatCard 
                label="Restream throughput (estimated)"
                chart={<Line data={restreamThroughputChartData} options={{...commonChartOptions, scales: {...commonChartOptions.scales, y: {...commonChartOptions.scales.y, ticks: {...commonChartOptions.scales.y.ticks, callback: (v: string | number) => `${v}k`}}}}} />}
                chartValue={`${restreamThroughputHistory[restreamThroughputHistory.length - 1] || 0} Kbps`}
                chartColor="var(--magenta)"
              />
            </div>
          </div>
        )}

        {isAdmin && <details className="mx-3 mt-3 text-sm border-1 border-round" style={{ borderColor: 'var(--base01)' }} aria-label="Process telemetry">
          <summary className="p-3 font-medium" style={{ cursor: 'pointer', color: 'var(--text-h)' }}>Performance details</summary>
          <div className="px-3 pb-3 flex flex-column gap-2">
          <div>API RSS: {metric(telemetry?.api?.memory?.rss, 1048576)} MiB · Event loop p99: {metric(telemetry?.api?.eventLoop?.p99Ms)} ms · CPU: {metric(telemetry?.api?.cpuPercent)}%</div>
          {telemetry?.media ? <>
            <div>Media RSS: {metric(telemetry.media.memory?.rss, 1048576)} MiB · Event loop p99: {metric(telemetry.media.eventLoop?.p99Ms)} ms · CPU: {metric(telemetry.media.cpuPercent)}%</div>
            <div>Slow disconnects: {telemetry.media.mediaSafety?.slowDisconnects ?? '—'} · Queues: {metric(telemetry.media.mediaSafety?.queuedBytes, 1048576)} MiB · reserved: {metric(telemetry.media.mediaSafety?.currentQueuedBytes, 1048576)} MiB · peak: {metric(telemetry.media.mediaSafety?.peakQueuedBytes, 1048576)} MiB</div>
          </> : <div>Media telemetry unavailable</div>}
          <small>CPU covers API and media Node processes, not FFmpeg; 100% is one core. Egress is accepted network bytes, not confirmed delivery. Queues exclude kernel buffers; reservations include pending writes. Restream throughput is estimated.</small>
          </div>
        </details>}

        <div className="mt-4 px-3">
          <DataTable 
            value={streams}
            responsiveLayout="scroll" 
            className="shadow-none border-1" 
            style={{ borderColor: 'var(--base01)' }}
            expandedRows={expandedRows ?? undefined}
            onRowToggle={(e) => setExpandedRows(e.data)}
            rowExpansionTemplate={rowExpansionTemplate}
            dataKey="id"
            paginator 
            rows={5}
            header={renderHeader()}
          >
            <Column expander style={{ width: '3em' }} headerStyle={{ backgroundColor: '#1f2937', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column field="channelName" header="Channel Name" headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }} />
            <Column header="Status" body={statusBody} headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column header="Watchers" body={watchersBody} headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column header="On Air" body={onAirBody} headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column header="Last Started" body={lastStartedBody} headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column header="Restreams" body={restreamsBody} headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)' }} />
            <Column header="" body={actionBody} headerStyle={{ backgroundColor: '#1f2937', color: 'var(--text-h)', textAlign: 'right', border: 'none' }} bodyStyle={{ backgroundColor: 'var(--bg)', textAlign: 'right' }} />
          </DataTable>
          <div className="flex gap-2 p-2">
            <Button label="Previous channels" disabled={streamOffset === 0} onClick={() => { setExpandedRows(null); setStreamOffset(Math.max(0, streamOffset - 50)); }} />
            <span>{streamOffset + 1}–{streamOffset + streams.length} of {streamTotal}</span>
            <Button label="Next channels" disabled={nextOffset === null} onClick={() => { setExpandedRows(null); setStreamOffset(nextOffset!); }} />
          </div>
        </div>
      </div>

      {/* Connection Info Dialog */}
      <Dialog header="Connection Details" visible={displayInfoDialog} style={{ width: '600px' }} onHide={() => setDisplayInfoDialog(false)}>
        {selectedStream && (
          <div className="flex flex-column gap-4 py-2">
            <div className="p-3 border-round" style={{ backgroundColor: 'var(--bg-highlight)' }}>
              <label className="block font-bold mb-2" style={{ color: 'var(--text-h)' }}>OBS / Encoder Settings</label>
              <div className="flex flex-column gap-3">
                <ConnectionInfoCard label="Server URL" value={rtmpIngestUrl} onCopy={copyToClipboard} />
                <ConnectionInfoCard label="Channel Key" value={`${selectedStream.channelName}?key=${selectedStream.streamKey}`} onCopy={copyToClipboard} />
              </div>
            </div>

            <ConnectionInfoCard label="Web Player Link" value={webPlayerUrl} onCopy={copyToClipboard} />
          </div>
        )}
      </Dialog>

      {/* Recording Player Dialog */}
      <Dialog 
        header={`Recording: ${selectedRecording ? (selectedRecording.title || new Date(selectedRecording.startedAt).toLocaleString()) : ''}`} 
        visible={displayRecordingDialog} 
        style={{ width: '800px' }} 
        onHide={() => setDisplayRecordingDialog(false)}
        blockScroll
      >
        {selectedRecording && (
          <div className="flex flex-column gap-3">
            <video 
              src={`${API_BASE_URL}${selectedRecording.filePath}`} 
              controls 
              autoPlay 
              className="w-full border-round shadow-4" 
              style={{ backgroundColor: '#000' }}
            />
            <div className="flex justify-content-between text-sm" style={{ color: 'var(--base1)' }}>
              <span>Recorded: {new Date(selectedRecording.startedAt).toLocaleString()}</span>
              <span>Size: {formatFileSize(selectedRecording.fileSize)}</span>
            </div>
          </div>
        )}
      </Dialog>

      {/* Rename Recording Dialog */}
      <Dialog 
        header="Rename Recording" 
        visible={displayRenameDialog} 
        style={{ width: '400px' }} 
        onHide={() => setDisplayRenameDialog(false)}
        footer={<div>
          <Button label="Cancel" icon="pi pi-times" onClick={() => setDisplayRenameDialog(false)} className="p-button-text" />
          <Button label="Save" icon="pi pi-check" onClick={saveRecordingTitle} autoFocus />
        </div>}
      >
        <div className="flex flex-column gap-2">
          <label htmlFor="rec_title" className="font-bold text-sm">New Title</label>
          <InputText 
            id="rec_title"
            value={newRecordingTitle} 
            onChange={(e) => setNewRecordingTitle(e.target.value)} 
            placeholder="e.g. Weekly Update - May 18"
            className="w-full"
            style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }}
          />
        </div>
      </Dialog>
    </div>
  );
};

export default Dashboard;
