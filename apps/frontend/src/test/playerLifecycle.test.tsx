import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import Player from '../pages/Player';
import { io } from 'socket.io-client';
const mocks = vi.hoisted(() => ({ url: undefined as undefined | string | (() => string), handlers: new Map<string, (...args: unknown[]) => void>(), dispose: Object.assign(vi.fn(), { resume: vi.fn() }), suspended: undefined as undefined | ((value: boolean) => void), connected: true, connect: vi.fn(), disconnect: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('axios');
vi.mock('emoji-picker-react', () => ({ default: () => null, Theme: { DARK: 'dark' } }));
vi.mock('../livePlayback', () => ({ startLivePlayback: (_video: HTMLVideoElement, _url: string | (() => string), suspended: (value: boolean) => void) => { mocks.url = _url; mocks.suspended = suspended; return mocks.dispose; } }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ get connected() { return mocks.connected; }, connect: mocks.connect, on: (name: string, fn: (...args: unknown[]) => void) => mocks.handlers.set(name, fn), off: mocks.off, disconnect: mocks.disconnect, emit: mocks.emit })) }));
afterEach(() => { localStorage.clear(); mocks.handlers.clear(); mocks.connected = true; vi.clearAllMocks(); vi.useRealTimers(); });
it('consumes only its channel stats and removes all owned socket handlers on unmount', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { channelName: 'mine', isLive: true } });
  mocks.emit.mockImplementation((name, _payload, ack) => { if (name === 'check_username') ack({ available: true }); if (name === 'join_channel') ack({ok:true}); });
  const view = render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
  fireEvent.change(await screen.findByPlaceholderText('Choose a name'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByText('Join Stream'));
  await waitFor(() => expect(screen.getByRole('log')).toBeInTheDocument());
  act(() => mocks.handlers.get('live_stats')!({ streams: { mine: { viewers: 7, isPublishing: true } } }));
  expect(screen.getByText('7 Viewers')).toBeInTheDocument();
  act(() => mocks.handlers.get('live_stats')!({ streams: { other: { viewers: 100, isPublishing: true } } }));
  expect(screen.getByText('7 Viewers')).toBeInTheDocument();
  view.unmount();
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  expect(mocks.off).toHaveBeenCalledWith('live_stats', expect.any(Function));
  expect(mocks.off).toHaveBeenCalledWith('receive_message', expect.any(Function));
});

