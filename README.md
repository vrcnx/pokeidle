# Pokémon Idle MMO

An idle / auto-battling Pokémon MMO with cloud saves, live chat, friend system, and peer-to-peer trades. Browser-based React frontend, Hono + Prisma + Socket.IO backend, separate admin dashboard. Gen 1 + 2-5 legendaries; raids organised by tier (Birds & Beasts → Mythical).

> ⚠ **Unofficial fan project.** Not affiliated with, endorsed by, or sponsored by Nintendo, Game Freak, or The Pokémon Company. Non-commercial. No copyrighted Pokémon assets are stored on this repo's servers — sprites are loaded at runtime from public PokeAPI CDN URLs.

## Layout

```
pokeidle/
├── game/        # Player-facing React app  (port 5173 in dev)
├── admin/       # Admin dashboard React app (port 5174 in dev)
├── server/      # Hono + Prisma + Socket.IO backend (port 8787 in dev)
└── tools/       # Internal utilities (map editor mockups, sprite scripts)
```

Three independent npm packages — no top-level workspace. Each has its own `package.json` and is built/deployed separately.

## Local dev

```bash
# 1. Server
cd server
cp .env.example .env       # fill in DATABASE_URL + BETTER_AUTH_SECRET
npm install
npm run db:push            # apply Prisma schema
npm run dev                # → http://localhost:8787

# 2. Game (in a new terminal)
cd game
npm install
npm run dev                # → http://localhost:5173

# 3. Admin (optional, in a new terminal)
cd admin
npm install
npm run dev                # → http://localhost:5174
```

Sign in with the email you set as `ADMIN_BOOTSTRAP_EMAIL` in `.env` to auto-promote yourself to admin on first login.

## Production deploy

- **Server**: Railway with a Postgres plugin. Set `DATABASE_URL`, `BETTER_AUTH_SECRET` (32+ random bytes), `BETTER_AUTH_URL`, `FRONTEND_ORIGIN` (comma-separated game + admin URLs), `ADMIN_BOOTSTRAP_EMAIL`, optionally `GOOGLE_CLIENT_ID/SECRET`. Server refuses to boot in `NODE_ENV=production` if `BETTER_AUTH_SECRET` is unset or still the dev default.
- **Game / Admin**: any static host (Vercel, Netlify, Railway static, etc.). Set `VITE_SERVER_URL` at build time pointing at your server URL.

Full deploy notes in [server/README.md](server/README.md).

## Tech

- **Frontend**: React 18 + Vite + TypeScript. State is `useReducer` + Context. Battle resolver is an event-driven simulator that emits typed events the UI consumes one-at-a-time for typewriter-paced animations.
- **Backend**: Hono on Node, Better Auth for email/Google OAuth, Prisma → Postgres in prod (SQLite locally), Socket.IO for chat / presence / trades.
- **Anti-cheat**: server-side save validation (IV/EV/move/level bounds), rate limits on auth + saves + chat + trade events, server-canonical Pokémon swap on trade lock-in (clients can't dupe by lying about ownership), session enforcement (newest cookie wins).
- **Sprites**: Gen 5 Black/White animated set from the PokeAPI sprites repo via jsDelivr. Game ships only species with IDs ≤ 649 to keep the sprite set 100% available.

## License

MIT for the original code in this repo. Pokémon names, sprites, and trademarks remain the property of their respective rights-holders; this project is a fan game distributed under fair-use principles. If you're a rights-holder and want this taken down, open an issue and we'll comply.
