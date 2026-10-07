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

Requirements: **Node.js 22.12+**, npm, PostgreSQL, Redis, and FFmpeg on PATH.
Run dependency installation from the workspace root, using the committed lockfile:

```bash
npm ci
cp apps/backend/.env.example apps/backend/.env
```

Edit `.env` with a dedicated database connection and a strong random JWT secret.
Create the PostgreSQL database/role first. Keep PostgreSQL and Redis private.
Never reuse the example placeholders as real credentials.

```bash
cd apps/backend
npx prisma generate
npx prisma migrate deploy
node seed_settings.js
node setup_admin.js admin '<strong-unique-password>'
npm start
```

The admin creation helper prints the supplied password: run it privately. Do not
re-run it to reset an existing account. In a second terminal, from the root:

```bash
npm run dev --workspace frontend -- --port 5174 --host 127.0.0.1 --strictPort
```

Open `http://localhost:5174`. This loopback configuration does **not** expose the
application to other LAN devices. LAN access needs an intentional bind-address,
URL, WSL networking, and firewall configuration; do not expose the development
server as a public production service.

## Testing and builds

Create a separate backend `.env.test` with a dedicated test PostgreSQL database,
Redis database, and JWT secret. Test recording files must use a dedicated temporary
root, not the production recording directory. Never point tests at application data. Apply the
same migrations to that test database before integration tests. Test bootstrap
must reject unsafe database configuration rather than silently use `.env`.

```bash
npm test
npm run build
```

The frontend build runs its tests and TypeScript checks before producing assets.
A passing development page is not proof of a passing production build.

Performance harness and limitations: [scripts/performance/README.md](scripts/performance/README.md).
Implementation and verification notes: [docs/performance-hardening.md](docs/performance-hardening.md).

---

## Performance hardening

See [runtime ownership, metrics and capacity-testing guidance](docs/performance-hardening.md) and the [repeatable load harness](scripts/performance/).

## Production Deployment

### 1. Backend Deployment
- Ensure **PostgreSQL**, **Redis**, and **FFmpeg** are installed on the target server.
- Clone the repository and run `npm ci` from the workspace root. Generate Prisma and apply migrations from `apps/backend` before starting the API.
- Run migrations and seed scripts as described in the Backend Setup.
- **Important:** After starting the server for the first time, log in as an Admin and navigate to **App Settings**. Update the `server_hostname` to your server's public IP or domain. This ensures that the ingest and player URLs are correctly displayed to users.
- Use a process manager like **PM2** to keep one API instance running. The API supervises its media child; do not enable PM2 cluster mode against the same ports/state:
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
  # From the workspace root, after npm ci
  npm run build
  ```
- Deploy the contents of the `dist` folder to your web server (Nginx, Apache, etc.).

### 3. Ports & Firewall
Allow only the required client networks through the firewall. These are the default service ports, not a recommendation to expose every listener publicly:
- `1935`: RTMP Ingest
- `3000`: Backend API & WebSockets
- `8000`: Media Server (HTTP-FLV)
- `80/443`: Frontend Web Server