it('resets authorization and disposes playback when navigating to another channel', async () => {
  vi.mocked(axios.get).mockResolvedValue({ data: { isLive: true } });
  mocks.emit.mockImplementation((name, _payload, ack) => { if (name === 'check_username') ack({ available: true }); if (name === 'join_channel') ack({ok:true}); });
  const view = render(<MemoryRouter initialEntries={['/watch/mine']}><Link to="/watch/other">Switch channel</Link><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
  fireEvent.change(await screen.findByPlaceholderText('Choose a name'), { target: { value: 'alice' } });
  fireEvent.click(screen.getByText('Join Stream'));
  await screen.findByRole('log');
  fireEvent.click(screen.getByText('Switch channel'));
  expect(await screen.findByPlaceholderText('Choose a name')).toHaveValue('');
  expect(mocks.dispose).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('offers explicit live resume after autoplay is blocked', async () => {
 vi.mocked(axios.get).mockResolvedValue({ data: { isLive: true } });
 mocks.emit.mockImplementation((name, _payload, ack) => { if (name === 'check_username') ack({ available: true }); if (name === 'join_channel') ack({ok:true}); });
 render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'), { target: { value: 'alice' } });
 fireEvent.click(screen.getByText('Join Stream'));
 await screen.findByRole('log');
 expect(mocks.suspended).toBeTypeOf('function');
 act(() => mocks.suspended!(true));
 fireEvent.click(screen.getByText('Resume live'));
 expect(mocks.dispose.resume).toHaveBeenCalledOnce();
});

it('waits for authoritative join acknowledgement and rejects duplicate usernames on initial join and reconnect', async () => {
 vi.mocked(axios.get).mockResolvedValue({ data: { isLive: true } });
 const acks: ((response: {ok:boolean;error?:string}) => void)[] = [];
 mocks.emit.mockImplementation((name, _payload, ack) => { if (name === 'check_username') ack({available:true}); if (name === 'join_channel') acks.push(ack); });
 const view = render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'), {target:{value:'alice'}});
 fireEvent.click(screen.getByText('Join Stream'));
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
 await waitFor(() => expect(acks).toHaveLength(1));
 act(() => acks[0]({ok:false,error:'Username unavailable'}));
 expect(await screen.findByText('Username unavailable')).toBeInTheDocument();
 fireEvent.click(screen.getByText('Join Stream'));
 await waitFor(() => expect(acks).toHaveLength(2));
 act(() => acks[1]({ok:true}));
 await screen.findByRole('log');
 act(() => mocks.handlers.get('disconnect')!());
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
 act(() => mocks.handlers.get('connect')!());
 expect(acks).toHaveLength(3);
 act(() => acks[2]({ok:false,error:'Username taken on reconnect'}));
 expect(await screen.findByText('Username taken on reconnect')).toBeInTheDocument();
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
 view.unmount();
 act(() => acks[2]({ok:true}));
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
});

it('ignores an acknowledgement from before disconnect and waits for a fresh reconnect acknowledgement', async () => {
 vi.mocked(axios.get).mockResolvedValue({ data: { isLive: true } });
 const acks: ((response: {ok:boolean}) => void)[] = [];
 mocks.emit.mockImplementation((name, _payload, ack) => { if (name === 'join_channel') acks.push(ack); });
 render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'), {target:{value:'alice'}});
 fireEvent.click(screen.getByText('Join Stream'));
 await waitFor(() => expect(acks).toHaveLength(1));
 act(() => mocks.handlers.get('disconnect')!());
 act(() => acks[0]({ok:true}));
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
 act(() => mocks.handlers.get('connect')!());
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
 act(() => acks[1]({ok:true}));
 expect(await screen.findByRole('log')).toBeInTheDocument();
});

it('bounds missing acknowledgements, leaves uncertain membership before retry and ignores a late success', async () => {
 vi.mocked(axios.get).mockResolvedValue({ data: { isLive: true } });
 const acks: ((response: {ok:boolean}) => void)[] = [];
 mocks.emit.mockImplementation((name, _payload, ack) => { if (name === 'join_channel') acks.push(ack); });
 const view = render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'), {target:{value:'alice'}});
 vi.useFakeTimers();
 mocks.emit.mockClear();
 fireEvent.click(screen.getByText('Join Stream'));
 act(() => vi.advanceTimersByTime(10000));
 expect(screen.getByText(/timed out/i)).toBeInTheDocument();
 expect(screen.getByText('Join Stream')).not.toBeDisabled();
 expect(mocks.emit.mock.calls.map(call => call[0])).toEqual(['join_channel', 'leave_channel']);
 fireEvent.click(screen.getByText('Join Stream'));
 act(() => acks[0]({ok:true}));
 expect(screen.queryByRole('log')).not.toBeInTheDocument();
 act(() => acks[1]({ok:true}));
 expect(screen.getByRole('log')).toBeInTheDocument();
 expect(mocks.emit.mock.calls.map(call => call[0])).toEqual(['join_channel', 'leave_channel', 'join_channel']);
 view.unmount();
 expect(vi.getTimerCount()).toBe(0);
});

it('recovers from initial connection errors and bounds waiting for a connection', async () => {
 vi.mocked(axios.get).mockResolvedValue({ data: { isLive: true } });
 mocks.connected = false;
 const view = render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'), {target:{value:'alice'}});
 vi.useFakeTimers();
 fireEvent.click(screen.getByText('Join Stream'));
 act(() => mocks.handlers.get('connect_error')?.(new Error('offline')));
 expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
 expect(screen.getByText('Join Stream')).not.toBeDisabled();
 fireEvent.click(screen.getByText('Join Stream'));
 expect(mocks.connect).toHaveBeenCalled();
 act(() => vi.advanceTimersByTime(10000));
 expect(screen.getByText(/timed out/i)).toBeInTheDocument();
 view.unmount();
 expect(vi.getTimerCount()).toBe(0);
 expect(mocks.off).toHaveBeenCalledWith('connect_error', expect.any(Function));
});

it('sends protected-channel password to the server without needing it in public metadata', async () => {
 vi.mocked(axios.get).mockResolvedValue({data:{channelName:'mine',isLive:true,isPasswordProtected:true}});
 mocks.emit.mockImplementation((name, _payload, ack) => {if(name==='join_channel')ack({ok:true,cap:'short-lived-scoped-test-cap'});});
 render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'), {target:{value:'alice'}});
 fireEvent.change(screen.getByPlaceholderText('Enter password'), {target:{value:'viewer-test-password'}});
 fireEvent.click(screen.getByText('Join Stream'));
 await waitFor(()=>expect(mocks.emit).toHaveBeenCalledWith('join_channel',{channelName:'mine',username:'alice',password:'viewer-test-password'},expect.any(Function)));
 expect(await screen.findByRole('log')).toBeInTheDocument();
});

it('propagates only the server capability to the actual media URL',async()=>{
 vi.mocked(axios.get).mockResolvedValue({data:{channelName:'mine',isLive:true,isPasswordProtected:true}});
 mocks.emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')ack({ok:true,cap:'scoped-test-cap'});});
 render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player />} /></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'),{target:{value:'alice'}});
 fireEvent.change(screen.getByPlaceholderText('Enter password'),{target:{value:'never-in-url'}});
 fireEvent.click(screen.getByText('Join Stream'));
 await screen.findByRole('log');
 const url=typeof mocks.url==='function'?mocks.url():mocks.url;
 expect(url).toContain('cap=scoped-test-cap');expect(url).not.toContain('never-in-url');
});

it('passes the current account token so assigned viewers can join without the shared password',async()=>{
 localStorage.setItem('token','current-account-jwt');
 vi.mocked(axios.get).mockResolvedValue({data:{channelName:'mine',isLive:true,isPasswordProtected:true}});
 mocks.emit.mockImplementation((name,_payload,ack)=>{if(name==='join_channel')ack({ok:true,cap:'account-bound-cap'});});
 render(<MemoryRouter initialEntries={['/watch/mine']}><Routes><Route path="/watch/:channelName" element={<Player/>}/></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Choose a name'),{target:{value:'assigned-viewer'}});
 fireEvent.click(screen.getByText('Join Stream'));
 await screen.findByRole('log');
 expect(io).toHaveBeenCalledWith(expect.any(String),{auth:{token:'current-account-jwt'}});
 expect(mocks.emit).toHaveBeenCalledWith('join_channel',{channelName:'mine',username:'assigned-viewer',password:''},expect.any(Function));
});
