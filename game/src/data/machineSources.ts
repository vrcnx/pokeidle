// Where machines come from.
//
// The three sources answer three different player questions, which is why
// there are three and not one:
//
//   MART   — "I know what I want." The setup and status toolkit (Swords
//            Dance, Toxic, Thunder Wave, the weather moves). These are the
//            competitive backbone, so they must be reliably BUYABLE: a player
//            building a specific set should never be gated behind a drop
//            roll. Stocked a few per city so each mart is worth a visit.
//
//   ROUTE  — "What's out here?" Every attacking TM is tied to exactly one
//            route and drops nowhere else. This is the reason to walk into
//            Route 14 at all once its Pokémon are in your dex, and it is the
//            part of this the request specifically asked for.
//
//   RAID   — "What's the hardest thing I can do?" The six HMs and the five
//            heaviest TMs (Hyper Beam, Giga Impact, Solar Beam, Overheat,
//            Explosion). Nothing sells them.
//
// ── WHY THIS IS COMPUTED, NOT TYPED OUT ───────────────────────────────────
// The route assignment is derived from route unlock order rather than
// hand-written, so it holds two properties no hand-written table would keep:
// stronger machines sit behind later routes automatically, and adding a
// region doesn't leave a hole. It is deterministic — the same route always
// drops the same machine, for every player, forever — which is what makes it
// something players can share ("Ice Beam is on Route 25") rather than a
// slot machine.

import { machineList, type MachineDef } from "./tms";
import { moves as movesTable } from "./moves";
import { mergedRoutes } from "./regions";

/** The heaviest hitters. Never sold, never found — earned in a raid. */
const RAID_PRICE_FLOOR = 60_000;

export type MachineSource = "mart" | "route" | "raid";

function sourceOf(m: MachineDef): MachineSource {
  if (m.kind === "hm") return "raid";
  if ((m.price ?? 0) >= RAID_PRICE_FLOOR) return "raid";
  // A status move is a tool, not a prize — it should be purchasable.
  return (movesTable[m.moveId]?.power ?? 0) === 0 ? "mart" : "route";
}

export const machineSource: Record<string, MachineSource> = Object.fromEntries(
  machineList.map((m) => [m.id, sourceOf(m)]),
);

export const martMachines: MachineDef[] = machineList.filter((m) => machineSource[m.id] === "mart");
export const raidMachines: MachineDef[] = machineList.filter((m) => machineSource[m.id] === "raid");
const routeMachines: MachineDef[] = machineList.filter((m) => machineSource[m.id] === "route");

// ── Route assignment ──────────────────────────────────────────────────────
// Routes in unlock order, weakest machine first. `unlockOrder` is the game's
// own idea of progression, so this rides the curve the map already has
// instead of inventing a second one. Towns are skipped: a drop only happens
// after a wild battle, and towns have no encounters.
const orderedRoutes = Object.values(mergedRoutes)
  .filter((r) => r.type === "route")
  .sort((a, b) => (a.unlockOrder ?? 999) - (b.unlockOrder ?? 999) || a.id.localeCompare(b.id));

// Weakest first, so early routes hand out Rock Smash and late ones Ice Beam.
// Ties broken by id so the order can't drift between builds.
const orderedMachines = [...routeMachines].sort(
  (a, b) => (a.price ?? 0) - (b.price ?? 0) || a.id.localeCompare(b.id),
);

/**
 * routeId -> machine id. There are more routes than machines, so the
 * machines are spread ACROSS the whole list rather than crowded into the
 * first N — otherwise every drop in the game would live in Kanto's opening
 * stretch and Johto would have none.
 */
export const routeMachineDrop: Record<string, string> = {};
if (orderedRoutes.length > 0 && orderedMachines.length > 0) {
  const stride = orderedRoutes.length / orderedMachines.length;
  orderedMachines.forEach((m, i) => {
    const route = orderedRoutes[Math.min(orderedRoutes.length - 1, Math.floor(i * stride))];
    if (route) routeMachineDrop[route.id] = m.id;
  });
}

/** machine id -> the one route it drops on, for "where do I find this?". */
export const machineDropRoute: Record<string, string> = Object.fromEntries(
  Object.entries(routeMachineDrop).map(([routeId, machineId]) => [machineId, routeId]),
);

/**
 * Chance a cleared wild battle on a route yields its machine.
 *
 * Deliberately low, and it only has to land ONCE: machines are reusable and
 * one-per-player, so this is a threshold you cross rather than a resource you
 * farm. At 1.5% the median player crosses it in ~46 battles on that route and
 * 95% of players have it inside 200 — long enough to be a find, short enough
 * that nobody is stuck behind it.
 */
export const ROUTE_MACHINE_DROP_CHANCE = 0.015;

/** Chance a cleared raid wave yields a machine the player is missing. */
export const RAID_MACHINE_DROP_CHANCE = 0.08;
