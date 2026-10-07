import { expect, it, vi } from 'vitest';
import axios from 'axios';
import { fetchPage } from '../pagination';
vi.mock('axios');
it('requests bounded array pages and rejects looping offsets', async () => {
  vi.mocked(axios.get).mockResolvedValueOnce({ data: [{ id: 1 }], headers: { 'x-next-offset': '50', 'x-total-count': '100' } });
  expect(await fetchPage('/api/streams', 'token', 0)).toEqual({ items: [{ id: 1 }], next: 50, total: 100 });
  expect(axios.get).toHaveBeenCalledWith('/api/streams', expect.objectContaining({ params: { offset: 0, limit: 50 } }));
  vi.mocked(axios.get).mockResolvedValueOnce({ data: [], headers: { 'x-next-offset': '50' } });
  await expect(fetchPage('/api/streams', 'token', 50)).rejects.toThrow('Invalid pagination');
});
