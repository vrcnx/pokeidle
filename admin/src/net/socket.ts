import { io, Socket } from "socket.io-client";
import { SERVER_URL } from "../api";

let socket: Socket | null = null;

// Connect once — Socket.IO handles reconnection. The connection sends
// the same Better Auth session cookie the REST admin API already relies
// on (withCredentials), which the server's handshake middleware uses to
// identify the admin — no separate auth needed. Mirrors game/src/net/socket.ts.
//
// auth.client: "admin-dashboard" tells the server this connection isn't
// gameplay — server/src/socket.ts skips presence/online-count and
// DailyActive tracking for it, so opening this page doesn't make an
// admin's own account look like an online player or a daily active
// user. It still authenticates, auto-joins chat rooms, and sends/
// receives broadcasts exactly like a normal connection.
export function getSocket(): Socket {
  if (socket) return socket;
  socket = io(SERVER_URL, {
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    auth: { client: "admin-dashboard" },
  });
  return socket;
}

export function closeSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
