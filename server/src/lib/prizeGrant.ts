// Writing a Prize into a player's save.
//
// Lifted out of routes/admin.ts unchanged so it has exactly ONE
// implementation shared by every caller that pays a prize out: the
// manual admin draw, the automatic giveaway draw loop
// (lib/giveawayDraw.ts) and mass-gift. Living in a lib rather than a
// route file is what lets the timer-driven draw reuse it without
// importing the admin Hono app (which would be a cycle).
import { prisma } from "../db.js";
import { validateSave } from "./saveValidation.js";
import { computeAccountLevel } from "./level.js";
import type { Prize } from "./giveaway.js";

function safeParseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Write prizes into a user's save, reusing the same validate-then-write
// discipline as the manual item grant so a prize can never produce a
// save the game would reject.
export async function grantPrizesToUser(userId: string, prizes: Prize[]): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { saveData: true } });
  if (!target) throw new Error("user not found");
  const base = target.saveData ? safeParseObject(target.saveData) : {};
  if (!base) throw new Error("save is corrupt");

  const save: Record<string, unknown> = { ...base };

  for (const p of prizes) {
    if (p.kind === "item") {
      const inv: Record<string, number> = {
        ...((save.inventory && typeof save.inventory === "object" && !Array.isArray(save.inventory))
          ? (save.inventory as Record<string, number>) : {}),
      };
      inv[p.itemId] = Math.min(999_999, (inv[p.itemId] ?? 0) + p.quantity);
      save.inventory = inv;
    } else if (p.kind === "money") {
      const cur = typeof save.money === "number" ? save.money : 0;
      save.money = Math.min(999_999_999, cur + p.amount);
    } else if (p.kind === "pokemon") {
      // Into the BOX, never the party: overwriting a party slot would be
      // a hostile way to receive a gift.
      const box = Array.isArray(save.box) ? [...(save.box as unknown[])] : [];
      const nextId = typeof save.nextPokemonId === "number" ? save.nextPokemonId : Date.now();
      // Re-id so the prize cannot collide with a mon the winner already
      // owns — an id clash would confuse trade ownership lookups, which
      // match by id.
      box.push({ ...p.mon, id: `g${nextId}` });
      save.box = box;
      save.nextPokemonId = nextId + 1;
    }
  }

  const v = validateSave(save);
  if (!v.ok) throw new Error(`prize would corrupt save: ${v.reason}`);

  const derived = computeAccountLevel(save);
  await prisma.user.update({
    where: { id: userId },
    data: {
      saveData: JSON.stringify(save),
      saveVersion: { increment: 1 },
      saveUpdatedAt: new Date(),
      accountLevel: derived.accountLevel,
      totalCaughtLevels: derived.totalCaughtLevels,
      pokedexCaughtCount: derived.pokedexCaughtCount,
    },
  });
}
