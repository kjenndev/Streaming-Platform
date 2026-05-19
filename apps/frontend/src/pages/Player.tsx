import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import flvjs from 'flv.js';
import { Card } from 'primereact/card';
import { InputText } from 'primereact/inputtext';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { io, Socket } from 'socket.io-client';
import axios from 'axios';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import StatusMessage from '../components/StatusMessage';
import { API_BASE_URL, MEDIA_BASE_URL, SOCKET_URL } from '../config';

const Player = () => {
  const { channelName } = useParams();
  const [stream, setStream] = useState<any>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [formData, setFormData] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [viewers, setViewers] = useState(0);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const flvPlayerRef = useRef<flvjs.Player | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const toast = useRef<Toast>(null);

  useEffect(() => {
    fetchStreamInfo();
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on('live_stats', (data) => {
      const stats = data.streams;
      if (channelName && stats[channelName]) {
        const channelStats = stats[channelName];
        setViewers(channelStats.viewers || 0);
        
        // Sync live status with real-time websocket data
        setStream((prev: any) => {
          if (prev && prev.isLive !== channelStats.isPublishing) {
            if (!channelStats.isPublishing) {
              // If stream just went offline, explicitly leave the channel
              socketRef.current?.emit('leave_channel');
              setIsAuthorized(false);
              setMessages([]);
            }
            return { ...prev, isLive: channelStats.isPublishing };
          }
          return prev;
        });
      } else if (channelName) {
        // If channel is missing from stats, assume it's offline
        setStream((prev: any) => {
          if (prev && prev.isLive) {
            return { ...prev, isLive: false };
          }
          return prev;
        });
      }
    });
    
    return () => {
      socket.disconnect();
    };
  }, [channelName]);

  useEffect(() => {
    if (isAuthorized && videoRef.current && channelName && stream?.isLive) {
      if (flvjs.isSupported()) {
        const flvPlayer = flvjs.createPlayer({
          type: 'flv',
          url: `${MEDIA_BASE_URL}/live/${channelName}.flv`
        });
        flvPlayer.attachMediaElement(videoRef.current);
        flvPlayer.load();
        flvPlayer.play();
        flvPlayerRef.current = flvPlayer;

        return () => {
          if (flvPlayerRef.current) {
            flvPlayerRef.current.destroy();
            flvPlayerRef.current = null;
          }
        };
      }
    }
  }, [isAuthorized, channelName, stream?.isLive]);

  useEffect(() => {
    if (isAuthorized && socketRef.current) {
      const join = () => {
        socketRef.current?.emit('join_channel', { channelName, username: formData.username });
        console.log('Joined channel:', channelName);
      };

      socketRef.current.on('connect', join);
      
      socketRef.current.on('kicked', () => {
        alert('You have been kicked from this stream by an administrator.');
        window.location.reload();
      });

      socketRef.current.on('receive_message', (msg) => {
        setMessages((prev) => [...prev, msg]);
      });
      
      join(); // Initial join

      return () => {
        socketRef.current?.off('connect', join);
        socketRef.current?.off('kicked');
        socketRef.current?.off('receive_message');
      };
    }
  }, [isAuthorized, channelName]);

  const fetchStreamInfo = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/public/streams/${channelName}`);
      setStream(res.data);
    } catch (err) {
      console.error('Stream not found');
    }
  };

  const handleJoin = () => {
    setError('');
    
    if (!formData.username.trim()) {
      setError('Username is required');
      return;
    }

    if (stream.isPasswordProtected && formData.password !== stream.password) {
      setError('Incorrect password');
      return;
    }

    // Check username availability via socket
    socketRef.current?.emit('check_username', { channelName, username: formData.username }, (response: any) => {
      if (response.available) {
        setIsAuthorized(true);
      } else {
        setError('This username is already taken in this channel');
      }
    });
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

  const onEmojiClick = (emojiData: any) => {
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
            <Button label="Join Stream" icon="pi pi-sign-in" onClick={handleJoin} className="mt-2" style={{ backgroundColor: 'var(--blue)', borderColor: 'var(--blue)' }} />
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
          <div className="flex-grow-1 overflow-y-auto p-3 flex flex-column gap-3" style={{ backgroundColor: 'var(--bg)' }}>
            {messages.map((msg, i) => (
              <div key={i} className="line-height-3 text-sm">
                {msg.isSystem ? (
                  <span className="italic" style={{ color: 'var(--base01)' }}>{msg.message}</span>
                ) : (
                  <>
                    <span className={`font-bold mr-2`} style={{ color: msg.username === formData.username ? 'var(--green)' : 'var(--blue)' }}>{msg.username}</span>
                    <span style={{ color: 'var(--text)' }}>{msg.message}</span>
                  </>
                )}
              </div>
            ))}
          </div>
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

export default Player;
