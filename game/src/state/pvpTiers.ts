// PvP tier bands — shared between the trainer-card hero ring and any
// future server-side surfaces (rank-up emails, leaderboards, etc.).
// Single source of truth so client/server don't drift.

export interface PvpTier {
  id: "bronze" | "silver" | "gold" | "platinum" | "diamond";
  name: string;
  floor: number;
  ceil: number;        // exclusive — next tier's floor
  color: string;       // CSS colour for the rating ring
  glow: string;        // soft glow colour for tier badge
}

export const PVP_TIERS: PvpTier[] = [
  { id: "bronze",   name: "Bronze",   floor: 0,    ceil: 1100, color: "#b07a48", glow: "rgba(176, 122, 72, 0.35)" },
  { id: "silver",   name: "Silver",   floor: 1100, ceil: 1300, color: "#cfd2d8", glow: "rgba(207, 210, 216, 0.35)" },
  { id: "gold",     name: "Gold",     floor: 1300, ceil: 1500, color: "#fbbf24", glow: "rgba(251, 191, 36, 0.35)" },
  { id: "platinum", name: "Platinum", floor: 1500, ceil: 1700, color: "#7fd1c4", glow: "rgba(127, 209, 196, 0.35)" },
  { id: "diamond",  name: "Diamond",  floor: 1700, ceil: 3000, color: "#a78bff", glow: "rgba(167, 139, 255, 0.35)" },
];

export function tierFor(rating: number): PvpTier {
  for (const t of PVP_TIERS) {
    if (rating >= t.floor && rating < t.ceil) return t;
  }
  return PVP_TIERS[PVP_TIERS.length - 1];
}

// Progress 0..1 within the current tier band.
export function tierProgress(rating: number): number {
  const t = tierFor(rating);
  return Math.max(0, Math.min(1, (rating - t.floor) / (t.ceil - t.floor)));
}

// Points until the next tier, or null at top tier.
export function ratingToNextTier(rating: number): { next: PvpTier; gap: number } | null {
  const t = tierFor(rating);
  const idx = PVP_TIERS.indexOf(t);
  if (idx < 0 || idx === PVP_TIERS.length - 1) return null;
  const next = PVP_TIERS[idx + 1];
  return { next, gap: next.floor - rating };
}
