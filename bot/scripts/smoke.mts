// End-to-end smoke test against a RUNNING game server.
//
// Exercises every endpoint the bot uses and renders the real cards from real
// production data, so the whole pipeline — auth, DTO shape, sprite fetch,
// canvas, fonts — is proven without needing a Discord token or a gateway
// connection. What it cannot cover is Discord itself: the gateway, slash
// command registration, and role assignment.
//
// READ-ONLY except for two deliberate exceptions, both harmless:
//   * /link/start mints an in-memory code that expires in ten minutes and is
//     bound to a Discord id nobody owns.
//   * /xp/message is a no-op while XP is disabled, and a normal award if it
//     is not — the same thing any message in the server would do.
//
// It deliberately does NOT create a giveaway or post a trade listing: both
// write durable rows and the trade one posts into the live in-game chat
// channel, which is not something a test should do to a production server.
//
// Run:  cd bot && npm run smoke
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "samples", "live");
mkdirSync(out, { recursive: true });

// Read .env directly rather than importing config.ts — config requires the
// Discord variables and exits if they are missing, and none of them are needed
// to talk to the game server.
const env: Record<string, string> = {};
for (const line of readFileSync(resolve(here, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const BASE = (process.argv[2] ?? env.API_BASE ?? "").replace(/\/+$/, "");
const TOKEN = env.BOT_TOKEN ?? "";
if (!BASE || !TOKEN) {
  console.error("Need API_BASE and BOT_TOKEN in bot/.env (or pass a base URL as argv[2]).");
  process.exit(1);
}

let pass = 0;
let fail = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function check(label: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    console.log(`  PASS  ${label.padEnd(34)} ${detail}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${label.padEnd(34)} ${String((e as Error).message)}`);
    fail++;
  }
}

function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log(`\nSmoke test → ${BASE}\n`);

console.log("── Auth ──────────────────────────────────────────────");
await check("rejects a missing token", async () => {
  const res = await fetch(`${BASE}/api/bot/leaderboard`, { signal: AbortSignal.timeout(15_000) });
  expect(res.status === 401, `expected 401, got ${res.status}`);
  return "401";
});
await check("rejects a wrong token", async () => {
  const res = await fetch(`${BASE}/api/bot/leaderboard`, {
    headers: { authorization: `Bearer ${"z".repeat(TOKEN.length)}` },
    signal: AbortSignal.timeout(15_000),
  });
  expect(res.status === 401, `expected 401, got ${res.status}`);
  return "401";
});
await check("accepts the real token", async () => {
  const r = await call("GET", "/api/bot/leaderboard?limit=3");
  expect(r.status === 200, `status ${r.status}`);
  return "200";
});

console.log("\n── Reads ─────────────────────────────────────────────");
let sampleUser = "";
await check("GET /leaderboard", async () => {
  const r = await call("GET", "/api/bot/leaderboard?limit=5");
  expect(r.status === 200, `status ${r.status}`);
  expect(Array.isArray(r.json.leaderboard), "no leaderboard array");
  sampleUser = r.json.leaderboard[0]?.username ?? "";
  return `${r.json.leaderboard.length} rows, top=${sampleUser || "(none)"}`;
});
await check("GET /profile?username=", async () => {
  expect(sampleUser, "no sample user from the leaderboard");
  const r = await call("GET", `/api/bot/profile?username=${encodeURIComponent(sampleUser)}`);
  expect(r.status === 200, `status ${r.status}`);
  expect(typeof r.json.accountLevel === "number", "no accountLevel");
  // The allowlist. These must never appear in a payload the bot renders.
  for (const leaked of ["email", "isAdmin", "banReason", "saveData"]) {
    expect(!(leaked in r.json), `LEAKED ${leaked}`);
  }
  return `level ${r.json.accountLevel}, no PII`;
});
await check("GET /team?username=", async () => {
  const r = await call("GET", `/api/bot/team?username=${encodeURIComponent(sampleUser)}`);
  expect(r.status === 200, `status ${r.status}`);
  return `${r.json.party?.length ?? 0} party, started=${r.json.started}`;
});
await check("GET /dex?username=", async () => {
  const r = await call("GET", `/api/bot/dex?username=${encodeURIComponent(sampleUser)}`);
  expect(r.status === 200, `status ${r.status}`);
  return `${r.json.caughtCount} caught`;
});
await check("GET /rank?username=", async () => {
  const r = await call("GET", `/api/bot/rank?username=${encodeURIComponent(sampleUser)}`);
  expect(r.status === 200, `status ${r.status}`);
  return r.json.unranked ? "unranked" : `rating ${r.json.rating}`;
});
await check("unknown player → helpful 404", async () => {
  const r = await call("GET", "/api/bot/profile?username=definitely-not-a-real-trainer");
  expect(r.status === 404, `status ${r.status}`);
  expect(r.json.error === "not_found", `error was ${r.json.error}`);
  return r.json.reason;
});
await check("unlinked caller → 'run /link'", async () => {
  const r = await call("GET", "/api/bot/profile?discordId=000000000000000009");
  expect(r.status === 404, `status ${r.status}`);
  expect(r.json.error === "unlinked", `error was ${r.json.error}`);
  expect(String(r.json.reason).includes("/link"), "copy does not mention /link");
  return "instruction, not an error";
});
await check("/mon refuses another player", async () => {
  const r = await call("GET", `/api/bot/mon?username=${encodeURIComponent(sampleUser)}&slot=1`);
  expect(r.status === 403, `expected 403, got ${r.status}`);
  return "403 self_only";
});

console.log("\n── Roles / giveaways / XP ────────────────────────────");
await check("GET /roles/desired", async () => {
  const r = await call("GET", "/api/bot/roles/desired");
  expect(r.status === 200, `status ${r.status}`);
  expect(Array.isArray(r.json.managedRoles), "no managedRoles");
  // The blast-radius guarantee: the bot only ever removes roles in this list.
  expect(r.json.managedRoles.length === 3, `managedRoles has ${r.json.managedRoles.length} entries`);
  return `${r.json.members.length} linked, aceMin ${r.json.aceTrainerMinLevel}, champMin ${r.json.championMinMatches}`;
});
await check("GET /giveaways/pending", async () => {
  const r = await call("GET", "/api/bot/giveaways/pending");
  expect(r.status === 200, `status ${r.status}`);
  return `${r.json.toAnnounce.length} to announce, ${r.json.toReport.length} to report`;
});
await check("GET /xp/leaderboard", async () => {
  const r = await call("GET", "/api/bot/xp/leaderboard?limit=5");
  expect(r.status === 200, `status ${r.status}`);
  return `${r.json.leaderboard.length} on the board`;
});
await check("POST /xp/message", async () => {
  const r = await call("POST", "/api/bot/xp/message", {
    discordId: "000000000000000009", channelId: "smoke", label: "smoke-test",
  });
  expect(r.status === 200, `status ${r.status}`);
  return r.json.skipped ? `skipped: ${r.json.skipped}` : `awarded ${r.json.awarded}`;
});
await check("POST /heartbeat", async () => {
  const r = await call("POST", "/api/bot/heartbeat", { guildMembers: 0, linkedMembers: 0, version: "smoke" });
  expect(r.status === 200, `status ${r.status}`);
  return "ok";
});

console.log("\n── Link flow ─────────────────────────────────────────");
await check("POST /link/start mints a code", async () => {
  const r = await call("POST", "/api/bot/link/start", {
    discordId: "000000000000000009", discordLabel: "smoke-test",
  });
  expect(r.status === 200, `status ${r.status}`);
  expect(/^[A-Z0-9]{6}$/.test(r.json.code), `odd code: ${r.json.code}`);
  // The URL players are DM'd. A wrong FRONTEND_ORIGIN sends them to the admin
  // dashboard, which is invisible until somebody complains.
  expect(String(r.json.linkUrl).endsWith("/link-discord"), `bad linkUrl: ${r.json.linkUrl}`);
  expect(!String(r.json.linkUrl).includes("localhost"), `linkUrl is localhost: ${r.json.linkUrl}`);
  return `${r.json.linkUrl}  reward=${r.json.rewardSummary ?? "none"}`;
});
await check("GET /link reports unlinked", async () => {
  const r = await call("GET", "/api/bot/link?discordId=000000000000000009");
  expect(r.status === 200, `status ${r.status}`);
  expect(r.json.linked === false, "reported as linked");
  return "not linked";
});

console.log("\n── Card rendering, from REAL data ────────────────────");
const cards = await import("../src/cards/index.ts");
await check("profile card", async () => {
  const [p, t] = await Promise.all([
    call("GET", `/api/bot/profile?username=${encodeURIComponent(sampleUser)}`),
    call("GET", `/api/bot/team?username=${encodeURIComponent(sampleUser)}`),
  ]);
  const png = await cards.profileCard(p.json, t.json.party ?? []);
  expect(png.length > 5000, `suspiciously small png (${png.length} bytes)`);
  writeFileSync(resolve(out, "profile.png"), png);
  return `${(png.length / 1024).toFixed(0)} KB`;
});
await check("team card", async () => {
  const t = await call("GET", `/api/bot/team?username=${encodeURIComponent(sampleUser)}`);
  const png = await cards.teamCard(t.json.username, t.json.party ?? []);
  writeFileSync(resolve(out, "team.png"), png);
  return `${(png.length / 1024).toFixed(0)} KB`;
});
await check("leaderboard card", async () => {
  const r = await call("GET", "/api/bot/leaderboard?limit=10");
  const png = await cards.leaderboardCard(r.json.leaderboard);
  writeFileSync(resolve(out, "leaderboard.png"), png);
  return `${(png.length / 1024).toFixed(0)} KB`;
});
await check("dex card", async () => {
  const r = await call("GET", `/api/bot/dex?username=${encodeURIComponent(sampleUser)}`);
  const png = await cards.dexCard(r.json);
  writeFileSync(resolve(out, "dex.png"), png);
  return `${(png.length / 1024).toFixed(0)} KB`;
});
await check("rank card", async () => {
  const r = await call("GET", `/api/bot/rank?username=${encodeURIComponent(sampleUser)}`);
  const png = await cards.rankCard(r.json.username, r.json);
  writeFileSync(resolve(out, "rank.png"), png);
  return `${(png.length / 1024).toFixed(0)} KB`;
});

console.log(`\n${pass} passed, ${fail} failed.  Cards → ${out}\n`);
process.exit(fail > 0 ? 1 : 0);
