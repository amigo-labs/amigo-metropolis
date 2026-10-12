// Committed sfxr presets — the regenerable JSON asset called for in assets.md
// §5. One preset per sim event cue (names match audio.ts / the EV_* buffer).
// Values are the sparse override of DEFAULT_PARAMS; tweak freely, then the synth
// re-renders. Feel-tuning against real playback stays an open pass (like the
// hover/difficulty passes) — the deliverable here is the wired pipeline.

import type { SfxrPreset } from "./sfxr";

/**
 * Stand-in for an original voice line (the `vo_*` cues below) until its file has
 * loaded: a short two-tone radio chirp, so an alert is never silent. The files
 * themselves are the original's speech (tools/generators/sfx/manifest.ts).
 */
const RADIO: SfxrPreset = {
  waveType: 0,
  baseFreq: 0.4,
  envSustain: 0.08,
  envDecay: 0.18,
  arpMod: 0.3,
  arpSpeed: 0.45,
  duty: 0.5,
  lpfFreq: 0.75,
  soundVol: 0.3,
};

/** Enemy in your base (see `alarm` below). */
const ALARM: SfxrPreset = {
  waveType: 1,
  baseFreq: 0.24,
  envAttack: 0.02,
  envSustain: 0.5,
  envDecay: 0.45,
  arpMod: -0.35,
  arpSpeed: 0.35,
  repeatSpeed: 0.55,
  vibStrength: 0.12,
  vibSpeed: 0.22,
  lpfFreq: 0.6,
  soundVol: 0.55,
};

