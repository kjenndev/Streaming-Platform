import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode, ReactElement } from 'react';
import axios from 'axios';
import Dashboard from '../pages/Dashboard';
import type { Stream } from '../models';
vi.mock('axios');
vi.mock('../components/Header', () => ({ default: () => null }));
vi.mock('react-chartjs-2', () => ({ Line: () => null }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), removeAllListeners: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('primereact/button', () => ({ Button: ({ label, tooltip, icon, onClick, disabled }: {label?: string; tooltip?: string; icon?: string; onClick?: () => void; disabled?: boolean}) => <button disabled={disabled} onClick={onClick}>{label || tooltip || icon}</button> }));
vi.mock('primereact/datatable', () => ({ DataTable: ({value, children}: {value: Stream[]; children: ReactElement<{body?: (row: Stream) => ReactNode}>[]}) => <>{value.map(row => <section key={row.id}>{children.map((col, i) => <div key={i}>{col.props.body?.(row)}</div>)}</section>)}</> }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

const cases = [
 {origin:'https://stream.example.test:8443', hostname:'localhost', port:1935, expected:'rtmp://stream.example.test:1935/live'},
 {origin:'http://203.0.113.42:8080', hostname:'localhost', port:1935, expected:'rtmp://203.0.113.42:1935/live'},
 {origin:'http://localhost:5174', hostname:'localhost', port:1935, expected:'rtmp://localhost:1935/live'},
 {origin:'https://stream.example.test', hostname:'ingest.example.test', port:2935, expected:'rtmp://ingest.example.test:2935/live'},
 {origin:'https://stream.example.test', hostname:'2001:db8::42', port:2935, expected:'rtmp://[2001:db8::42]:2935/live'},
 {origin:'https://[2001:db8::20]:8443', hostname:'localhost', port:1935, expected:'rtmp://[2001:db8::20]:1935/live'},
 {origin:'https://stream.example.test', hostname:'[2001:db8::42]', port:2935, expected:'rtmp://[2001:db8::42]:2935/live'},
 {origin:'https://stream.example.test', hostname:'ignored.example.test', port:1935, override:'rtmps://ingest.example.test:443/custom/live', expected:'rtmps://ingest.example.test:443/custom/live'},
 {origin:'https://stream.example.test', hostname:'localhost', port:1935, override:'rtmp://[2001:db8::99]:2935/live', expected:'rtmp://[2001:db8::99]:2935/live'},
 {origin:'https://stream.example.test', hostname:'', port:1935, expected:'rtmp://stream.example.test:1935/live'},
];
it.each(cases)('displays and copies $expected at $origin without changing the player origin or key', async ({origin,hostname,port,override,expected}) => {
 vi.stubGlobal('location', new URL(origin));
 vi.stubEnv('VITE_RTMP_INGEST', override || '');
 const writeText = vi.fn().mockResolvedValue(undefined);
 vi.stubGlobal('navigator', {clipboard:{writeText}});
 const open = vi.spyOn(window, 'open').mockImplementation(() => null);
 localStorage.setItem('roles', '["ADMIN"]');
 vi.mocked(axios.get).mockImplementation(async url => ({data: String(url).endsWith('/info') ? {hostname,rtmpPort:port,mediaPort:8000} : [{id:'s1',channelName:'demo',streamKey:'synthetic-only',isPublishing:true}],headers:{}}));
 render(<MemoryRouter><Dashboard /></MemoryRouter>);
 fireEvent.click(await screen.findByText('Connection Info'));
 const dialog = await screen.findByRole('dialog');
 const values = [expected,'demo?key=synthetic-only',`${origin}/watch/demo`];
 for (const value of values) {
  const input = within(dialog).getByDisplayValue(value);
  fireEvent.click(within(input.parentElement!).getByRole('button'));
  expect(writeText).toHaveBeenLastCalledWith(value);
 }
 fireEvent.click(screen.getByText('Watch Channel'));
 expect(new URL(open.mock.calls.at(-1)![0] as string, origin).href).toBe(values[2]);
 open.mockRestore();
});
