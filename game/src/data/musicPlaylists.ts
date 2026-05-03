// Background-music playlists, served from /public/music/<category>/.
// Each entry is a path relative to the public root. To add a track:
//   1. Drop the file into the matching public/music/<category>/ folder
//   2. Append the filename to the array below
// Vite serves /public/* as-is, so no import / hash step is needed.
//
// Categories:
//   challenge — boss battles (gym leaders, E4, champion, legendary raids)
//   city      — towns, marts, PC, indoor / built-up areas
//   routes    — overworld routes, caves, mountains, the open world

export const musicPlaylists: Record<MusicCategory, string[]> = {
  challenge: [
    // Folder is empty as of writing — drop tracks in
    // public/music/challenge/ and add their names here.
  ],
  city: [
    "city (1).mp3",
    "city (3).mp3",
    "city (4).mp3",
    "city (5).mp3",
    "city (6).mp3",
  ],
  routes: [
    "Pastel Paths.mp3",
    "Pastel Paths (1).mp3",
    "Pastel Route.mp3",
    "routes (1).mp3",
    "routes (2).mp3",
    "routes (3).mp3",
  ],
};

export type MusicCategory = "challenge" | "city" | "routes";

export function trackUrl(category: MusicCategory, filename: string): string {
  return `/music/${category}/${encodeURIComponent(filename)}`;
}
