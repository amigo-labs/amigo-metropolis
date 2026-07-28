// SFX cue manifest (#27, assets.md §5). Cue name -> one original Future Cop
// `Cwav` sound, committed as a raw next to this file and processed into
// packages/client/public/sfx/<cue>.wav by `bun run gen:sfx`.
//
// The shipped default is the clean-room sfxr synth in
// packages/client/src/audio/presets.ts, and it stays the fallback for every cue
// forever: audio/engine.ts renders all presets synchronously at unlock and only
// then upgrades the cues listed here from their files. An empty manifest is
// therefore a valid, fully working state — which is exactly what it is right
// now — and a cue with no entry simply keeps its synth.
//
// WHY THIS IS EMPTY. The 348 unique extracted sounds carry no semantic labels.
// Nothing in the mission data says which one is "shot" and which is "capture":
// `Cshd` gives sound ids, loop flags and script ids, but the script table
// (`Cfun`) is undecoded, so the chain from an event to a sound is broken on the
// data side. Picking is a listening job for someone who knows the game
// (PLAN.md Phase 12, owner pass).
//
// The RE repo narrows it a long way and is the place to start:
// - extracted/handoff/sfx_pa_candidates.md — 46 of the 348 appear ONLY in the
//   six Precinct Assault containers, so those are the candidates for the
//   PA-specific cues (capture / claim / produce / purchase).
// - extracted/handoff/sfx_clap_tags.md + sfx_tagged/ — the same 46 auto-tagged
//   by an audio classifier (gunshot / explosion / impact / death / engine /
//   alarm / …). Machine guesses, not ground truth, but they order the audition:
//   the combat cues have 5-6 candidates each, the PA-specific ones almost none.
// - One cue is not recoverable at all: the base-intrusion alarm was wired in
//   `Cfun`, so `alarm` stays authored regardless (docs/specs/fcop-logic.md §8.6).
//
// TO FILL A CUE: drop the WAV under tools/generators/sfx/raw/fcop/, add an entry
// below, run `bun run gen:sfx`, and commit the generated output in the same
// change. Every `cue` must be a key of PRESETS — sfxFiles.test.ts enforces that,
// so a typo fails the suite instead of silently never loading.

export interface SfxCueSource {
  /** Source file in the RE repo, e.g. "extracted/sfx_v2/s004.wav". */
  readonly path: string;
  /** `src_id` from extracted/sfx_v2/manifest.json — the original Cwav id. */
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
}

export const SFX_CUES: readonly SfxCueSpec[] = [];
