#!/usr/bin/env bash
# Start the virtual X display, then the renderer, as children of THIS shell so
# `wait -n` can actually watch them. The container exits (and Railway restarts
# it) if either Xvfb or the renderer dies.
set -u

DISPLAY_NUM="${DISPLAY:-:99}"

# 1920x1080x24 virtual framebuffer. Chromium renders here; ffmpeg captures it.
Xvfb "${DISPLAY_NUM}" -screen 0 1920x1080x24 -nolisten tcp -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Wait for the display to accept connections (up to ~6s), else press on anyway.
for _ in $(seq 1 30); do
  if xdpyinfo -display "${DISPLAY_NUM}" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

node dist/index.js &
NODE_PID=$!

# Forward a container SIGTERM to node so it can stop the broadcast gracefully.
trap 'kill -TERM "${NODE_PID}" 2>/dev/null' TERM INT

# Wait for whichever child exits first (bash 4.3+; bookworm bash has it). When
# node OR Xvfb dies, tear the other down and exit so the platform restarts us.
wait -n "${XVFB_PID}" "${NODE_PID}"
EXIT=$?
echo "[start] a child process exited (rc=${EXIT}) — stopping container"
kill -TERM "${NODE_PID}" 2>/dev/null
kill -TERM "${XVFB_PID}" 2>/dev/null
exit "${EXIT}"
