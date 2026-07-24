# ── Build stage: compile TS → dist/ ─────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage: chromium + xvfb + ffmpeg + the compiled renderer ──────
FROM node:20-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      xvfb \
      x11-utils \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    DISPLAY=:99 \
    MUSIC_DIR=/app/music

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Music bed (optional). Any audio files placed in /app/music are looped as the
# stream's audio; an empty dir runs silent.
COPY music ./music
COPY start.sh ./start.sh
RUN chmod +x start.sh

# dumb-init reaps Xvfb/chromium/ffmpeg zombies cleanly.
ENTRYPOINT ["dumb-init", "--"]
CMD ["./start.sh"]
