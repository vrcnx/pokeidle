// Daily login rewards + streak. Server-authoritative: the streak and the
// once-per-day gate are decided against the server's UTC clock, so moving
// the client clock can't farm rewards. The reward itself is small and is
// applied to the save by the client (protected by the unconditional local
// save), while the server owns the anti-abuse bits.

export interface DailyReward {
  money: number;
  items: { itemId: string; quantity: number }[];
  label: string;
}

// A 7-day cycle. Only money + Poké Balls (all confirmed item ids) so a
// reward can never reference an item that doesn't exist. Day 7 is the
// milestone. Beyond day 7 the cycle repeats with a mild multiplier.
const CYCLE: DailyReward[] = [
  { money: 500,  items: [], label: "$500" },
  { money: 0,    items: [{ itemId: "pokeball", quantity: 5 }], label: "5× Poké Ball" },
  { money: 800,  items: [], label: "$800" },
  { money: 0,    items: [{ itemId: "greatball", quantity: 3 }], label: "3× Great Ball" },
  { money: 1200, items: [], label: "$1,200" },
  { money: 0,    items: [{ itemId: "greatball", quantity: 5 }], label: "5× Great Ball" },
  { money: 2500, items: [{ itemId: "ultraball", quantity: 3 }], label: "$2,500 + 3× Ultra Ball" },
];

// The reward for the Nth consecutive day (1-based). Money scales up a little
// each completed week, capped at 2× after four weeks, so a long streak stays
// worth keeping without ballooning.
export function rewardForStreak(streak: number): DailyReward {
  const day = Math.max(1, streak);
  const base = CYCLE[(day - 1) % 7];
  const weeks = Math.floor((day - 1) / 7);
  const mult = 1 + Math.min(weeks * 0.25, 1);
  const money = Math.round(base.money * mult);
  const label = base.money > 0 && mult > 1
    ? base.label.replace(/\$[\d,]+/, `$${money.toLocaleString()}`)
    : base.label;
  return { money, items: base.items, label };
}

// UTC-midnight instant for a given time.
export function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export interface DailyStatus {
  claimedToday: boolean;
  streak: number;              // current streak (BEFORE today's claim if unclaimed)
  longestStreak: number;
  // The streak the player will be on AFTER claiming today (streak+1, or 1 if
  // a day was missed). Drives the "claim to reach day N" preview.
  streakIfClaimed: number;
  todayReward: DailyReward;    // what claiming now would grant
  nextClaimInMs: number;       // 0 if claimable now, else ms until UTC midnight
}

// Pure status computation from the persisted fields + now.
export function computeStatus(
  fields: { dailyStreak: number; longestDailyStreak: number; lastDailyClaimAt: Date | null },
  now: Date,
): DailyStatus {
  const todayStart = utcMidnight(now);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const last = fields.lastDailyClaimAt;

  const claimedToday = !!last && last.getTime() >= todayStart.getTime();
  // If they claimed yesterday, today continues the streak; otherwise it
  // resets to 1. If they already claimed today, the current streak stands.
  const streakIfClaimed = claimedToday
    ? fields.dailyStreak
    : (last && last.getTime() >= yesterdayStart.getTime() ? fields.dailyStreak + 1 : 1);

  const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
  return {
    claimedToday,
    streak: fields.dailyStreak,
    longestStreak: fields.longestDailyStreak,
    streakIfClaimed,
    todayReward: rewardForStreak(claimedToday ? fields.dailyStreak : streakIfClaimed),
    nextClaimInMs: claimedToday ? Math.max(0, tomorrowStart.getTime() - now.getTime()) : 0,
  };
}
