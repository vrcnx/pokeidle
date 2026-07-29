import { defineConfig } from "vitest/config";

// Tests live in tests/ (outside src/) so `tsc` (rootDir: src) never sweeps
// them into the production build. They import production modules from
// ../src/*.ts via the same `.js` specifiers the code itself uses.
//
// HARD RULE: no test may touch the production database or the network.
// Every test that pulls in a module whose import graph reaches src/db.ts or
// src/socket.ts must vi.mock those modules — the mock is hoisted, so the
// real PrismaClient / socket.io server is never even constructed.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Belt and braces: if a test forgets to mock db.ts, make sure the real
    // DATABASE_URL from server/.env can never be picked up.
    env: {
      DATABASE_URL: "postgresql://vitest:vitest@127.0.0.1:1/refuse_to_connect",
      NODE_ENV: "test",
      ALERT_WEBHOOK_URL: "",
    },
    testTimeout: 15_000,
  },
});
