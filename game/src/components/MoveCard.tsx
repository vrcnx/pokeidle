import type { PokemonType } from "../types";
import { typeEffectiveness } from "../utils/typing";
import { useT } from "../i18n/useT";
import "./movesPanel.css";

// A move, as one card. Design by Pani.
//
// ── WHAT CHANGED, AND WHY IT READS BETTER ───────────────────────────
// The old tile was a solid block of the move's type colour with white text on
// top. That put the loudest thing on the card — a full-bleed saturated fill —
// on the least useful piece of information, and it did it four times at once,
// so a moveset was four competing colour fields and you had to read every
// word to find anything. It also made contrast a lottery: white on Electric's
// #f8d030 is 1.7:1.
//
// Pani's version keeps the type colour as an EDGE. The card surface goes back
// to the panel colour every other card in the game uses, the type is a chip
// you can read, and the numbers get to be the brightest thing on a card whose
// entire job is comparing numbers.
//
// ── WHY THIS IS ONE COMPONENT AND NOT TWO ───────────────────────────
// PvpArena used to re-emit this markup by hand, with a comment explaining that
// it copies `.moves-panel` / `.move-slot` "so a PvP move tile is visually the
// same object as an idle one". Copied markup is a promise you have to keep by
// remembering, and it had already drifted — the PvP tile had quietly lost the
// category icon. Sharing the component is the same intent, enforced.

export const TYPE_COLOR: Record<PokemonType, string> = {
  Normal:   "#a8a878",
  Fire:     "#f08030",
  Water:    "#6890f0",
  Electric: "#f8d030",
  Grass:    "#78c850",
  Ice:      "#98d8d8",
  Fighting: "#c03028",
  Poison:   "#a040a0",
  Ground:   "#e0c068",
  Flying:   "#a890f0",
  Psychic:  "#f85888",
  Bug:      "#a8b820",
  Rock:     "#b8a038",
  Ghost:    "#705898",
  Dragon:   "#7038f8",
  Dark:     "#705848",
  Steel:    "#b8b8d0",
  Fairy:    "#ee99ac",
};

export const CATEGORY_ICON: Record<string, string> = {
  physical: "✴",
  special:  "◎",
  status:   "☯",
};

/**
 * The effectiveness badge for a move against a defender's actual typing.
 *
 * Lives here rather than in either panel because both were computing it, from
 * two copies of the same ladder, and a rule change would have had to be made
 * in both. Returns null for the cases with nothing worth saying — a status
 * move, no defender, or plain neutral damage — so three cards out of four are
 * not carrying a "1×" chip that means "normal".
 */
export function effChip(
  moveType: PokemonType,
  category: string | undefined,
  defTypes: PokemonType[],
): { label: string; cls: string } | null {
  if (category === "status" || defTypes.length === 0) return null;
  const mult = typeEffectiveness(moveType, defTypes);
  const cls = mult === 0 ? "mv-eff--immune"
    : mult >= 2 ? "mv-eff--super"
    : mult <= 0.5 ? "mv-eff--resist"
    : "mv-eff--neutral";
  const label = mult === 0 ? "Immune"
    : mult >= 4 ? "4×"
    : mult >= 2 ? "2×"
    : mult === 0.25 ? "¼×"
    : mult <= 0.5 ? "½×"
    : "";
  return label ? { label, cls } : null;
}

export interface MoveCardProps {
  name: string;
  type: PokemonType | null;
  category: string;
  power: number | null;
  accuracy: number | null;
  pp: number;
  maxPp: number;
  /** Type-effectiveness against the current opponent, when there is one and
   *  the move is the kind that has one. Null hides the chip entirely rather
   *  than showing a neutral "1×", which is noise on three cards out of four. */
  eff: { label: string; cls: string } | null;
  disabled?: boolean;
  pickable?: boolean;
  /** One line on what the move does, from src/data/moveDescriptions.ts.
   *  Shown only when the card is wide enough to hold it — see movesPanel.css. */
  description?: string;
  /** The last-resort attack, not a move. Drawn colourless and dashed so it
   *  never reads as a fifth option worth choosing. */
  struggle?: boolean;
  title?: string;
  onClick?: () => void;
}

export function MoveCard({
  name, type, category, power, accuracy, pp, maxPp,
  eff, disabled, pickable, struggle, description, title, onClick,
}: MoveCardProps) {
  const t = useT();
  const color = (type && TYPE_COLOR[type]) || "#888";
  const icon = CATEGORY_ICON[category] ?? "✴";
  const hasPP = pp > 0;
  // A quarter of the bar, floored at one: "2 left" matters on a 8 PP move and
  // does not on a 40 PP one.
  const ppLow = hasPP && pp <= Math.max(1, Math.ceil(maxPp * 0.25));

  return (
    <button
      type="button"
      className={[
        "mv-card",
        eff?.cls ?? "",
        disabled ? "mv-card--out" : "",
        pickable ? "mv-card--pickable" : "",
        struggle ? "mv-card--struggle" : "",
      ].filter(Boolean).join(" ")}
      // The one thing the card takes from the move rather than from the
      // stylesheet. Everything else derives from it, so a card is themed by
      // setting a single custom property.
      style={{ ["--mv-type" as string]: color }}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      <span className="mv-head">
        <span className="mv-cat-dot" aria-hidden>{icon}</span>
        <span className="mv-name">{name}</span>
        {eff && <span className="mv-eff">{eff.label}</span>}
        {struggle ? (
          <span className="mv-pp">{t("last resort")}</span>
        ) : (
          <span className={`mv-pp ${ppLow ? "is-low" : ""} ${hasPP ? "" : "is-out"}`}>
            <span className="mv-pp-label">{t("PP")}</span> {pp}/{maxPp}
          </span>
        )}
      </span>

      {description && <span className="mv-desc">{description}</span>}

      <span className="mv-meta">
        <span className="mv-type">{type ?? "?"}</span>
        <span className="mv-stat">
          <span className="mv-stat-label">{t("POW")}</span> {power || "—"}
        </span>
        <span className="mv-stat">
          <span className="mv-stat-label">{t("ACC")}</span> {accuracy ? `${accuracy}%` : "—"}
        </span>
        <span className="mv-stat mv-stat--cat">
          <span aria-hidden>{icon}</span> {category}
        </span>
      </span>
    </button>
  );
}
