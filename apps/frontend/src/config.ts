// Global Application Configuration
// These values can be overridden by environment variables at build time using Vite's import.meta.env

const origin = window.location.origin;
const apiFallback = import.meta.env.DEV ? 'http://localhost:3000' : origin;
const mediaFallback = import.meta.env.DEV ? 'http://localhost:8000' : `${origin}/media`;

export const API_BASE_URL = import.meta.env.VITE_API_URL || apiFallback;
export const MEDIA_BASE_URL = import.meta.env.VITE_MEDIA_URL || mediaFallback;

// Socket.io connection URL
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || apiFallback;

// Default RTMP Ingest URL for informational purposes
export const RTMP_INGEST_BASE = import.meta.env.VITE_RTMP_INGEST || 'rtmp://localhost/live';
