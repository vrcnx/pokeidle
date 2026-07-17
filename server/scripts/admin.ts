#!/usr/bin/env tsx
// Admin operations CLI.
//
// Unlike scripts/bugs.ts and scripts/errors.ts (which talk straight to
// Postgres), this one drives the REAL HTTP admin API. That matters:
// several admin actions have live side effects that only exist inside
// the running server process — announce() emits chat:message over
// Socket.IO, ban() force-disconnects the user's sockets, and
// start-bracket-match() spins up a PvP battle room. A direct Prisma
// write would silently skip all of that.
//
// Auth: sends `x-admin-key: $ADMIN_API_KEY`. The server refuses the
// header entirely unless ADMIN_API_KEY is set there too (>=32 chars),
// and the key acts as a real admin row so every action lands in the
// audit log with via:"api-key".
//
// Setup (server env):
//   ADMIN_API_KEY=<64 hex chars>          # openssl rand -hex 32
//   ADMIN_API_KEY_USERNAME=<admin uname>  # optional; defaults to oldest admin
// Setup (this CLI):
//   ADMIN_API_KEY=<same value>
//   ADMIN_API_URL=https://api.pokeidle.com   # optional; defaults to localhost
//
//   tsx scripts/admin.ts online
//   tsx scripts/admin.ts analytics
//   tsx scripts/admin.ts tournament list
//   tsx scripts/admin.ts tournament create "Sunday Showdown" --cap 50
//   tsx scripts/admin.ts tournament add <id> <username>
//   tsx scripts/admin.ts tournament bracket <id>
//   tsx scripts/admin.ts tournament advance <id>
//   tsx scripts/admin.ts tournament start-match <id> <userA> <userB>
//   tsx scripts/admin.ts tournament status <id> <open|live|finished>
//   tsx scripts/admin.ts tournament delete <id>
//   tsx scripts/admin.ts announce "Server restart in 5 minutes"
//   tsx scripts/admin.ts user find <query>
//   tsx scripts/admin.ts user ban <username> [--days N] [--reason "..."]
//   tsx scripts/admin.ts user unban <username>
//   tsx scripts/admin.ts user grant <username> <itemId> <qty>

const BASE = (process.env.ADMIN_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.ADMIN_API_KEY ?? "";

function flag(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}

// Positional args, excluding flags and their values.
function positionals(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { i++; continue; } // skip flag + its value
    out.push(a);
  }
  return out;
}

async function req(method: string, path: string, body?: unknown): Promise<any> {
  if (!KEY) {
    throw new Error(
      "ADMIN_API_KEY is not set in this shell.\n" +
      "Generate one with: openssl rand -hex 32\n" +
      "Then set it BOTH on the server env and here."
    );
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-admin-key": KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json) : text.slice(0, 400);
    throw new Error(`${method} ${path} → ${res.status}\n${detail}`);
  }
  return json;
}

function out(v: unknown) {
  console.log(JSON.stringify(v, null, 2));
}

// Resolve a username to a user id via the admin search endpoint.
async function userIdFor(username: string): Promise<{ id: string; username: string }> {
  const r = await req("GET", `/api/admin/users?q=${encodeURIComponent(username)}&pageSize=25`);
  const exact = (r.users ?? []).find(
    (u: any) => u.username?.toLowerCase() === username.toLowerCase()
  );
  if (!exact) {
    const near = (r.users ?? []).map((u: any) => u.username).join(", ");
    throw new Error(`No user with username "${username}".${near ? ` Close matches: ${near}` : ""}`);
  }
  return { id: exact.id, username: exact.username };
}

