export interface Restream { url?: string; key?: string; enabled?: boolean }
export interface Stream { id: string; channelName: string; streamKey?: string; isLive?: boolean; isPublishing?: boolean; isDisabled?: boolean; isPasswordProtected?: boolean; password?: string; isRecordingEnabled?: boolean; restreamUrls?: Record<string, Restream>; viewers?: number; startTime?: number; lastStartedAt?: string; }
export interface Recording { id: string; title?: string; fileName: string; filePath: string; startedAt: string; duration: number; fileSize: string | number; stream?: Stream }
export interface ChannelStats { viewers?: number; isPublishing?: boolean; startTime?: number; lastStartedAt?: string; bitrate?: number }
export interface ProcessTelemetry {
  cpuPercent?: number;
  memory?: { rss?: number };
  eventLoop?: { p99Ms?: number; maxMs?: number; utilization?: number };
  egressBitsPerSecond?: number;
  mediaSafety?: { slowDisconnects?: number; queuedBytes?: number; currentQueuedBytes?: number; peakQueuedBytes?: number };
}
export interface LiveStats { telemetry?: { api?: ProcessTelemetry | null; media?: ProcessTelemetry | null }; streams?: Record<string, ChannelStats>; system?: { cpu?: number }; totalRestreams?: number; totalRestreamThroughput?: number }
export interface User { id: string; username: string; roles: string[]; authorizedStreams?: Stream[] }
export interface StreamOption { label: string; value: string }
export interface Setting { key: string; value: string; description?: string }
export interface SecurityLog { event: string; createdAt: string; username?: string; ip?: string; details?: string }
