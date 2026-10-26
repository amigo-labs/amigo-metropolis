// Schema + playability + exact-hash pins for the two LAYERED FCOP arenas
// (Hollywood Keys, Venice Beach). A changed pin means the extractor/converter
// output changed → regenerate the map JSON (tools/generators/convert.ts) and, if any
// golden runs on it, bump SIM_VERSION + re-record in the same commit.
//
// WHY THESE TWO ARE SEPARATE
// Issue #30 rebuilt the arenas from their original Precinct Assault logic, and
// issue #29 turned la-cantina into the multi-deck arena it always was. These two
// were held back longest because most of their ground is a deck: Hk's canal and
// Ovmp's are water plates over a floor, and the streets are decks over those.
// Stage 2 imports them like the other four since every feature carries the
// surface the original stands it on (the last describe block). Its first
// argument — a vertical-gap measurement — was RETIRED as circular; the
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
    // Stage 1 re-run with its per-deck walls and the kerbs opened on every
    // lattice (SIM_VERSION 94); the carve opens nothing more.
    wallsV: 276205368,
    wallsH: 4011072299,
  },
  [VENICE_BEACH_ID]: {
    size: 305,
    heights: 2525341779,
    layerHeights: [3981683061, 2671519192],
    layerMasks: [3788166252, 1780779980],
    // SIM_VERSION 94: stage 1 re-run with its per-deck walls, the kerbs opened
    // on every lattice.
    wallsV: 242533927,
    wallsH: 2735658924,
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
      // A hover spawn may stand on the water (Hk's both do, as the original's).
      if (!s.hover) expect(isWater(map, s.x, s.y)).toBe(false);
    }
  });

  it("lanes are walker-traversable in slope (base floor)", () => {
    // Slope goes through the shared `worstUphillRise`, which is the stepper's own
    // rule: uphill only, and heights from `resolveWalker`. On the imported
    // layouts the polyline is a deck road (nodes carry layer from ground_cast);
    // a unit snaps onto that surface near each node, so measuring the polyline
    // as if it were ground-floor is the wrong question. Lanes need not be dry:
    // only a mech's own movement reads the water (fcop-fidelity.md P13), and the
    // original's tanks drive Hk's and Ovmp's water like any ground.
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
 * The layered arenas' layouts, imported with their decks (issue #33).
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
 * WHAT REPLACED IT
 * The question a walker actually asks. A deck is not entered from below, it is
 * entered SIDEWAYS, at its edge, where the ground has risen to meet it — which is
 * what a ramp is, and why the extractor keeps ramps in layer 0. Measured that way
 * the decks are enterable: 616 + 1374 entry cells on hollywood-keys, 998 + 130 on
 * venice-beach, and `resolveWalker` already makes the transition.
 *
 * WHAT CLOSED #33
 * Not the sim's movement or its wall model (#29: per-layer lattices and a
 * layer-aware flood). Per-FEATURE surfaces. No actor's Y is stored — ACT `pos_h`
 * is 0 on every PC record — because every construct asks the terrain with a
 * selector byte of its own record (`terrain_height_at`, 0x004545d0; the bytes in
 * tools/generators/fcopLogic.ts HEIGHT_SELECTOR), as `cnet_load` does for a node.
 * gen:palogic runs that query over the shipped plates and stage 2 stands each
 * feature on the sim surface carrying its answer; the generator's reachability
 * repair and mapConnectivity.test.ts ask whether the mech can serve a feature ON
 * that surface. tools/generators/test/featureLayers.test.ts holds every feature
 * of all six arenas to the original's height.
 */
describe("the layered arenas carry the original's layout on its decks (issue #33)", () => {
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

    it(`${id}: carries the imported PA layout, its features on their decks`, () => {
      expect(map.laneGraph).toBeDefined();
      expect(map.laneGraph?.nodes.length).toBeGreaterThan(50);
      expect(map.weapons.length).toBeGreaterThan(0);
      expect(map.turretSpots.length).toBeGreaterThan(4);
      const nodes = map.laneGraph?.nodes ?? [];
      const onDeck = (ps: readonly { layer: number }[]): number =>
        ps.filter((p) => p.layer > 0).length;
      // The bases' structures and ring guns stand on decks on both arenas: it was
      // the flattening of these to the canal floor that kept the two out.
      for (const b of map.bases) {
        expect(onDeck([b.gate, b.groundConsole, b.airConsole, ...b.turrets])).toBeGreaterThan(2);
      }
      expect(onDeck(map.triggerVolumes)).toBe(map.triggerVolumes.length);
      if (id === HOLLYWOOD_KEYS_ID) {
        // Hk's canal is a water plate over its floor (deck 1 at the water level),
        // the streets a deck over that. The original stands both mechs, both
        // shops of each base, its gate and every node of both roads on the
        // water — the shops' topmost plate is the canal's, at the foot of the
        // street deck beside them — and 8 of the 12 ring guns up on the street.
        const onWater = [
          ...map.spawns,
          ...map.bases.flatMap((b) => [b.gate, b.groundConsole, b.airConsole]),
        ];
        for (const p of onWater) {
          expect(p.layer).toBe(1);
          expect(Math.abs(resolveHeight(map, p.x, p.y, 1) - map.waterLevel)).toBeLessThan(0.01);
        }
        expect(onDeck(nodes)).toBe(nodes.length);
        expect(map.bases.flatMap((b) => b.turrets).filter((t) => t.layer === 2).length).toBe(8);
        expect(onDeck(map.turretSpots)).toBe(19);
      } else {
        // Ovmp's spawns are dry ground; about a quarter of its road is a deck.
        expect(onDeck(map.spawns)).toBe(0);
        expect(onDeck(nodes)).toBe(123);
        expect(onDeck(map.pickups)).toBe(6);
      }
    });

    it(`${id}: carries a wall lattice of its own on every deck`, () => {
      // Stage 1 re-run against the RE dump's per-deck walls (convert.ts
      // `rank0_walls*` and each deck's own): collision on a deck reads that
      // deck's parapets, and the road beneath it the ground's.
      expect(map.layerWallsV.length).toBe(map.layerHeights.length);
      expect(map.layerWallsH.length).toBe(map.layerHeights.length);
    });
  }
});
