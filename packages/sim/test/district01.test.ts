// Schema + playability validation for the committed district-01 map, plus an
// exact hash pin: regenerating the map (tools/generators/genDistrict01.ts) changes
// gameplay everywhere it is sampled, so a changed pin means SIM_VERSION bump
// + golden regeneration for every golden recorded on this map.
import { describe, expect, it } from "bun:test";
import { AVATAR_WALKER_MAX_SLOPE } from "../src/balance";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import {
  DISTRICT_01_ID,
  getMapById,
  isWater,
  loadMapFromJson,
  type MapJson,
  sampleHeight,
  worldExtent,
} from "../src/map";

const map = getMapById(DISTRICT_01_ID);

describe("district-01 schema", () => {
  it("has the authored dimensions and feature counts", () => {
    expect(map.size).toBe(128);
    expect(map.cellSize).toBe(2);
    expect(worldExtent(map)).toBe(254);
    expect(map.spawns.length).toBe(2);
    expect(map.basePlots.length).toBe(2);
    expect(map.lanes.length).toBe(3);
    expect(map.turretSpots.length).toBe(6);
    expect(map.outpostSpots.length).toBe(2);
    expect(map.dummySpots.length).toBeGreaterThanOrEqual(4);
  });

  it("pins the exact FNV-1a hash of the loaded heights", () => {
    const bytes = new Uint8Array(map.heights.buffer);
    expect(fnv1aBytes(fnv1aInit(), bytes, 0, bytes.length)).toBe(HEIGHTS_HASH_PIN);
  });

  it("has water (the river) but keeps all authored features dry", () => {
    let waterCells = 0;
    for (const w of map.waterMask) waterCells += w;
    expect(waterCells).toBeGreaterThan(500); // a real river…
    expect(waterCells).toBeLessThan(3000); // …not a flood
    for (const s of map.spawns) expect(isWater(map, s.x, s.y)).toBe(false);
    for (const p of [...map.turretSpots, ...map.outpostSpots, ...map.dummySpots]) {
      expect(isWater(map, p.x, p.y)).toBe(false);
    }
  });

  it("spawns sit on their own flat base plots", () => {
    for (let team = 0; team < 2; team++) {
      const s = map.spawns[team];
      const b = map.basePlots[team];
      const d = Math.hypot(s.x - b.x, s.y - b.y);
      expect(d).toBeLessThanOrEqual(b.radius);
      expect(sampleHeight(map, s.x, s.y)).toBeCloseTo(2.0, 1);
    }
  });

  it("base structures sit dry on their own flat plots", () => {
    expect(map.bases.length).toBe(2);
    for (let team = 0; team < 2; team++) {
      const base = map.bases[team];
      const plotC = map.basePlots[team];
      expect(base.turrets.length).toBeGreaterThanOrEqual(4); // rules.md §5: ring of 4-6
      expect(base.turrets.length).toBeLessThanOrEqual(6);
      const pts = [
        { x: base.gate.x, y: base.gate.y },
        base.core,
        base.groundConsole,
        base.airConsole,
        { x: base.pad.x, y: base.pad.y },
        ...base.turrets,
      ];
      for (const p of pts) {
        expect(Math.hypot(p.x - plotC.x, p.y - plotC.y)).toBeLessThanOrEqual(plotC.radius);
        expect(isWater(map, p.x, p.y)).toBe(false);
        expect(sampleHeight(map, p.x, p.y)).toBeCloseTo(2.0, 1);
      }
    }
  });

  it("bases are exact 180° mirrors of each other (fairness)", () => {
    const e = worldExtent(map);
    const [w, ea] = map.bases;
    const mirrored = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      expect(b.x).toBe(e - a.x);
      expect(b.y).toBe(e - a.y);
    };
    mirrored(w.gate, ea.gate);
    expect(ea.gate.radius).toBe(w.gate.radius);
    mirrored(w.core, ea.core);
    mirrored(w.groundConsole, ea.groundConsole);
    mirrored(w.airConsole, ea.airConsole);
    mirrored(w.pad, ea.pad);
    expect(ea.pad.radius).toBe(w.pad.radius);
    expect(ea.turrets.length).toBe(w.turrets.length);
    for (let i = 0; i < w.turrets.length; i++) {
      mirrored(w.turrets[i], ea.turrets[i]);
    }
  });

  it("every lane starts near base 0 and ends near base 1", () => {
    for (const lane of map.lanes) {
      const first = lane[0];
      const last = lane[lane.length - 1];
      const b0 = map.basePlots[0];
      const b1 = map.basePlots[1];
      expect(Math.hypot(first.x - b0.x, first.y - b0.y)).toBeLessThan(b0.radius + 10);
      expect(Math.hypot(last.x - b1.x, last.y - b1.y)).toBeLessThan(b1.radius + 10);
    }
  });

  it("lanes are walker-traversable: dry and within the slope limit", () => {
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
          const slope = Math.abs(h - prevH) / (segLen / steps);
          expect(slope).toBeLessThan(AVATAR_WALKER_MAX_SLOPE);
          prevH = h;
        }
      }
    }
  });
});

