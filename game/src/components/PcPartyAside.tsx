import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { useDragAndDrop } from "../hooks/useDrag";
import { PartyRow, PartyHealButton } from "./PartyColumn";
import { useT } from "../i18n/useT";
import "./pcParty.css";

// The PC's third column: your party, beside your box.
//
// ── WHY IT IS HERE ──────────────────────────────────────────────────
// The box and the party are two halves of one job. Before the hub, the PC
// was a full-screen tab and the party lived in a rail behind it, so
// "deposit this, withdraw that" meant closing the thing you were looking
// at, or dragging across a dialog edge onto a list you could not see.
//
// Putting the party in the dialog makes the drag a drag between two things
// that are both on screen — which is the only arrangement in which drag and
// drop is a feature rather than a trick you have to already know.
//
// ── WHY IT REUSES PartyRow ──────────────────────────────────────────
// Every rule about a party member — what it accepts on a drop, what its
// context menu offers, which releases the guards refuse, how a keyboard
// reaches any of it — is in that component. A second party list written to
// look the same would agree with this one exactly until the first change to
// any of those, and then quietly stop.

export function PcPartyAside() {
  const { state } = useGame();
  const t = useT();

  // The same live-state ref PartyColumn keeps, for the same reason: a row's
  // context-menu closures are frozen when the menu opens, and this component
  // outlives every row in it. See the note in PartyColumn.
  const liveRef = useRef(state);
  useEffect(() => { liveRef.current = state; });

  const party = state.party;
  const open = Math.max(0, 6 - party.length);

  return (
    <div className="pc-party">
      <header className="pc-party-head">
        <h3>{t("Party")}</h3>
        <span className="pc-party-count">{party.length}<span className="dim">/6</span></span>
        <PartyHealButton />
      </header>

      <ul className="pc-party-list" role="group" aria-label={t("Party")}>
        {party.map((p, idx) => (
          <PartyRow key={p.id} pokemon={p} index={idx} live={liveRef} />
        ))}
        {/* An empty slot is a real drop target, not a spacer. Without them a
            player with four Pokémon has nowhere in this column to drop a
            fifth: PartyRow is the only target, and there is no row to aim at.
            Rendered as slots rather than one big "drop here" zone so the
            column keeps its shape as the party grows and shrinks — six
            positions, always, and you can see how many are free. */}
        {Array.from({ length: open }, (_, i) => (
          <PartyOpenSlot key={`open-${i}`} n={party.length + i + 1} />
        ))}
      </ul>

      <p className="pc-party-hint">
        {t("Drag between the box and your party. Tap a Pokémon for details.")}
      </p>
    </div>
  );
}

/** A free party position. Accepts a box Pokémon and nothing else. */
function PartyOpenSlot({ n }: { n: number }) {
  const { state, dispatch } = useGame();
  const t = useT();
  const ref = useDragAndDrop<HTMLLIElement>({
    target: {
      // Box only. A party→party drop here would be a reorder onto a slot that
      // does not exist, and SWAP_PARTY has no meaning for an empty index —
      // accepting it would light the slot up and then do nothing.
      accept: (payload) => payload.kind === "box" && state.party.length < 6,
      onDrop: (payload) => {
        const boxIndex = (payload.data as { index: number }).index;
        dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex } });
      },
    },
  });
  return (
    <li ref={ref} className="pc-party-open" aria-label={`${t("Empty party slot")} ${n}`}>
      <span className="pc-party-open-n" aria-hidden>{n}</span>
      <span className="pc-party-open-text">{t("Empty")}</span>
    </li>
  );
}
