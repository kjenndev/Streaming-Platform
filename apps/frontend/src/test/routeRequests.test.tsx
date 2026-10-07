import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import SharePlayer from '../pages/SharePlayer';
import StreamEditor from '../pages/StreamEditor';
vi.mock('axios');
vi.mock('../components/Header', () => ({default: () => null}));
afterEach(() => {vi.clearAllMocks();vi.useRealTimers();});
it.each(['share','editor'])('aborts superseded %s requests and ignores their late results', async kind => {
 const pending: {resolve: (response: unknown) => void; signal?: AbortSignal}[] = [];
 vi.mocked(axios.get).mockImplementation((_url, config) => new Promise(resolve => pending.push({resolve, signal: config?.signal as AbortSignal})));
 const view = render(<MemoryRouter initialEntries={['/a']}><Link to="/b">Next route</Link><Routes><Route path="/:id" element={kind === 'share' ? <SharePlayer/> : <StreamEditor/>}/></Routes></MemoryRouter>);
 await waitFor(() => expect(pending).toHaveLength(1));
 fireEvent.click(screen.getByText('Next route'));
 await waitFor(() => expect(pending).toHaveLength(2));
 expect(pending[0].signal?.aborted).toBe(true);
 const response = (id: string, title: string) => ({data: kind === 'share' ? {id,title,filePath:'/file',startedAt:'2026-01-01',duration:1,fileSize:1} : [{id,channelName:title}],headers:{}});
 await act(async () => pending[1].resolve(response('b','Current')));
 if (kind === 'share') expect(screen.getByText('Current')).toBeInTheDocument();
 else expect(screen.getByDisplayValue('Current')).toBeInTheDocument();
 await act(async () => pending[0].resolve(response('a','Stale')));
 expect(screen.queryByText('Stale')).not.toBeInTheDocument();
 expect(screen.queryByDisplayValue('Stale')).not.toBeInTheDocument();
 view.unmount();
 expect(pending[1].signal?.aborted).toBe(true);
});
it('clears an unavailable recording error and shows loading on the next route', async () => {
 vi.mocked(axios.get).mockRejectedValueOnce(new Error('missing')).mockImplementationOnce(() => new Promise(() => {}));
 render(<MemoryRouter initialEntries={['/a']}><Link to="/b">Next route</Link><Routes><Route path="/:id" element={<SharePlayer/>}/></Routes></MemoryRouter>);
 await screen.findByText('Recording Unavailable');
 fireEvent.click(screen.getByText('Next route'));
 await screen.findByText('Loading recording...');
 expect(screen.queryByText('Recording Unavailable')).not.toBeInTheDocument();
});

it('exchanges a private recording password and puts only the capability on the video request',async()=>{
 vi.mocked(axios.get).mockRejectedValueOnce({response:{status:403}}).mockResolvedValue({data:{id:'private',title:'Protected',filePath:'/recordings/private.mp4',startedAt:'2026-01-01',duration:1,fileSize:1}});
 vi.mocked(axios.post).mockResolvedValue({data:{cap:'recording-cap'}});
 render(<MemoryRouter initialEntries={['/private']}><Routes><Route path="/:id" element={<SharePlayer/>}/></Routes></MemoryRouter>);
 fireEvent.change(await screen.findByPlaceholderText('Recording password'),{target:{value:'never-in-url'}});
 fireEvent.click(screen.getByText('Unlock recording'));
 await screen.findByText('Protected');
 expect(document.querySelector('video')?.src).toContain('cap=recording-cap');
 expect(document.querySelector('video')?.src).not.toContain('never-in-url');
 expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/public/recordings/private/playback'),{password:'never-in-url'},expect.objectContaining({signal:expect.any(AbortSignal)}));
});

it('renews recording capability before expiry and preserves playback position',async()=>{
 vi.mocked(axios.get).mockResolvedValue({data:{id:'private',title:'Protected',playbackCap:'initial-cap',filePath:'/recordings/private.mp4',startedAt:'2026-01-01',duration:100,fileSize:1}});
 vi.mocked(axios.post).mockResolvedValue({data:{cap:'renewed-cap'}});
 vi.useFakeTimers();
 const view=render(<MemoryRouter initialEntries={['/private']}><Routes><Route path="/:id" element={<SharePlayer/>}/></Routes></MemoryRouter>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 expect(screen.getByText('Protected')).toBeInTheDocument();
 const video=document.querySelector('video')!;video.currentTime=42;
 fireEvent.loadedMetadata(video);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/api/public/recordings/private/playback'),{cap:'initial-cap'},expect.objectContaining({signal:expect.any(AbortSignal)}));
 expect(document.querySelector('video')?.src).toContain('renewed-cap');
 fireEvent.loadedMetadata(document.querySelector('video')!);
 expect(document.querySelector('video')?.currentTime).toBe(42);
 view.unmount();vi.useRealTimers();
});

it('retries transient archive renewal without discarding a still-valid playback session',async()=>{
 vi.mocked(axios.get).mockResolvedValue({data:{id:'private',title:'Protected',playbackCap:'initial-cap',filePath:'/recordings/private.mp4',startedAt:'2026-01-01',duration:100,fileSize:1}});
 vi.mocked(axios.post).mockRejectedValueOnce(new Error('temporary network error')).mockResolvedValue({data:{cap:'recovered-cap'}});
 vi.useFakeTimers();
 const view=render(<MemoryRouter initialEntries={['/private']}><Routes><Route path="/:id" element={<SharePlayer/>}/></Routes></MemoryRouter>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(document.querySelector('video')).not.toBeNull();
 expect(screen.queryByPlaceholderText('Recording password')).not.toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
 expect(document.querySelector('video')?.src).toContain('recovered-cap');
 view.unmount();
});
