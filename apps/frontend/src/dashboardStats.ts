import type { ChannelStats, Stream } from './models';
export function mergeStats(rows: Stream[], stats: Record<string, ChannelStats>): Stream[] {
  let changed = false;
  const next = rows.map(row => {
    const stat = stats[row.channelName];
    const update = { viewers: stat?.viewers || 0, isPublishing: !!stat?.isPublishing, startTime: stat?.startTime || 0, lastStartedAt: stat?.lastStartedAt ?? row.lastStartedAt };
    if (row.viewers === update.viewers && row.isPublishing === update.isPublishing && row.startTime === update.startTime && row.lastStartedAt === update.lastStartedAt) return row;
    changed = true;
    return { ...row, ...update };
  });
  if (!changed) return rows;
  // Page membership and ordering belong to the server query, not telemetry.
  return next;
}
