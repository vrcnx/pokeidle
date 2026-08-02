// Role reconciliation.
//
// Asks the game server "who should have what?" and makes it true. No events,
// no webhooks, no memory of what it did last time — the desired state is
// recomputed from scratch every pass and the diff is applied.
//
// ── WHY RECONCILE ───────────────────────────────────────────────────
// An event-driven version ("someone took #1 → move the Champion role") loses a
// message every time the bot is redeploying, Discord rate-limits, or the
// process restarts mid-handler. A lost event leaves a WRONG role in place
// permanently, and nothing will ever notice. A reconciler that misses a pass
// is stale for one interval and then correct.
//
// ══ THE SAFETY PROPERTY THAT MATTERS MOST ═══════════════════════════
//
// The remove step is scoped to `managedRoles` — the list the server sends —
// and to nothing else.
//
// The obvious implementation of a reconciler is "remove every role not in the
// desired set". Run that here and its first pass strips Moderator, Admin,
// every colour role, every pronoun role and everything anyone picked up in
// #get-roles, from every linked member in the server. It would look like a
// hack. `managedRoles` is what makes the blast radius exactly three roles.

import { Client, type Guild, type Role } from "discord.js";
import { api, type DesiredRoles } from "./api.js";
import { config } from "./config.js";

/** Members we have already explained that we cannot manage. Process-local and
 *  deliberately never cleared: the conditions it covers (owning the server,
 *  outranking the bot) do not change on their own, and a restart is the right
 *  moment to say it again. */
const explained = new Set<string>();

/** Resolve managed role NAMES to this guild's role objects. Names rather than
 *  ids in the payload so the game server never has to hold guild-specific
 *  configuration — see server/src/lib/discordRoles.ts. */
function resolveRoles(guild: Guild, names: string[]): Map<string, Role> {
  const out = new Map<string, Role>();
  for (const name of names) {
    const role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (role) out.set(name, role);
    else console.warn(`[roles] no role named "${name}" in this guild — skipping it this pass.`);
  }
  return out;
}

/**
 * Can the bot actually assign this role?
 *
 * Discord refuses any role change at or above the bot's own highest role, and
 * refuses managed (integration/booster) roles outright. Checking first turns a
 * silent per-member API rejection into one clear log line naming the problem,
 * which is the difference between "the bot is broken" and "move the bot's role
 * up in Server Settings".
 */
function assignable(guild: Guild, role: Role): boolean {
  const me = guild.members.me;
  if (!me) return false;
  if (role.managed) {
    console.warn(`[roles] "${role.name}" is managed by an integration — Discord won't let me assign it.`);
    return false;
  }
  if (role.position >= me.roles.highest.position) {
    console.warn(
      `[roles] "${role.name}" sits at or above my own highest role. ` +
        "Drag my role above it in Server Settings → Roles, or I can't grant it.",
    );
    return false;
  }
  return true;
}

