# Streaming Platform

An enterprise-level, multi-channel RTMP streaming platform with a unified Solarized Dark UI.

## Project Structure
- `/apps/backend`: Node.js server managing RTMP ingest, restreaming, and the administrative API.
- `/apps/frontend`: React application providing a real-time dashboard and web player.

## Core Features
- **Centralized Dashboard**: Real-time metrics for CPU load, Ingress/Egress throughput, and viewer counts.
- **Multi-Platform Restreaming**: Simultaneously push streams to Twitch, Facebook, TikTok, and more.
- **Automated Recordings**: Record broadcasts to MP4 with in-browser playback and management.
- **Granular RBAC**: Admin, Manager, and Client roles with specific channel authorizations.
- **Secure Access**: Password-protected channels and encrypted authentication.

## Quick Start (Development)

### 1. Backend Setup
```bash
cd apps/backend
npm install
npx prisma migrate dev
node setup_admin.js
node seed_settings.js
npm start
```

### 2. Frontend Setup
```bash
cd apps/frontend
npm install
npm run dev -- --port 5174 --host
```

Access the dashboard at `http://localhost:5174` and log in with your admin credentials.

---

## Testing

The project uses **Jest** for backend testing and **Vitest** for frontend testing.

### Run all tests:
```bash
# Backend
cd apps/backend
npm test

# Frontend
cd apps/frontend
npm test
```

The frontend build process (`npm run build`) automatically runs the test suite before generating production assets.

---

## Production Deployment

### 1. Backend Deployment
- Ensure **PostgreSQL**, **Redis**, and **FFmpeg** are installed on the target server.
- Clone the repository and install dependencies in `apps/backend`.
- Run migrations and seed scripts as described in the Backend Setup.
- **Important:** After starting the server for the first time, log in as an Admin and navigate to **App Settings**. Update the `server_hostname` to your server's public IP or domain. This ensures that the ingest and player URLs are correctly displayed to users.
- Use a process manager like **PM2** to keep the server running:
  ```bash
  pm2 start index.js --name "streaming-backend"
  ```

### 2. Frontend Deployment
- The frontend is a static Vite application.
- Set the following environment variables before building to point to your production server:
  - `VITE_API_URL`: The full URL of your backend API (e.g., `https://api.yourdomain.com`).
  - `VITE_MEDIA_URL`: The full URL of your media server (e.g., `http://yourdomain.com:8000`).
  - `VITE_SOCKET_URL`: The full URL for WebSocket connections (usually same as API).
- Run the build command:
  ```bash
  cd apps/frontend
  npm install
  npm run build
  ```
- Deploy the contents of the `dist` folder to your web server (Nginx, Apache, etc.).

### 3. Ports & Firewall
Ensure the following ports are open on your server's firewall:
- `1935`: RTMP Ingest
- `3000`: Backend API & WebSockets
- `8000`: Media Server (HTTP-FLV)
- `80/443`: Frontend Web Server
