import { expect, it } from 'vitest';
import { mergeStats } from '../dashboardStats';
it('preserves unchanged row and array identity without sorting every tick', () => {
  const rows = [{ id: '1', channelName: 'a', isPublishing: true, viewers: 2, startTime: 100, lastStartedAt: undefined }];
  expect(mergeStats(rows, { a: { isPublishing: true, viewers: 2, startTime: 100 } })).toBe(rows);
  const next = mergeStats(rows, { a: { isPublishing: true, viewers: 3, startTime: 100 } });
  expect(next[0].viewers).toBe(3);
  expect(mergeStats(next, {})[0].viewers).toBe(0);
});