export const PRESETS: Record<string, SfxrPreset> = {
  // Primary weapon: short descending zap.
  shot: {
    waveType: 0,
    baseFreq: 0.52,
    freqRamp: -0.34,
    envSustain: 0.04,
    envDecay: 0.16,
    duty: 0.35,
    lpfFreq: 0.9,
    soundVol: 0.28,
  },
  // Heavy / AoE detonation: punchy filtered noise.
  explosion: {
    waveType: 3,
    baseFreq: 0.22,
    freqRamp: -0.12,
    envSustain: 0.22,
    envPunch: 0.5,
    envDecay: 0.42,
    lpfFreq: 0.55,
    lpfRamp: -0.05,
    soundVol: 0.5,
  },
  // Something took damage: brief gritty tick.
  hit: {
    waveType: 3,
    baseFreq: 0.42,
    freqRamp: -0.22,
    envSustain: 0.03,
    envDecay: 0.14,
    lpfFreq: 0.8,
    soundVol: 0.32,
  },
  // A unit/avatar died: low downward boom.
  death: {
    waveType: 3,
    baseFreq: 0.3,
    freqRamp: -0.28,
    envSustain: 0.16,
    envPunch: 0.45,
    envDecay: 0.5,
    lpfFreq: 0.4,
    soundVol: 0.55,
  },
  // Avatar respawn: rising re-materialize sweep.
  respawn: {
    waveType: 2,
    baseFreq: 0.3,
    freqRamp: 0.32,
    envAttack: 0.05,
    envSustain: 0.12,
    envDecay: 0.28,
    soundVol: 0.4,
  },
  // Console purchase confirmed: two-note coin blip.
  purchase: {
    waveType: 0,
    baseFreq: 0.5,
    envSustain: 0.06,
    envDecay: 0.22,
    arpMod: 0.45,
    arpSpeed: 0.55,
    duty: 0.4,
    soundVol: 0.34,
  },
  // Purchase refused (points short, 20 alive, a claim under 30): a low falling
  // buzz, the counterpart of the purchase blip.
  refuse: {
    waveType: 1,
    baseFreq: 0.26,
    freqRamp: -0.18,
    envSustain: 0.08,
    envDecay: 0.18,
    duty: 0.5,
    lpfFreq: 0.6,
    soundVol: 0.3,
  },
  // Gate breached — match-deciding fanfare: longer, brighter, vibrato tail.
  breach: {
    waveType: 1,
    baseFreq: 0.4,
    freqRamp: 0.12,
    envAttack: 0.02,
    envSustain: 0.45,
    envPunch: 0.4,
    envDecay: 0.6,
    arpMod: 0.35,
    arpSpeed: 0.7,
    vibStrength: 0.25,
    vibSpeed: 0.4,
    lpfFreq: 0.85,
    soundVol: 0.6,
  },
  // Neutral turret captured: short ascending confirm.
  capture: {
    waveType: 0,
    baseFreq: 0.42,
    freqRamp: 0.1,
    envSustain: 0.08,
    envDecay: 0.26,
    arpMod: 0.3,
    arpSpeed: 0.6,
    soundVol: 0.36,
  },
  // Outpost claimed: warmer two-note chime.
  claim: {
    waveType: 2,
    baseFreq: 0.36,
    envAttack: 0.02,
    envSustain: 0.12,
    envDecay: 0.34,
    arpMod: 0.5,
    arpSpeed: 0.5,
    soundVol: 0.42,
  },
  // --- Precinct Assault cues (rules.md §9) ---------------------------------
  // Enemy in your base: a slow two-tone klaxon. Long and low so it reads over a
  // firefight. Since the alert lines were bound (fcop-fidelity.md R15) the event
  // speaks the original's intrusion line instead (vo_intrusion_*, below); this
  // klaxon is that cue's synth stand-in and the settings preview.
  alarm: ALARM,
  // --- The original's alert lines (fcop-fidelity.md R15) --------------------
  // Played by side: `_0` is the line the original speaks for slot 0's base, `_1`
  // for slot 1's (fcop-re/ai-and-rules.md §6). Each is upgraded to the original
  // speech file by audio/sfxFiles.generated.ts; these are the synth stand-ins.
  vo_intrusion_0: ALARM,
  vo_intrusion_1: ALARM,
  vo_turret_fire_0: RADIO,
  vo_turret_fire_1: RADIO,
  vo_turret_lost_0: RADIO,
  vo_turret_lost_1: RADIO,
  vo_gate_0: RADIO,
  vo_gate_1: RADIO,
  // Power-up collected: bright rising triad, clearly a reward.
  pickup: {
    waveType: 2,
    baseFreq: 0.46,
    freqRamp: 0.18,
    envSustain: 0.06,
    envDecay: 0.24,
    arpMod: 0.5,
    arpSpeed: 0.62,
    soundVol: 0.34,
  },
  // Walker <-> hover change: an electrical discharge with a servo under it.
  //
  // Noise rather than a tone, because the arcs it plays over are noise; the
  // rising ramp is the servo committing and the vibrato is the crackle. Long
  // decay on purpose — it has the sim's whole transform lock to fill (1.37 s
  // since the original's 41 ticks; it was tuned against 0.8 s),
  // and a short blip under three quarters of a second of visible sparking reads
  // as the sound having failed.
  transform: {
    waveType: 3,
    baseFreq: 0.28,
    freqRamp: 0.14,
    freqDramp: -0.12,
    envAttack: 0.03,
    envSustain: 0.2,
    envPunch: 0.35,
    envDecay: 0.5,
    vibStrength: 0.35,
    vibSpeed: 0.6,
    lpfFreq: 0.7,
    lpfResonance: 0.3,
    soundVol: 0.36,
  },
};

/** Cues that repeat rapidly get a little random detune so they don't machine-gun. */
export const DETUNE_CUES: ReadonlySet<string> = new Set(["shot", "hit"]);

/**
 * Cues that always play centred, whatever the event's position.
 *
 * These are messages to the player rather than sounds in the world: a base alarm
 * that pans quietly to one side is exactly the wrong behaviour, and purchases /
 * claims / breach are UI feedback for an action the player just took.
 */
export const GLOBAL_CUES: ReadonlySet<string> = new Set([
  "alarm",
  "purchase",
  "refuse",
  "claim",
  "breach",
  "vo_intrusion_0",
  "vo_intrusion_1",
  "vo_turret_fire_0",
  "vo_turret_fire_1",
  "vo_turret_lost_0",
  "vo_turret_lost_1",
  "vo_gate_0",
  "vo_gate_1",
]);
