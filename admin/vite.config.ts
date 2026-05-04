import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Admin is built standalone — it must not depend on sibling packages
// (game/) being present. Catalog data + sprite helpers live as JSON
// snapshots + inlined functions in src/data/gameCatalog.ts. To refresh
// from the game's source: `npx tsx scripts/snapshot.mts`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
});
