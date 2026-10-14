// Each arena's units are its own mission's Cobjs (fcop-fidelity.md G1). These
// pin the role table gen:paunits read off the RE's pa_models.json against the
// numbers the RE documents (docs/formats/pa-models.md "The table"), the side
// each Metropolis team plays, and the turret lookups the frame loop makes.

import { describe, expect, test } from "bun:test";
import { getMapById } from "@metropolis/sim";
import * as THREE from "three";
import { arenaUnitsFor, bakedPoint, spotKey, turretSpotsOf } from "../src/render/arenaUnits";
import { ARENA_UNITS, UNIT_MODEL_FILES } from "../src/render/arenaUnits.generated";

/** The mission and Cobj a file is, checking that the arena may draw it. */
function ownCobj(mapId: string, file: string): { mission: string; cobj: number } {
  const f = UNIT_MODEL_FILES.find((m) => m.file === file);
  if (!f) throw new Error(`no file ${file}`);
  expect(f.usedBy).toContain(mapId);
  return { mission: f.mission, cobj: f.cobj };
}

// The RE's table, by arena (Cobj ids in the arena's own mission).
const TABLE: Record<
  string,
  {
    mission: string;
    tank: number;
    jet: number;
    fortress: number;
    hull: number;
    guns: number[];
    baseTurret: [number, number];
    neutral: [number, number][];
    captain: number[];
  }
> = {
  "la-cantina": {
    mission: "Mp",
    tank: 30,
    jet: 22,
    fortress: 41,
    hull: 36,
    guns: [37, 37, 38, 38],
    baseTurret: [20, 21],
    neutral: [[31, 32]],
    captain: [54, 54, 54, 56, 56, 56, 57, 57, 57, 58],
  },
  "urban-jungle": {
    mission: "Conft",
    tank: 30,
    jet: 22,
    fortress: 42,
    hull: 37,
    guns: [38, 38, 39, 39],
    baseTurret: [20, 21],
    neutral: [[31, 32]],
    captain: [56, 56, 56, 58, 58, 58, 59, 59, 59, 60],
  },
  "proving-ground": {
    mission: "Slim",
    tank: 31,
    jet: 22,
    fortress: 42,
    hull: 36,
    guns: [37, 37, 38, 38],
    baseTurret: [20, 21],
    neutral: [[32, 33]],
    captain: [64, 64, 64, 84, 84, 84, 85, 85, 85, 86],
  },
  "bug-hunt": {
    mission: "Joke",
    tank: 31,
    jet: 22,
    fortress: 41,
    hull: 35,
    guns: [36, 36, 37, 37],
    baseTurret: [20, 21],
    neutral: [[32, 21]],
    captain: [63, 63, 63, 63, 63, 63, 63, 63, 63, 84],
  },
  "hollywood-keys": {
    mission: "Hk",
    tank: 30,
    jet: 22,
    fortress: 41,
    hull: 36,
    guns: [37, 37, 38, 38],
    baseTurret: [20, 21],
    neutral: [
      [32, 33],
      [43, 44],
    ],
    captain: [57, 57, 57, 59, 59, 59, 60, 60, 60, 60],
  },
  "venice-beach": {
    mission: "Ovmp",
    tank: 30,
    jet: 22,
    fortress: 41,
    hull: 36,
    guns: [37, 37, 38, 38],
    baseTurret: [20, 21],
    neutral: [[31, 32]],
    captain: [54, 54, 54, 56, 56, 56, 57, 57, 57, 58],
  },
};

/**
 * A shared file carries the first arena's id; this arena's own id for the same
 * payload is what the RE's table names. Mp/Conft/Slim number some payloads
 * differently, so compare through the twin map gen:paunits shares by.
 */
const TWIN: Record<string, Record<number, number>> = {
  // Conft's own ids for the payloads it shares with Mp.
  "urban-jungle": { 20: 20, 22: 22, 36: 37, 54: 56, 56: 58, 57: 59, 58: 60 },
  // Slim's own ids for the payloads it shares with Mp and Conft.
  "proving-ground": {
    20: 20,
    21: 21,
    22: 22,
    29: 29,
    30: 31,
    31: 32,
    32: 33,
    36: 36,
    41: 42,
    54: 64,
    56: 84,
    57: 85,
    58: 86,
  },
  "venice-beach": { 54: 54, 56: 56, 57: 57, 58: 58 },
};

function idHere(mapId: string, file: string): number {
  const { mission, cobj } = ownCobj(mapId, file);
  if (mission === TABLE[mapId].mission) return cobj;
  const twin = TWIN[mapId]?.[cobj];
  if (twin === undefined) throw new Error(`${mapId}: ${file} is ${mission}'s and has no twin here`);
  return twin;
}

