// Ability runtime registry: maps ability id → effect hooks the battle
// resolver consults. Phase 1 ships:
//
//   levitate    — Ground immunity (onIncomingMove)
//   sturdy      — survives at 1 HP if at full HP (onIncomingDamage)
//   flashFire   — Fire immunity + "boosted next" flag (onIncomingMove)
//   intimidate  — drops opponent Atk on switch-in (onSwitchIn)
//
// Adding a new ability is one entry in `abilities` plus (for stat hooks)
// any extra fields on BattleSide. Most abilities are pure functions of
// the move/state passed in.

import type {
  BattleEvent,
  MoveCategory,
  PokemonType,
  StatusCondition,
  WeatherCondition,
} from "../types";
import type { BattleSide } from "./battle";

export interface IncomingMoveCtx {
  user: BattleSide;
  attacker: BattleSide;
  moveType: PokemonType;
  moveCategory: MoveCategory;
  moveId: string;
}

export type IncomingMoveResult =
  | { kind: "immune"; message: string }
  | { kind: "absorbAndBoost"; boostType: PokemonType; message: string }
  | null;

export interface IncomingDamageCtx {
  user: BattleSide;
  attacker: BattleSide;
  damage: number;
  moveType: PokemonType;
}

export type IncomingDamageResult = { clamped: number; message?: string } | null;

export interface SwitchInCtx {
  user: BattleSide;
  opponent: BattleSide;
  userSide: "player" | "enemy";
  // Mutable weather slot — Drought/Drizzle/Sand Stream/Snow Warning may
  // overwrite. Set to null to clear, or to a fresh object to install.
  weather: { current: { type: WeatherCondition; turnsRemaining: number } | null };
}

export interface StatusInflictCtx {
  user: BattleSide;
  attacker: BattleSide;
  status: StatusCondition;
}

export interface ContactCtx {
  user: BattleSide;       // the holder of the ability (the defender taking the hit)
  attacker: BattleSide;   // the attacker who made contact
  damageDealt: number;
}

export interface AbilityHooks {
  onIncomingMove?: (ctx: IncomingMoveCtx) => IncomingMoveResult;
  onIncomingDamage?: (ctx: IncomingDamageCtx) => IncomingDamageResult;
  onSwitchIn?: (ctx: SwitchInCtx) => BattleEvent[];
  // Returns { blocked: true, message? } to prevent a status from being
  // applied to this Pokémon. Limber/Insomnia/etc. live here.
  onStatusInflict?: (ctx: StatusInflictCtx) => { blocked: true; message?: string } | null;
  // Called when this Pokémon (the defender) is hit by a contact move.
  // Used by Static, Flame Body, Effect Spore — may inflict a status on
  // the attacker or push events. The handler may directly mutate
  // attacker.status (after checking attacker's ability via the resolver).
  onContact?: (ctx: ContactCtx) => BattleEvent[] | null;
}

const GROUND_BYPASSES_LEVITATE = new Set<string>([
  // (Empty in Gen 1.) Future moves like Smack Down/Thousand Arrows would
  // bypass Levitate; nothing in our move table does today.
]);

