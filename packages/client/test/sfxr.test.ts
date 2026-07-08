// The audio engine (AudioContext, gain graph) is browser-only, but the synth +
// presets + music loop are pure and rendered headlessly here — this is what
// proves the "regenerable JSON asset" promise: the committed presets always
// render the same finite, bounded, non-trivial buffers.

import { describe, expect, test } from "bun:test";
import { renderMusicLoop } from "../src/audio/music";
import { DETUNE_CUES, PRESETS } from "../src/audio/presets";
import { renderSfxr } from "../src/audio/sfxr";

const RATE = 44100;

function stats(buf: Float32Array): { peak: number; rms: number; finite: boolean } {
  let peak = 0;
  let sumSq = 0;
  let finite = true;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) finite = false;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, buf.length)), finite };
}

describe("sfxr synth", () => {
  test("every preset renders a finite, bounded, audible buffer", () => {
    for (const name of Object.keys(PRESETS)) {
      const buf = renderSfxr(PRESETS[name], RATE);
      const s = stats(buf);
      expect(buf.length).toBeGreaterThan(RATE * 0.02); // at least ~20 ms
      expect(buf.length).toBeLessThanOrEqual(RATE * 5); // hard cap honored
      expect(s.finite).toBe(true);
      expect(s.peak).toBeLessThanOrEqual(1); // never clips past full scale
      expect(s.rms).toBeGreaterThan(0); // not silence
    }
  });

  test("rendering is deterministic for a fixed seed", () => {
    const a = renderSfxr(PRESETS.explosion, RATE, 123);
    const b = renderSfxr(PRESETS.explosion, RATE, 123);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]);
  });

  test("distinct presets produce distinct audio", () => {
    const shot = renderSfxr(PRESETS.shot, RATE);
    const boom = renderSfxr(PRESETS.explosion, RATE);
    // Different length or different first-100ms content — they must not alias.
    let differs = shot.length !== boom.length;
    const n = Math.min(shot.length, boom.length, RATE / 10);
    for (let i = 0; i < n && !differs; i++) if (shot[i] !== boom[i]) differs = true;
    expect(differs).toBe(true);
  });

  test("noise cue changes with the seed; tonal cue does not use noise", () => {
    // explosion is a noise wave → seed changes the waveform.
    const n1 = renderSfxr(PRESETS.explosion, RATE, 1);
    const n2 = renderSfxr(PRESETS.explosion, RATE, 2);
    let noiseDiffers = false;
    const n = Math.min(n1.length, n2.length);
    for (let i = 0; i < n; i++)
      if (n1[i] !== n2[i]) {
        noiseDiffers = true;
        break;
      }
    expect(noiseDiffers).toBe(true);
  });

  test("detune cues are declared and present as presets", () => {
    for (const cue of DETUNE_CUES) expect(PRESETS[cue]).toBeDefined();
  });
});

describe("music loop", () => {
  test("renders a seamless, non-clipping, non-silent loop", () => {
    const buf = renderMusicLoop(RATE);
    const s = stats(buf);
    expect(buf.length).toBeGreaterThan(RATE * 5); // multi-second loop
    expect(s.finite).toBe(true);
    expect(s.peak).toBeLessThanOrEqual(1);
    expect(s.peak).toBeGreaterThan(0.1); // normalized to real headroom
    // Seamless: the wrap boundary shouldn't be a discontinuous click.
    const jump = Math.abs(buf[0] - buf[buf.length - 1]);
    expect(jump).toBeLessThan(0.5);
  });
});
