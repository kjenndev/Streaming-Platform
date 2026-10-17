import './ManagerPlayer.css';
import { expireSession } from '../session';
import type { Stream, LiveStats } from '../models';
import ChatMessages from '../components/ChatMessages';
import { appendMessage, type ChatMessage } from '../chat';
import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { startLivePlayback } from '../livePlayback';
import { Card } from 'primereact/card';
import { InputText } from 'primereact/inputtext';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { io, Socket } from 'socket.io-client';
import axios from 'axios';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import StatusMessage from '../components/StatusMessage';
import { API_BASE_URL, MEDIA_BASE_URL, SOCKET_URL } from '../config';

export type ManagerPlayer = {channelName:string;grant:string;displayName:string;isLive:boolean;watching:boolean;onAdmission:(admitted:boolean,response?:{credentials?:{server?:string;streamKey?:string}})=>void;onGrantRefreshed:(grant:string)=>void;onAuthorizationLost:()=>void;onWatch:()=>void;onStop:()=>void};
type PlayerProps = { videoOnly?: boolean; manager?: ManagerPlayer };

export const PlayerSession = ({ videoOnly = false, manager }: PlayerProps) => {
  const params = useParams();
  const channelName = manager?.channelName || params.channelName;
  const [stream, setStream] = useState<Stream | null>(()=>manager?{id:`mss:${channelName}`,channelName:channelName!,isLive:manager.isLive,isDisabled:false}:null);
  const joinPassword = useRef('');
  const playbackCap = useRef('');
  const [joinUsername, setJoinUsername] = useState<string | null>(manager?.displayName ?? null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(true);
  const [formData, setFormData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [viewers, setViewers] = useState(0);
  
  const [playbackSuspended, setPlaybackSuspended] = useState(false);
  const playbackRef = useRef<ReturnType<typeof startLivePlayback> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const managerGrantRef = useRef(manager?.grant);
  const refreshGeneration = useRef(0);
  const toast = useRef<Toast>(null);

  useEffect(() => {
    const controller = new AbortController();
    if(!manager)void axios.get<Stream>(`${API_BASE_URL}/api/public/streams/${channelName}`, { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setStream(res.data); })
      .catch(() => { if (!controller.signal.aborted) setError('Stream not found'); });
    const token = manager ? null : localStorage.getItem('token');
    const socket = io(SOCKET_URL, manager ? {auth:{mssGrant:manager.grant,channelName}} : token ? { auth: { token } } : undefined);
    socketRef.current = socket;

    const invalidSession = () => {
      if(manager){playbackCap.current='';socket.auth={};manager.onAuthorizationLost();return;}
      expireSession(token);
      // Public playback can be retried anonymously; never redirect capability failures.
      socket.auth = {};
      setError('Your sign-in session has expired. Join again as a viewer or sign in.');
    };
    socket.on('session_invalid', invalidSession);
    const sessionConnectionError = (error: Error & { data?: { status?: number } }) => {
      if (error.data?.status === 401) invalidSession();
    };
    socket.on('connect_error', sessionConnectionError);


    const receiveStats = (data: LiveStats) => {
      const channelStats = channelName ? data.streams?.[channelName] : undefined;
      // Channel-room packets are not global snapshots: absence is not offline.
      if (!channelStats) return;
      if(manager&&!channelStats.isPublishing)setPreviewMuted(true);
      setViewers(channelStats.viewers || 0);
      setStream(previous => previous && previous.isLive !== channelStats.isPublishing
        ? { ...previous, isLive: !!channelStats.isPublishing } : previous);
    };
    socket.on('live_stats', receiveStats);
    return () => {
      controller.abort();
      socket.off('live_stats', receiveStats);
      socket.off('session_invalid', invalidSession);
      socket.off('connect_error', sessionConnectionError);
      socket.disconnect();
      socketRef.current = null;
    };
  // Delegated callbacks are deliberately not connection identity; the grant is.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName,!!manager]);

  useEffect(()=>{
    if(!manager||managerGrantRef.current===manager.grant){managerGrantRef.current=manager?.grant;return;}
    managerGrantRef.current=manager.grant;const socket=socketRef.current;if(!socket)return;const grant=manager.grant,request=++refreshGeneration.current;let pending=true;
    const fail=()=>{if(!pending||request!==refreshGeneration.current||socketRef.current!==socket)return;pending=false;refreshGeneration.current++;playbackCap.current='';socket.auth={};playbackRef.current?.();playbackRef.current=null;socket.emit('leave_channel');manager.onAuthorizationLost()};
    const deadline=setTimeout(fail,8000);const disconnected=()=>fail();socket.on('disconnect',disconnected);
    socket.emit('refresh_delegation',{grant:manager.grant},(response:{ok:boolean;cap?:string})=>{
      if(!pending||request!==refreshGeneration.current||socketRef.current!==socket)return;
      if(!response?.ok||!response.cap){clearTimeout(deadline);fail();return;}
      pending=false;clearTimeout(deadline);socket.off('disconnect',disconnected);
      playbackCap.current=response.cap;
      socket.auth={mssGrant:grant,channelName};
      playbackRef.current?.refresh();
      manager.onGrantRefreshed(grant);
    });
    return()=>{pending=false;clearTimeout(deadline);socket.off('disconnect',disconnected)};
  // Grant identity alone drives this exchange; callback object identity is UI state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[manager?.grant,channelName]);

  useEffect(() => {
    if (isAuthorized && (!manager || manager.watching) && videoRef.current && channelName && stream?.isLive) {
      const playback = startLivePlayback(videoRef.current, () => manager?`${MEDIA_BASE_URL}/mss-live/${channelName}.flv`:`${MEDIA_BASE_URL}/live/${channelName}.flv${playbackCap.current ? `?cap=${encodeURIComponent(playbackCap.current)}` : ''}`, setPlaybackSuspended, (videoOnly||manager) ? message => {
        setError(message);
        setIsAuthorized(false);
        setJoinUsername(null);
        manager?.onAuthorizationLost();
      } : undefined,manager?()=>({'X-MSS-Playback':playbackCap.current}):undefined);
      playbackRef.current = playback;
      return () => { playback(); playbackRef.current = null; };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, channelName, stream?.isLive, videoOnly,manager?.watching]);

  useEffect(() => {
    const socket = socketRef.current;
    if (joinUsername !== null && socket) {
      let active = true;
      let generation = 0;
      let joined = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let renewal: ReturnType<typeof setTimeout> | undefined;
      const renew = () => {
        if (!active || !joined) return;
        const request = generation;
        renewal = setTimeout(expire, 10000);
        socket.emit('renew_playback', {}, (response: {ok:boolean;cap?:string}) => {
          if (!active || request !== generation || !joined) return;
          if (!response?.ok || !response.cap) { expire(); return; }
          playbackCap.current = response.cap;
          clearTimeout(renewal);
          renewal = setTimeout(renew, 60000);
        });
      };
      const expire = () => {
        generation++;
        clearTimeout(renewal);
        playbackCap.current = '';
        if(manager)socket.auth = {};
        joined = false;
        setIsAuthorized(false);
        setError('Joining timed out. Please try again.');
        setJoinUsername(null);
        manager?.onAuthorizationLost();
      };
      const connectionFailed = (error?: Error & { data?: { status?: number } }) => {
        expire();
        clearTimeout(deadline);
        setError(error?.data?.status === 401 ? 'Your sign-in session has expired. Join again as a viewer or sign in.' : 'Connection failed. Please try again.');
      };
      const armDeadline = () => {
        clearTimeout(deadline);
        deadline = setTimeout(expire, 10000);
      };
      const disconnected = () => {
        if(manager)setPreviewMuted(true);
        generation++;
        clearTimeout(renewal);
        playbackCap.current = '';
        joined = false;
        setIsAuthorized(false);
        armDeadline();
      };
      const join = () => {
        const request = ++generation;
        armDeadline();
        joined = false;
        setIsAuthorized(false);
        socket.emit('join_channel', { channelName, username: joinUsername, password: joinPassword.current }, (response: { ok: boolean; error?: string; cap?: string; credentials?: {server?:string;streamKey?:string} }) => {
          if (!active || request !== generation || socketRef.current !== socket) return;
          clearTimeout(deadline);
          joined = response?.ok === true && (!(videoOnly || manager) || !!response.cap);
          playbackCap.current = joined ? response.cap || '' : '';
          clearTimeout(renewal);
          if (joined && response.cap) renewal = setTimeout(renew, 60000);
          setIsAuthorized(joined);
          manager?.onAdmission(joined,response);
          if (!joined) {
            setError(response?.error || (videoOnly ? 'Playback admission failed. Please retry.' : 'This username is already taken in this channel'));
            setJoinUsername(null);
          } else {
            setError('');
            setPlaybackSuspended(false);
          }
        });
      };
      const kicked = () => {
        if (videoOnly || manager) {
          expire();
          setError('You have been removed from this stream.');manager?.onAuthorizationLost();
          return;
        }
        alert('You have been kicked from this stream by an administrator.');
        window.location.reload();
      };
      const receiveMessage = (msg: ChatMessage) => { if (joined) setMessages(previous => appendMessage(previous, msg)); };
      socket.on('connect', join);
      socket.on('connect_error', connectionFailed);
      socket.on('disconnect', disconnected);
      socket.on('kicked', kicked);
      socket.on('receive_message', receiveMessage);
      armDeadline();
      if (socket.connected !== false) join();
      else socket.connect();
      return () => {
        active = false;
        clearTimeout(renewal);
        playbackCap.current = '';
        clearTimeout(deadline);
        // Ordered before any retry on this socket: release even if its ack was lost.
        // Stale acknowledgements must not leave a newer accepted membership.
        socket.off('connect', join);
        socket.off('connect_error', connectionFailed);
        socket.off('disconnect', disconnected);
        socket.off('kicked', kicked);
        socket.off('receive_message', receiveMessage);
        socket.emit('leave_channel');
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinUsername, channelName, videoOnly,!!manager]);


  const handleJoin = () => {
    setError('');
    
    if (!videoOnly && !formData.username.trim()) {
      setError('Username is required');
      return;
    }

    joinPassword.current = formData.password;

    // The join acknowledgement, not an availability precheck, grants membership.
    // Ephemeral viewer identity satisfies existing room admission without a chat form.
    setJoinUsername(videoOnly ? `viewer-${crypto.getRandomValues(new Uint32Array(4)).join('-')}` : formData.username);
  };

  const sendMessage = () => {
    if (newMessage.trim() && socketRef.current) {
      socketRef.current.emit('send_message', {
        channelName,
        username: formData.username,
        message: newMessage
      });
      setNewMessage('');
      setShowEmojiPicker(false);
    }
  };

  const onEmojiClick = (emojiData: { emoji: string }) => {
    setNewMessage(prev => prev + emojiData.emoji);
  };

  if(manager){
    return <main className="mss-manager-player">
      <header style={{display:'flex',flexWrap:'wrap',gap:8,justifyContent:'space-between',alignItems:'center',padding:'8px 12px',minWidth:0}}><span style={{minWidth:0,overflowWrap:'anywhere'}}>Signed in as {manager.displayName}</span><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{!manager.watching?<Button label="Return to preview" disabled={!isAuthorized} onClick={()=>{setPreviewMuted(true);manager.onWatch()}} style={{minHeight:44}}/>:<Button label={previewMuted?'Unmute':'Mute'} disabled={!isAuthorized||!stream?.isLive} onClick={()=>setPreviewMuted(value=>!value)} style={{minHeight:44}}/>}</div></header>
      <section aria-label="Video preview" className="mss-manager-video">{manager.watching&&isAuthorized&&stream?.isLive?<video ref={videoRef} aria-label="Live stream" muted={previewMuted} playsInline style={{width:'100%',height:'100%',objectFit:'contain'}}/>:<span role="status">{!isAuthorized?'Connecting preview…':!stream?.isLive?'Stream offline. Preview resumes automatically.':!manager.watching?'Library audio selected. Return to preview to switch.':'Preparing preview…'}</span>}</section>
      <section aria-label="Chat" className="mss-manager-chat"><ChatMessages messages={messages} username={manager.displayName}/><form onSubmit={event=>{event.preventDefault();sendMessage()}} style={{display:'flex',flexWrap:'wrap',gap:8,padding:8,minWidth:0}}><InputText aria-label="Message" value={newMessage} onChange={event=>setNewMessage(event.target.value)} maxLength={500} style={{flex:'1 1 10rem',minWidth:0,minHeight:44}}/><Button type="submit" label="Send" style={{minHeight:44}}/></form></section>
    </main>;
  }

  if (videoOnly) {
    const message = !stream ? (error || 'Loading stream…')
      : stream.isDisabled ? 'Stream unavailable.'
      : !stream.isLive ? 'Stream offline.' : '';
    return <main aria-label="Live video" style={{ width: '100%', height: '100dvh', background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'auto' }}>
      {message ? <div role="status" style={{ padding: 16, textAlign: 'center' }}>{message}{(error || stream) && <div><Button label="Retry" onClick={() => window.location.reload()} /></div>}</div>
      : !isAuthorized ? <form onSubmit={event => { event.preventDefault(); handleJoin(); }} style={{ padding: 12, maxWidth: '100%', maxHeight: '100%', overflow: 'auto', display: 'grid', gap: 8 }}>
        {stream?.isPasswordProtected && <><label htmlFor="embed-password">Stream password</label><InputText id="embed-password" type="password" autoComplete="off" value={formData.password} onChange={event => setFormData({ ...formData, password: event.target.value })} style={{ width: '100%', minWidth: 0 }} /></>}
        {error && <div role="alert">{error}</div>}
        <Button type="submit" label={joinUsername !== null ? 'Connecting…' : error ? 'Retry playback' : 'Watch live'} disabled={joinUsername !== null} />
      </form>
      : <>
        <video ref={videoRef} controls playsInline aria-label="Live stream" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />
        {playbackSuspended && <Button label="Resume live" style={{ position: 'absolute' }} onClick={() => playbackRef.current?.resume()} />}
      </>}
    </main>;
  }

  if (!stream) return <div className="p-4 text-white">Loading stream...</div>;

  if (stream.isDisabled) {
    return (
      <StatusMessage 
        title="Stream Unavailable"
        icon="pi pi-exclamation-triangle"
        iconColor="var(--red)"
        message={<>This channel is currently <strong>under maintenance</strong> or has been disabled by an administrator.</>}
        actionLabel="Back to Home"
        onAction={() => window.location.href = '/'}
      />
    );
  }

  if (!stream.isLive) {
    return (
      <StatusMessage 
        title="Stream Offline"
        icon="pi pi-video-slash"
        iconColor="var(--base01)"
        message={<>The channel <strong>{channelName}</strong> is currently offline. Please check back later!</>}
        actionLabel="Refresh"
        onAction={() => window.location.reload()}
      />
    );
  }

  if (!isAuthorized) {
    return (
      <div className="flex align-items-center justify-content-center" style={{ height: '100vh', backgroundColor: 'var(--bg)' }}>
        <Card title={`Join ${channelName}`} style={{ width: '90%', maxWidth: '400px' }} className="shadow-8 border-1 border-white-alpha-10 bg-gray-900">
          <div className="flex flex-column gap-3">
            <div className="flex flex-column gap-2">
              <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Username</label>
              <InputText 
                placeholder="Choose a name" 
                value={formData.username} 
                onChange={(e) => setFormData({ ...formData, username: e.target.value })} 
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }}
              />
            </div>
            
            {stream.isPasswordProtected && (
              <div className="flex flex-column gap-2">
                <label className="text-sm font-bold" style={{ color: 'var(--text-h)' }}>Stream Password</label>
                <InputText 
                  type="password" 
                  placeholder="Enter password" 
                  value={formData.password} 
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })} 
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                  style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)' }}
                />
              </div>
            )}
            
            {error && <small className="p-error" style={{ color: 'var(--red)' }}>{error}</small>}
            <Button label="Join Stream" disabled={joinUsername !== null} icon="pi pi-sign-in" onClick={handleJoin} className="mt-2" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)' }} />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden w-full" style={{ backgroundColor: 'var(--bg)' }}>
      <Toast ref={toast} />
      <div className="flex-grow-1 flex flex-column h-full relative overflow-hidden">
        <div className="flex-grow-1 flex align-items-center justify-content-center overflow-hidden" style={{ backgroundColor: '#001b23' }}>
          {playbackSuspended && <Button label="Resume live" onClick={() => playbackRef.current?.resume()} />}
          <video 
            ref={videoRef} 
            controls 
            className="w-full h-full object-contain"
          />
        </div>
        <div className="border-top-1 flex justify-content-between align-items-center shadow-2 px-3" style={{ height: '80px', backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
          <div>
            <h2 className="m-0 text-xl" style={{ color: 'var(--text-h)' }}>{channelName}</h2>
            <div className="flex align-items-center gap-3 mt-1">
              <span className="font-bold flex align-items-center gap-1" style={{ color: 'var(--red)' }}>
                <i className="pi pi-circle-fill" style={{ fontSize: '0.6rem' }}></i>
                LIVE
              </span>
              <span className="text-sm flex align-items-center gap-1" style={{ color: 'var(--base0)' }}>
                <i className="pi pi-users" style={{ fontSize: '0.9rem' }}></i>
                {viewers} {viewers === 1 ? 'Viewer' : 'Viewers'}
              </span>
            </div>
          </div>
          <Button 
            icon={`pi ${showChat ? 'pi-chevron-right' : 'pi-chevron-left'}`} 
            onClick={() => setShowChat(!showChat)} 
            className="p-button-text p-button-rounded"
            style={{ color: 'var(--base0)' }}
            tooltip={showChat ? "Hide Chat" : "Show Chat"}
            tooltipOptions={{ position: 'left' }}
          />
        </div>
      </div>

      {showChat && (
        <div className="w-22rem md:w-24rem flex flex-column border-left-1 h-full shadow-4" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)', maxWidth: '100%' }}>
          <div className="p-3 border-bottom-1 font-bold text-sm tracking-wider uppercase flex justify-content-between" style={{ borderColor: 'var(--base01)', color: 'var(--base0)' }}>
            <span>Stream Chat</span>
            <span className="text-xs" style={{ color: 'var(--blue)' }}>@{formData.username}</span>
          </div>
          <ChatMessages messages={messages} username={formData.username} />
          <div className="border-top-1 flex align-items-center px-3 relative" style={{ height: '80px', backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
            {showEmojiPicker && (
              <div className="absolute" style={{ bottom: '80px', right: '10px', zIndex: 1000 }}>
                <EmojiPicker 
                  theme={Theme.DARK} 
                  onEmojiClick={onEmojiClick}
                  autoFocusSearch={false}
                  width={300}
                  height={400}
                />
              </div>
            )}
            <div className="flex gap-2 w-full">
              <Button 
                icon="pi pi-face-smile" 
                className="p-button-text p-button-secondary p-0" 
                onClick={() => setShowEmojiPicker(!showEmojiPicker)} 
                style={{ color: 'var(--base01)', minWidth: '30px' }}
              />
              <InputText 
                value={newMessage} 
                onChange={(e) => setNewMessage(e.target.value)} 
                placeholder="Send a message" 
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                className="flex-grow-1 p-inputtext-sm py-2 px-3"
                style={{ backgroundColor: 'var(--bg)', color: 'var(--text)', borderColor: 'var(--base01)', minWidth: 0 }}
              />
              <Button icon="pi pi-send" onClick={sendMessage} className="p-button-sm" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Player = ({ videoOnly = false }: PlayerProps) => {
  const { channelName } = useParams();
  return <PlayerSession key={`${channelName}:${videoOnly}`} videoOnly={videoOnly} />;
};
export default Player;
