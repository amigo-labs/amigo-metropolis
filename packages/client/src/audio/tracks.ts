// Music track manifest (assets.md §5). Files live in
// packages/client/public/music/ and are fetched at runtime, so adding one needs
// no rebuild. Licensing follows assets.md §2 — there is no license restriction on
// committed assets — with provenance recorded in CREDITS.md.

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
  { id: "track1", name: "Neon Coil", url: "/music/track1.mp3" },
  { id: "track2", name: "Rust Circuit", url: "/music/track2.mp3" },
  { id: "track3", name: "Slim Cover", url: "/music/track3.mp3" },
];

/** Coerces a persisted/unknown value to a valid selection ("off" fallback). */
export function parseMusicSelection(v: unknown): MusicSelection {
  for (const opt of MUSIC_OPTIONS) if (opt.id === v) return opt.id;
  return "off";
}
