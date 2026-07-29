import { defineConfig } from "vitest/config";

// Reducer/util tests. They import the reducer and pure utils directly —
// no components, no hooks, no DOM, no network. Tests live in tests/
// (outside src/) so `tsc -b` (include: ["src"]) never sweeps them into the
// production typecheck/build.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
