// Dependency-free sfxr synthesizer (assets.md §5: "jsfxr presets committed as
// JSON (regenerable)"). This is a clean-room TypeScript write-up of DrPetter's
// sfxr algorithm (public-domain technique), not a copied port. It turns a small
// parameter set into a mono PCM buffer at runtime, so no binary .ogg needs to
// live in a public repo — the JSON presets ARE the committed, regenerable asset.
//
// NOTE: this is CLIENT code, not sim code — Math.sin and friends are fine here.
// The only randomness (the noise waveform) runs through a seeded mulberry32 so a
// given preset always renders the exact same buffer: reproducible across
// sessions (stable cache) and pinnable in a unit test.

/** sfxr parameters. All normalized 0..1 unless noted; ranges match sfxr's GUI. */
export interface SfxrParams {
  /** 0 square · 1 saw · 2 sine · 3 noise */
  waveType: number;

  // Envelope (seconds-ish; sfxr scales by ^2 * 100000 samples).
  envAttack: number;
  envSustain: number;
  envPunch: number; // extra volume at the start of sustain
  envDecay: number;

  // Frequency.
  baseFreq: number; // start pitch
  freqLimit: number; // cutoff pitch (0 = none)
  freqRamp: number; // per-sample slide (-1..1)
  freqDramp: number; // slide of the slide

  // Vibrato.
  vibStrength: number;
  vibSpeed: number;

  // Arpeggio (a single pitch jump partway through).
  arpMod: number; // -1..1
  arpSpeed: number;

  // Square duty (square wave only).
  duty: number;
  dutyRamp: number;

  // Retrigger.
  repeatSpeed: number;

  // Phaser.
  phaOffset: number; // -1..1
  phaRamp: number; // -1..1

  // Filters.
  lpfFreq: number; // 1 = off
  lpfRamp: number;
  lpfResonance: number;
  hpfFreq: number; // 0 = off
  hpfRamp: number;

  /** Master gain for the preset (pre user-volume). */
  soundVol: number;
}

export const DEFAULT_PARAMS: SfxrParams = {
  waveType: 0,
  envAttack: 0,
  envSustain: 0.3,
  envPunch: 0,
  envDecay: 0.4,
  baseFreq: 0.3,
  freqLimit: 0,
  freqRamp: 0,
  freqDramp: 0,
  vibStrength: 0,
  vibSpeed: 0,
  arpMod: 0,
  arpSpeed: 0,
  duty: 0,
  dutyRamp: 0,
  repeatSpeed: 0,
  phaOffset: 0,
  phaRamp: 0,
  lpfFreq: 1,
  lpfRamp: 0,
  lpfResonance: 0,
  hpfFreq: 0,
  hpfRamp: 0,
  soundVol: 0.5,
};

/** A preset is a sparse override of the defaults — this is what we commit. */
export type SfxrPreset = Partial<SfxrParams>;

export function resolveParams(preset: SfxrPreset): SfxrParams {
  return { ...DEFAULT_PARAMS, ...preset };
}

/** Seeded PRNG so the noise waveform (and thus the whole buffer) is stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;

/**
 * Renders a preset to a mono Float32Array in [-1, 1] at `sampleRate`. Runs once
 * per cue at unlock time (never in the frame loop), so allocations are fine.
 */
