import { InventoryRibbon } from "./InventoryRibbon";
import { MetaDock } from "./GlobalDock";
import { MiniChat } from "./MiniChat";
import { UnlockHint } from "./ContextPanel";

// Right column: account-level / social actions. Settings + Social dock
// at the top, Next-Goal tracker, then live chat takes the rest of the
// space, profile strip at the bottom. Goal sits above chat so the
// player's eye lands on progress info before the chatter.
export function LocationColumn() {
  return (
    <div className="location-column">
      <MetaDock />
      <UnlockHint />
      <MiniChat />
      <InventoryRibbon />
    </div>
  );
}
