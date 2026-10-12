// SFX cue manifest (#27, assets.md §5). Cue name -> one original Future Cop
// sound, committed as a raw next to this file and processed into
// packages/client/public/sfx/<cue>.wav by `bun run gen:sfx`.
//
// The shipped default is the clean-room sfxr synth in
// packages/client/src/audio/presets.ts, and it stays the fallback for every cue
// forever: audio/engine.ts renders all presets synchronously at unlock and only
// then upgrades the cues listed here from their files. A cue with no entry
// simply keeps its synth.
//
// WHAT IS FILLED, AND WHY THOSE. The original's alert lines are bound now. This
// file used to say it was empty "on purpose" because no sound op in the `Cfun`
// mission scripts was proven; that is obsolete. Script ops 0x0c (queue) and 0x0d
// (interrupt) play SPEECH lines, and the decompiled scripts of all six PA arenas
// say which line each event plays (docs/specs/fcop-re/ai-and-rules.md §6, the
// RE repo's docs/behavior/precinct-assault.md "Voice cues"). Speech id N is
// `extracted/voice/wav/v{N+1:03d}.wav`, verified for all 86 ids in all six
// arenas. The voice cues below (`vo_*`) are those lines, for the events the sim
// emits (fcop-fidelity.md R15). What each line SAYS is not transcribed; the
// meaning is the event that plays it. The lines come in pairs per side, and are
// played by side (the slot the original's script names), not from the local
// player's point of view.
//
// STILL OPEN: the ordinary sound effects. The 348 unique extracted sounds carry no
// semantic labels and their binding (`Cshd` sound events -> script) is not read,
// so which one is "shot" is still a listening job (PLAN.md Phase 12, owner
// pass). The RE repo narrows it — every path below is relative to a checkout of
// `amigo-labs/fcop-reverse-engineering`, NOT to this repo:
// - `extracted/findings/sfx_pa_candidates.md` — 46 of the 348 appear ONLY in the
//   six Precinct Assault containers (capture / claim / purchase candidates).
// - `docs/sfx_index.md` § "Precinct Assault / MP family" — the PA bank's
//   `script_id`s 70-90 are stable across all six arenas.
// - `extracted/findings/sfx_manual_class.json` — 118 sounds labelled by ear,
//   which beat the CLAP auto-tags in `extracted/findings/sfx_clap_tags.md`.
// - The purchase pads' accept/deny sounds and the pickup sound are pending-sound
//   slot values 63 / 73 / 83 (ai-and-rules.md §6), a lead for those three cues.
//
// TO FILL A CUE: drop the WAV under tools/generators/sfx/raw/fcop/, add an entry
// below, run `bun run gen:sfx`, and commit the generated output in the same
// change. Every `cue` must be a key of PRESETS — sfxFiles.test.ts enforces that,
// so a typo fails the suite instead of silently never loading.

export interface SfxCueSource {
  /** Source file in the RE repo, e.g. "extracted/sfx_v2/s004.wav". */
  readonly path: string;
  /**
   * The original's id: for a sound effect the `src_id` from
   * extracted/sfx_v2/manifest.json (the Cwav id); for a voice line its speech id
   * N (the file is v{N+1:03d}.wav).
   */
  readonly srcId: number;
  readonly author: string;
  readonly license: string;
}

export interface SfxCueSpec {
  /** Cue name; must exist in packages/client/src/audio/presets.ts PRESETS. */
  readonly cue: string;
  /** Raw WAV, relative to tools/generators/sfx/raw/. */
  readonly raw: string;
  readonly source: SfxCueSource;
  /** Seconds to drop from the head (silence / a click). Default 0. */
  readonly trimStart?: number;
  /** Seconds to drop from the tail. Default 0. */
  readonly trimEnd?: number;
  /**
   * Extra linear trim applied AFTER the -3 dBFS peak normalisation, for a cue
   * that is correct but too loud against the others. 1 = leave it.
   */
  readonly gain?: number;
  /** Output bit depth. Default 16; 8 for a source that is 8-bit already. */
  readonly bits?: 8 | 16;
}

/** One original voice line: speech id `id`, the bank shared by all six PA arenas. */
function voice(cue: string, id: number): SfxCueSpec {
  const file = `v${String(id + 1).padStart(3, "0")}.wav`;
  return {
    cue,
    raw: `fcop/voice/${file}`,
    source: {
      path: `extracted/voice/wav/${file}`,
      srcId: id,
      author: "Electronic Arts / EA Canada (Future Cop: L.A.P.D., 1998)",
      license: "original game asset, used as permitted by docs/specs/assets.md §2",
    },
    // u8 22050 Hz mono at the source: 8-bit output keeps every file under 55 KB.
    bits: 8,
  };
}

export const SFX_CUES: readonly SfxCueSpec[] = [
  // A base turret is destroyed: slot 0's (id 0) / slot 1's (id 1).
  voice("vo_turret_lost_0", 0),
  voice("vo_turret_lost_1", 1),
  // Intrusion: an enemy tank, Dreadnought or avatar entered slot 0's (2) / slot
  // 1's (3) base zone; the sim holds each base quiet for 8.3 s after.
  voice("vo_intrusion_0", 2),
  voice("vo_intrusion_1", 3),
  // A base turret is under fire: slot 0's (4) / slot 1's (5); 10 s per side.
  voice("vo_turret_fire_0", 4),
  voice("vo_turret_fire_1", 5),
  // A gate is reached: slot 1's (6, slot 0 wins) / slot 0's (19, slot 0 loses).
  voice("vo_gate_1", 6),
  voice("vo_gate_0", 19),
];
