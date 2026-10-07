import { useEffect, useState, type ReactNode } from 'react';
import { Button } from 'primereact/button';
import { fetchPage, type Page } from '../pagination';

// Mounted only for an expanded row/tab; one page retained, no prefetch.
export default function PagedItems<T>({ url, token, children, generation = 0 }: { generation?: number; url: string; token: string | null; children: (items: T[]) => ReactNode }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<T>>({ items: [], next: null, total: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchPage<T>(url, token, offset, controller.signal).then(result => {
      if (!controller.signal.aborted) { setPage(result); setError(''); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setError('Could not load this page.'); setLoading(false); } });
    return () => controller.abort();
  }, [url, token, offset, refresh, generation]);
  const move = (value: number) => { setLoading(true); setOffset(value); };
  return <>
    {error && <p role="alert">{error}</p>}
    {loading ? <p>Loading…</p> : !error && children(page.items)}
    <div className="flex gap-2 align-items-center p-2">
      <Button label="Previous" disabled={loading || offset === 0} onClick={() => move(Math.max(0, offset - 50))} />
      <span>{!error && `${page.items.length ? offset + 1 : 0}–${offset + page.items.length} of ${page.total}`}</span>
      <Button label="Next" disabled={loading || !!error || page.next === null} onClick={() => move(page.next!)} />
      <Button label="Refresh" disabled={loading} onClick={() => { setLoading(true); setRefresh(v => v + 1); }} />
    </div>
  </>;
}
