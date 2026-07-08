// Procedural music loop — the "CC0 music loop" of PLAN Phase 7, self-authored
// (no external track), so it is CC0 by us (see CREDITS.md). A slow minor-key pad
// + soft arpeggio rendered once to a seamlessly-looping buffer. Deliberately
// low-key and off by default (musicVolume 0) — it is ambience, not a headliner.
// CLIENT code: Math.sin/pow are fine here.

const BASE = 55; // A1, Hz — everything is an interval above this
const semis = (s: number): number => BASE * 2 ** (s / 12);

// Four-bar loop, natural-minor color. Each entry: [pad chord semitones], arp run.
const A_MIN = [12, 24, 27, 31]; // A minor triad spread
const F_MAJ = [8, 20, 24, 27]; // F major
const C_MAJ = [15, 27, 31, 34]; // C major
const G_MAJ = [10, 22, 26, 29]; // G major
const PROGRESSION = [A_MIN, F_MAJ, C_MAJ, G_MAJ];

const BPM = 76;
const BEATS_PER_BAR = 4;

/** Soft attack/release envelope, cosine-shaped edges, in [0,1]. */
function env(t: number, dur: number, attack: number, release: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < attack) return 0.5 - 0.5 * Math.cos((t / attack) * Math.PI);
  const rStart = dur - release;
  if (t > rStart) return 0.5 - 0.5 * Math.cos(((dur - t) / release) * Math.PI);
  return 1;
}

/**
 * Renders the loop to a mono Float32Array. Notes whose tails run past the loop
 * end wrap back to the start, so the buffer loops with no click. Runs once at
 * audio unlock — allocation cost is irrelevant.
 */
export function renderMusicLoop(sampleRate = 44100): Float32Array<ArrayBuffer> {
  const beat = 60 / BPM;
  const barDur = beat * BEATS_PER_BAR;
  const loopDur = barDur * PROGRESSION.length;
  const n = Math.round(loopDur * sampleRate);
  const buf = new Float32Array(n);

  const add = (
    startSec: number,
    freq: number,
    dur: number,
    gain: number,
    atk: number,
    rel: number,
  ): void => {
    const start = Math.round(startSec * sampleRate);
    const len = Math.ceil(dur * sampleRate) + Math.ceil(rel * sampleRate);
    const w = freq * 2 * Math.PI;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const e = env(t, dur, atk, rel);
      if (e === 0) continue;
      // Slightly detuned two-oscillator voice for warmth.
      const s = (Math.sin(w * t) + 0.6 * Math.sin(w * 1.003 * t)) * 0.5;
      buf[(start + i) % n] += s * e * gain;
    }
  };

  for (let bar = 0; bar < PROGRESSION.length; bar++) {
    const chord = PROGRESSION[bar];
    const barStart = bar * barDur;
    // Sustained pad: the low two chord tones, one long swelling note per bar.
    add(barStart, semis(chord[0] - 12), barDur, 0.16, 0.5, 0.5);
    add(barStart, semis(chord[1] - 12), barDur, 0.12, 0.6, 0.6);
    // Arpeggio: one chord tone per beat, gentle plucks.
    for (let b = 0; b < BEATS_PER_BAR; b++) {
      const note = chord[b % chord.length];
      add(barStart + b * beat, semis(note), beat * 0.9, 0.09, 0.01, beat * 0.5);
    }
  }

  // Normalize to a safe headroom so summed voices never clip.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak > 0) {
    const g = 0.7 / peak;
    for (let i = 0; i < n; i++) buf[i] *= g;
  }
  return buf;
}
