# ── Build stage: compile TS → dist/ ─────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage: node + fonts + the compiled bot ──────────────────────
# No browser and no ffmpeg — the bot holds a websocket to Discord, makes HTTPS
# calls to the game server, and draws PNGs with @napi-rs/canvas (which bundles
# its own Skia and needs no system graphics libraries).
#
# FONTS ARE NOT OPTIONAL. node:20-bookworm-slim ships with none, and
# @napi-rs/canvas draws text using whatever the OS has — so without this the
# cards render perfectly except that EVERY LABEL IS BLANK. It fails silently
# and only in production, because a developer machine always has fonts.
# src/cards/draw.ts resolves the family at runtime and logs loudly if it finds
# nothing, but the actual fix is here.
#
# fonts-dejavu-core is ~1MB and covers Latin, Greek and Cyrillic. Colour emoji
# are deliberately NOT installed (fonts-noto-color-emoji is ~10MB); the cards
# keep emoji out of rendered text and put them in the Discord message body,
# where Discord renders them itself.
FROM node:20-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      dumb-init \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# dumb-init so SIGTERM reaches node directly on redeploy and the gateway
# connection closes cleanly (see the shutdown handler in src/index.ts).
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
