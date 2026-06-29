# omeglesite

An Omegle-style random chat app with **live video** and **text chat**. Two strangers are
randomly paired; either can hit **New** to meet someone new.

It runs in two places:

- **Locally / on your LAN** — `npm run dev` (no database needed)
- **Online on Vercel** — serverless functions + **Supabase** (free tier) for shared state

Video and audio are **peer-to-peer over WebRTC**. The server only pairs people, relays
signaling, and delivers chat messages.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in two browser tabs, click **Start** in both, and you'll be paired.
No Supabase setup required for local dev — it uses in-memory storage automatically.

## Deploy to Vercel + Supabase (free)

### 1. Create a Supabase project (free)

1. Go to [supabase.com](https://supabase.com) → **Start your project** → create a new project.
2. Open **SQL Editor** → **New query**, paste the contents of `supabase/schema.sql`, and **Run**.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** key (under "Project API keys") → `SUPABASE_SERVICE_ROLE_KEY`
   
   > Use the **service_role** key on Vercel only — never put it in frontend code.

### 2. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) → import **FoundYourFlow/omeglesite**.
2. Before deploying, add **Environment Variables**:
   - `SUPABASE_URL` = your project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = your service role key
   
   If Vercel's Supabase integration already created variables named
   `STORAGE_SUPABASE_URL` and `STORAGE_SUPABASE_SERVICE_ROLE_KEY`, those work too.
3. Click **Deploy**.

Every push to `main` auto-deploys if the repo is linked to Vercel.

### 3. Test

Open your `*.vercel.app` URL on two devices, click **Start**, and you're connected.

## How it works

```
Browser A  ──(HTTP poll /api/rtc)──►  Vercel function ◄──(HTTP poll /api/rtc)── Browser B
     │                               (Supabase: queue,                               │
     │                                mailboxes, pairings)                            │
     └────────────────  WebRTC peer-to-peer video / audio  ──────────────────────────┘
```

- `api/rtc.js` — single endpoint: `join`, `poll`, `signal`, `chat`, `leave`, `next`.
- `lib/matchmaker.js` — queueing, pairing, mailboxes, liveness via heartbeats.
- `lib/store.js` — Supabase Postgres in production, in-memory for local dev.
- `supabase/schema.sql` — two small tables (`store_kv`, `store_list`).
- `public/` — Omegle-style UI.

## Connectivity note

WebRTC needs STUN/TURN for peers on different networks. Free public servers are configured
in `public/app.js`. For guaranteed connectivity across strict NATs, add your own TURN
credentials (Twilio, Metered, or self-hosted coturn).
