// Committed sfxr presets — the regenerable JSON asset called for in assets.md
// §5. One preset per sim event cue (names match audio.ts / the EV_* buffer).
// Values are the sparse override of DEFAULT_PARAMS; tweak freely, then the synth
// re-renders. Feel-tuning against real playback stays an open pass (like the
// hover/difficulty passes) — the deliverable here is the wired pipeline.

import type { SfxrPreset } from "./sfxr";

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
};

/** Cues that repeat rapidly get a little random detune so they don't machine-gun. */
export const DETUNE_CUES: ReadonlySet<string> = new Set(["shot", "hit"]);