export function renderSfxr(
  preset: SfxrPreset,
  sampleRate = 44100,
  seed = 0x9e3779b9,
): Float32Array<ArrayBuffer> {
  const p = resolveParams(preset);
  const rnd = mulberry32(seed);
  const frnd = (range: number): number => rnd() * range;

  let fperiod = 100 / (p.baseFreq * p.baseFreq + 0.001);
  let period = Math.trunc(fperiod);
  const fmaxperiod = 100 / (p.freqLimit * p.freqLimit + 0.001);
  let fslide = 1 - p.freqRamp ** 3 * 0.01;
  const fdslide = -(p.freqDramp ** 3) * 0.000001;

  let squareDuty = 0.5 - p.duty * 0.5;
  const squareSlide = -p.dutyRamp * 0.00005;

  const arpMod = p.arpMod >= 0 ? 1 - p.arpMod ** 2 * 0.9 : 1 + p.arpMod ** 2 * 10;
  let arpTime = 0;
  let arpLimit = p.arpSpeed === 1 ? 0 : Math.trunc((1 - p.arpSpeed) ** 2 * 20000 + 32);

  // Low-pass / high-pass state.
  let fltp = 0;
  let fltdp = 0;
  let fltw = p.lpfFreq ** 3 * 0.1;
  const fltwD = 1 + p.lpfRamp * 0.0001;
  let fltdmp = (5 / (1 + p.lpfResonance ** 2 * 20)) * (0.01 + fltw);
  if (fltdmp > 0.8) fltdmp = 0.8;
  let fltphp = 0;
  let flthp = p.hpfFreq ** 2 * 0.1;
  const flthpD = 1 + p.hpfRamp * 0.0003;

  // Vibrato.
  let vibPhase = 0;
  const vibSpeed = p.vibSpeed ** 2 * 0.01;
  const vibAmp = p.vibStrength * 0.5;

  // Envelope.
  let envVol = 0;
  let envStage = 0;
  let envTime = 0;
  const envLength = [
    Math.trunc(p.envAttack ** 2 * 100000),
    Math.trunc(p.envSustain ** 2 * 100000),
    Math.trunc(p.envDecay ** 2 * 100000),
  ];

  // Phaser.
  let fphase = p.phaOffset ** 2 * 1020 * (p.phaOffset < 0 ? -1 : 1);
  const fdphase = p.phaRamp ** 2 * (p.phaRamp < 0 ? -1 : 1);
  let iphase = Math.abs(Math.trunc(fphase));
  let ipp = 0;
  const phaserBuffer = new Float32Array(1024);

  // Retrigger.
  let repTime = 0;
  const repLimit = p.repeatSpeed === 0 ? 0 : Math.trunc((1 - p.repeatSpeed) ** 2 * 20000 + 32);

  const noiseBuffer = new Float32Array(32);
  for (let i = 0; i < 32; i++) noiseBuffer[i] = frnd(2) - 1;

  let phase = 0;
  const out: number[] = [];
  const MAX_SAMPLES = sampleRate * 5; // hard cap: no preset should exceed 5 s

  for (let n = 0; n < MAX_SAMPLES; n++) {
    repTime++;
    if (repLimit !== 0 && repTime >= repLimit) {
      // Retrigger: reset the sliding start-of-sound state.
      repTime = 0;
      fperiod = 100 / (p.baseFreq * p.baseFreq + 0.001);
      period = Math.trunc(fperiod);
      fslide = 1 - p.freqRamp ** 3 * 0.01;
      squareDuty = 0.5 - p.duty * 0.5;
      arpTime = 0;
      arpLimit = p.arpSpeed === 1 ? 0 : Math.trunc((1 - p.arpSpeed) ** 2 * 20000 + 32);
    }

    // Arpeggio: one pitch jump.
    arpTime++;
    if (arpLimit !== 0 && arpTime >= arpLimit) {
      arpLimit = 0;
      fperiod *= arpMod;
    }

    // Frequency slide.
    fslide += fdslide;
    fperiod *= fslide;
    if (fperiod > fmaxperiod) {
      fperiod = fmaxperiod;
      if (p.freqLimit > 0) break; // frequency cutoff ends the sound
    }

    let rfperiod = fperiod;
    if (vibAmp > 0) {
      vibPhase += vibSpeed;
      rfperiod = fperiod * (1 + Math.sin(vibPhase) * vibAmp);
    }
    period = Math.trunc(rfperiod);
    if (period < 8) period = 8;

    squareDuty += squareSlide;
    if (squareDuty < 0) squareDuty = 0;
    if (squareDuty > 0.5) squareDuty = 0.5;

    // Envelope.
    envTime++;
    if (envTime > envLength[envStage]) {
      envTime = 0;
      envStage++;
      if (envStage === 3) break;
    }
    if (envStage === 0) {
      envVol = envLength[0] === 0 ? 1 : envTime / envLength[0];
    } else if (envStage === 1) {
      envVol = 1 + (envLength[1] === 0 ? 0 : (1 - envTime / envLength[1]) * 2 * p.envPunch);
    } else {
      envVol = envLength[2] === 0 ? 0 : 1 - envTime / envLength[2];
    }

    // Phaser sweep.
    fphase += fdphase;
    iphase = Math.abs(Math.trunc(fphase));
    if (iphase > 1023) iphase = 1023;

    if (flthpD !== 0) {
      flthp *= flthpD;
      if (flthp < 0.00001) flthp = 0.00001;
      if (flthp > 0.1) flthp = 0.1;
    }

    // 8x supersampling for a cleaner waveform.
    let ssample = 0;
    for (let si = 0; si < 8; si++) {
      phase++;
      if (phase >= period) {
        phase %= period;
        if (p.waveType === 3) {
          for (let i = 0; i < 32; i++) noiseBuffer[i] = frnd(2) - 1;
        }
      }
      const fp = phase / period;
      let sample: number;
      switch (p.waveType) {
        case 1: // saw
          sample = 1 - fp * 2;
          break;
        case 2: // sine
          sample = Math.sin(fp * TAU);
          break;
        case 3: // noise
          sample = noiseBuffer[Math.trunc(fp * 32) & 31];
          break;
        default: // square
          sample = fp < squareDuty ? 0.5 : -0.5;
          break;
      }

      // Low-pass.
      const pp = fltp;
      fltw *= fltwD;
      if (fltw < 0) fltw = 0;
      if (fltw > 0.1) fltw = 0.1;
      if (p.lpfFreq !== 1) {
        fltdp += (sample - fltp) * fltw;
        fltdp -= fltdp * fltdmp;
      } else {
        fltp = sample;
        fltdp = 0;
      }
      fltp += fltdp;
      // High-pass.
      fltphp += fltp - pp;
      fltphp -= fltphp * flthp;
      sample = fltphp;

      // Phaser.
      phaserBuffer[ipp & 1023] = sample;
      sample += phaserBuffer[(ipp - iphase + 1024) & 1023];
      ipp = (ipp + 1) & 1023;

      ssample += sample * envVol;
    }

    ssample = (ssample / 8) * 2 * p.soundVol;
    if (ssample > 1) ssample = 1;
    if (ssample < -1) ssample = -1;
    out.push(ssample);
  }

  return Float32Array.from(out);
}
