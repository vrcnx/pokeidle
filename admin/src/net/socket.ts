import { io, Socket } from "socket.io-client";
import { SERVER_URL } from "../api";

let socket: Socket | null = null;

// Connect once — Socket.IO handles reconnection. The connection sends
// the same Better Auth session cookie the REST admin API already relies
// on (withCredentials), which the server's handshake middleware uses to
// identify the admin — no separate auth needed. Mirrors game/src/net/socket.ts.
export function getSocket(): Socket {
  if (socket) return socket;
  socket = io(SERVER_URL, {
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });
  return socket;
}

export function closeSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
