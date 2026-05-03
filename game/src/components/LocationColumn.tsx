import { InventoryRibbon } from "./InventoryRibbon";
import { MetaDock } from "./GlobalDock";
import { MiniChat } from "./MiniChat";

// Right column: account-level / social actions. Settings + Social dock at
// the top, live chat takes the rest of the space, profile strip at the
// bottom. (Town actions + Goal moved to the left party column.)
export function LocationColumn() {
  return (
    <div className="location-column">
      <MetaDock />
      <MiniChat />
      <InventoryRibbon />
    </div>
  );
}
