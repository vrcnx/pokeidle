import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Default to 5173 locally, but honour the PORT env var so external
    // launchers (preview tooling, CI) can pick a free port when 5173
    // is occupied by another concurrent project.
    port: Number(process.env.PORT) || 5173,
  },
});
