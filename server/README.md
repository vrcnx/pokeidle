# Pokemon MMO Server

Backend for the multiplayer Pokemon idle game. Hono + Prisma + Better Auth + Socket.IO.

## Local dev

```bash
cd server
cp .env.example .env       # then edit values; defaults work for local SQLite
npm install
npm run db:push            # creates SQLite db and applies schema
npm run dev                # starts on http://localhost:8787
```

## Production (Railway)

1. Create a Railway project with a Postgres plugin
2. Add a service from the `server/` directory
3. Set env vars:
   - `DATABASE_URL` (auto-injected by Railway Postgres plugin)
   - `BETTER_AUTH_SECRET` (32-byte random string)
   - `BETTER_AUTH_URL` (your backend URL)
   - `FRONTEND_ORIGIN` (comma-separated allowlist — game URL **and** admin URL,
     e.g. `https://play.example.com,https://admin.example.com`)
   - `ADMIN_BOOTSTRAP_EMAIL` (the email that auto-promotes to admin on first sign-in)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (optional, for Google login)
   - `NODE_ENV=production`
4. The Prisma schema already targets `postgresql`. No edit needed.
5. Build: `npm install && npx prisma generate && npx prisma db push && npm run build`
   (use `prisma migrate deploy` instead of `db push` once you start tracking
   migrations; for now the project is unmigrated and uses `db push`).
6. Start: `npm start`

The game and admin frontends each get built separately (`npm run build` in
`game/` and `admin/`) and deployed to a static host (Vercel, Netlify, Railway
static, etc.). Set `VITE_SERVER_URL` at build time on each so they point at
this server in prod.

## Endpoints

- `POST /api/auth/sign-up/email` — email signup
- `POST /api/auth/sign-in/email` — email login
- `GET  /api/auth/sign-in/social/google` — Google OAuth start
- `POST /api/auth/sign-out`
- `GET  /api/auth/get-session` — current session
- `GET  /api/saves` — get caller's cloud save
- `POST /api/saves` — upload save snapshot
- `GET  /api/profile/me` — caller's profile
- `GET  /api/profile/:username` — public profile
- `GET  /api/friends` — list friends + pending
- `POST /api/friends/request` — `{ username }`
- `POST /api/friends/:id/accept`
- `DELETE /api/friends/:id`
- `GET  /api/chat/:channelId/history` — recent messages

## Socket.IO events

Chat:
- `chat:join` `{ channelId }`
- `chat:leave` `{ channelId }`
- `chat:send` `{ channelId, content }` (ack: `{ ok, id?, error? }`)
- `chat:message` (server → client) `{ id, channelId, content, createdAt, user }`
- `presence:update` (server → client) `{ userId, online }`

Trade:
- `trade:invite` `{ toUserId }` (client → server, ack: `{ ok, tradeId?, expiresAt? }`)
- `trade:invite` (server → client) `{ tradeId, from, expiresAt }`
- `trade:respond` `{ tradeId, accept }` (client → server)
- `trade:start` (server → client) `{ tradeId, other, expiresAt }`
- `trade:offer` `{ tradeId, offer }` (client → server, offer is full Pokemon JSON or null)
- `trade:lock` `{ tradeId, locked }` (client → server)
- `trade:state` (server → client) — broadcast of both sides' offer + lock state
- `trade:cancel` `{ tradeId }` (client → server)
- `trade:complete` (server → client) `{ tradeId, sentMonId, received, otherUser }`
- `trade:cancelled` (server → client) `{ tradeId, reason }`

Auth:
- `session:replaced` (server → client) — fires when another device signs in
  on the same account; client should disconnect + reload.
