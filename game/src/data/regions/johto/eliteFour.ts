import type { GymLeader } from "../../../types";

// Johto Elite Four sit just above the gym ceiling (Clair ~75) and climb
// 75 → 82 across the four members, with Champion Lance topping out at 85 —
// matching the Kanto endgame band so beating Johto is a real capstone.
export const eliteFour: GymLeader[] = [
  {
    id: "will",
    name: "Will",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "will-gen2",
    team: [{ speciesKey: "xatu", level: 75 }, { speciesKey: "jynx", level: 76 }, { speciesKey: "exeggutor", level: 76 }, { speciesKey: "slowbro", level: 77 }, { speciesKey: "xatu", level: 78 }],
  },
  {
    id: "kogaJohto",
    name: "Koga",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "koga-gen2",
    team: [{ speciesKey: "ariados", level: 76 }, { speciesKey: "venomoth", level: 77 }, { speciesKey: "muk", level: 78 }, { speciesKey: "forretress", level: 79 }, { speciesKey: "crobat", level: 80 }],
  },
  {
    id: "brunoJohto",
    name: "Bruno",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "bruno-gen2",
    team: [{ speciesKey: "hitmontop", level: 78 }, { speciesKey: "hitmonlee", level: 78 }, { speciesKey: "hitmonchan", level: 78 }, { speciesKey: "onix", level: 79 }, { speciesKey: "machamp", level: 81 }],
  },
  {
    id: "karen",
    name: "Karen",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "karen-gen2",
    team: [{ speciesKey: "umbreon", level: 79 }, { speciesKey: "vileplume", level: 79 }, { speciesKey: "murkrow", level: 80 }, { speciesKey: "gengar", level: 81 }, { speciesKey: "houndoom", level: 82 }],
  },
];

export const champion: GymLeader = {
  id: "lanceJohto",
  name: "Lance",
  title: "Champion",
  locationKey: "blackthornCity",
  badgeName: "",
  badgeColor: "#dd6644",
  spriteKey: "lance-gen2",
  team: [{ speciesKey: "gyarados", level: 82 }, { speciesKey: "charizard", level: 83 }, { speciesKey: "aerodactyl", level: 83 }, { speciesKey: "dragonite", level: 84 }, { speciesKey: "dragonite", level: 84 }, { speciesKey: "dragonite", level: 85 }],
};
