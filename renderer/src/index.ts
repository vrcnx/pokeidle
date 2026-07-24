import { CONFIG } from "./config.js";
import { fetchDesiredState, reportStatus, postFrame } from "./server.js";
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
  let lastState: Awaited<ReturnType<typeof fetchDesiredState>> = null;
  let watching = false;
  while (!shuttingDown) {
    try {
      const fetched = await fetchDesiredState(); // null = server unreachable
      if (fetched) lastState = fetched;
      // Track the cadence from the latest poll here, not after the work below
      // — if anything in this try block throws, a stale `watching = true`
      // would pin the loop in its 1s hot cadence indefinitely.
      watching = !!fetched?.watching;
      // If the server is unreachable (e.g. an API redeploy), HOLD the
      // last-known desired state instead of tearing the stream down. The game
      // client rides out the blip and reconnects its own socket, so viewers
      // don't see a drop on every server deploy. Only an explicit disabled
      // state from a REACHABLE server stops the broadcast.
      const effective = fetched ?? lastState;
      if (effective && effective.enabled && effective.loginUrl && CONFIG.twitchKey) {
        await bc.ensureRunning(effective);
      } else if (fetched) {
        await bc.stop();
      }

      // Live browser control. Apply any admin-relayed clicks/keystrokes first,
      // then send back a fresh preview frame so the operator sees the result.
      if (fetched?.input?.length) await bc.applyInput(fetched.input);
      if (watching) {
        const shot = await bc.capture();
        if (shot) await postFrame(shot.data, shot.width, shot.height);
      }
    } catch (e) {
      console.error("[renderer] reconcile error:", (e as Error).message);
    }
    await reportStatus(bc.status());
    // Tick faster while an admin is driving the browser so clicks land
    // promptly and the preview stays current; fall back to the lazy cadence
    // when nobody's looking.
    await sleep(watching ? Math.min(1000, CONFIG.pollIntervalMs) : CONFIG.pollIntervalMs);
  }
}

main().catch((e) => {
  console.error("[renderer] fatal:", e);
  process.exit(1);
});
