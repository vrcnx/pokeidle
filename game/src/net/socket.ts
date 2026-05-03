import { io, Socket } from "socket.io-client";
import { SERVER_BASE } from "./api";

let socket: Socket | null = null;

// Connect once — Socket.IO handles reconnection. The connection sends
// the Better Auth session cookie via withCredentials, which the server
// uses to identify the user in its handshake middleware.
export function getSocket(): Socket {
  if (socket && socket.connected) return socket;
  if (socket) return socket;
  socket = io(SERVER_BASE, {
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
  });

  // Server-pushed kick: another browser/device signed into this
  // account. Drop the cached socket so reconnect doesn't loop on
  // the same dead session, then full-reload the page so AuthContext
  // re-runs and the auth modal appears.
  socket.on("session:replaced", () => {
    socket?.disconnect();
    socket = null;
    if (typeof window !== "undefined") {
      // A small delay so any pending UI updates flush before reload.
      setTimeout(() => window.location.reload(), 50);
    }
  });

  return socket;
}

export function closeSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
