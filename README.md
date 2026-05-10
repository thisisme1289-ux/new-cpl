# CPL Cricket Game

Realtime hand-cricket web game with room-code matches, 12 vs 12 team setup, and playable Player vs Bot practice.

## Run Locally

```bash
npm install
npm run dev
```

Client: http://localhost:5173  
Server: http://localhost:4000  
Health check: http://localhost:4000/health

The local client connects to `http://localhost:4000` unless `VITE_SOCKET_URL` is set.

## Deploy Live

Recommended setup: **GitHub + Railway**.

- GitHub stores the source code.
- Railway hosts the Vite browser app.
- Railway hosts the long-running Node/Express Socket.IO server.

Vercel alone is not recommended for this project because CPL needs a persistent Socket.IO server.

## GitHub Upload Checklist

Upload these files and folders:

- `src/`
- `server/`
- `index.html`
- `package.json`
- `package-lock.json`
- `README.md`
- `.gitignore`
- `.env.example`

Do not upload:

- `node_modules/`
- `dist/`
- `.env`

## Railway Backend Service

Create a Railway service from the GitHub repo for the Socket.IO backend.

Settings:

- Root directory: repo root
- Build command: `npm install`
- Start command: `npm run server`
- Health check path: `/health`

Environment variables:

```bash
FRONTEND_URL=https://your-cpl-frontend-domain
```

Railway sets `PORT` automatically. The server also supports local fallback port `4000`.

After deployment, Railway will give you a public backend URL. Use that URL for the frontend `VITE_SOCKET_URL`.

## Railway Frontend Service

Create a second Railway service from the same GitHub repo for the browser app.

Settings:

- Root directory: repo root
- Build command: `npm install && npm run build`
- Output directory: `dist`

Environment variables:

```bash
VITE_SOCKET_URL=https://your-cpl-backend-domain
```

Use `https://` in production. A deployed HTTPS frontend cannot connect to an insecure `http://` Socket.IO backend.

After the frontend URL is generated, update the backend service:

```bash
FRONTEND_URL=https://your-cpl-frontend-domain
```

Then redeploy the backend.

## Multi-Device Test Plan

1. Open the deployed frontend URL on phone, laptop, and another browser.
2. Create a Single Player room on device A.
3. Join the room code from device B.
4. Confirm toss choice, ball choices, reveals, innings break, chase, and result panel.
5. Test Multiplayer public and private room setup.
6. Test Player vs Bot on each device.
7. Open the backend health URL and confirm it returns:

```json
{ "ok": true }
```

8. If multiplayer does not connect, check browser console for CORS or mixed-content errors.

## Environment Variables

Frontend:

- `VITE_SOCKET_URL`: public Socket.IO backend URL.

Backend:

- `FRONTEND_URL`: public frontend URL allowed by Socket.IO CORS.
- `PORT`: server port. Railway sets this automatically.

For multiple frontend domains, comma-separate `FRONTEND_URL`:

```bash
FRONTEND_URL=https://main-domain.com,https://preview-domain.com
```

## Current Modes

- Single Player: playable `1 vs 1` room-code match.
- Multiplayer: playable team setup with public random rooms and private room codes.
- Player vs Bot: playable local practice mode with bot difficulty, stats, and match flow.

## Visual System

- Direction: stadium broadcast game UI.
- Local assets live in `src/assets/`.
- CSS motion respects reduced-motion preferences.
- Every UI change should remain responsive for desktop, mobile, and touch devices.
