# Streaming Platform - Frontend

A modern, responsive dashboard and web player for the RTMP streaming platform. Built with a focused **Solarized Dark** aesthetic.

## Technologies
- **React + Vite**: Fast, modern frontend framework.
- **TypeScript**: Static typing for reliability.
- **PrimeReact**: Professional UI component library.
- **Chart.js**: Real-time throughput and system monitoring graphs.
- **flv.js**: Low-latency browser decoding for HTTP-FLV streams.
- **Emoji-Picker-React**: Integrated chat emoji support.

## Key Modules
- **Admin Dashboard**: Central hub for monitoring system health, active channel bitrates, and viewer counts.
- **Channel Editor**: Configure channel names, passwords, recording status, and per-platform restream keys.
- **User Management**: Granular RBAC interface for creating users and assigning specific channel permissions.
- **App Settings**: Global configuration UI for system ports and hostnames.
- **Web Player**: Public-facing viewer interface with low-latency video and real-time chat.

## Getting Started

### Prerequisites
- Node.js (v18+)
- Backend server running on port 3000

### Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run development server:
   ```bash
   npm run dev -- --port 5174 --host
   ```

### Production Build
To build the application for production, you must set the environment variables to point to your production backend.

1. Create a `.env.production` file or set them in your shell:
   ```env
   VITE_API_URL=https://api.yourdomain.com
   VITE_MEDIA_URL=http://yourdomain.com:8000
   VITE_SOCKET_URL=https://api.yourdomain.com
   VITE_RTMP_INGEST=rtmp://yourdomain.com/live
   ```
2. Run the build:
   ```bash
   npm run build
   ```
3. The production-ready files will be in the `dist/` directory.

## Chat layout regression

`src/test/chat.test.tsx` covers bounded history, follow-scroll state and escaped message rendering. Native geometry is checked separately by `scripts/chat-layout.mjs` (requires an existing Playwright installation and Chromium):

```bash
# Never replace dist while the local preview is serving it.
node ../../node_modules/vite/bin/vite.js build --outDir /absolute/external/chat-build
node scripts/chat-layout.mjs /absolute/external/chat-build /absolute/external/chat-evidence
```

If Playwright is installed outside this workspace, set `PLAYWRIGHT_MODULE` to its `index.mjs` file URL. The harness intercepts all networking, supplies synthetic Socket.IO/API events and inert media, and checks 1280/390/320px geometry, wrapped messages, history, input stability and local send behavior. It writes screenshots and `compactchat-report.json`; it never joins or sends to a real channel.

## Design Language
The UI follows strict **Solarized Dark** principles:
- **Background**: `#002b36` (base03)
- **Primary Highlights**: `#268bd2` (blue)
- **Success States**: `#859900` (green)
- **Alerts**: `#dc322f` (red)
- **Charts**: Interactive lines using Solarized Blue, Green, and Magenta.
- **Layout**: Full-bleed dashboard with responsive, centered editors.
