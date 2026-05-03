import { useEffect, useRef, useState } from "react";

// Returns a counter that bumps every time `hp` decreases for the SAME
// Pokemon (identified by `id`). Heals don't trigger; new encounters reset
// the counter to 0 so the pokeball-enter animation isn't masked by a
// phantom "damage" caused by HP-comparison across different Pokemon.
export function useDamageFlash(id: string | undefined, hp: number | undefined): number {
  const prevRef = useRef<{ id?: string; hp?: number }>({});
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (id === undefined || hp === undefined) {
      prevRef.current = {};
      setBump(0);
      return;
    }
    const prev = prevRef.current;
    if (prev.id !== id) {
      // new Pokemon entered the slot — reset bump and snapshot
      prevRef.current = { id, hp };
      setBump(0);
      return;
    }
    if (prev.hp !== undefined && hp < prev.hp) {
      setBump((b) => b + 1);
    }
    prevRef.current = { id, hp };
  }, [id, hp]);
  return bump;
}
