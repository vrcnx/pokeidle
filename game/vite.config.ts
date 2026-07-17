import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// A fresh value each build. Baked into the client bundle AND written into
// version.json (below). A running client polls version.json and, when its
// baked-in id no longer matches, knows a newer build has deployed and can
// prompt the player to reload.
const BUILD_ID = `${pkg.version}+${Date.now().toString(36)}`;

// Emit /version.json into the build output.
function versionManifest() {
  return {
    name: "version-manifest",
    generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: string }) => void }) {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId: BUILD_ID, version: pkg.version }),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionManifest()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
  },
});
