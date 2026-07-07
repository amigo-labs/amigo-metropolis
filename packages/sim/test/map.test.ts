// Exact-value pins (toBe): a changed value here means the test map or the
// sampler no longer produces committed bit-exact results — SIM_VERSION bump
// plus golden regeneration, not a test tweak.
import { describe, expect, it } from "bun:test";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import { createTestMap, sampleHeight, worldExtent } from "../src/map";

const map = createTestMap();

describe("test map", () => {
  it("is 128x128 with 2m cells (254m extent)", () => {
    expect(map.size).toBe(128);
    expect(map.heights.length).toBe(128 * 128);
    expect(map.waterMask.length).toBe(128 * 128);
    expect(worldExtent(map)).toBe(254);
  });

  it("pins the exact FNV-1a hash of the generated heights", () => {
    const bytes = new Uint8Array(map.heights.buffer);
    expect(fnv1aBytes(fnv1aInit(), bytes, 0, bytes.length)).toBe(876168712);
  });

  it("pins individual generated heights", () => {
    expect(map.heights[0]).toBe(0);
    expect(map.heights[64 * 128 + 64]).toBe(-0.5274316668510437);
  });
});

describe("bilinear sampling", () => {
  it("returns exact vertex heights at grid vertices", () => {
    expect(sampleHeight(map, 0, 0)).toBe(0);
    expect(sampleHeight(map, 20, 40)).toBe(3.67326021194458);
    expect(sampleHeight(map, 254, 254)).toBe(-3.324460506439209);
  });

  it("interpolates edge midpoints to the exact vertex average", () => {
    const a = map.heights[20 * 128 + 10];
    const b = map.heights[20 * 128 + 11];
    expect(sampleHeight(map, 21, 40)).toBe((a + b) / 2);
    expect(sampleHeight(map, 21, 40)).toBe(3.79079532623291);
  });

  it("pins interior bilinear samples", () => {
    expect(sampleHeight(map, 128, 128)).toBe(-0.5274316668510437);
    expect(sampleHeight(map, 100.5, 37.25)).toBe(-2.5093349665403366);
  });

  it("clamps out-of-bounds queries to edge heights", () => {
    expect(sampleHeight(map, -50, 3000)).toBe(-1.077759861946106);
    expect(sampleHeight(map, -1, -1)).toBe(sampleHeight(map, 0, 0));
    expect(sampleHeight(map, 9999, 9999)).toBe(sampleHeight(map, 254, 254));
  });
});
