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
    // Stereo s16: left +1, right -1 => mono 0.
    const bytes = buildWav({ channels: 2, bits: 16, frames: 4 }, (view, at, f) => {
      view.setInt16(at + f * 4, 32767, true);
      view.setInt16(at + f * 4 + 2, -32767, true);
    });
    const { rate, samples } = decodeWav(bytes);
    expect(rate).toBe(22050);
    expect(samples.length).toBe(4);
    for (const v of samples) expect(Math.abs(v)).toBeLessThan(1e-4);
  });

  test("rejects a non-RIFF file", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/);
  });
});

// Malformed input, per the review on #36. The point of each is not that it fails
// but that it fails *diagnosably*: without these guards a truncated or oddly
// encoded source either surfaces as a bare DataView RangeError or, for a float
// depth the loop cannot address, returns misaligned garbage silently.
describe("wav codec rejects malformed input", () => {
  test("a data chunk longer than the file", () => {
    const bytes = buildWav({ frames: 8 });
    // Claim twice the samples that are actually there.
    new DataView(bytes.buffer).setUint32(40, 8 * 2 * 2, true);
    expect(() => decodeWav(bytes)).toThrow(/declares .* the file ends at/);
  });

  test("but tolerates junk AFTER a complete fmt+data pair", () => {
    // Not a malformed-input case so much as the counterpart to it, and the reason
    // the overflow check stops rather than throws once both chunks are in hand.
    // 197 of the 801 WAVs in the RE repo's legacy sfx/ dump look like this.
    const good = buildWav({ frames: 4 }, (view, at, f) => {
      view.setInt16(at + f * 2, 1000, true);
    });
    const bytes = new Uint8Array(good.length + 8);
    bytes.set(good, 0);
    const view = new DataView(bytes.buffer);
    for (const [i, ch] of [..."JUNK"].entries()) view.setUint8(good.length + i, ch.charCodeAt(0));
    view.setUint32(good.length + 4, 0xffffffff, true); // absurd declared length
    const { samples } = decodeWav(bytes);
    expect(samples.length).toBe(4);
    expect(samples[0]).toBeCloseTo(1000 / 32768, 5);
  });

  test("a short fmt chunk", () => {
    const bytes = buildWav({ frames: 4, fmtLength: 12 });
    expect(() => decodeWav(bytes)).toThrow(/fmt chunk is 12 bytes, need 16/);
  });

  test("WAVE_FORMAT_EXTENSIBLE without its subformat GUID", () => {
    const bytes = buildWav({ frames: 4, format: 0xfffe });
    expect(() => decodeWav(bytes)).toThrow(/extensible fmt chunk is 16 bytes, need 40/);
  });

  test("a float depth the sample loop cannot address", () => {
    // The silent one: 16-bit float would be read as Float32, four bytes per
    // sample against a two-byte stride.
    const bytes = buildWav({ frames: 4, format: 3, bits: 16 });
    expect(() => decodeWav(bytes)).toThrow(/float WAV bit depth 16, expected 32 or 64/);
  });

  test("a bit depth that is not a whole byte", () => {
    const bytes = buildWav({ frames: 4, bits: 12 });
    expect(() => decodeWav(bytes)).toThrow(/PCM WAV bit depth 12/);
  });

  test("64-bit integer PCM, which the loop has no branch for", () => {
    const bytes = buildWav({ frames: 4, bits: 64 });
    expect(() => decodeWav(bytes)).toThrow(/PCM WAV bit depth 64/);
  });

  test("a data chunk under one frame", () => {
    const bytes = buildWav({ frames: 0 });
    expect(() => decodeWav(bytes)).toThrow(/under one frame/);
  });
});

interface WavShape {
  format?: number;
  channels?: number;
  bits?: number;
  rate?: number;
  frames?: number;
  /** Declared fmt chunk size, for testing a truncated header. */
  fmtLength?: number;
}

/** Builds a canonical 44-byte-header WAV, with each field overridable. */
function buildWav(
  shape: WavShape,
  fill?: (view: DataView, dataAt: number, frame: number) => void,
): Uint8Array {
  const format = shape.format ?? 1;
  const channels = shape.channels ?? 1;
  const bits = shape.bits ?? 16;
  const rate = shape.rate ?? 22050;
  const frames = shape.frames ?? 4;
  const fmtLength = shape.fmtLength ?? 16;
  const frameBytes = Math.ceil(bits / 8) * channels;
  const dataBytes = frames * frameBytes;
  const bytes = new Uint8Array(20 + fmtLength + 8 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, fmtLength, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, (rate * frameBytes) | 0, true);
  view.setUint16(32, frameBytes, true);
  if (fmtLength >= 16) view.setUint16(34, bits, true);
  const dataAt = 20 + fmtLength + 8;
  ascii(dataAt - 8, "data");
  view.setUint32(dataAt - 4, dataBytes, true);
  if (fill) for (let f = 0; f < frames; f++) fill(view, dataAt, f);
  return bytes;
}
