import type { GameState } from "../types";
import { routes } from "../data/routes";

// Single source of truth for "what phase is the UI in?". Used by ContextPanel
// and any other component that needs to render differently based on whether
// the player is fighting, exploring, or in a meta state. Derived from the
// existing reducer state — no new fields required.
//
// Distinct from `state.phase` because:
//   - We split the three battle types so the context panel can show
//     wild-specific actions (ball strip) vs trainer-specific (team balls)
//     vs boss-specific (gauntlet progress).
//   - We split idle into route/town because what's available there differs.
//   - We collapse healing/evolution/starter into a single "meta" since the
//     right column doesn't matter much during those (full-screen modals own
//     the surface).
export type UIPhase =
  | "battle-wild"
  | "battle-trainer"
  | "battle-boss"
  | "idle-route"
  | "idle-town"
  | "idle-raid"
  | "meta";

export function getUIPhase(state: GameState): UIPhase {
  if (state.phase === "starterSelect" || state.phase === "healing" || state.phase === "evolution") {
    return "meta";
  }
  if (state.phase === "bossBattle") return "battle-boss";
  if (state.phase === "trainerBattle") return "battle-trainer";
  if (state.phase === "battle") return "battle-wild";
  // Idle: route vs town vs raid island based on the route definition.
  const here = routes[state.currentLocation];
  if (here?.type === "town") return "idle-town";
  if (here?.type === "raid") return "idle-raid";
  return "idle-route";
}
