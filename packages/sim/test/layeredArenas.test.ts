// Schema + playability + exact-hash pins for the two LAYERED FCOP arenas
// (Hollywood Keys, Venice Beach). A changed pin means the extractor/converter
// output changed → regenerate the map JSON (tools/generators/convert.ts) and, if any
// golden runs on it, bump SIM_VERSION + re-record in the same commit.
//
// WHY THESE TWO STILL CARRY HAND-AUTHORED FEATURES
// Issue #30 rebuilt four arenas from their original Precinct Assault logic, and
// issue #29 turned la-cantina into the multi-deck arena it always was. These two
// are still excluded, and not for want of data — hk-logic.json and ovmp-logic.json
// are committed. What is missing is per-FEATURE layer information, not sim
// machinery; the wall pins plus the tests below are what stop stage 2 being
// pointed at them by accident. See the last describe block for the numbers, and
// note that its original vertical-gap argument was RETIRED as circular — the
// reasoning there is worth reading before re-deriving it.
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
    // Stage-2 import carves the deck roads open (issue #33).
    wallsV: 403770020,
    wallsH: 2248086300,
  },
  [VENICE_BEACH_ID]: {
    size: 305,
    heights: 2525341779,
    layerHeights: [3981683061, 2671519192],
    layerMasks: [3788166252, 1780779980],
    wallsV: 3492741943,
    wallsH: 1478409668,
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
    // rule: uphill only, and heights from `resolveWalker`. On the imported
    // layouts the polyline is a deck road (nodes carry layer from ground_cast);
    // a unit snaps onto that surface near each node, so measuring the polyline
    // as if it were ground-floor is the wrong question. Dryness still applies.
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
          if (map.laneGraph === undefined) {
            expect(worstUphillRise(map, x0, y0, x1, y1)).toBe(0);
          }
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
 * Why the original layouts are still not imported here (issue #33).
 *
 * The extracted logic exists in-tree — hk-logic.json, ovmp-logic.json — and
 * `bun run gen:arena hollywood-keys` reports "OK — no problems". It is wrong
 * anyway, and these tests are the record of why, so the deferral is a measurement
 * rather than a note someone has to trust.
 *
 * WHAT THIS BLOCK USED TO ASSERT, AND WHY IT WAS RETIRED
 * It measured the vertical gap from each deck cell to the ground under it, found
 * the smallest anywhere on either arena was 0.594 m against STEP_SNAP = 0.35, and
 * concluded no walker can ever reach a deck. Issue #29 established that this could
 * not have come out any other way: the extractor separates stacked surfaces only
 * when they are more than MULTI_THRESH = 16 quanta (0.5 m) apart, and it keeps a
 * ramp's continuous run INSIDE layer 0 on purpose. So "every deck is more than
 * 0.5 m above the floor" is a restatement of the extractor's clustering constant,
 * not a fact about Hollywood Keys, and any arena it is ever run on will pass it.
 *
 * WHAT REPLACES IT
 * The question a walker actually asks. A deck is not entered from below, it is
 * entered SIDEWAYS, at its edge, where the ground has risen to meet it — which is
 * what a ramp is, and why the extractor keeps ramps in layer 0. Measured that way
 * the decks are enterable: 616 + 1374 entry cells on hollywood-keys, 998 + 130 on
 * venice-beach, and `resolveWalker` already makes the transition (la-cantina's
 * 1180 are live since #29). So issue #33's open question 6 is answered — the
 * original needs no hovering and the extractor drops no ramps — and the walker
 * model needs no change.
 *
 * WHAT IS ACTUALLY LEFT FOR #33
 * Not the sim's movement or its wall model; #29 landed per-layer lattices and a
 * layer-aware flood, and proved them on la-cantina. What remains is per-FEATURE:
 *   - a `layer` field on spawns/bases/pads/lanes, because Hk puts 8 Turret, 3
 *     NeutralTurret and 2 TeamBase? on cells that have a deck overhead (Ovmp: 4
 *     ItemPickup and 1 NeutralTurret), and nothing can say which storey they are
 *     on. la-cantina needed none of this — all 15 of its actors under a deck are
 *     scenery, so every gameplay feature there is layer 0.
 *   - render/structures.ts drawing a structure at its feature's layer instead of
 *     at sampleHeight.
 *   - the actor-Y blocker is CLOSED, and not the way #33 expected: ACT `pos_h` is
 *     0.0 on every actor of every PC mission, so it cannot come from the
 *     container at all. Deck membership is inferred from the terrain instead —
 *     annotate_actor_layers.py in the RE repo, `actors.layered.json`.
 *
 * When these assertions start failing, that model has landed: update them, do not
 * delete them.
 */
describe("the layered arenas' decks are enterable but their layouts are not imported (issue #33)", () => {
  for (const id of [HOLLYWOOD_KEYS_ID, VENICE_BEACH_ID]) {
    const map = getMapById(id);
    const s = map.size;

    it(`${id}: decks are most of the arena and are entered at their edges`, () => {
      let present = 0;
      let entries = 0;
      for (let L = 0; L < map.layerHeights.length; L++) {
        for (let j = 1; j < s - 1; j++) {
          for (let i = 1; i < s - 1; i++) {
            const k = j * s + i;
            if (map.layerMask[L][k] !== 1) continue;
            present++;
            // An entry cell: this deck cell has a NON-deck neighbour whose ground
            // is within a step of the deck surface — the top of a ramp.
            const deckH = map.layerHeights[L][k];
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              const nk = (j + dy) * s + (i + dx);
              if (map.layerMask[L][nk] === 1) continue;
              if (Math.abs(map.heights[nk] - deckH) <= STEP_SNAP) {
                entries++;
                break;
              }
            }
          }
        }
      }
      expect(present).toBeGreaterThan(s * s * 0.4); // decks are most of the arena
      // The claim that matters, and the one the retired vertical-gap test could
      // never have found: there is a way up.
      expect(entries).toBeGreaterThan(0);
    });

    it(`${id}: no deck is within one step of the floor beneath it (extractor property)`, () => {
      // Kept, but demoted to what it is: a check that the extractor's clustering
      // constant still holds, so nobody reads it as a statement about reachability
      // again. MULTI_THRESH = 16 quanta = 0.5 m; STEP_SNAP is 0.35.
      let minGap = Number.POSITIVE_INFINITY;
      for (let L = 0; L < map.layerHeights.length; L++) {
        for (let k = 0; k < s * s; k++) {
          if (map.layerMask[L][k] !== 1) continue;
          const gap = map.layerHeights[L][k] - map.heights[k];
          if (gap < minGap) minGap = gap;
        }
      }
      expect(minGap).toBeGreaterThan(0.5);
      expect(minGap).toBeGreaterThan(STEP_SNAP);
    });

    it(`${id}: carries the imported PA layout with deck-aware lane nodes`, () => {
      // Issue #33 foundation + ground_cast on Cnet nodes: stage 2 is adopted.
      // Spawns/bases/turrets stay layer 0 until actors.layered.json can name
      // which under-deck cells are on the deck vs under it; the road network
      // uses the authored cast, which is what made Hk's streets unusable when
      // flattened to the canal floor.
      expect(map.laneGraph).toBeDefined();
      expect(map.laneGraph?.nodes.length).toBeGreaterThan(50);
      expect(map.weapons.length).toBeGreaterThan(0);
      expect(map.turretSpots.length).toBeGreaterThan(4);
      // At least some lane nodes sit on a deck (Hk: all of them; Ovmp: ~20%).
      let onDeck = 0;
      const nodes = map.laneGraph!.nodes;
      for (const n of nodes) {
        if (n.layer > 0) onDeck += 1;
      }
      expect(onDeck).toBeGreaterThan(0);
    });

    it(`${id}: has no per-deck wall lattice yet, so it shares layer 0's`, () => {
      // Stage 1 has not re-emitted per-deck walls for these two; collision on a
      // deck still uses the ground lattice. When til_mesh / convert ships those
      // lattices, this flips.
      expect(map.layerWallsV.length).toBe(0);
      expect(map.layerWallsH.length).toBe(0);
    });
  }
});
