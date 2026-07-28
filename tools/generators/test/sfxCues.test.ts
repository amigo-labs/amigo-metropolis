// Contract test for the SFX cue pipeline (#27). Three things, none of which
// needs a committed audio file — which matters, because the manifest is
// deliberately empty until the cue picking happens by ear:
//
// 1. every manifest cue names a real sfxr preset, so a typo fails here rather
//    than silently never loading at runtime;
// 2. the generated SFX_FILES lookup still matches the manifest, i.e.
//    `bun run gen:sfx` was re-run in the same commit (same contract as
//    unitModels.test.ts);
// 3. the hand-rolled WAV codec round-trips, since it has no library behind it.

import { describe, expect, test } from "bun:test";
import { PRESETS } from "../../../packages/client/src/audio/presets";
import { SFX_FILES } from "../../../packages/client/src/audio/sfxFiles.generated";
import { SFX_CUES } from "../sfx/manifest";
import { decodeWav, encodeWav } from "../sfx/wav";

describe("sfx cue manifest", () => {
  test("every cue is a real preset", () => {
    for (const spec of SFX_CUES) {
      expect(Object.keys(PRESETS)).toContain(spec.cue);
    }
  });

  test("no cue is listed twice", () => {
    const cues = SFX_CUES.map((s) => s.cue);
    expect(new Set(cues).size).toBe(cues.length);
  });

  test("generated SFX_FILES matches the manifest", () => {
    expect(Object.keys(SFX_FILES).sort()).toEqual(SFX_CUES.map((s) => s.cue).sort());
    for (const spec of SFX_CUES) {
      expect(SFX_FILES[spec.cue]).toBe(`/sfx/${spec.cue}.wav`);
    }
  });

  test("an empty manifest leaves every cue on the synth", () => {
    // Not a tautology: it pins the intended default. When cues do get filled in
    // this flips to a count, and the presets must still all be present.
    if (SFX_CUES.length === 0) expect(Object.keys(SFX_FILES).length).toBe(0);
    expect(Object.keys(PRESETS).length).toBeGreaterThan(0);
  });
});

describe("wav codec", () => {
  test("round-trips mono float within 16-bit quantization", () => {
    const rate = 22050;
    const samples = new Float32Array(1024);
    for (let i = 0; i < samples.length; i++) {
      // A ramp through the full range, so both signs and the rails are covered.
      samples[i] = (i / (samples.length - 1)) * 2 - 1;
    }
    const back = decodeWav(encodeWav({ rate, samples }));
    expect(back.rate).toBe(rate);
    expect(back.samples.length).toBe(samples.length);
    let maxErr = 0;
    for (let i = 0; i < samples.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(samples[i] - back.samples[i]));
    }
    // Two LSB, not one, because int16 is asymmetric: encoding scales the
    // positive half by 32767 while decoding divides everything by 32768, so a
    // full-scale positive sample loses 1/32768 on top of its half-LSB rounding.
    // ~40 dB below the 16-bit noise floor either way.
    expect(maxErr).toBeLessThanOrEqual(2 / 32767);
  });

  test("clamps out-of-range samples instead of wrapping", () => {
    const samples = new Float32Array([2, -2, 0]);
    const back = decodeWav(encodeWav({ rate: 8000, samples }));
    expect(back.samples[0]).toBeCloseTo(1, 4);
    expect(back.samples[1]).toBeCloseTo(-1, 4);
    expect(back.samples[2]).toBe(0);
  });

  test("averages channels down to mono", () => {
    // Hand-built stereo s16 WAV: left +1, right -1 => mono 0.
    const frames = 4;
    const bytes = new Uint8Array(44 + frames * 4);
    const view = new DataView(bytes.buffer);
    const ascii = (at: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + frames * 4, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true); // stereo
    view.setUint32(24, 22050, true);
    view.setUint32(28, 22050 * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, frames * 4, true);
    for (let f = 0; f < frames; f++) {
      view.setInt16(44 + f * 4, 32767, true);
      view.setInt16(44 + f * 4 + 2, -32767, true);
    }
    const { rate, samples } = decodeWav(bytes);
    expect(rate).toBe(22050);
    expect(samples.length).toBe(frames);
    for (const v of samples) expect(Math.abs(v)).toBeLessThan(1e-4);
  });

  test("rejects a non-RIFF file", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow();
  });
});
