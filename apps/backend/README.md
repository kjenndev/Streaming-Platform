# Streaming Platform - Backend

This is the backend core for the high-performance RTMP streaming platform. It manages video ingest, multi-platform restreaming, automated recordings, and the administrative API.

## Core Technologies
- **Node.js**: Runtime environment.
- **Node-Media-Server (v4)**: RTMP ingest and HTTP-FLV delivery.
- **Express**: REST API framework.
- **Socket.io**: Real-time stats and chat synchronization.
- **Prisma + PostgreSQL**: Persistent storage for channels, users, and recordings.
- **Redis**: High-speed tracking of live viewers and stream metadata.
- **FFmpeg**: Manual relay engine for restreaming and MP4 conversion.

## Key Features
- **RTMP Ingest**: High-performance video ingest on port 1935.
- **Multi-Platform Restreaming**: Simultaneously relay streams to Twitch, Facebook (RTMPS), TikTok, and Instagram using manual FFmpeg processes.
- **Automated Recordings**: Optional per-channel recording that captures live broadcasts and converts them to web-friendly MP4 files.
- **Role-Based Access Control (RBAC)**: Supports `ADMIN`, `STREAM_MANAGER`, and `CLIENT` roles with granular permissions.
- **Live Metrics**: Real-time calculation of bitrate (ingress/egress), viewer counts, and system CPU load.
- **Dynamic Configuration**: Global app settings managed via the database and UI.

## Getting Started

### Prerequisites
- Node.js (v18+)
- PostgreSQL
- Redis
- FFmpeg (installed and accessible in system path)

### Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment:
   Create a `.env` file with the following:
   ```env
   DATABASE_URL="postgresql://user:pass@localhost:5432/db_name"
   REDIS_URL="redis://localhost:6379"
   JWT_SECRET="your-secret-key"
   RTMP_PORT=1935
   HTTP_PORT=3000
   MEDIA_HTTP_PORT=8000
   VERBOSE=false
   ```
3. Initialize Database:
   ```bash
   npx prisma migrate dev
   node setup_admin.js
   node seed_settings.js
   ```

### Running the Server
```bash
npm start
```

### Post-Startup Configuration
Once the server is running and you have logged into the Admin Dashboard:
1. Navigate to **App Settings** from the user profile menu.
2. Update the `server_hostname` to your server's public IP or domain.
3. Update any port numbers or FFmpeg paths if they differ from the defaults.
4. Note: Core service port changes require a server restart.

## Logging
The backend supports a **Verbose Mode** for debugging:
- Set `VERBOSE=true` in `.env` to see real-time WebSocket traffic and process logs.
- Normal mode (`VERBOSE=false`) only shows critical events and errors.
