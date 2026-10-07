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

const PlayerSession = () => {
  const { channelName } = useParams();
  const [stream, setStream] = useState<Stream | null>(null);
  const joinPassword = useRef('');
  const playbackCap = useRef('');
  const [joinUsername, setJoinUsername] = useState<string | null>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
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
  const toast = useRef<Toast>(null);

  useEffect(() => {
    const controller = new AbortController();
    void axios.get<Stream>(`${API_BASE_URL}/api/public/streams/${channelName}`, { signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setStream(res.data); })
      .catch(() => { if (!controller.signal.aborted) setError('Stream not found'); });
    const token = localStorage.getItem('token');
    const socket = io(SOCKET_URL, token ? { auth: { token } } : undefined);
    socketRef.current = socket;

    const receiveStats = (data: LiveStats) => {
      const channelStats = channelName ? data.streams?.[channelName] : undefined;
      // Channel-room packets are not global snapshots: absence is not offline.
      if (!channelStats) return;
      setViewers(channelStats.viewers || 0);
      setStream(previous => previous && previous.isLive !== channelStats.isPublishing
        ? { ...previous, isLive: !!channelStats.isPublishing } : previous);
    };
    socket.on('live_stats', receiveStats);
    return () => {
      controller.abort();
      socket.off('live_stats', receiveStats);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [channelName]);

  useEffect(() => {
    if (isAuthorized && videoRef.current && channelName && stream?.isLive) {
      const playback = startLivePlayback(videoRef.current, () => `${MEDIA_BASE_URL}/live/${channelName}.flv${playbackCap.current ? `?cap=${encodeURIComponent(playbackCap.current)}` : ''}`, setPlaybackSuspended);
      playbackRef.current = playback;
      return () => { playback(); playbackRef.current = null; };
    }
  }, [isAuthorized, channelName, stream?.isLive]);

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
        joined = false;
        setIsAuthorized(false);
        setError('Joining timed out. Please try again.');
        setJoinUsername(null);
      };
      const connectionFailed = () => {
        expire();
        clearTimeout(deadline);
        setError('Connection failed. Please try again.');
      };
      const armDeadline = () => {
        clearTimeout(deadline);
        deadline = setTimeout(expire, 10000);
      };
      const disconnected = () => {
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
        socket.emit('join_channel', { channelName, username: joinUsername, password: joinPassword.current }, (response: { ok: boolean; error?: string; cap?: string }) => {
          if (!active || request !== generation || socketRef.current !== socket) return;
          clearTimeout(deadline);
          joined = response?.ok === true;
          playbackCap.current = joined ? response.cap || '' : '';
          clearTimeout(renewal);
          if (joined && response.cap) renewal = setTimeout(renew, 60000);
          setIsAuthorized(joined);
          if (!joined) {
            setError(response?.error || 'This username is already taken in this channel');
            setJoinUsername(null);
          } else {
            setError('');
            setPlaybackSuspended(false);
          }
        });
      };
      const kicked = () => {
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
  }, [joinUsername, channelName]);



  const handleJoin = () => {
    setError('');
    
    if (!formData.username.trim()) {
      setError('Username is required');
      return;
    }

    joinPassword.current = formData.password;

    // The join acknowledgement, not an availability precheck, grants membership.
    setJoinUsername(formData.username);
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
        <div className="w-22rem md:w-24rem flex flex-column border-left-1 h-full shadow-4" style={{ backgroundColor: 'var(--bg-highlight)', borderColor: 'var(--base01)' }}>
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

const Player = () => {
  const { channelName } = useParams();
  return <PlayerSession key={channelName} />;
};
export default Player;
