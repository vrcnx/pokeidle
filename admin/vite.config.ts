import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // Allow importing from sibling packages (game/ specifically) so
    // the admin can reuse the source-of-truth Pokémon table and items
    // catalog without copying that data here. Reads only — Vite still
    // refuses writes outside the project root.
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
  resolve: {
    alias: {
      "@game": path.resolve(__dirname, "..", "game", "src"),
    },
  },
});
