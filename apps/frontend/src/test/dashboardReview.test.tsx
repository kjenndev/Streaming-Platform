import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode, ReactElement } from 'react';
import axios from 'axios';
import Dashboard from '../pages/Dashboard';
import type { Stream } from '../models';
const mocks = vi.hoisted(() => ({ emit: vi.fn(), charts: [] as {options: {scales: {y: {max?: number}}}}[], handlers: new Map<string, (...args: unknown[]) => void>() }));
vi.mock('axios');
vi.mock('../components/Header', () => ({ default: () => null }));
vi.mock('react-chartjs-2', () => ({ Line: (props: {options: {scales: {y: {max?:number}}}}) => { mocks.charts.push(props); return null; } }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: (event: string, fn: (...args: unknown[]) => void) => mocks.handlers.set(event, fn), emit: mocks.emit, removeAllListeners: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('primereact/confirmdialog', () => ({ confirmDialog: ({ accept }: { accept: () => void }) => accept() }));
vi.mock('primereact/button', () => ({ Button: ({ label, tooltip, onClick, disabled }: { label?: string; tooltip?: string; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{label || tooltip}</button> }));
vi.mock('primereact/tabview', () => ({ TabView: ({children}: {children: ReactNode}) => <>{children}</>, TabPanel: ({children}: {children: ReactNode}) => <>{children}</> }));
vi.mock('primereact/datatable', () => ({ DataTable: ({ value, header, children, rowExpansionTemplate }: { value: Stream[]; header: ReactNode; children: ReactElement<{body?: (row: Stream) => ReactNode}>[]; rowExpansionTemplate: (row: Stream) => ReactNode }) => <>{header}{value.map(row => <section key={row.id}><p>{row.channelName}</p>{children.map((col, i) => <div key={i}>{col.props.body?.(row)}</div>)}{rowExpansionTemplate(row)}</section>)}</> }));
afterEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); mocks.charts.length = 0; localStorage.clear(); vi.useRealTimers(); });
function setup(role = 'ADMIN') {
 localStorage.setItem('roles', JSON.stringify([role]));
 vi.mocked(axios.get).mockImplementation(async url => ({ data: String(url).endsWith('/viewers') ? [{ username: 'alice' }] : String(url).endsWith('/recordings') ? [] : String(url).endsWith('/info') ? {} : [{ id: 's1', channelName: 'mine', isPublishing: false }], headers: {} }));
 return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}
it('renders viewer objects and sends only the username when kicking', async () => {
 setup();
 expect(await screen.findByText('alice')).toBeInTheDocument();
 fireEvent.click(screen.getByText('Kick User'));
 expect(mocks.emit).toHaveBeenCalledWith('kick_user', { channelName: 'mine', username: 'alice' });
});

it.each(['CLIENT', 'STREAM_MANAGER'])('polls %s without overlapping requests or retaining timers after unmount', async role => {
 vi.useFakeTimers();
 const view = setup(role);
 await act(async () => { await vi.advanceTimersByTimeAsync(0); });
 expect(screen.queryByText('API + Media CPU (100% = 1 core)')).not.toBeInTheDocument();
 expect(screen.queryByLabelText('Process telemetry')).not.toBeInTheDocument();
 let resolve!: (response: {data: unknown[]; headers: object}) => void;
 const calls = () => vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/api/streams')).length;
 const initial = calls();
 vi.mocked(axios.get).mockImplementation(() => new Promise(r => { resolve = r; }));
 await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
 expect(calls()).toBe(initial + 1);
 await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
 expect(calls()).toBe(initial + 1);
 await act(async () => { resolve({data: [{id:'s1',channelName:'mine',isPublishing:true,viewers:9}], headers:{}}); });
 expect(screen.getByText('LIVE')).toBeInTheDocument();
 if (role === 'CLIENT') expect(screen.getByText('Watch Channel')).not.toBeDisabled();
 view.unmount();
 const before = calls();
 await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
 expect(calls()).toBe(before);
});

it.each(['Delete', 'Rename', 'recording_saved'])('refreshes mounted recording detail after %s', async action => {
 setup();
 await screen.findByText('alice');
 let title = 'Original recording';
 vi.mocked(axios.get).mockImplementation(async url => ({data: String(url).endsWith('/recordings') ? (title ? [{id:'r1',title,startedAt:'2026-01-01',duration:1,fileSize:1}] : []) : String(url).endsWith('/viewers') ? [{username:'alice'}] : [{id:'s1',channelName:'mine'}],headers:{}}));
 const refreshButtons = screen.getAllByText('Refresh');
 fireEvent.click(refreshButtons[1]);
 await screen.findByText('Original recording');
 vi.mocked(axios.delete).mockImplementation(async () => { title = ''; return {}; });
 vi.mocked(axios.put).mockImplementation(async () => { title = 'Renamed recording'; return {}; });
 if (action === 'recording_saved') {
  title = 'New recording';
  act(() => mocks.handlers.get('recording_saved')!());
 } else {
  fireEvent.click(screen.getByText(action));
  if (action === 'Rename') fireEvent.click(await screen.findByText('Save'));
 }
 if (action === 'Delete') await screen.findByText('No recordings available.');
 else await screen.findByText(action === 'Rename' ? 'Renamed recording' : 'New recording');
 expect(screen.queryByText('Original recording')).not.toBeInTheDocument();
});

it('requests catalog-wide search, offline filter and sort with offset reset', async () => {
 setup();
 await screen.findByText('alice');
 const streamCalls = () => vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/api/streams'));
 vi.mocked(axios.get).mockImplementation(async (url, config) => ({data: String(url).endsWith('/api/streams') ? [{id:'s2',channelName: (config?.params as {search?: string} | undefined)?.search ? 'Faraway' : 'next',isPublishing:true}] : [],headers: {'x-next-offset': (config?.params as {offset?:number})?.offset === 50 ? '' : '50','x-total-count':'100'}}));
 fireEvent.change(screen.getByPlaceholderText('Search Channels...'), {target:{value:'Faraway'}});
 await waitFor(() => expect(streamCalls().at(-1)?.[1]?.params).toMatchObject({offset:0,limit:50,search:'Faraway',hideOffline:false,sort:'live-first'}));
 await screen.findByText('Faraway');
 fireEvent.click(screen.getByText('Next channels'));
 await waitFor(() => expect((streamCalls().at(-1)?.[1]?.params as {offset:number})?.offset).toBe(50));
 fireEvent.click(screen.getByLabelText('Show Offline'));
 await waitFor(() => expect(streamCalls().at(-1)?.[1]?.params).toMatchObject({offset:0,hideOffline:true}));
 fireEvent.change(screen.getByLabelText('Sort channels'), {target:{value:'name'}});
 await waitFor(() => expect(streamCalls().at(-1)?.[1]?.params).toMatchObject({offset:0,search:'Faraway',hideOffline:true,sort:'name'}));
});

it('renders actual API/media telemetry, unclipped core CPU and distinguishes estimated restream throughput', async () => {
 setup(); await screen.findByText('alice');
 act(() => mocks.handlers.get('live_stats')!({system:{cpu:7}, streams:{mine:{bitrate:999}}, totalRestreamThroughput:123, telemetry:{api:{cpuPercent:80,memory:{rss:104857600},eventLoop:{p99Ms:2}},media:{cpuPercent:150,memory:{rss:209715200},eventLoop:{p99Ms:8},egressBitsPerSecond:12000000,mediaSafety:{slowDisconnects:3,queuedBytes:1048576,currentQueuedBytes:2097152,peakQueuedBytes:4194304}}}}));
 expect(screen.getByText('API + Media CPU (100% = 1 core)')).toBeInTheDocument();
 expect(screen.getByText('230.0%')).toBeInTheDocument();
 expect(screen.getByText('12000.0 Kbps')).toBeInTheDocument();
 expect(screen.getByText('Media network egress (accepted)')).toBeInTheDocument();
 expect(screen.getByText('Restream throughput (estimated)')).toBeInTheDocument();
 expect(screen.getByText(/API RSS: 100.0 MiB.*p99: 2.0 ms/)).toBeInTheDocument();
 expect(screen.getByText(/Media RSS: 200.0 MiB.*p99: 8.0 ms/)).toBeInTheDocument();
 expect(screen.getByText(/Slow disconnects: 3/)).toBeInTheDocument();
 expect(screen.getByText(/Queues: 1.0 MiB.*reserved: 2.0 MiB.*peak: 4.0 MiB/)).toBeInTheDocument();
 expect(mocks.charts.every(chart => chart.options.scales.y.max === undefined)).toBe(true);
 act(() => mocks.handlers.get('live_stats')!({telemetry:{api:{cpuPercent:5},media:null}}));
 expect(screen.getByText('Media telemetry unavailable')).toBeInTheDocument();
 expect(screen.queryByText('230.0%')).not.toBeInTheDocument();
 expect(screen.queryByText('12000.0 Kbps')).not.toBeInTheDocument();
});

it.each(['offline-filter', 'live-first'])('coalesces admin %s membership changes into server page refreshes and cancels queued work', async mode => {
 const view = setup();
 await screen.findByText('alice');
 if (mode === 'offline-filter') {
  fireEvent.click(screen.getByLabelText('Show Offline'));
  await waitFor(() => expect(vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/api/streams')).at(-1)?.[1]?.params).toMatchObject({hideOffline:true}));
 }
 vi.useFakeTimers();
 const calls = () => vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/api/streams'));
 const initial = calls().length;
 let resolve!: (value: {data: Stream[]; headers: object}) => void;
 vi.mocked(axios.get).mockImplementation((url) => String(url).endsWith('/api/streams') ? new Promise(r => {resolve = r;}) : Promise.resolve({data:[],headers:{}}));
 act(() => {
  mocks.handlers.get('live_stats')!({streams:{outside:{isPublishing:true}}});
  mocks.handlers.get('live_stats')!({streams:{outside:{isPublishing:true,viewers:2}}});
 });
 await act(async () => { await vi.advanceTimersByTimeAsync(500); });
 expect(calls()).toHaveLength(initial + 1);
 // A second transition while HTTP is pending must wait, not abort/restart it.
 act(() => mocks.handlers.get('live_stats')!({streams:{outside:{isPublishing:false},newest:{isPublishing:true}}}));
 await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
 expect(calls()).toHaveLength(initial + 1);
 await act(async () => { resolve({data:[{id:'s2',channelName:'outside',isPublishing:true}],headers:{}}); });
 await act(async () => { await vi.advanceTimersByTimeAsync(500); });
 expect(calls()).toHaveLength(initial + 2);
 await act(async () => { resolve({data:[{id:'s3',channelName:'newest',isPublishing:true}],headers:{}}); });
 expect(screen.getByText('newest')).toBeInTheDocument();
 expect(screen.queryByText('mine')).not.toBeInTheDocument();
 expect(screen.queryByText('outside')).not.toBeInTheDocument();
 act(() => mocks.handlers.get('live_stats')!({streams:{newest:{isPublishing:false}}}));
 view.unmount();
 await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
 expect(calls()).toHaveLength(initial + 2);
 expect(calls().at(-1)?.[1]?.signal?.aborted).toBe(true);
});

it('preserves server-selected name order across publishing updates without needless refetch', async () => {
 const view = setup();
 await screen.findByText('alice');
 vi.mocked(axios.get).mockImplementation(async url => ({data: String(url).endsWith('/api/streams') ? [{id:'a',channelName:'Alpha',isPublishing:false},{id:'z',channelName:'Zulu',isPublishing:false}] : [],headers:{}}));
 fireEvent.change(screen.getByLabelText('Sort channels'), {target:{value:'name'}});
 await screen.findByText('Alpha');
 vi.useFakeTimers();
 const calls = () => vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/api/streams')).length;
 const before = calls();
 act(() => mocks.handlers.get('live_stats')!({streams:{Alpha:{isPublishing:false},Zulu:{isPublishing:true,startTime:100}}}));
 expect(Array.from(view.container.querySelectorAll('section > p')).map(node => node.textContent)).toEqual(['Alpha','Zulu']);
 await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
 expect(calls()).toBe(before);
 expect(screen.getByLabelText('Sort channels')).toHaveValue('name');
 view.unmount();
});

it('keeps performance details collapsed by default and lets admins expand and collapse them', async () => {
 setup(); await screen.findByText('alice');
 const toggle = screen.getByText('Performance details');
 const details = toggle.closest('details');
 expect(details).not.toBeNull();
 expect(details).not.toHaveAttribute('open');
 expect(screen.getByText(/API RSS:/)).not.toBeVisible();
 fireEvent.click(toggle);
 expect(details).toHaveAttribute('open');
 expect(screen.getByText(/API RSS:/)).toBeVisible();
 expect(screen.getByText(/CPU covers API and media/)).toBeVisible();
 fireEvent.click(toggle);
 expect(details).not.toHaveAttribute('open');
 expect(screen.getByText(/API RSS:/)).not.toBeVisible();
});
