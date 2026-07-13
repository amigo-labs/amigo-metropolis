// Exact-value pins (toBe): a changed value here means the test map or the
// sampler no longer produces committed bit-exact results — SIM_VERSION bump
// plus golden regeneration, not a test tweak.
import { describe, expect, it } from "bun:test";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import {
  BUG_HUNT_ID,
  createTestMap,
  DISTRICT_01_ID,
  getMapById,
  HOLLYWOOD_KEYS_ID,
  LA_CANTINA_ID,
  MAP_REGISTRY,
  PROVING_GROUND_ID,
  sampleHeight,
  TEST_MAP_ID,
  URBAN_JUNGLE_ID,
  VENICE_BEACH_ID,
  worldExtent,
} from "../src/map";

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

describe("map registry", () => {
  it("lists the selectable arenas in menu order with unique ids", () => {
    expect(MAP_REGISTRY.map((m) => m.id)).toEqual([
      DISTRICT_01_ID,
      URBAN_JUNGLE_ID,
      PROVING_GROUND_ID,
      LA_CANTINA_ID,
      BUG_HUNT_ID,
      HOLLYWOOD_KEYS_ID,
      VENICE_BEACH_ID,
    ]);
    expect(new Set(MAP_REGISTRY.map((m) => m.id)).size).toBe(MAP_REGISTRY.length);
  });

  it("loads every registry entry through getMapById with a display name", () => {
    for (const info of MAP_REGISTRY) {
      expect(info.displayName.length).toBeGreaterThan(0);
      expect(getMapById(info.id).id).toBe(info.id);
    }
  });

  it("keeps the debug test map out of the picker but resolvable by id", () => {
    expect(MAP_REGISTRY.some((m) => m.id === TEST_MAP_ID)).toBe(false);
    expect(getMapById(TEST_MAP_ID).id).toBe(TEST_MAP_ID);
  });

  it("throws on unknown map ids", () => {
    expect(() => getMapById("no-such-map")).toThrow("unknown map id");
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