export const abilities: Record<string, AbilityHooks> = {
  levitate: {
    onIncomingMove: ({ user, moveType, moveId }) =>
      moveType === "Ground" && !GROUND_BYPASSES_LEVITATE.has(moveId)
        ? { kind: "immune", message: `${user.name} avoided the attack with Levitate!` }
        : null,
  },

  flashFire: {
    onIncomingMove: ({ user, moveType }) =>
      moveType === "Fire"
        ? {
            kind: "absorbAndBoost",
            boostType: "Fire",
            message: `${user.name}'s Flash Fire raised its Fire power!`,
          }
        : null,
  },

  sturdy: {
    // If the holder is at full HP and the incoming hit would faint it,
    // clamp damage so it survives at 1 HP. One-shot prevention only.
    onIncomingDamage: ({ user, damage }) => {
      if (user.currentHp < user.maxHp) return null;
      if (damage < user.currentHp) return null;
      const clamped = user.currentHp - 1;
      return {
        clamped,
        message: `${user.name} endured the hit with Sturdy!`,
      };
    },
  },

  intimidate: {
    onSwitchIn: ({ user, opponent, userSide }) => {
      const oppSide = userSide === "player" ? "enemy" : "player";
      opponent.statStages ||= {};
      const cur = opponent.statStages.attack ?? 0;
      // Don't drop below the -6 stage floor.
      if (cur <= -6) return [];
      opponent.statStages.attack = Math.max(-6, cur - 1);
      return [
        {
          type: "ability",
          message: `${user.name}'s Intimidate cut ${opponent.name}'s Attack!`,
          payload: { side: oppSide, ability: "intimidate" },
        },
      ];
    },
  },

  // === Status immunities ===
  limber: {
    onStatusInflict: ({ user, status }) =>
      status === "paralyzed"
        ? { blocked: true, message: `${user.name}'s Limber prevents paralysis!` }
        : null,
  },
  insomnia: {
    onStatusInflict: ({ user, status }) =>
      status === "asleep"
        ? { blocked: true, message: `${user.name}'s Insomnia prevents sleep!` }
        : null,
  },
  vitalSpirit: {
    onStatusInflict: ({ user, status }) =>
      status === "asleep"
        ? { blocked: true, message: `${user.name}'s Vital Spirit prevents sleep!` }
        : null,
  },
  waterVeil: {
    onStatusInflict: ({ user, status }) =>
      status === "burned"
        ? { blocked: true, message: `${user.name}'s Water Veil prevents burns!` }
        : null,
  },
  immunity: {
    onStatusInflict: ({ user, status }) =>
      status === "poisoned" || status === "badlyPoisoned"
        ? { blocked: true, message: `${user.name}'s Immunity prevents poison!` }
        : null,
  },

  // === Contact-based status infliction ===
  // 30% chance to inflict on the attacker. Status doesn't apply if
  // attacker already has one or its ability prevents the status (handled
  // by the resolver's tryInflictStatus, not here).
  static: {
    onContact: ({ user, attacker }) => {
      if (Math.random() >= 0.3) return null;
      // The resolver will call tryInflictStatus with this status; we just
      // return an event hinting at the trigger. Actual application is
      // done via the resolver to centralize immunity checks.
      return [
        {
          type: "abilityTrigger",
          message: `${user.name}'s Static!`,
          payload: { ability: "static", inflictOnAttacker: "paralyzed" },
        },
      ];
    },
  },
  flameBody: {
    onContact: ({ user }) => {
      if (Math.random() >= 0.3) return null;
      return [
        {
          type: "abilityTrigger",
          message: `${user.name}'s Flame Body!`,
          payload: { ability: "flameBody", inflictOnAttacker: "burned" },
        },
      ];
    },
  },
  effectSpore: {
    onContact: ({ user }) => {
      if (Math.random() >= 0.3) return null;
      // Roll evenly between paralysis / sleep / poison.
      const pool: StatusCondition[] = ["paralyzed", "asleep", "poisoned"];
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return [
        {
          type: "abilityTrigger",
          message: `${user.name}'s Effect Spore!`,
          payload: { ability: "effectSpore", inflictOnAttacker: pick },
        },
      ];
    },
  },

  // Synchronize: when this Pokémon is statused with paralyze/burn/poison,
  // pass the same status back to the attacker. Hook via onStatusInflict
  // returning a "reflect" effect — but our hook only blocks. We'll add a
  // separate path: synchronize is handled by the resolver checking the
  // user.ability after status applies.
  synchronize: {
    // No-op here; the resolver special-cases this ability id when the
    // user is successfully statused with paralyze/burn/poison.
  },

  // === Weather setters (switch-in) ===
  drought: {
    onSwitchIn: ({ user, weather }) => {
      weather.current = { type: "sun", turnsRemaining: 5 };
      return [{ type: "weatherSet", message: `${user.name}'s Drought intensified the sunlight!` }];
    },
  },
  drizzle: {
    onSwitchIn: ({ user, weather }) => {
      weather.current = { type: "rain", turnsRemaining: 5 };
      return [{ type: "weatherSet", message: `${user.name}'s Drizzle started a downpour!` }];
    },
  },
  sandStream: {
    onSwitchIn: ({ user, weather }) => {
      weather.current = { type: "sand", turnsRemaining: 5 };
      return [{ type: "weatherSet", message: `${user.name}'s Sand Stream kicked up a sandstorm!` }];
    },
  },
  // Snow Warning — Gen 5 weather-setter ability. Mirrors Drought /
  // Drizzle / Sand Stream but sets hail. The hail damage / Ice-type
  // immunity / "buffeted by hail" tick logic is already wired
  // downstream in battle.ts end-of-turn so this just needs to install
  // the weather state on switch-in.
  snowWarning: {
    onSwitchIn: ({ user, weather }) => {
      weather.current = { type: "hail", turnsRemaining: 5 };
      return [{ type: "weatherSet", message: `${user.name}'s Snow Warning whipped up a hailstorm!` }];
    },
  },
};

// Convenience: returns the active hooks for a side, or an empty object
// if the Pokémon has no ability or the ability isn't in the registry.
export function hooksFor(side: BattleSide): AbilityHooks {
  if (!side.ability) return {};
  return abilities[side.ability] ?? {};
}
