import type { GymLeader } from "../../../types";

export const eliteFour: GymLeader[] = [
  {
    id: "will",
    name: "Will",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "will-gen2",
    team: [{ speciesKey: "xatu", level: 40 }, { speciesKey: "jynx", level: 41 }, { speciesKey: "exeggutor", level: 41 }, { speciesKey: "slowbro", level: 41 }, { speciesKey: "xatu", level: 42 }],
  },
  {
    id: "kogaJohto",
    name: "Koga",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "koga-gen2",
    team: [{ speciesKey: "ariados", level: 40 }, { speciesKey: "venomoth", level: 41 }, { speciesKey: "forretress", level: 43 }, { speciesKey: "muk", level: 42 }, { speciesKey: "crobat", level: 44 }],
  },
  {
    id: "brunoJohto",
    name: "Bruno",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "bruno-gen2",
    team: [{ speciesKey: "hitmontop", level: 42 }, { speciesKey: "hitmonlee", level: 42 }, { speciesKey: "hitmonchan", level: 42 }, { speciesKey: "onix", level: 43 }, { speciesKey: "machamp", level: 46 }],
  },
  {
    id: "karen",
    name: "Karen",
    title: "Elite Four",
    locationKey: "blackthornCity",
    badgeName: "",
    badgeColor: "#7755aa",
    spriteKey: "karen-gen2",
    team: [{ speciesKey: "umbreon", level: 42 }, { speciesKey: "vileplume", level: 42 }, { speciesKey: "gengar", level: 45 }, { speciesKey: "murkrow", level: 44 }, { speciesKey: "houndoom", level: 47 }],
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
  team: [{ speciesKey: "gyarados", level: 44 }, { speciesKey: "dragonite", level: 47 }, { speciesKey: "charizard", level: 46 }, { speciesKey: "aerodactyl", level: 46 }, { speciesKey: "dragonite", level: 47 }, { speciesKey: "dragonite", level: 50 }],
};
