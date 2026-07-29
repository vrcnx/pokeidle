// Battle math and per-turn simulation.
// Reverse-engineered from the original `gg`, `vg`, `xf`, `bg`, `Sg` and
// supporting helpers in the production bundle.

import { moves as movesTable } from "../data/moves";
import type {
  BattleEvent,
  MoveDef,
  Pokemon,
  PokemonType,
  StatStages,
  StatusCondition,
} from "../types";
import { typeEffectiveness } from "./typing";
import { hooksFor } from "./abilityRegistry";
import {
  TYPE_BOOST_ITEMS,
  TYPE_BOOST_MULTIPLIER,
  LIFE_ORB_DAMAGE_MULT,
  LIFE_ORB_RECOIL_FRACTION,
  LEFTOVERS_HEAL_FRACTION,
} from "./heldItemEffects";
import type { WeatherState, WeatherCondition } from "../types";

// Mutable weather context passed into executeTurn. The resolver may
// set/clear weather via moves (Sunny Day, etc), abilities (Drought, etc),
// or the natural turn timer. Caller reads `current` after resolution.
export interface WeatherCtx {
  current: WeatherState | null;
}

export type BattleSide = Pokemon & {
  statStages?: Partial<StatStages>;
  mustRecharge?: boolean;
  lockedMove?: string | null;
  lockTurnsRemaining?: number;
  types?: PokemonType[]; // attached at battle setup, since species->types lookup
  flashFireBoost?: boolean; // set after absorbing a Fire move; 1.5x own Fire moves
  switchInFired?: boolean;  // true once onSwitchIn ability hooks have run for this side
};

interface DamageResult {
  damage: number;
  isCrit: boolean;
  effectiveness: number;
  effectivenessLabel: string | null;
}

