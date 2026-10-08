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
- **Important:** Configure the advertised ingest endpoint as described below. The website and RTMP ingest may require different public hosts; a working website does not establish RTMP reachability.
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


### Connection Details: advertised ingest vs. website

The dashboard's **Connection Info → Connection Details** dialog uses this order
for its OBS **Server URL**:

1. `VITE_RTMP_INGEST`, set **before building the frontend**, is the complete
   advertised ingest URL, e.g. `rtmp://ingest.example.com:1935/live` or
   `rtmps://ingest.example.com:443/live`. It preserves the configured scheme,
   external port and path. The stream editor already uses this setting too.
   This is the preferred option when an external port, TLS terminator or proxy
   mapping differs from the backend listener. It does not enable TLS by itself.
2. Otherwise, **App Settings → `server_hostname`** supplies the ingest hostname
   or literal IP (no scheme, path or port). The dialog uses `rtmp://`, the
   effective RTMP listener port from `/api/info`, and `/live`. IPv6 literals may
   be bracketed or unbracketed. An explicit non-localhost setting wins over the
   website host, allowing separate ingest and web hosts.
3. If that setting is empty or the seeded `localhost`, the dialog falls back to
   the **current website hostname/IP**, retaining the API's RTMP port. This is a
   same-host convenience, **not public IP discovery or a reachability check**.
   Local development at localhost still advertises localhost.

The **Web Player Link** always uses the current frontend origin, preserving its
HTTP/HTTPS scheme and web port, just like **Watch Channel**. An ingest hostname
must not replace the player hostname. Stream keys and playback/API/socket
configuration are unchanged. `VITE_API_URL`, `VITE_MEDIA_URL` and `VITE_SOCKET_URL`
still need their existing production configuration; this dialog fix does not
change their localhost defaults. The editor's legacy fallback (when no
`VITE_RTMP_INGEST` is supplied) is unchanged; set that variable for a consistent
explicit ingest URL in both screens.

For a website behind an ordinary Cloudflare HTTP proxy, do **not** assume the
proxied website hostname accepts RTMP. Use an independently reachable ingest
endpoint, such as a separate **DNS-only** record pointing to your public ingress
IP, and advertise it using the settings above. Keep the website's proxy and
certificate configuration separate. DNS-only configuration alone is not enough:
the external TCP port, firewall, router/NAT forwarding and listener must all be
verified independently. Advertising an endpoint neither opens a port nor proves
that an encoder can connect.

A browser knows the website hostname or the literal IP used to open it, not the
origin's public ingress IP behind NAT/CDN. If a literal public IP is required,
set `server_hostname` to that IP or use it in `VITE_RTMP_INGEST`. No visitor IP,
forwarded request header, private bind address, or third-party external-IP lookup
is used to guess the server address.