async function main() {
  const [cmd, sub, ...rest] = positionals();

  if (!cmd || cmd === "help" || cmd === "--help") { printUsage(); return; }

  // ── Quick reads ──────────────────────────────────────────────────
  if (cmd === "whoami")    { out(await req("GET", "/api/admin/me")); return; }
  if (cmd === "online")    { out(await req("GET", "/api/admin/live-ops").then((r) => ({
    online: r.online.length,
    users: r.online.map((o: any) => ({ username: o.user?.username, sessions: o.sessionCount })),
  }))); return; }
  if (cmd === "analytics") { out(await req("GET", "/api/admin/analytics")); return; }

  // ── Announce ─────────────────────────────────────────────────────
  if (cmd === "announce") {
    const content = [sub, ...rest].filter(Boolean).join(" ");
    if (!content) throw new Error(`Usage: admin.ts announce "message"`);
    out(await req("POST", "/api/admin/announce", { content }));
    return;
  }

  // ── Pinned banner ────────────────────────────────────────────────
  if (cmd === "banner") {
    if (!sub || sub === "show") {
      out(await req("GET", "/api/admin/announcements"));
      return;
    }
    if (sub === "clear") {
      out(await req("POST", "/api/admin/announcements/clear"));
      return;
    }
    if (sub === "set") {
      // admin.ts banner set <type> "message" [href] [linkLabel]
      const [type, message, href, linkLabel] = rest;
      if (!type || !message) {
        throw new Error(`Usage: admin.ts banner set <info|event|giveaway|warning|maintenance> "message" [href] [linkLabel]`);
      }
      out(await req("POST", "/api/admin/announcements", {
        type, message,
        href: href || null,
        linkLabel: linkLabel || null,
      }));
      return;
    }
    throw new Error(`Usage: admin.ts banner {show|set|clear}`);
  }

  // ── Tournaments ──────────────────────────────────────────────────
  if (cmd === "tournament" || cmd === "t") {
    if (!sub || sub === "list") {
      const r = await req("GET", "/api/admin/tournaments");
      out(r.tournaments.map((t: any) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        levelCap: t.levelCap,
        entries: t.entries.length,
        startsAt: t.startsAt,
      })));
      return;
    }
    if (sub === "show") {
      const r = await req("GET", "/api/admin/tournaments");
      const t = r.tournaments.find((x: any) => x.id === rest[0]);
      if (!t) throw new Error(`No tournament ${rest[0]}`);
      out({ ...t, bracket: t.bracket ? JSON.parse(t.bracket) : null });
      return;
    }
    if (sub === "create") {
      const name = rest[0];
      if (!name) throw new Error(`Usage: admin.ts tournament create "Name" [--cap 50] [--format tournament]`);
      const capRaw = flag("cap");
      out(await req("POST", "/api/admin/tournaments", {
        name,
        levelCap: capRaw ? Number(capRaw) : null,
        format: flag("format", "tournament"),
      }));
      return;
    }
    if (sub === "delete") {
      if (!rest[0]) throw new Error("Usage: admin.ts tournament delete <id>");
      out(await req("DELETE", `/api/admin/tournaments/${rest[0]}`));
      return;
    }
    if (sub === "status") {
      const [id, status] = rest;
      if (!id || !status) throw new Error("Usage: admin.ts tournament status <id> <open|live|finished>");
      out(await req("PATCH", `/api/admin/tournaments/${id}`, { status }));
      return;
    }
    if (sub === "add") {
      const [id, username] = rest;
      if (!id || !username) throw new Error("Usage: admin.ts tournament add <id> <username>");
      out(await req("POST", `/api/admin/tournaments/${id}/entries`, { username }));
      return;
    }
    if (sub === "remove") {
      const [id, entryId] = rest;
      if (!id || !entryId) throw new Error("Usage: admin.ts tournament remove <id> <entryId>");
      out(await req("DELETE", `/api/admin/tournaments/${id}/entries/${entryId}`));
      return;
    }
    if (sub === "bracket") {
      if (!rest[0]) throw new Error("Usage: admin.ts tournament bracket <id>");
      const r = await req("POST", `/api/admin/tournaments/${rest[0]}/generate-bracket`);
      out({ ...r.tournament, bracket: r.tournament.bracket ? JSON.parse(r.tournament.bracket) : null });
      return;
    }
    if (sub === "advance") {
      if (!rest[0]) throw new Error("Usage: admin.ts tournament advance <id>");
      out(await req("POST", `/api/admin/tournaments/${rest[0]}/advance-bracket`));
      return;
    }
    if (sub === "start-match") {
      const [id, a, b] = rest;
      if (!id || !a || !b) throw new Error("Usage: admin.ts tournament start-match <id> <userA> <userB>");
      const [ua, ub] = await Promise.all([userIdFor(a), userIdFor(b)]);
      out(await req("POST", `/api/admin/tournaments/${id}/match`, {
        aUserId: ua.id,
        bUserId: ub.id,
      }));
      return;
    }
    throw new Error(`Unknown tournament subcommand: ${sub}`);
  }

  // ── Users ────────────────────────────────────────────────────────
  if (cmd === "user" || cmd === "u") {
    if (sub === "find") {
      const r = await req("GET", `/api/admin/users?q=${encodeURIComponent(rest[0] ?? "")}&pageSize=25`);
      out(r.users.map((u: any) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        level: u.accountLevel,
        dex: u.pokedexCaughtCount,
        admin: u.isAdmin,
        bannedUntil: u.bannedUntil,
        lastSeenAt: u.lastSeenAt,
      })));
      return;
    }
    if (sub === "ban") {
      const username = rest[0];
      if (!username) throw new Error(`Usage: admin.ts user ban <username> [--days N] [--reason "..."]`);
      const { id } = await userIdFor(username);
      const days = Number(flag("days", "7"));
      const until = new Date(Date.now() + days * 86400000).toISOString();
      out(await req("POST", `/api/admin/users/${id}/ban`, { until, reason: flag("reason") ?? null }));
      return;
    }
    if (sub === "unban") {
      const username = rest[0];
      if (!username) throw new Error("Usage: admin.ts user unban <username>");
      const { id } = await userIdFor(username);
      out(await req("POST", `/api/admin/users/${id}/ban`, { until: null, reason: null }));
      return;
    }
    if (sub === "grant") {
      const [username, itemId, qtyRaw] = rest;
      if (!username || !itemId) throw new Error("Usage: admin.ts user grant <username> <itemId> <qty>");
      const { id } = await userIdFor(username);
      out(await req("POST", `/api/admin/users/${id}/items`, {
        itemId,
        quantity: Number(qtyRaw ?? "1"),
      }));
      return;
    }
    if (sub === "promote" || sub === "demote") {
      const username = rest[0];
      if (!username) throw new Error(`Usage: admin.ts user ${sub} <username>`);
      const { id } = await userIdFor(username);
      out(await req("POST", `/api/admin/users/${id}/admin`, { isAdmin: sub === "promote" }));
      return;
    }
    if (sub === "snapshots") {
      const username = rest[0];
      if (!username) throw new Error("Usage: admin.ts user snapshots <username>");
      const { id } = await userIdFor(username);
      const r = await req("GET", `/api/admin/users/${id}/snapshots`);
      out(r.snapshots.map((s: any) => ({
        id: s.id,
        when: s.createdAt,
        reason: s.reason,
        v: s.saveVersion,
        lvl: s.summary?.level, badges: s.summary?.badges, caught: s.summary?.caught,
        money: s.summary?.money, kb: s.summary ? Math.round(s.summary.bytes / 1024) : null,
      })));
      return;
    }
    if (sub === "restore") {
      const [username, snapshotId] = rest;
      if (!username || !snapshotId) {
        throw new Error("Usage: admin.ts user restore <username> <snapshotId>  (get ids from: user snapshots <username>)");
      }
      const { id } = await userIdFor(username);
      out(await req("POST", `/api/admin/users/${id}/snapshots/${snapshotId}/restore`));
      return;
    }
    throw new Error(`Unknown user subcommand: ${sub}`);
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.error(`Admin operations CLI — drives the live HTTP admin API.

  Env:
    ADMIN_API_KEY   required, must match the server's ADMIN_API_KEY
    ADMIN_API_URL   default http://localhost:8787

  Reads
    whoami                             Which admin the key acts as
    online                             Who is connected right now
    analytics                          Full analytics payload

  Announce
    announce "message"                 Broadcast to global chat (live)

  Pinned banner
    banner show                        Show the live banner + recent history
    banner set <type> "message" [href] [label]
                                       Pin a banner. type: info|event|giveaway|warning|maintenance
    banner clear                       Take the banner down

  Tournaments  (alias: t)
    tournament list
    tournament show <id>
    tournament create "Name" [--cap 50] [--format tournament]
    tournament add <id> <username>
    tournament remove <id> <entryId>
    tournament bracket <id>            Seed the bracket, flips to live
    tournament advance <id>            Pull in finished matches, advance
    tournament start-match <id> <userA> <userB>
    tournament status <id> <open|live|finished>
    tournament delete <id>

  Users  (alias: u)
    user find <query>
    user ban <username> [--days N] [--reason "..."]
    user unban <username>
    user promote <username>
    user demote <username>
    user grant <username> <itemId> <qty>
    user snapshots <username>          List a player's save-history checkpoints
    user restore <username> <id>       Roll a player back to a snapshot (reversible)

  Every write lands in the admin audit log attributed to the key's
  actor with via:"api-key".`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