function statStageMultiplier(stage: number): number {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

function clampStage(stage: number): number {
  return Math.max(-6, Math.min(6, stage));
}

function getStage(side: BattleSide, stat: keyof StatStages): number {
  return side.statStages?.[stat] ?? 0;
}

// Attempt to inflict a status on `target`. Returns true if applied.
// Handles type immunities, ability blocks, and the "already statused"
// rule (only one major status at a time).
function tryInflictStatus(
  target: BattleSide,
  status: StatusCondition,
  events: BattleEvent[]
): boolean {
  // Already statused — block.
  if (target.status) return false;

  // Type immunities (canon Gen 1+):
  const types = target.types ?? [];
  if (status === "burned" && types.includes("Fire")) return false;
  if (status === "frozen" && types.includes("Ice")) return false;
  if ((status === "poisoned" || status === "badlyPoisoned") &&
      (types.includes("Poison") || types.includes("Steel"))) return false;
  // Electric types are paralysis-immune in Gen 6+; we mirror that since
  // it's standard modern behavior.
  if (status === "paralyzed" && types.includes("Electric")) return false;

  // Ability blocks (Limber/Insomnia/Vital Spirit/Water Veil/Immunity).
  const hooks = hooksFor(target);
  const blocked = hooks.onStatusInflict?.({
    user: target,
    attacker: target, // attacker not relevant for immunity check
    status,
  });
  if (blocked?.blocked) {
    if (blocked.message) events.push({ type: "abilityImmune", message: blocked.message });
    return false;
  }

  // Apply.
  target.status = status;
  if (status === "asleep") target.sleepTurns = 1 + Math.floor(Math.random() * 3); // 1-3 turns
  if (status === "badlyPoisoned") target.toxicTurns = 1;
  events.push({
    type: "statusInflict",
    message: statusInflictMessage(target.name, status),
    payload: { status },
  });

  // Status-cure berries — fire as soon as the matching status lands.
  // Lum cures any major status; specific berries cure their named
  // status. Consumed on trigger. We re-emit a statusCure event so the
  // UI HP card status badge clears cleanly.
  consumeStatusCureBerry(target, status, events);
  return true;
}

// Cure-berry trigger. Inspects target.heldItem and clears the matching
// status if it matches. Returns true if a berry was consumed.
function consumeStatusCureBerry(
  target: BattleSide,
  status: StatusCondition | "confused",
  events: BattleEvent[]
): boolean {
  const item = target.heldItem;
  if (!item) return false;
  const cures: Record<string, true> | null =
    item === "lumberry"    ? { paralyzed: true, asleep: true, burned: true, frozen: true, poisoned: true, badlyPoisoned: true, confused: true } as any
    : item === "cheriberry"  ? { paralyzed: true } as any
    : item === "chestoberry" ? { asleep: true } as any
    : item === "pechaberry"  ? { poisoned: true, badlyPoisoned: true } as any
    : item === "rawstberry"  ? { burned: true } as any
    : item === "aspearberry" ? { frozen: true } as any
    : item === "persimberry" ? { confused: true } as any
    : null;
  if (!cures || !(cures as any)[status]) return false;
  target.heldItem = undefined;
  if (status === "confused") {
    target.confusedTurns = 0;
    events.push({
      type: "statusCure",
      message: `${target.name} snapped out of confusion with its berry!`,
    });
  } else {
    target.status = undefined;
    target.sleepTurns = undefined;
    target.toxicTurns = undefined;
    events.push({
      type: "statusCure",
      message: `${target.name}'s berry cured its ${statusWord(status)}!`,
    });
  }
  return true;
}

function statusWord(s: StatusCondition): string {
  switch (s) {
    case "paralyzed":     return "paralysis";
    case "asleep":        return "sleep";
    case "burned":        return "burn";
    case "frozen":        return "freeze";
    case "poisoned":      return "poison";
    case "badlyPoisoned": return "toxic";
  }
}

function weatherSetMessage(w: WeatherCondition): string {
  switch (w) {
    case "sun":  return "The sunlight turned harsh!";
    case "rain": return "It started to rain!";
    case "sand": return "A sandstorm kicked up!";
    case "hail": return "It started to hail!";
  }
}
function weatherImmune(types: PokemonType[], w: WeatherCondition): boolean {
  if (w === "sand") return types.includes("Rock") || types.includes("Ground") || types.includes("Steel");
  if (w === "hail") return types.includes("Ice");
  return true; // sun/rain don't tick damage
}

function statusInflictMessage(name: string, status: StatusCondition): string {
  switch (status) {
    case "paralyzed":     return `${name} is paralyzed! It may be unable to move.`;
    case "asleep":        return `${name} fell asleep!`;
    case "burned":        return `${name} was burned!`;
    case "frozen":        return `${name} was frozen solid!`;
    case "poisoned":      return `${name} was poisoned!`;
    case "badlyPoisoned": return `${name} was badly poisoned!`;
  }
}

export function computeDamage(
  attackerLevel: number,
  attackerStat: number,
  defenderStat: number,
  move: MoveDef,
  attackerTypes: PokemonType[],
  defenderTypes: PokemonType[],
  attackerStage = 0,
  defenderStage = 0
): DamageResult {
  if (move.power === 0) {
    return { damage: 0, isCrit: false, effectiveness: 1, effectivenessLabel: null };
  }
  if (Math.random() * 100 >= move.accuracy) {
    return { damage: 0, isCrit: false, effectiveness: 1, effectivenessLabel: "miss" };
  }
  const atk = Math.floor(attackerStat * statStageMultiplier(attackerStage));
  const def = Math.max(1, Math.floor(defenderStat * statStageMultiplier(defenderStage)));
  const base = Math.floor(
    (Math.floor((2 * attackerLevel) / 5 + 2) * move.power * atk) / def / 50 + 2
  );
  // High-crit moves (Slash, Razor Leaf, Karate Chop, Crabhammer) use
  // critRatio: 2 → 1/8. Default is 1/16.
  const critChance = (move.critRatio ?? 1) / 16;
  const isCrit = Math.random() < critChance;
  const critMult = isCrit ? 2 : 1;
  const stab = attackerTypes.includes(move.type) ? 1.5 : 1;
  const eff = typeEffectiveness(move.type, defenderTypes);
  const random = (Math.floor(Math.random() * 16) + 85) / 100;
  const damage = Math.max(1, Math.floor(base * critMult * stab * eff * random));
  let label: string | null = null;
  if (eff === 0) label = "It had no effect!";
  else if (eff < 1) label = "It's not very effective...";
  else if (eff > 1) label = "It's super effective!";
  return {
    damage: eff === 0 ? 0 : damage,
    isCrit,
    effectiveness: eff,
    effectivenessLabel: label,
  };
}

// Expected damage (used by the AI to pick its best move).
function expectedDamage(
  attackerLevel: number,
  attackerStat: number,
  defenderStat: number,
  move: MoveDef,
  attackerTypes: PokemonType[],
  defenderTypes: PokemonType[],
  attackerStage = 0,
  defenderStage = 0
): number {
  if (move.power === 0) return 0;
  const atk = Math.floor(attackerStat * statStageMultiplier(attackerStage));
  const def = Math.max(1, Math.floor(defenderStat * statStageMultiplier(defenderStage)));
  const base = Math.floor(
    (Math.floor((2 * attackerLevel) / 5 + 2) * move.power * atk) / def / 50 + 2
  );
  const stab = attackerTypes.includes(move.type) ? 1.5 : 1;
  const eff = typeEffectiveness(move.type, defenderTypes);
  return Math.floor(base * stab * eff * 0.925);
}

// The fallback every side uses when its whole moveset is spent. Nothing
// learns it and it never occupies a move slot, so it has no PP of its own
// and the PP decrement below simply finds no slot to charge.
export const STRUGGLE_ID = "struggle";

// Struggle is typeless from Gen 5 on: no STAB, no type chart. We model that
// by handing computeDamage empty type lists. It matters more here than in
// the real games — a Ghost is immune to Normal, so a type-respecting
// Struggle would let one wall an out-of-PP player into a battle that can
// never end.
function struggleResult(): { moveId: string; move: MoveDef } {
  return { moveId: STRUGGLE_ID, move: movesTable[STRUGGLE_ID]! };
}

// Helper for the AI: how many of the attacker's moves currently have PP left?
function moveHasPp(side: BattleSide, moveId: string): boolean {
  const slot = side.moves.find((m) => m.id === moveId);
  return !!slot && slot.pp > 0;
}

/** True when there is no move left to use — the Struggle condition. Vacuously
 *  true for an empty moveset, which is the right answer for the one save
 *  shape that can produce it (a Pokémon whose last move was deleted). */
export function isOutOfPP(moves: { pp: number }[]): boolean {
  return moves.every((m) => m.pp <= 0);
}

export function pickSmartMove(
  moveIds: string[],
  attacker: BattleSide,
  defender: BattleSide,
  attackerTypes: PokemonType[],
  defenderTypes: PokemonType[]
): { moveId: string; move: MoveDef } {
  // Step 1 — only consider moves with PP. Everything spent means Struggle:
  // the old fallback re-picked from the full list, so a Pokémon with four
  // empty slots kept firing them off at full strength forever.
  const usable = moveIds.filter((id) => moveHasPp(attacker, id));
  if (usable.length === 0) return struggleResult();
  const candidates = usable;

  // Step 2 — score each move's expected damage with the same risky-effect
  // penalties the original used.
  let bestMove = candidates[0];
  let bestDamage = -1;
  let bestMoveDef: MoveDef | undefined;
  for (const id of candidates) {
    const def = movesTable[id];
    if (!def || def.power === 0) continue;
    const aStat = def.category === "physical" ? attacker.attack : attacker.spAttack;
    const dStat = def.category === "physical" ? defender.defense : defender.spDefense;
    const aStage = getStage(attacker, def.category === "physical" ? "attack" : "spAttack");
    const dStage = getStage(defender, def.category === "physical" ? "defense" : "spDefense");
    let exp = expectedDamage(
      attacker.level,
      aStat,
      dStat,
      def,
      attackerTypes,
      defenderTypes,
      aStage,
      dStage
    );
    if ((def as any).effect) {
      const eff = (def as any).effect;
      switch (eff.type) {
        case "recoil":      exp *= 1 - eff.fraction; break;
        case "recharge":    exp *= 0.5; break;
        case "selfDestruct":exp *= 0.15; break;
        case "multiTurnLock": exp *= 0.75; break;
        case "crashOnMiss": exp *= def.accuracy / 100; break;
      }
    }
    if (exp > bestDamage) {
      bestDamage = exp;
      bestMove = id;
      bestMoveDef = def;
    }
  }

  // Step 3 — setup awareness. If the best damaging move can't even put a dent
  // in the opponent (≤ 25% of their current HP) and we're healthy enough to
  // afford a turn (HP ≥ 70%), look for a self-buff statChange move that boosts
  // the relevant attacking stat. Skip if we're already at +4 or better — at
  // that point the next attack matters more than another buff.
  const opponentHp = Math.max(1, defender.currentHp || defender.maxHp);
  const ownHpPct = (attacker.currentHp || attacker.maxHp) / Math.max(1, attacker.maxHp);
  const damageRatio = bestDamage / opponentHp;
  if (bestMoveDef && damageRatio < 0.25 && ownHpPct > 0.7) {
    const statKey = bestMoveDef.category === "physical" ? "attack" : "spAttack";
    const currentStage = getStage(attacker, statKey);
    if (currentStage < 4) {
      const setupId = candidates.find((id) => {
        const m = movesTable[id];
        const eff = (m as any)?.effect;
        return (
          m &&
          m.power === 0 &&
          eff?.type === "statChange" &&
          eff.target === "self" &&
          (eff.changes?.[statKey] ?? 0) >= 1
        );
      });
      if (setupId) {
        return { moveId: setupId, move: movesTable[setupId]! };
      }
    }
  }

  return { moveId: bestMove, move: movesTable[bestMove]! };
}

// Wild-encounter move pick. Takes the whole side rather than a list of ids
// so it can honour PP the same way pickSmartMove does — a wild Pokémon that
// has burned through its moveset Struggles like anything else.
export function pickRandomMove(
  attacker: BattleSide
): { moveId: string; move: MoveDef } {
  const usable = attacker.moves.filter((m) => m.pp > 0).map((m) => m.id);
  if (usable.length === 0) return struggleResult();
  const damaging = usable.filter((id) => {
    const m = movesTable[id];
    return m && m.power > 0;
  });
  const pool = damaging.length > 0 ? damaging : usable;
  const id = pool[Math.floor(Math.random() * pool.length)];
  return { moveId: id, move: movesTable[id]! };
}

const STAT_LABELS: Record<string, string> = {
  attack: "Attack",
  defense: "Defense",
  spAttack: "Sp. Attack",
  spDefense: "Sp. Defense",
  speed: "Speed",
};

export function statLabel(stat: string): string {
  return STAT_LABELS[stat] ?? stat;
}

// Execute a single turn. Mutates `player` and `enemy` HP/state, returns the
// list of events to log/animate. `smartEnemy` makes the enemy pick its best move
// (used in trainer/boss fights); wild encounters use random selection.
export function executeTurn(
  player: BattleSide,
  enemy: BattleSide,
  smartEnemy = false,
  playerMoveOverride?: string,
  weatherCtx: WeatherCtx = { current: null },
  // When true, the player chose a non-attacking action this turn
  // (e.g. threw a Poké Ball that failed). Skip the player's attack
  // pick + execution so only the enemy gets to act, plus the usual
  // end-of-turn weather/status ticks.
  playerSkipped = false,
): BattleEvent[] {
  const events: BattleEvent[] = [];
  player.statStages ||= {};
  enemy.statStages ||= {};

  // Switch-in ability hooks (Intimidate, Drought, etc). Fires once per
  // Pokemon's first turn after entering battle. weatherCtx is exposed so
  // weather-setter abilities can install their condition.
  for (const [user, opponent, userSide] of [
    [player, enemy, "player" as const],
    [enemy, player, "enemy" as const],
  ] as const) {
    if (user.switchInFired) continue;
    if (user.currentHp <= 0) continue;
    const hooks = hooksFor(user);
    const switchInEvents = hooks.onSwitchIn?.({ user, opponent, userSide, weather: weatherCtx });
    if (switchInEvents && switchInEvents.length > 0) {
      events.push(...switchInEvents);
    }
    user.switchInFired = true;
  }

  const playerRecharge = !!player.mustRecharge;
  const enemyRecharge = !!enemy.mustRecharge;
  if (playerRecharge) player.mustRecharge = false;
  if (enemyRecharge) enemy.mustRecharge = false;

  // Pick player's move. Priority order:
  //   1. Forced (recharge after Hyper Beam)
  //   2. Locked (mid Outrage / Petal Dance / Thrash)
  //   3. Manual Struggle from the UI, when the moveset is spent
  //   4. Manual override from the UI (only if it's actually one of this
  //      Pokémon's moves and has PP — otherwise fall through to AI/random)
  //   5. Smart AI pick
  //
  // pFreshPick: did we pick a NEW move this turn (= PP should be
  // decremented), or are we continuing a previously-paid action?
  // Recharge turns (Hyper Beam after-glow) and continuing lock-in
  // moves (Outrage turns 2-3) both paid their PP when the move was
  // originally chosen, so we don't double-charge them here.
  let pMoveId: string = "";
  let pMove: MoveDef | undefined;
  let pFreshPick = false;
  if (!playerSkipped) {
    if (playerRecharge) {
      pMoveId = player.moves[0].id;
      pMove = movesTable[pMoveId];
    } else if (player.lockedMove) {
      pMoveId = player.lockedMove;
      pMove = movesTable[pMoveId];
    } else if (playerMoveOverride === STRUGGLE_ID && isOutOfPP(player.moves)) {
      // The moves panel only offers Struggle once every slot is empty;
      // re-check here so it can't be used as a free extra attack.
      pMoveId = STRUGGLE_ID;
      pMove = movesTable[STRUGGLE_ID];
      pFreshPick = true;
    } else if (
      playerMoveOverride &&
      player.moves.some((m) => m.id === playerMoveOverride && m.pp > 0)
    ) {
      pMoveId = playerMoveOverride;
      pMove = movesTable[pMoveId];
      pFreshPick = true;
    } else {
      const pick = pickSmartMove(
        player.moves.map((m) => m.id),
        player,
        enemy,
        player.types ?? [],
        enemy.types ?? []
      );
      pMoveId = pick.moveId;
      pMove = pick.move;
      pFreshPick = true;
    }
  }

  // Pick enemy's move
  let eMoveId: string;
  let eMove: MoveDef | undefined;
  let eFreshPick = false;
  if (enemyRecharge) {
    eMoveId = enemy.moves[0].id;
    eMove = movesTable[eMoveId];
  } else if (enemy.lockedMove) {
    eMoveId = enemy.lockedMove;
    eMove = movesTable[eMoveId];
  } else {
    const pick = smartEnemy
      ? pickSmartMove(
          enemy.moves.map((m) => m.id),
          enemy,
          player,
          enemy.types ?? [],
          player.types ?? []
        )
      : pickRandomMove(enemy);
    eMoveId = pick.moveId;
    eMove = pick.move;
    eFreshPick = true;
  }

  // Determine turn order (priority > priority, else speed)
  const pPriority = playerRecharge ? -10 : pMove?.priority ?? 0;
  const ePriority = enemyRecharge ? -10 : eMove?.priority ?? 0;
  type Step = { attacker: BattleSide; defender: BattleSide; moveId: string; isPlayer: boolean };
  const steps: Step[] = [];
  if (playerSkipped) {
    // Player committed to a non-move action this turn (e.g. failed
    // ball throw). Only the enemy gets a step.
    steps.push({ attacker: enemy, defender: player, moveId: eMoveId, isPlayer: false });
  } else if (pPriority > ePriority) {
    steps.push(
      { attacker: player, defender: enemy, moveId: pMoveId, isPlayer: true },
      { attacker: enemy, defender: player, moveId: eMoveId, isPlayer: false }
    );
  } else if (ePriority > pPriority) {
    steps.push(
      { attacker: enemy, defender: player, moveId: eMoveId, isPlayer: false },
      { attacker: player, defender: enemy, moveId: pMoveId, isPlayer: true }
    );
  } else if ((function () {
    // Effective speed: paralysis halves; weather-dependent abilities double.
    const w = weatherCtx.current?.type;
    function effSpeed(side: BattleSide): number {
      let s = side.speed;
      // Gen 5 paralyzes to QUARTER speed (Gen 6+ changed to half).
      // Target era is Gen 5 to match the PvP simulator.
      if (side.status === "paralyzed") s = Math.floor(s / 4);
      if (side.ability === "chlorophyll" && w === "sun") s = s * 2;
      if (side.ability === "swiftSwim" && w === "rain") s = s * 2;
      return s;
    }
    return effSpeed(player) >= effSpeed(enemy);
  })()) {
    steps.push(
      { attacker: player, defender: enemy, moveId: pMoveId, isPlayer: true },
      { attacker: enemy, defender: player, moveId: eMoveId, isPlayer: false }
    );
  } else {
    steps.push(
      { attacker: enemy, defender: player, moveId: eMoveId, isPlayer: false },
      { attacker: player, defender: enemy, moveId: pMoveId, isPlayer: true }
    );
  }

  for (const step of steps) {
    if (step.attacker.currentHp <= 0) continue;

    // === Status pre-move gates ===
    // Sleep: cannot attack while sleepTurns > 0; tick down each turn.
    if (step.attacker.status === "asleep") {
      if ((step.attacker.sleepTurns ?? 0) > 0) {
        step.attacker.sleepTurns = (step.attacker.sleepTurns ?? 0) - 1;
        events.push({
          type: "statusBlock",
          message: `${step.attacker.name} is fast asleep.`,
        });
        continue;
      } else {
        // Wake up.
        step.attacker.status = undefined;
        step.attacker.sleepTurns = undefined;
        events.push({
          type: "statusCure",
          message: `${step.attacker.name} woke up!`,
        });
      }
    }
    // Freeze: 20% chance to thaw each turn, otherwise skip.
    if (step.attacker.status === "frozen") {
      if (Math.random() < 0.20) {
        step.attacker.status = undefined;
        events.push({
          type: "statusCure",
          message: `${step.attacker.name} thawed out!`,
        });
      } else {
        events.push({
          type: "statusBlock",
          message: `${step.attacker.name} is frozen solid!`,
        });
        continue;
      }
    }
    // Paralysis: 25% full skip; passes through otherwise.
    if (step.attacker.status === "paralyzed" && Math.random() < 0.25) {
      events.push({
        type: "statusBlock",
        message: `${step.attacker.name} is paralyzed and can't move!`,
      });
      continue;
    }

    // Confusion: ticks down each attack; 50% chance to hurt self while active.
    // Volatile status — stacks with major status (paralysis/burn/etc).
    if ((step.attacker.confusedTurns ?? 0) > 0) {
      step.attacker.confusedTurns!--;
      if (step.attacker.confusedTurns === 0) {
        events.push({
          type: "statusCure",
          message: `${step.attacker.name} snapped out of confusion!`,
        });
      } else {
        events.push({
          type: "statusBlock",
          message: `${step.attacker.name} is confused...`,
        });
        if (Math.random() < 0.5) {
          // Self-hit: typeless 40-power physical, attacker's Atk vs own Def.
          const selfDmg = Math.max(
            1,
            Math.floor(
              (Math.floor((2 * step.attacker.level) / 5 + 2) * 40 * step.attacker.attack) /
                Math.max(1, step.attacker.defense) /
                50 +
                2
            )
          );
          step.attacker.currentHp = Math.max(0, step.attacker.currentHp - selfDmg);
          events.push({
            type: "recoil",
            message: `${step.attacker.name} hurt itself in confusion! (${selfDmg} damage)`,
            payload: {
              target: step.isPlayer ? "player" : "enemy",
              damage: selfDmg,
              hpAfter: step.attacker.currentHp,
              hpMax: step.attacker.maxHp,
            },
          });
          if (step.attacker.currentHp <= 0) {
            events.push({
              type: "faint",
              message: `${step.attacker.name} fainted!`,
              payload: { target: step.isPlayer ? "player" : "enemy" },
            });
            break;
          }
          continue;
        }
      }
    }

    if (step.isPlayer ? playerRecharge : enemyRecharge) {
      events.push({
        type: "recharge",
        message: `${step.attacker.name} must recharge!`,
      });
      continue;
    }
    const move = movesTable[step.moveId];
    if (!move) continue;

    // PP decrement — pre-move gates (sleep / freeze / paralysis-full)
    // already `continue`d above without reaching here, so reaching
    // this point means the move actually starts to execute, which is
    // when canonical Pokémon mechanics charge PP (a miss still costs
    // PP, but skipped pre-move turns don't). Only fresh picks pay:
    // forced recharge and continuing lock-in turns already paid on
    // the originating turn.
    const fresh = step.isPlayer ? pFreshPick : eFreshPick;
    if (fresh) {
      const slot = step.attacker.moves.find((m) => m.id === step.moveId);
      if (slot) slot.pp = Math.max(0, slot.pp - 1);
    }

    if (
      step.attacker.lockedMove &&
      step.attacker.lockTurnsRemaining !== undefined &&
      step.attacker.lockTurnsRemaining > 0
    ) {
      step.attacker.lockTurnsRemaining--;
    }

    events.push({
      type: "attack",
      message: `${step.attacker.name} used ${move.name}!`,
      payload: {
        target: step.isPlayer ? "enemy" : "player",
        moveId: step.moveId,
        moveType: move.type,
        moveCategory: move.category,
      },
    });

    // Status moves with statChange / inflictStatus effects
    if (move.power === 0) {
      const eff = (move as any).effect;
      // Status moves still respect accuracy.
      if (Math.random() * 100 >= move.accuracy) {
        events.push({
          type: "miss",
          message: `${step.attacker.name}'s attack missed!`,
        });
        continue;
      }
      if (eff?.type === "statChange") {
        const tgt: BattleSide = eff.target === "self" ? step.attacker : step.defender;
        const tgtSide = tgt === player ? "player" : "enemy";
        tgt.statStages ||= {};
        for (const [statKey, deltaRaw] of Object.entries(eff.changes)) {
          const stat = statKey as keyof StatStages;
          const delta = deltaRaw as number;
          const cur = tgt.statStages![stat] ?? 0;
          const next = clampStage(cur + delta);
          tgt.statStages![stat] = next;
          const verb = delta > 0 ? "rose" : "fell";
          const adverb = Math.abs(delta) >= 2 ? "sharply " : "";
          events.push({
            type: "statChange",
            message: `${tgt.name}'s ${statLabel(stat)} ${adverb}${verb}!`,
            payload: { target: tgtSide },
          });
        }
      } else if (eff?.type === "inflictStatus") {
        if (Math.random() < (eff.chance ?? 1)) {
          const tgt: BattleSide = eff.target === "self" ? step.attacker : step.defender;
          tryInflictStatus(tgt, eff.status, events);
        }
      } else if (eff?.type === "confuse") {
        if (Math.random() < (eff.chance ?? 1)) {
          const tgt: BattleSide = eff.target === "self" ? step.attacker : step.defender;
          if ((tgt.confusedTurns ?? 0) === 0) {
            tgt.confusedTurns = 2 + Math.floor(Math.random() * 4); // 2-5 turns (Gen 5)
            // Persim Berry / Lum Berry cure confusion as soon as it lands.
            consumeStatusCureBerry(tgt, "confused", events);
            events.push({
              type: "confuse",
              message: `${tgt.name} became confused!`,
            });
          }
        }
      } else if (eff?.type === "setWeather") {
        // Move overwrites whatever weather is active. Always 5-turn baseline
        // (Damp Rock / Heat Rock extensions aren't modeled).
        weatherCtx.current = { type: eff.weather, turnsRemaining: eff.turns };
        events.push({
          type: "weatherSet",
          message: weatherSetMessage(eff.weather),
        });
      }
      continue;
    }

    // Defender ability check — Levitate's Ground immunity, Flash Fire's
    // Fire absorb, etc. Runs only for damaging moves; status moves are
    // unaffected (standard Pokémon behavior).
    const defHooks = hooksFor(step.defender);
    const incoming = defHooks.onIncomingMove?.({
      user: step.defender,
      attacker: step.attacker,
      moveType: move.type,
      moveCategory: move.category,
      moveId: step.moveId,
    });
    if (incoming?.kind === "immune") {
      events.push({ type: "abilityImmune", message: incoming.message });
      continue;
    }
    if (incoming?.kind === "absorbAndBoost") {
      step.defender.flashFireBoost = true;
      events.push({ type: "abilityImmune", message: incoming.message });
      continue;
    }

    let aStat = move.category === "physical" ? step.attacker.attack : step.attacker.spAttack;
    // Burn halves physical Attack — unless attacker has Guts, which negates
    // the burn drop and adds its own +50% Atk boost when statused.
    if (move.category === "physical" && step.attacker.status === "burned" && step.attacker.ability !== "guts") {
      aStat = Math.max(1, Math.floor(aStat / 2));
    }
    // Guts: when statused with anything, +50% physical Attack.
    if (move.category === "physical" && step.attacker.ability === "guts" && step.attacker.status) {
      aStat = Math.floor(aStat * 1.5);
    }
    const dStat = move.category === "physical" ? step.defender.defense : step.defender.spDefense;
    const aStage = getStage(step.attacker, move.category === "physical" ? "attack" : "spAttack");
    const dStage = getStage(step.defender, move.category === "physical" ? "defense" : "spDefense");
    // Compound Eyes: 1.3× accuracy multiplier. Wrap the move so the
    // accuracy roll inside computeDamage uses the boosted value.
    const accBoost = step.attacker.ability === "compoundEyes" ? 1.3 : 1;
    const effectiveMove = accBoost === 1
      ? move
      : { ...move, accuracy: Math.min(100, move.accuracy * accBoost) };
    // Struggle is typeless: empty type lists mean no STAB and a flat 1×
    // from the type chart, so it can always chip away at anything.
    const isStruggle = step.moveId === STRUGGLE_ID;
    const result = computeDamage(
      step.attacker.level,
      aStat,
      dStat,
      effectiveMove,
      isStruggle ? [] : step.attacker.types ?? [],
      isStruggle ? [] : step.defender.types ?? [],
      aStage,
      dStage
    );

    // Flash Fire boost: if the attacker has previously absorbed a Fire move,
    // its own Fire moves get a 1.5× multiplier. Applied before Sturdy so
    // Sturdy clamps based on the boosted value.
    let appliedDamage = result.damage;
    if (move.type === "Fire" && step.attacker.flashFireBoost) {
      appliedDamage = Math.floor(appliedDamage * 1.5);
    }

    // Multi-hit: if the move has a multiHit effect, roll the hit count
    // and multiply total damage. Skill Link forces max hits.
    // For the canonical 2-5 hit family (Fury Swipes, Double Slap, Pin
    // Missile, Bullet Seed, etc.), Gen 5 uses a WEIGHTED distribution:
    // 2 hits 35%, 3 hits 35%, 4 hits 15%, 5 hits 15% — uniform would
    // give 5-hit results 25% of the time (10% too often) and skew the
    // long-run damage ~18% higher than canonical.
    let multiHitCount = 1;
    {
      const mEff = (move as any).effect;
      if (mEff?.type === "multiHit") {
        if (step.attacker.ability === "skillLink") {
          multiHitCount = mEff.maxHits;
        } else if (mEff.minHits === 2 && mEff.maxHits === 5) {
          // The canonical 2-5 hit family.
          const r = Math.random();
          if (r < 0.35)      multiHitCount = 2;
          else if (r < 0.70) multiHitCount = 3;
          else if (r < 0.85) multiHitCount = 4;
          else               multiHitCount = 5;
        } else {
          // Other multi-hit shapes (Bonemerang = always 2, Double Hit =
          // always 2, etc.) stay uniform across their min..max range.
          multiHitCount = mEff.minHits + Math.floor(Math.random() * (mEff.maxHits - mEff.minHits + 1));
        }
        appliedDamage = appliedDamage * multiHitCount;
      }
    }

    // === Damage-modifier abilities (attacker side) ===
    // Pinch boost: Overgrow/Blaze/Torrent/Swarm boost matching-type moves
    // by 1.5× when HP is at or below 1/3 maxHp.
    const PINCH_BOOST: Record<string, PokemonType> = {
      overgrow: "Grass", blaze: "Fire", torrent: "Water", swarm: "Bug",
    };
    const pinchType = PINCH_BOOST[step.attacker.ability ?? ""];
    if (pinchType && move.type === pinchType &&
        step.attacker.currentHp <= step.attacker.maxHp / 3) {
      appliedDamage = Math.floor(appliedDamage * 1.5);
    }
    // Adaptability: STAB becomes 2× instead of 1.5× → effective bump = 4/3.
    if (step.attacker.ability === "adaptability" &&
        (step.attacker.types ?? []).includes(move.type)) {
      appliedDamage = Math.floor(appliedDamage * (4 / 3));
    }
    // Tinted Lens: NVE damage doubled (effectiveness < 1 but > 0).
    if (step.attacker.ability === "tintedLens" &&
        result.effectiveness > 0 && result.effectiveness < 1) {
      appliedDamage = Math.floor(appliedDamage * 2);
    }
    // Iron Fist: punching moves +20%.
    if (step.attacker.ability === "ironFist" && move.isPunch) {
      appliedDamage = Math.floor(appliedDamage * 1.2);
    }
    // Reckless: recoil/crash moves +20%.
    {
      const recklessEff = (move as any).effect;
      if (step.attacker.ability === "reckless" &&
          (recklessEff?.type === "recoil" || recklessEff?.type === "crashOnMiss")) {
        appliedDamage = Math.floor(appliedDamage * 1.2);
      }
    }
    // Type-boost held items (Charcoal, Magnet, Mystic Water, etc.): +20% to matching type.
    {
      const heldType = step.attacker.heldItem ? TYPE_BOOST_ITEMS[step.attacker.heldItem] : undefined;
      if (heldType && heldType === move.type) {
        appliedDamage = Math.floor(appliedDamage * TYPE_BOOST_MULTIPLIER);
      }
    }
    // Weather-based damage modifiers. Cloud Nine on either side suppresses
    // weather effects entirely.
    if (weatherCtx.current && step.attacker.ability !== "cloudNine" && step.defender.ability !== "cloudNine") {
      const w = weatherCtx.current.type;
      if (w === "sun") {
        if (move.type === "Fire") appliedDamage = Math.floor(appliedDamage * 1.5);
        if (move.type === "Water") appliedDamage = Math.floor(appliedDamage * 0.5);
      } else if (w === "rain") {
        if (move.type === "Water") appliedDamage = Math.floor(appliedDamage * 1.5);
        if (move.type === "Fire") appliedDamage = Math.floor(appliedDamage * 0.5);
      }
    }
    // Life Orb: +30% damage; recoil applied AFTER damage event.
    if (step.attacker.heldItem === "lifeorb") {
      appliedDamage = Math.floor(appliedDamage * LIFE_ORB_DAMAGE_MULT);
    }

    if (result.effectivenessLabel === "miss") {
      events.push({
        type: "miss",
        message: `${step.attacker.name}'s attack missed!`,
      });
      const eff = (move as any).effect;
      if (eff?.type === "crashOnMiss" && step.attacker.ability !== "magicGuard") {
        const dmg = Math.max(1, Math.floor(step.attacker.maxHp * eff.fraction));
        step.attacker.currentHp = Math.max(0, step.attacker.currentHp - dmg);
        events.push({
          type: "recoil",
          message: `${step.attacker.name} kept going and crashed! (${dmg} damage)`,
          payload: {
            target: step.isPlayer ? "player" : "enemy",
            damage: dmg,
            hpAfter: step.attacker.currentHp,
            hpMax: step.attacker.maxHp,
          },
        });
        if (step.attacker.currentHp <= 0) {
          events.push({
            type: "faint",
            message: `${step.attacker.name} fainted!`,
            payload: { target: step.isPlayer ? "player" : "enemy" },
          });
          break;
        }
      }
      continue;
    }

    // Sturdy clamp: if defender has Sturdy and is at full HP, an otherwise
    // fatal hit drops it to 1 HP instead. Runs after Flash Fire boost so
    // Sturdy compares against the post-boost damage.
    let sturdyMessage: string | null = null;
    const sturdyResult = defHooks.onIncomingDamage?.({
      user: step.defender,
      attacker: step.attacker,
      damage: appliedDamage,
      moveType: move.type,
    });
    if (sturdyResult) {
      appliedDamage = sturdyResult.clamped;
      sturdyMessage = sturdyResult.message ?? null;
    }
    // Focus Sash: like Sturdy but consumed on trigger.
    let focusSashMessage: string | null = null;
    if (
      step.defender.heldItem === "focussash" &&
      step.defender.currentHp === step.defender.maxHp &&
      appliedDamage >= step.defender.currentHp
    ) {
      appliedDamage = step.defender.currentHp - 1;
      step.defender.heldItem = undefined; // consume
      focusSashMessage = `${step.defender.name} hung on with its Focus Sash!`;
    }

    step.defender.currentHp = Math.max(0, step.defender.currentHp - appliedDamage);
    events.push({
      type: "damage",
      message: `${step.defender.name} took ${appliedDamage} damage!`,
      payload: {
        target: step.isPlayer ? "enemy" : "player",
        damage: appliedDamage,
        hpAfter: step.defender.currentHp,
        hpMax: step.defender.maxHp,
      },
    });
    if (multiHitCount > 1)
      events.push({
        type: "multiHit",
        message: `Hit ${multiHitCount} times!`,
      });
    if (result.isCrit) events.push({ type: "critical", message: "A critical hit!" });
    if (result.effectivenessLabel)
      events.push({ type: "effectiveness", message: result.effectivenessLabel });
    if (sturdyMessage)
      events.push({ type: "abilityImmune", message: sturdyMessage });
    if (focusSashMessage)
      events.push({ type: "itemTrigger", message: focusSashMessage });
    // Life Orb recoil: 10% maxHP self-damage after a successful hit (Magic Guard skips it).
    if (
      step.attacker.heldItem === "lifeorb" &&
      step.attacker.ability !== "magicGuard" &&
      appliedDamage > 0 &&
      step.attacker.currentHp > 0
    ) {
      const recoil = Math.max(1, Math.floor(step.attacker.maxHp * LIFE_ORB_RECOIL_FRACTION));
      step.attacker.currentHp = Math.max(0, step.attacker.currentHp - recoil);
      events.push({
        type: "recoil",
        message: `${step.attacker.name} was hurt by its Life Orb! (${recoil} damage)`,
        payload: {
          target: step.isPlayer ? "player" : "enemy",
          damage: recoil,
          hpAfter: step.attacker.currentHp,
          hpMax: step.attacker.maxHp,
        },
      });
      if (step.attacker.currentHp <= 0) {
        events.push({
          type: "faint",
          message: `${step.attacker.name} fainted!`,
          payload: { target: step.isPlayer ? "player" : "enemy" },
        });
      }
    }

    const eff = (move as any).effect;
    if (eff) {
      switch (eff.type) {
        case "recoil": {
          // Magic Guard prevents recoil damage entirely.
          if (step.attacker.ability === "magicGuard") break;
          // Struggle bills the user's own max HP; everything else bills a
          // slice of the damage it just dealt.
          const dmg = eff.ofMaxHp
            ? Math.max(1, Math.floor(step.attacker.maxHp * eff.fraction))
            : Math.max(1, Math.floor(appliedDamage * eff.fraction));
          step.attacker.currentHp = Math.max(0, step.attacker.currentHp - dmg);
          events.push({
            type: "recoil",
            message: `${step.attacker.name} was hurt by recoil! (${dmg} damage)`,
            payload: {
              target: step.isPlayer ? "player" : "enemy",
              damage: dmg,
              hpAfter: step.attacker.currentHp,
              hpMax: step.attacker.maxHp,
            },
          });
          if (step.attacker.currentHp <= 0) {
            events.push({
              type: "faint",
              message: `${step.attacker.name} fainted!`,
              payload: { target: step.isPlayer ? "player" : "enemy" },
            });
          }
          break;
        }
        case "recharge":
          step.attacker.mustRecharge = true;
          break;
        case "selfDestruct":
          step.attacker.currentHp = 0;
          events.push({
            type: "faint",
            message: `${step.attacker.name} fainted!`,
            payload: { target: step.isPlayer ? "player" : "enemy" },
          });
          break;
        case "multiTurnLock":
          if (!step.attacker.lockedMove) {
            const turns =
              eff.minTurns + Math.floor(Math.random() * (eff.maxTurns - eff.minTurns + 1));
            step.attacker.lockedMove = step.moveId;
            step.attacker.lockTurnsRemaining = turns - 1;
          }
          if (
            step.attacker.lockTurnsRemaining !== undefined &&
            step.attacker.lockTurnsRemaining <= 0 &&
            step.attacker.lockedMove
          ) {
            step.attacker.lockedMove = null;
            step.attacker.lockTurnsRemaining = 0;
            // Outrage / Petal Dance / Thrash become confused after lock ends.
            // Gen 5 confusion lasts 2-5 turns.
            if ((step.attacker.confusedTurns ?? 0) === 0) {
              step.attacker.confusedTurns = 2 + Math.floor(Math.random() * 4);
              events.push({
                type: "confuse",
                message: `${step.attacker.name} became confused due to fatigue!`,
              });
              consumeStatusCureBerry(step.attacker, "confused", events);
            }
          }
          break;
        case "confuse":
          if (Math.random() < (eff.chance ?? 1) && step.defender.currentHp > 0) {
            const tgt: BattleSide = eff.target === "self" ? step.attacker : step.defender;
            // Gen 5 confusion lasts 2-5 turns.
            if ((tgt.confusedTurns ?? 0) === 0) {
              tgt.confusedTurns = 2 + Math.floor(Math.random() * 4);
              consumeStatusCureBerry(tgt, "confused", events);
              events.push({
                type: "confuse",
                message: `${tgt.name} became confused!`,
              });
            }
          }
          break;
        case "inflictStatus":
          if (Math.random() < (eff.chance ?? 1) && step.defender.currentHp > 0) {
            const tgt: BattleSide = eff.target === "self" ? step.attacker : step.defender;
            const applied = tryInflictStatus(tgt, eff.status, events);
            // Synchronize: pass burn/poison/paralyze back to the attacker.
            if (
              applied &&
              tgt !== step.attacker &&
              tgt.ability === "synchronize" &&
              (eff.status === "burned" || eff.status === "poisoned" ||
               eff.status === "paralyzed" || eff.status === "badlyPoisoned")
            ) {
              tryInflictStatus(step.attacker, eff.status, events);
            }
          }
          break;
      }
    }

    // === Contact abilities (Static / Flame Body / Effect Spore) ===
    // Trigger only on damaging physical moves landing a hit.
    if (move.category === "physical" && step.defender.currentHp > 0) {
      const defenderHooks = hooksFor(step.defender);
      const contactEvents = defenderHooks.onContact?.({
        user: step.defender,
        attacker: step.attacker,
        damageDealt: appliedDamage,
      });
      if (contactEvents && contactEvents.length > 0) {
        for (const ev of contactEvents) {
          events.push(ev);
          const inflict = ev.payload?.inflictOnAttacker as StatusCondition | undefined;
          if (inflict) tryInflictStatus(step.attacker, inflict, events);
        }
      }
    }

    if (step.defender.currentHp <= 0) {
      events.push({
        type: "faint",
        message: `${step.defender.name} fainted!`,
        payload: { target: step.isPlayer ? "enemy" : "player" },
      });
      // Moxie: scoring a KO grants the attacker +1 Attack.
      if (step.attacker.ability === "moxie") {
        step.attacker.statStages ||= {};
        const cur = step.attacker.statStages.attack ?? 0;
        if (cur < 6) {
          step.attacker.statStages.attack = cur + 1;
          events.push({
            type: "ability",
            message: `${step.attacker.name}'s Moxie raised its Attack!`,
          });
        }
      }
      break;
    }
    if (step.attacker.currentHp <= 0) break;
  }

  // === End-of-turn weather damage (sand/hail) ===
  if (weatherCtx.current) {
    const w = weatherCtx.current.type;
    if (w === "sand" || w === "hail") {
      for (const side of [player, enemy] as const) {
        if (side.currentHp <= 0) continue;
        if (side.ability === "magicGuard" || side.ability === "cloudNine") continue;
        if (side.ability === "overcoat") continue;
        if (weatherImmune(side.types ?? [], w)) continue;
        const dmg = Math.max(1, Math.floor(side.maxHp / 16));
        side.currentHp = Math.max(0, side.currentHp - dmg);
        events.push({
          type: "weatherDamage",
          message: w === "sand"
            ? `${side.name} is buffeted by the sandstorm! (${dmg} damage)`
            : `${side.name} is pelted by hail! (${dmg} damage)`,
          payload: {
            target: side === player ? "player" : "enemy",
            damage: dmg,
            hpAfter: side.currentHp,
            hpMax: side.maxHp,
          },
        });
        if (side.currentHp <= 0) {
          events.push({
            type: "faint",
            message: `${side.name} fainted!`,
            payload: { target: side === player ? "player" : "enemy" },
          });
        }
      }
    }
    // Decrement weather turns; clear when it expires.
    weatherCtx.current.turnsRemaining--;
    if (weatherCtx.current.turnsRemaining <= 0) {
      const ended = weatherCtx.current.type;
      weatherCtx.current = null;
      events.push({
        type: "weatherEnded",
        message:
          ended === "sun"  ? "The harsh sunlight faded." :
          ended === "rain" ? "The rain stopped." :
          ended === "sand" ? "The sandstorm subsided." :
                              "The hail stopped.",
      });
    }
  }

  // === End-of-turn ticks ===
  // Status: Burn 1/16, Poison 1/8, Toxic scaling 1/16×turn.
  // Held items: Leftovers heals 1/16 maxHP.
  // Magic Guard makes the holder immune to indirect damage (burn/poison/toxic
  // ticks) but Leftovers still heals it.
  for (const side of [player, enemy] as const) {
    if (side.currentHp <= 0) continue;
    // Leftovers heal first — applies regardless of status.
    if (side.heldItem === "leftovers" && side.currentHp < side.maxHp) {
      const heal = Math.max(1, Math.floor(side.maxHp * LEFTOVERS_HEAL_FRACTION));
      side.currentHp = Math.min(side.maxHp, side.currentHp + heal);
      events.push({
        type: "itemTrigger",
        message: `${side.name} restored a little HP with Leftovers.`,
        payload: {
          target: side === player ? "player" : "enemy",
          heal,
          hpAfter: side.currentHp,
          hpMax: side.maxHp,
        },
      });
    }
    // HP-restore berries — Sitrus (1/4 maxHP) and Oran (10 HP flat) pop
    // when the holder is at or below half HP. Single-use; we null the
    // heldItem on trigger. Sitrus prioritised over Oran in the (rare)
    // case a holder somehow has both (only one slot exists, but defensive).
    if (side.currentHp > 0 && side.currentHp <= Math.floor(side.maxHp / 2)) {
      if (side.heldItem === "sitrusberry") {
        const heal = Math.max(1, Math.floor(side.maxHp / 4));
        side.currentHp = Math.min(side.maxHp, side.currentHp + heal);
        side.heldItem = undefined;
        events.push({
          type: "itemTrigger",
          message: `${side.name} ate its Sitrus Berry and restored HP!`,
          payload: {
            target: side === player ? "player" : "enemy",
            heal,
            hpAfter: side.currentHp,
            hpMax: side.maxHp,
          },
        });
      } else if (side.heldItem === "oranberry") {
        const heal = Math.min(10, side.maxHp - side.currentHp);
        if (heal > 0) {
          side.currentHp = side.currentHp + heal;
          side.heldItem = undefined;
          events.push({
            type: "itemTrigger",
            message: `${side.name} ate its Oran Berry and restored 10 HP!`,
            payload: {
              target: side === player ? "player" : "enemy",
              heal,
              hpAfter: side.currentHp,
              hpMax: side.maxHp,
            },
          });
        }
      }
    }
    if (side.ability === "magicGuard") continue;
    if (side.status === "burned") {
      const dmg = Math.max(1, Math.floor(side.maxHp / 16));
      side.currentHp = Math.max(0, side.currentHp - dmg);
      events.push({
        type: "statusTick",
        message: `${side.name} was hurt by its burn! (${dmg} damage)`,
        payload: {
          target: side === player ? "player" : "enemy",
          damage: dmg,
          hpAfter: side.currentHp,
          hpMax: side.maxHp,
        },
      });
      if (side.currentHp <= 0) {
        events.push({
          type: "faint",
          message: `${side.name} fainted!`,
          payload: { target: side === player ? "player" : "enemy" },
        });
      }
    } else if (side.status === "poisoned") {
      const dmg = Math.max(1, Math.floor(side.maxHp / 8));
      side.currentHp = Math.max(0, side.currentHp - dmg);
      events.push({
        type: "statusTick",
        message: `${side.name} was hurt by poison! (${dmg} damage)`,
        payload: {
          target: side === player ? "player" : "enemy",
          damage: dmg,
          hpAfter: side.currentHp,
          hpMax: side.maxHp,
        },
      });
      if (side.currentHp <= 0) {
        events.push({
          type: "faint",
          message: `${side.name} fainted!`,
          payload: { target: side === player ? "player" : "enemy" },
        });
      }
    } else if (side.status === "badlyPoisoned") {
      const turns = side.toxicTurns ?? 1;
      const dmg = Math.max(1, Math.floor(side.maxHp * turns / 16));
      side.currentHp = Math.max(0, side.currentHp - dmg);
      side.toxicTurns = turns + 1;
      events.push({
        type: "statusTick",
        message: `${side.name} is hurt by toxic! (${dmg} damage)`,
        payload: {
          target: side === player ? "player" : "enemy",
          damage: dmg,
          hpAfter: side.currentHp,
          hpMax: side.maxHp,
        },
      });
      if (side.currentHp <= 0) {
        events.push({
          type: "faint",
          message: `${side.name} fainted!`,
          payload: { target: side === player ? "player" : "enemy" },
        });
      }
    }
  }

  return events;
}
