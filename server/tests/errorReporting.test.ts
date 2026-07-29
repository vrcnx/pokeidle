// recordError context preservation. The known bug being pinned: meta was
// dropped from the structured log line, and a failed ErrorLog insert
// swallowed the entire event — so when the DB was the thing that was
// unhappy, the error AND its context evaporated together.

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  executeRaw: undefined as unknown as () => Promise<number>,
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    $executeRaw: (...args: unknown[]) => h.executeRaw(...(args as [])),
  },
}));

import { recordError } from "../src/lib/errorReporting.js";
import { logger } from "../src/lib/logger.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("recordError", () => {
  it("includes meta in the structured log line", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    h.executeRaw = async () => 1;
    await recordError({
      kind: "server",
      message: "pvp_start_battle_failed",
      source: "test",
      meta: { battleId: "b_1", simulatorError: "boom" },
    });
    expect(spy).toHaveBeenCalledWith(
      "pvp_start_battle_failed",
      expect.objectContaining({ meta: { battleId: "b_1", simulatorError: "boom" } }),
    );
  });

  it("skips the DB entirely outside production (never touches prod ErrorLog from dev)", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const raw = vi.fn(async () => 1);
    h.executeRaw = raw;
    await recordError({ kind: "server", message: "dev_crash" }); // NODE_ENV=test
    expect(raw).not.toHaveBeenCalled();
  });

  it("a failed insert logs the FULL event — the context survives somewhere", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    h.executeRaw = async () => { throw new Error("connection refused"); };
    await recordError({
      kind: "server",
      message: "trade_record_persist_failed",
      source: "socket.trade:complete",
      userId: "u9",
      meta: { tradeId: "t_42" },
    });
    // Second call is the persist-failure line; it must carry the whole event.
    const persistFailure = spy.mock.calls.find(([msg]) => msg === "[errorReporting] failed to persist");
    expect(persistFailure).toBeDefined();
    expect(persistFailure![1]).toMatchObject({
      err: expect.stringContaining("connection refused"),
      event: expect.objectContaining({
        message: "trade_record_persist_failed",
        source: "socket.trade:complete",
        userId: "u9",
        meta: { tradeId: "t_42" },
      }),
    });
  });

  it("never throws to its caller even when everything below it fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    h.executeRaw = async () => { throw new Error("db is a smoking crater"); };
    await expect(
      recordError({ kind: "server", message: "anything" }),
    ).resolves.toBeUndefined();
  });
});
