// Schema + playability + exact-hash pins for the two LAYERED FCOP arenas
// (Hollywood Keys, Venice Beach). A changed pin means the extractor/converter
// output changed → regenerate the map JSON (tools/generators/convert.ts) and, if any
// golden runs on it, bump SIM_VERSION + re-record in the same commit.
//
// WHY THESE TWO STILL CARRY HAND-AUTHORED FEATURES
// Issue #30 rebuilt the four single-storey arenas from their original Precinct
// Assault logic. These two are excluded, and not for want of data — hk-logic.json
// and ovmp-logic.json are committed. The blocker is measured, and the wall pins
// plus the deck-reachability test below are what stop stage 2 being pointed at
// them by accident. See the "deferred" describe block for the numbers.
import { describe, expect, it } from "bun:test";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import {
  getMapById,
  HOLLYWOOD_KEYS_ID,
  isWater,
  MAP_REGISTRY,
  type MapData,
  resolveHeight,
  VENICE_BEACH_ID,
} from "../src/map";
import { STEP_SNAP } from "../src/sim";
import { worstUphillRise } from "../src/units";

const bufHash = (a: Float32Array | Uint8Array): number =>
  fnv1aBytes(fnv1aInit(), new Uint8Array(a.buffer), 0, a.buffer.byteLength) >>> 0;

interface Pins {
  size: number;
  heights: number;
  layerHeights: number[];
  layerMasks: number[];
  /**
   * Collision geometry. These two had no wall pin, which meant stage 2 could be
   * pointed at them and carve their lattice with nothing failing — see the
   * deferral block at the bottom of this file for why that must not happen
   * silently.
   */
  wallsV: number;
  wallsH: number;
}

const PINS: Record<string, Pins> = {
  [HOLLYWOOD_KEYS_ID]: {
    size: 289,
    heights: 3740312999,
    layerHeights: [2172217779, 623664885],
    layerMasks: [1005174504, 265879142],
    wallsV: 1087146293,
    wallsH: 2860731642,
  },
  [VENICE_BEACH_ID]: {
    size: 305,
    heights: 2525341779,
    layerHeights: [3981683061, 2671519192],
    layerMasks: [3788166252, 1780779980],
    wallsV: 817673982,
    wallsH: 2870618577,
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

  it("pins the exact hash of the wall arrays", () => {
    expect(bufHash(map.wallsV)).toBe(pin.wallsV);
    expect(bufHash(map.wallsH)).toBe(pin.wallsH);
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
    // Slope goes through the shared `worstUphillRise`, which is the stepper's own
    // rule: uphill only, and heights from `resolveWalker`. Both details matter
    // MORE here than anywhere else — these are the only two arenas with decks, so
    // they are the only ones where resolveWalker can differ from a bare
    // sampleHeight. This block used to take `Math.abs` of a bare sample, i.e. it
    // asserted a rule the sim does not implement, on the maps most likely to
    // expose the difference. Measured: 0 blocking steps under either rule, so
    // nothing about these two arenas changes — but the assertion now means what
    // it says.
    for (const lane of map.lanes) {
      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.ceil(segLen);
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          const x0 = a.x + (b.x - a.x) * t0;
          const y0 = a.y + (b.y - a.y) * t0;
          const x1 = a.x + (b.x - a.x) * t1;
          const y1 = a.y + (b.y - a.y) * t1;
          expect(isWater(map, x1, y1)).toBe(false);
          expect(worstUphillRise(map, x0, y0, x1, y1)).toBe(0);
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

/**
 * Why the original layouts are not imported here (issue #30 deferral).
 *
 * The extracted logic exists in-tree — hk-logic.json, ovmp-logic.json — and
 * `bun run gen:arena hollywood-keys` reports "OK — no problems". It is wrong
 * anyway, and these tests are the record of why, so the deferral is a measurement
 * rather than a note someone has to trust.
 *
 * Every extra deck on both arenas sits at least 0.594 m above the base surface,
 * while resolveWalker only steps up STEP_SNAP = 0.35 m — so there is not one cell
 * on either map where a walker can reach a deck. And the decks are not detail:
 * they are 62% of hollywood-keys' grid and 44% of venice-beach's. On Hollywood
 * Keys the base surface is the canal floor and the city is layer 1, which is why
 * convert.ts hand-projected those spawns down in the first place.
 *
 * Import them anyway and the result looks clean and is not: all 140 of Hk's lane
 * graph nodes, both its spawns and 22 of its 34 base structures land under an
 * unreachable deck, and the lane carve edits 0 wall bits across 160 edges because
 * nothing blocks an empty canal floor. Venice Beach is better but still 119 of
 * 520 graph nodes and 15 of 38 base structures under a deck. Nothing catches it:
 * enrichArena's reachability flood and mapConnectivity's are both layer-blind,
 * MapJson has no per-feature layer field, and render/structures.ts draws every
 * structure at sampleHeight.
 *
 * Doing this properly needs per-layer wall lattices, a layer on each feature, a
 * flood that understands decks, and an actor Y from the extractor (actors.json
 * carries a `height` field but it is 0 on both arenas' X1Alpha, so which deck an
 * actor belongs to is currently unknowable). That is a design change, not a bug
 * fix, and it is a sibling of issue #29.
 *
 * When the first of these tests starts failing, that model has landed: update
 * them, do not delete them.
 */
describe("the layered arenas' decks are unreachable (issue #30 deferral)", () => {
  for (const id of [HOLLYWOOD_KEYS_ID, VENICE_BEACH_ID]) {
    const map = getMapById(id);
    const s = map.size;

    it(`${id}: no walker can step onto a deck from the base surface`, () => {
      let present = 0;
      let steppable = 0;
      let minGap = Number.POSITIVE_INFINITY;
      for (let L = 0; L < map.layerHeights.length; L++) {
        for (let k = 0; k < s * s; k++) {
          if (map.layerMask[L][k] !== 1) continue;
          present++;
          const gap = map.layerHeights[L][k] - map.heights[k];
          if (gap < minGap) minGap = gap;
          if (gap <= STEP_SNAP) steppable++;
        }
      }
      expect(present).toBeGreaterThan(s * s * 0.4); // decks are most of the arena
      expect(minGap).toBeGreaterThan(STEP_SNAP);
      expect(steppable).toBe(0);
    });

    it(`${id}: still carries its hand-authored features, not the original layout`, () => {
      // laneGraph is stage 2's marker. Its absence is the deferral; its presence
      // means someone ran gen:arena here, and the test above is why they should
      // not have.
      expect(map.laneGraph).toBeUndefined();
      expect(map.weapons.length).toBe(0);
      expect(map.turretSpots.length).toBe(4);
    });
  }
});
