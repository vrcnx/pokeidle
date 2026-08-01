# ── Build stage: compile TS → dist/ ─────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage: just node + the compiled bot ─────────────────────────
# No browser, no ffmpeg, nothing else — the bot holds a websocket to Discord
# and makes HTTPS calls to the game server, and that is the whole job.
FROM node:20-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# dumb-init so SIGTERM reaches node directly on redeploy and the gateway
# connection closes cleanly (see the shutdown handler in src/index.ts).
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