describe("loadMapFromJson validation", () => {
  const tiny = (): MapJson => ({
    id: "t",
    size: 2,
    cellSize: 1,
    waterLevel: 0,
    heights: [
      [0, 32],
      [-16, 64],
    ],
    water: ["01", "00"],
    spawns: [
      { x: 0, y: 0, yaw: 0 },
      { x: 1, y: 1, yaw: 0 },
    ],
    basePlots: [
      { x: 0, y: 0, radius: 1 },
      { x: 1, y: 1, radius: 1 },
    ],
    bases: [
      {
        gate: { x: 0, y: 1, radius: 1 },
        core: [0, 0],
        groundConsole: [0, 0],
        airConsole: [0, 0],
        pad: { x: 0, y: 0, radius: 1 },
        turrets: [],
      },
      {
        gate: { x: 1, y: 0, radius: 1 },
        core: [1, 1],
        groundConsole: [1, 1],
        airConsole: [1, 1],
        pad: { x: 1, y: 1, radius: 1 },
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  });

  it("reconstructs exact heights from 1/32 m integers", () => {
    const m = loadMapFromJson(tiny());
    expect(m.heights[0]).toBe(0);
    expect(m.heights[1]).toBe(1);
    expect(m.heights[2]).toBe(-0.5);
    expect(m.heights[3]).toBe(2);
    expect(m.waterMask[1]).toBe(1);
    expect(m.waterMask[2]).toBe(0);
  });

  it("rejects malformed maps with precise errors", () => {
    expect(() => loadMapFromJson({ ...tiny(), heights: [[0, 32]] })).toThrow("height rows");
    expect(() => loadMapFromJson({ ...tiny(), water: ["01", "0x"] })).toThrow("non-0/1");
    expect(() =>
      loadMapFromJson({
        ...tiny(),
        heights: [
          [0, 0.5],
          [0, 0],
        ],
      }),
    ).toThrow("non-integer height");
    expect(() => loadMapFromJson({ ...tiny(), spawns: [{ x: 0, y: 0, yaw: 0 }] })).toThrow(
      "exactly 2 spawns",
    );
    expect(() => loadMapFromJson({ ...tiny(), turretSpots: [[9, 0]] })).toThrow("out of bounds");
    expect(() => loadMapFromJson({ ...tiny(), lanes: [[[0, 0]]] })).toThrow("fewer than 2");
    expect(() => loadMapFromJson({ ...tiny(), bases: [tiny().bases[0]] })).toThrow(
      "exactly 2 bases",
    );
    const badGate = tiny();
    badGate.bases[0].gate = { x: 9, y: 0, radius: 1 };
    expect(() => loadMapFromJson(badGate)).toThrow("gate out of bounds");
    const badRing = tiny();
    // 16 is the cap since the original Mp places 16 base-defence turrets per
    // base (fcop-logic.md §8.2); the guard only catches authoring runaway now.
    badRing.bases[1].turrets = new Array(17).fill([1, 1]);
    expect(() => loadMapFromJson(badRing)).toThrow("max 16");
    // Malformed base shapes must fail with actionable messages, not TypeErrors.
    const nullBase = tiny();
    (nullBase.bases as unknown[])[0] = null;
    expect(() => loadMapFromJson(nullBase)).toThrow("base 0 is not an object");
    const badTurrets = tiny();
    (badTurrets.bases[1] as { turrets: unknown }).turrets = "nope";
    expect(() => loadMapFromJson(badTurrets)).toThrow("base 1 turrets is not a list");
    const badCore = tiny();
    (badCore.bases[0] as { core: unknown }).core = undefined;
    expect(() => loadMapFromJson(badCore)).toThrow("core is not an [x, y] pair");
  });

  // Precinct Assault fields (rules.md §9). They are optional, so the first
  // assertion here is the load-bearing one: a map without them stays valid and
  // comes back with every PA list empty, which is what makes the PA systems a
  // provable no-op on the other arenas.
  it("treats the PA feature fields as optional and rejects malformed ones", () => {
    const plain = loadMapFromJson(tiny());
    expect(plain.weapons).toEqual([]);
    expect(plain.turretParams).toEqual([]);
    expect(plain.turretYaw).toEqual([]);
    expect(plain.laneGraph).toBeUndefined();
    expect(plain.pickups).toEqual([]);
    expect(plain.triggerVolumes).toEqual([]);
    expect(plain.props).toEqual([]);
    for (const base of plain.bases) {
      expect(base.defence).toEqual([]);
      expect(base.coreHp).toBe(0);
      expect(base.productionTicks).toBe(0);
      expect(base.productionLimit).toBe(0);
    }

    const weapon = { range: 6, delay: 16, damage: 8, turnSpeed: 0.1, fovCos: -1 };
    expect(() => loadMapFromJson({ ...tiny(), weapons: [{ ...weapon, range: 0 }] })).toThrow(
      "weapon 0 bad range",
    );
    expect(() => loadMapFromJson({ ...tiny(), weapons: [{ ...weapon, delay: 0 }] })).toThrow(
      "weapon 0 bad delay",
    );
    expect(() => loadMapFromJson({ ...tiny(), weapons: [{ ...weapon, fovCos: 2 }] })).toThrow(
      "weapon 0 bad fovCos",
    );

    // Per-spot lists must line up with turretSpots or the indexing silently
    // shifts and turrets get someone else's gun.
    expect(() => loadMapFromJson({ ...tiny(), weapons: [weapon], turretParams: [0, 0] })).toThrow(
      "turretParams has 2 entries",
    );
    expect(() => loadMapFromJson({ ...tiny(), turretYaw: [0, 0] })).toThrow("turretYaw has 2");
    expect(() =>
      loadMapFromJson({
        ...tiny(),
        weapons: [weapon],
        turretSpots: [[1, 1]],
        turretParams: [1],
      }),
    ).toThrow("weapon index 1 out of range");

    // A 3-node chain 0-1-2, so a hop can be made to point at a non-neighbour.
    const graph = (over: Record<string, unknown>) => ({
      ...tiny(),
      laneGraph: {
        nodes: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        edges: [
          [1, -1, -1, -1],
          [0, 2, -1, -1],
          [1, -1, -1, -1],
        ],
        // team 0 walks 0 -> 1 -> 2 (arrived), team 1 walks 2 -> 1 -> 0.
        nextHopA: [
          [1, 2, -1],
          [-1, 0, 1],
        ],
        nextHopB: [
          [-1, -1, -1],
          [-1, -1, -1],
        ],
        entry: [0, 2],
        ...over,
      },
    });
    expect(() => loadMapFromJson(graph({}))).not.toThrow();
    expect(() => loadMapFromJson(graph({ nodes: [[0, 0]] }))).toThrow("laneGraph needs >= 2 nodes");
    expect(() => loadMapFromJson(graph({ edges: [[1, -1, -1, -1]] }))).toThrow(
      "laneGraph edges has 1 rows",
    );
    expect(() =>
      loadMapFromJson(
        graph({
          edges: [
            [9, -1, -1, -1],
            [0, 2, -1, -1],
            [1, -1, -1, -1],
          ],
        }),
      ),
    ).toThrow("edge 0.0 target 9 out of range");
    expect(() =>
      loadMapFromJson(
        graph({
          edges: [
            [0, -1, -1, -1],
            [0, 2, -1, -1],
            [1, -1, -1, -1],
          ],
        }),
      ),
    ).toThrow("node 0 links to itself");
    // A signpost may only point along an existing edge — the invariant the
    // runtime traversal relies on instead of searching.
    expect(() =>
      loadMapFromJson(
        graph({
          nextHopA: [
            [2, 2, -1],
            [-1, 0, 1],
          ],
        }),
      ),
    ).toThrow("nextHopA[0][0] -> 2 is not a neighbour");
    // ...and following it must terminate, or a unit would circle forever.
    expect(() =>
      loadMapFromJson(
        graph({
          nextHopA: [
            [1, 0, -1],
            [-1, 0, 1],
          ],
        }),
      ),
    ).toThrow("nextHopA loops for team 0");

    expect(() =>
      loadMapFromJson({ ...tiny(), pickups: [{ x: 9, y: 0, kind: 0, respawnTicks: 1 }] }),
    ).toThrow("pickup 0 out of bounds");
    expect(() =>
      loadMapFromJson({
        ...tiny(),
        triggerVolumes: [{ x: 1, y: 1, halfW: 0, halfL: 1, team: 0, watch: 1 }],
      }),
    ).toThrow("trigger 0 needs positive half extents");
    expect(() =>
      loadMapFromJson({
        ...tiny(),
        triggerVolumes: [{ x: 1, y: 1, halfW: 1, halfL: 1, team: 3, watch: 1 }],
      }),
    ).toThrow("trigger 0 bad team");

    // Production without a ceiling would fill the entity store.
    const runaway = tiny();
    runaway.bases[0].productionTicks = 150;
    expect(() => loadMapFromJson(runaway)).toThrow("no productionLimit");
  });
});

// Pinned after generation; see file header for the regeneration contract.
const HEIGHTS_HASH_PIN = 1016509266;
