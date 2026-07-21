// Schema + playability + exact-hash pins for the two LAYERED FCOP arenas
// (Hollywood Keys, Venice Beach). A changed pin means the extractor/converter
// output changed → regenerate the map JSON (tools/generators/convert.ts) and, if any
// golden runs on it, bump SIM_VERSION + re-record in the same commit.
import { describe, expect, it } from "bun:test";
import { AVATAR_WALKER_MAX_SLOPE } from "../src/balance";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import {
  getMapById,
  HOLLYWOOD_KEYS_ID,
  isWater,
  MAP_REGISTRY,
  type MapData,
  resolveHeight,
  sampleHeight,
  VENICE_BEACH_ID,
} from "../src/map";

const bufHash = (a: Float32Array | Uint8Array): number =>
  fnv1aBytes(fnv1aInit(), new Uint8Array(a.buffer), 0, a.buffer.byteLength) >>> 0;

interface Pins {
  size: number;
  heights: number;
  layerHeights: number[];
  layerMasks: number[];
}

const PINS: Record<string, Pins> = {
  [HOLLYWOOD_KEYS_ID]: {
    size: 289,
    heights: 3740312999,
    layerHeights: [2172217779, 623664885],
    layerMasks: [1005174504, 265879142],
  },
  [VENICE_BEACH_ID]: {
    size: 305,
    heights: 2525341779,
    layerHeights: [3981683061, 2671519192],
    layerMasks: [3788166252, 1780779980],
  },
};

function checkArena(id: string, displayName: string): void {
  const map: MapData = getMapById(id);
  const pin = PINS[id];

  it("is offered in the menu registry", () => {
    expect(MAP_REGISTRY.some((m) => m.id === id && m.displayName === displayName)).toBe(true);
  });

  it("has the authored square dimensions and two extra decks", () => {
    expect(map.size).toBe(pin.size);
    expect(map.cellSize).toBe(1);
    expect(map.layerHeights.length).toBe(2);
    expect(map.layerMask.length).toBe(2);
    expect(map.spawns.length).toBe(2);
    expect(map.lanes.length).toBeGreaterThanOrEqual(1);
  });

  it("pins the exact hash of the base heights + both decks", () => {
    expect(bufHash(map.heights)).toBe(pin.heights);
    for (let L = 0; L < 2; L++) {
      expect(bufHash(map.layerHeights[L])).toBe(pin.layerHeights[L]);
      expect(bufHash(map.layerMask[L])).toBe(pin.layerMasks[L]);
    }
  });

  it("each deck is present at a real number of cells above the base surface", () => {
    for (let L = 0; L < 2; L++) {
      let present = 0;
      for (const v of map.layerMask[L]) present += v;
      expect(present).toBeGreaterThan(0);
    }
    // Layer 1 covers substantially more ground than layer 2 (deck over roof).
    let l1 = 0;
    let l2 = 0;
    for (const v of map.layerMask[0]) l1 += v;
    for (const v of map.layerMask[1]) l2 += v;
    expect(l1).toBeGreaterThan(l2);
  });

  it("spawns sit dry on their own flat base plots", () => {
    for (let team = 0; team < 2; team++) {
      const s = map.spawns[team];
      const b = map.basePlots[team];
      expect(Math.hypot(s.x - b.x, s.y - b.y)).toBeLessThanOrEqual(b.radius);
      expect(isWater(map, s.x, s.y)).toBe(false);
    }
  });

  it("lanes are dry and walker-traversable in slope (base floor)", () => {
    for (const lane of map.lanes) {
      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.ceil(segLen);
        let prevH = sampleHeight(map, a.x, a.y);
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          expect(isWater(map, x, y)).toBe(false);
          const h = sampleHeight(map, x, y);
          expect(Math.abs(h - prevH) / (segLen / steps)).toBeLessThan(AVATAR_WALKER_MAX_SLOPE);
          prevH = h;
        }
      }
    }
  });

  it("resolveHeight returns a higher surface on a deck cell than the base", () => {
    // find a layer-1 present vertex and confirm its deck sits above the ground
    const s = map.size;
    let found = false;
    for (let k = 0; k < map.layerMask[0].length && !found; k++) {
      if (map.layerMask[0][k] !== 1) continue;
      const i = k % s;
      const j = Math.floor(k / s);
      if (i >= s - 1 || j >= s - 1) continue;
      const x = i + 0.5;
      const y = j + 0.5;
      const deck = resolveHeight(map, x, y, 1);
      const ground = resolveHeight(map, x, y, 0);
      if (deck > ground + 0.5) found = true;
    }
    expect(found).toBe(true);
  });
}

describe("hollywood-keys (layered)", () => checkArena(HOLLYWOOD_KEYS_ID, "Hollywood Keys"));
describe("venice-beach (layered)", () => checkArena(VENICE_BEACH_ID, "Venice Beach"));
