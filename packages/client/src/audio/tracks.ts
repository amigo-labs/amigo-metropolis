// Music track manifest (assets.md §5: "CC0/CC-BY tracks for v1"). The file
// slots are placeholders — drop real mp3s into packages/client/public/music/
// (they are fetched at runtime, no rebuild needed). The repo is public: any
// committed track MUST be CC0 or CC-BY, with a CREDITS.md row naming source,
// author, and license, and the display name here updated to the track title.

export type MusicSelection = "off" | "synth" | "track1" | "track2" | "track3";

export interface MusicOption {
  readonly id: MusicSelection;
  /** Shown in the menu's Sound drawer. */
  readonly name: string;
  /** Absent for the non-file options ("off", the procedural "synth" loop). */
  readonly url?: string;
}

export const MUSIC_OPTIONS: readonly MusicOption[] = [
  { id: "off", name: "Off" },
  { id: "synth", name: "Ambient Synth" },
  { id: "track1", name: "Track 1", url: "/music/track1.mp3" },
  { id: "track2", name: "Track 2", url: "/music/track2.mp3" },
  { id: "track3", name: "Track 3", url: "/music/track3.mp3" },
];

/** Coerces a persisted/unknown value to a valid selection ("off" fallback). */
export function parseMusicSelection(v: unknown): MusicSelection {
  for (const opt of MUSIC_OPTIONS) if (opt.id === v) return opt.id;
  return "off";
}