export async function reconcileOnce(client: Client): Promise<void> {
  let desired: DesiredRoles;
  try {
    desired = await api.desiredRoles();
  } catch (e) {
    // A game server blip is a skipped pass, not a crash. The next tick fixes
    // it, and doing nothing is strictly better than acting on partial data.
    console.error("[roles] couldn't fetch desired state — skipping this pass.", String(e));
    return;
  }

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    console.error(`[roles] guild ${config.guildId} not reachable — skipping this pass.`);
    return;
  }

  await guild.roles.fetch();
  const managed = resolveRoles(guild, desired.managedRoles);
  if (managed.size === 0) {
    console.error("[roles] none of the managed roles exist in this guild — nothing to do.");
    return;
  }
  const usable = [...managed.values()].filter((r) => assignable(guild, r));
  if (usable.length === 0) return;
  const usableIds = new Set(usable.map((r) => r.id));

  // One fetch of the whole member list rather than a fetch per linked member.
  // Requires the GUILD_MEMBERS privileged intent — see the README.
  const members = await guild.members.fetch().catch((e) => {
    console.error(
      "[roles] couldn't fetch members. This usually means the SERVER MEMBERS INTENT " +
        "is off in the Discord Developer Portal → Bot → Privileged Gateway Intents.",
      String(e),
    );
    return null;
  });
  if (!members) return;

  const desiredByDiscordId = new Map(desired.members.map((m) => [m.discordId, m]));

  let granted = 0;
  let removed = 0;

  const me = guild.members.me;

  for (const [discordId, member] of members) {
    if (member.user.bot) continue;

    // Members Discord will never let us modify, no matter what permissions we
    // hold. Attempting anyway produces one rejected API call per role per pass
    // — for the server owner that is a warning every five minutes, forever,
    // about a condition that cannot be fixed from this side.
    //
    // The owner is absolute: role position is irrelevant, a bot cannot touch
    // them even with Administrator. Anyone whose highest role sits at or above
    // ours is the ordinary hierarchy rule, and THAT one is fixable — by moving
    // our role up — so it is worth naming the member.
    const unmanageable =
      member.id === guild.ownerId
        ? "they own this server, and Discord never lets a bot change the owner's roles"
        : me && member.roles.highest.position >= me.roles.highest.position
          ? `their highest role (${member.roles.highest.name}) is at or above mine`
          : null;

    if (unmanageable) {
      // Once per member per process. A permanent condition does not need
      // repeating every pass, but it does need saying at least once, or role
      // sync looks like it is silently doing nothing.
      if (!explained.has(member.id)) {
        explained.add(member.id);
        const wanted = desiredByDiscordId.get(discordId)?.roles ?? [];
        console.warn(
          `[roles] skipping ${member.user.tag}: ${unmanageable}.` +
            (wanted.length ? ` They would otherwise get: ${wanted.join(", ")}.` : ""),
        );
      }
      continue;
    }

    const want = desiredByDiscordId.get(discordId);
    // Someone in the server with no link row wants NO managed roles. That is
    // how an /unlink, an account deletion, and a ban all take effect without
    // any of them needing to notify the bot.
    const wantNames = new Set((want?.roles ?? []).map((n) => n.toLowerCase()));

    for (const role of usable) {
      const shouldHave = wantNames.has(role.name.toLowerCase());
      const has = member.roles.cache.has(role.id);
      if (shouldHave && !has) {
        await member.roles.add(role, "pokeidle role sync").then(
          () => { granted++; },
          (e) => console.warn(`[roles] couldn't grant ${role.name} to ${member.user.tag}:`, String(e)),
        );
      } else if (!shouldHave && has && usableIds.has(role.id)) {
        // The `usableIds` check is belt-and-braces on the managed-roles scope:
        // this branch can only ever touch a role that came from the server's
        // own managedRoles list AND that we resolved and verified above.
        await member.roles.remove(role, "pokeidle role sync").then(
          () => { removed++; },
          (e) => console.warn(`[roles] couldn't remove ${role.name} from ${member.user.tag}:`, String(e)),
        );
      }
    }
  }

  if (granted || removed) {
    console.log(
      `[roles] reconciled: +${granted} / -${removed}` +
        (desired.champion ? ` · champion: ${desired.champion.username}` : " · no champion"),
    );
  }

  // Check in, so the admin dashboard can say whether this process is alive.
  // Deliberately AFTER the work and deliberately swallowed: a heartbeat is
  // telemetry, and a failed one must never turn a successful reconcile into a
  // logged failure.
  await api
    .heartbeat({
      guildMembers: members.size,
      linkedMembers: desired.members.length,
      rolesGranted: granted,
      rolesRemoved: removed,
      champion: desired.champion?.username ?? null,
    })
    .catch(() => undefined);
}

export function startRoleSync(client: Client): void {
  if (config.roleSyncDisabled) {
    console.log("[roles] ROLE_SYNC_DISABLED=1 — not reconciling.");
    return;
  }
  // OVERLAP GUARD. A reconcile walks every member and awaits an API call per
  // role change, so on a large guild it can outrun the interval. Without this,
  // setInterval would start a second pass on top of the first, then a third —
  // each one adding concurrent requests to a Discord API that is already the
  // reason the pass is slow. That is how a slow reconcile becomes a rate-limit
  // spiral rather than just a late one.
  //
  // Skipping is always the right answer: the next tick reconciles the same
  // state, so a dropped pass costs latency, never correctness.
  let running = false;
  const tick = async () => {
    if (running) {
      console.warn("[roles] previous pass still running — skipping this tick.");
      return;
    }
    running = true;
    try {
      await reconcileOnce(client);
    } catch (e) {
      console.error("[roles] pass failed:", String(e));
    } finally {
      running = false;
    }
  };
  // Run once at boot so a deploy immediately corrects anything that drifted
  // while the bot was down, then on the interval.
  void tick();
  setInterval(() => void tick(), config.roleSyncIntervalMs).unref?.();
}
