import { CONFIG } from "./config.js";
import { fetchDesiredState, reportStatus } from "./server.js";
import { Broadcaster } from "./broadcaster.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[renderer] starting — server ${CONFIG.serverUrl}, ingest ${CONFIG.twitchIngestUrl}, key ${CONFIG.twitchKey ? "set" : "MISSING"}`);
  const bc = new Broadcaster();

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[renderer] ${sig} — stopping broadcast`);
    // Bound teardown: a wedged Playwright close must not delay exit past the
    // platform's SIGKILL grace period.
    await Promise.race([bc.stop(), sleep(3000)]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Reconcile loop: pull desired state, converge the browser+encoder to it,
  // report status. This IS the 24/7 watchdog — a crashed child is simply
  // brought back on the next tick.
  while (!shuttingDown) {
    try {
      const state = await fetchDesiredState();
      if (state && state.enabled && state.loginUrl && CONFIG.twitchKey) {
        await bc.ensureRunning(state);
      } else {
        await bc.stop();
      }
    } catch (e) {
      console.error("[renderer] reconcile error:", (e as Error).message);
    }
    await reportStatus(bc.status());
    await sleep(CONFIG.pollIntervalMs);
  }
}

main().catch((e) => {
  console.error("[renderer] fatal:", e);
  process.exit(1);
});
