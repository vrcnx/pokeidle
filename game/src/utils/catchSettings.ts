import type { CatchMode, CatchSettings, GameState } from "../types";

export function resolveCatchSettings(
  state: GameState,
  routeKey: string,
  speciesKey: string
): CatchSettings {
  return (
    state.catchSettings[routeKey]?.[speciesKey] ?? state.globalCatchDefaults
  );
}

/**
 * THE auto-catch mode list, shared by both places the player picks one:
 * CatchSettingsModal (radio rows) and CatchSettingsPanel (a select).
 *
 * They each carried their own copy, with labels that had already drifted
 * ("Only shinies" vs "Only if shiny"). That is not a cosmetic problem: adding
 * a mode to one list and not the other ships a setting half the UI cannot
 * reach or display, and this list is being ADDED TO right now.
 *
 * `hint` is the sentence that disambiguates the option. It exists because
 * "Not caught yet" — one option covering both readings — became a bug report
 * (br_cb4d83f3ada30b1ec4) as soon as the Pokédex began distinguishing
 * "registered" from "currently owned". The two successor options are a coin
 * flip from their names alone, so the names are not left to carry it.
 *
 * `not_owned` is deliberately listed before `pokedex_new`: it is the reading
 * most players asking for "not caught yet" actually wanted.
 */
export const CATCH_MODE_OPTIONS: {
  value: CatchMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "always",
    label: "Always catch",
    hint: "Every wild encounter.",
  },
  {
    value: "shiny_only",
    label: "Only shinies",
    hint: "Shiny encounters only.",
  },
  {
    value: "level_threshold",
    label: "Above level",
    hint: "Only at or above the level you set.",
  },
  {
    value: "not_owned",
    label: "Not owned",
    hint: "Anything you aren't holding right now, in your party or PC. Release, trade or evolve away your last one and the species counts again.",
  },
  {
    value: "pokedex_new",
    label: "Not registered",
    hint: "Only species your Pokédex has never registered. Registration is permanent, so each species triggers this at most once, ever.",
  },
];

export function catchModeHint(mode: CatchMode): string {
  return CATCH_MODE_OPTIONS.find((o) => o.value === mode)?.hint ?? "";
}
