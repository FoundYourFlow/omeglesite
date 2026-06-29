# omeglesite

An Omegle-style random chat app with **live video** and **text chat**. Two strangers are
randomly paired; either can hit **Next** to meet someone new.

It runs in two places:

- **Locally / on your LAN** — `npm run dev`
- **Online, deployed on Vercel** — serverless functions handle matchmaking & signaling

Video and audio are sent **peer-to-peer over WebRTC** (they never touch the server). The
server is only used to pair people and relay the small WebRTC "handshake" messages. Text
chat travels over a WebRTC data channel, so it's also peer-to-peer.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in two browser tabs (or share the printed `Network` URL with
another device on your Wi‑Fi), click **Start** in both, and you'll be paired.

> Browsers only allow camera/mic on `https://` or `localhost`. On the LAN URL (plain
> `http://192.168.x.x`) some browsers block the camera. For LAN testing use two tabs on the
> host machine, or deploy to Vercel (HTTPS) for real cross-device use.

## Deploy to Vercel (works online)

Because Vercel is **serverless**, it can't run a long-lived WebSocket server. This project is
built for that: matchmaking/signaling live in `api/rtc.js` and share state through a small
**Upstash Redis** store (the Vercel-recommended replacement for the old Vercel KV).

1. Push this repo to GitHub (already done if you cloned from GitHub).
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import this repo.
3. In the project, open **Storage → Create Database → Upstash for Redis** (from the Marketplace)
   and connect it to the project. This auto-adds the `KV_REST_API_URL` / `KV_REST_API_TOKEN`
   (a.k.a. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) env vars.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the functions pick up the Redis variables.
5. Open your `*.vercel.app` URL on two devices, click **Start**, and you're connected.

Or deploy from the CLI:

```bash
npm i -g vercel
vercel            # link & deploy a preview
vercel --prod     # production deploy
```

> **Without Redis** the app still deploys and may work when both users happen to hit the same
> warm function instance, but matchmaking is unreliable. **Add Upstash Redis for correct
> multi-user behavior.**

## How it works

```
Browser A  ──(HTTP poll /api/rtc)──►  Vercel function ◄──(HTTP poll /api/rtc)── Browser B
     │                               (Vercel KV: queue,                              │
     │                                mailboxes, pairings)                           │
     └────────────────  WebRTC peer-to-peer video / audio / chat  ──────────────────┘
```

- `api/rtc.js` — single endpoint with actions: `join`, `poll`, `signal`, `leave`, `next`.
- `lib/matchmaker.js` — queueing, pairing, mailboxes, liveness via heartbeats.
- `lib/store.js` — Upstash Redis in production, in-memory for local dev.
- `public/` — the UI (`index.html`, `style.css`, `app.js`).

## Connectivity note

WebRTC needs a TURN server to connect peers behind strict/symmetric NATs. Free public STUN +
best-effort TURN servers are configured in `public/app.js`. For guaranteed cross-network
connectivity, plug in your own TURN credentials (e.g. Twilio, Metered, or a self-hosted
coturn) in the `ICE_SERVERS` config.