describe("each arena draws its own mission's Cobjs", () => {
  for (const [mapId, want] of Object.entries(TABLE)) {
    test(mapId, () => {
      const u = ARENA_UNITS[mapId];
      expect(u.mission).toBe(want.mission);
      expect(idHere(mapId, u.tank.model)).toBe(want.tank);
      expect(idHere(mapId, u.jet.model)).toBe(want.jet);
      expect(idHere(mapId, u.fortress.model)).toBe(want.fortress);
      expect(idHere(mapId, u.dreadnought.hull)).toBe(want.hull);
      expect(u.dreadnought.guns.map((g) => idHere(mapId, g.model))).toEqual(want.guns);
      expect([idHere(mapId, u.baseTurret.gun), idHere(mapId, u.baseTurret.base)]).toEqual(
        want.baseTurret,
      );
      expect(u.neutralTurrets.map((t) => [idHere(mapId, t.gun), idHere(mapId, t.base)])).toEqual(
        want.neutral,
      );
      expect(u.skyCaptain.byLevel.map((f) => idHere(mapId, f))).toEqual(want.captain);
      expect(idHere(mapId, u.console)).toBe(29);
    });
  }

  test("a shared file is one payload, and never another arena's different model", () => {
    for (const f of UNIT_MODEL_FILES) {
      expect(f.usedBy[0]).toBe(f.file.slice(0, f.file.indexOf("/")));
      expect(f.raw).toBe(`fcop-units/${f.mission}/obj_${String(f.cobj).padStart(3, "0")}.glb`);
    }
    // Hk's tank is a model of its own on page 6, Ovmp's units sample its page 4,
    // Joke's are all its own: none of those arenas draws Mp's file.
    for (const mapId of ["hollywood-keys", "venice-beach", "bug-hunt"]) {
      expect(ownCobj(mapId, ARENA_UNITS[mapId].tank.model).mission).toBe(TABLE[mapId].mission);
    }
  });
});

describe("the side each Metropolis team plays", () => {
  test("team 0 is the low end of the field: side 2 on Mp, side 1 elsewhere", () => {
    expect(ARENA_UNITS["la-cantina"].sides).toEqual([2, 1]);
    for (const mapId of [
      "urban-jungle",
      "proving-ground",
      "bug-hunt",
      "hollywood-keys",
      "venice-beach",
    ]) {
      expect(ARENA_UNITS[mapId].sides).toEqual([1, 2]);
    }
  });

  test("a map with no mission draws Mp's units, team 0 on side 1", () => {
    const u = arenaUnitsFor("test-128");
    expect(u.tank.model).toBe(ARENA_UNITS["la-cantina"].tank.model);
    expect(u.sides).toEqual([1, 2]);
  });
});

describe("turret lookups", () => {
  test("Hk's 43/44 set stands on exactly its seven records' spots", () => {
    const map = getMapById("hollywood-keys");
    const u = ARENA_UNITS["hollywood-keys"];
    expect(u.neutralTurrets[1].spots).toEqual([7, 12, 14, 16, 17, 18, 19]);
    const spots = turretSpotsOf(map, u);
    map.turretSpots.forEach((s, k) => {
      const set = spots.neutralSet.get(spotKey(s.x, s.y));
      expect(set).toBe(u.neutralTurrets[1].spots.includes(k) ? 1 : 0);
    });
  });

  test("every placed turret finds its rest yaw by where it stands", () => {
    for (const id of Object.keys(ARENA_UNITS)) {
      const map = getMapById(id);
      const spots = turretSpotsOf(map, ARENA_UNITS[id]);
      for (const base of map.bases) {
        for (const t of base.turrets) {
          // As the snapshot carries it: float32.
          expect(spots.restYaw.get(spotKey(Math.fround(t.x), Math.fround(t.y)))).toBe(t.yaw);
        }
      }
      map.turretSpots.forEach((s, k) => {
        expect(spots.restYaw.get(spotKey(s.x, s.y))).toBe(map.turretYaw[k]);
      });
    }
  });

  test("a model point turns with the quarter turn every unit's geometry is baked with", () => {
    // unitMeshes.ts: geometry.rotateY(PI / 2). The point must land where the
    // same rotation puts it.
    const p = new THREE.Vector3(-0.2676, 0.4863, 0.2832);
    const want = p.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const got = bakedPoint([-0.2676, 0.4863, 0.2832], new THREE.Vector3());
    expect(got.x).toBeCloseTo(want.x, 6);
    expect(got.y).toBeCloseTo(want.y, 6);
    expect(got.z).toBeCloseTo(want.z, 6);
  });
});
