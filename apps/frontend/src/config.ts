// Global Application Configuration
// These values can be overridden by environment variables at build time using Vite's import.meta.env

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
export const MEDIA_BASE_URL = import.meta.env.VITE_MEDIA_URL || 'http://localhost:8000';

// Socket.io connection URL
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

// Default RTMP Ingest URL for informational purposes
export const RTMP_INGEST_BASE = import.meta.env.VITE_RTMP_INGEST || 'rtmp://localhost/live';
