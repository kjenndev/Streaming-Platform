import axios from 'axios';
export interface Page<T> { items: T[]; next: number | null; total: number }
export async function fetchPage<T>(url: string, token: string | null, offset = 0, signal?: AbortSignal, filters?: { search: string; hideOffline: boolean; sort: 'live-first' | 'name' }): Promise<Page<T>> {
  const response = await axios.get<T[]>(url, { headers: { Authorization: `Bearer ${token}` }, params: { ...filters, offset, limit: 50 }, signal });
  if (!Array.isArray(response.data) || response.data.length > 50) throw new Error('Invalid pagination response');
  const raw = response.headers['x-next-offset'];
  const next = raw == null || raw === '' ? null : Number(raw);
  if (next !== null && (!Number.isSafeInteger(next) || next <= offset)) throw new Error('Invalid pagination offset');
  const total = Number(response.headers['x-total-count'] ?? response.data.length);
  return { items: response.data, next, total: Number.isFinite(total) ? total : response.data.length };
}

export async function fetchStreamCatalog<T>(url: string, token: string | null, signal?: AbortSignal) {
  const items: T[] = [];
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    signal?.throwIfAborted();
    const page = await fetchPage<T>(url, token, offset, signal);
    signal?.throwIfAborted();
    items.push(...page.items);
    if (page.next === null) return items;
    offset = page.next;
  }
  throw new Error('Stream catalog exceeds 5000 channels; narrow the selection');
}
