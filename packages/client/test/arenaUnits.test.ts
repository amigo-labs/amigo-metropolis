// Each arena's units are its own mission's Cobjs (fcop-fidelity.md G1). These
// pin the role table gen:paunits read off the RE's pa_models.json against the
// numbers the RE documents (docs/formats/pa-models.md "The table"), the side
// each Metropolis team plays, and the turret lookups the frame loop makes.

import { describe, expect, test } from "bun:test";
import { ARCHETYPE, getMapById, wardenLevel } from "@metropolis/sim";
import * as THREE from "three";
import { SCENERY_PLACEMENTS } from "../src/render/arenaScenery.generated";
import {
  arenaUnitsFor,
  bakedPoint,
  createArenaUnits,
  gunMatrix,
  gunPointOf,
  gunPointTable,
  restKey,
  spotKey,
  turretSpotsOf,
} from "../src/render/arenaUnits";
import { ARENA_UNITS, UNIT_MODEL_FILES } from "../src/render/arenaUnits.generated";
import { createGreyboxMeshes } from "../src/render/greybox";
import { recordYaw } from "../src/render/recordYaw";
import { sideOfTeam } from "../src/render/sides";
import {
  atlasOffset,
  patchTeamUv,
  prepareTeamUvMask,
  TEAM_UV_ATTR,
  TEAM_UV_MASK,
} from "../src/render/teamUv";
import { roundTrackOf } from "../src/render/unitMeshes";
import { TrackClock } from "../src/render/unitTracks";

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
  test("team N is the original's player slot N: side 1, then side 2, on every arena", () => {
    for (const mapId of [
      "la-cantina",
      "urban-jungle",
      "proving-ground",
      "bug-hunt",
      "hollywood-keys",
      "venice-beach",
    ]) {
      expect(ARENA_UNITS[mapId].sides).toEqual([1, 2]);
    }
  });

  test("gen:paunits' Dreadnought pairing agrees with render/sides.ts", () => {
    // Two readings of one fact: the client colours by sides.ts; the table's
    // own `sides` is the generator's cross-check.
    for (const [mapId, u] of Object.entries(ARENA_UNITS)) {
      expect([sideOfTeam(mapId, 0), sideOfTeam(mapId, 1)]).toEqual([...u.sides]);
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

  test("every placed turret finds its base's own yaw by where it stands and whose it is", () => {
    // RE turret_part.c 0x0041cf70: the base part reads its yaw off the
    // turret's record at +0x42 (0x0041cfed), not the gun's +0x34. Every turret
    // the map places is a record of its kind and side within 0.1 m.
    for (const id of Object.keys(ARENA_UNITS)) {
      const map = getMapById(id);
      const spots = turretSpotsOf(map, ARENA_UNITS[id]);
      const records = SCENERY_PLACEMENTS[id].turretBases;
      const placed = [
        ...map.bases.flatMap((b, team) => b.turrets.map((t) => ({ t, team, neutral: false }))),
        ...map.outpostPlates.flatMap((p) =>
          p.turrets.map((t, team) => ({ t, team, neutral: false })),
        ),
        ...map.turretSpots.map((t) => ({ t, team: 0, neutral: true })),
      ];
      const keys = new Set<number>();
      for (const { t, team, neutral } of placed) {
        const side = neutral ? 0 : sideOfTeam(id, team);
        const own = records.filter(
          (r) =>
            (neutral ? r.type === 36 : r.type === 8 && r.side === side) &&
            Math.hypot(r.x - t.x, r.y - t.y) < 0.1,
        );
        expect({ id, at: [t.x, t.y], neutral, records: own.length }).toEqual({
          id,
          at: [t.x, t.y],
          neutral,
          records: 1,
        });
        // As the snapshot carries it: float32.
        const key = restKey(Math.fround(t.x), Math.fround(t.y), neutral, team);
        expect(keys.has(key)).toBe(false);
        keys.add(key);
        expect(spots.restYaw.get(key)).toBe(recordYaw(own[0].yaw));
      }
    }
  });

  test("a map of no mission keeps its own turret yaw", () => {
    const map = getMapById("test-128");
    const spots = turretSpotsOf(map, ARENA_UNITS["la-cantina"]);
    map.turretSpots.forEach((s, k) => {
      expect(spots.restYaw.get(restKey(s.x, s.y, true, 0))).toBe(map.turretYaw[k] ?? 0);
    });
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

describe("team colour by the original's texture offset", () => {
  test("each side's offset lands on the other half of the page, in atlas units", () => {
    const out = new Float32Array(2);
    const map = new THREE.Texture({ width: 256, height: 256 });
    // Mp's tank: side 2 is v + 76 texels.
    const tank = ARENA_UNITS["la-cantina"].tank.uv;
    expect(tank[1]).toEqual({ u: 0, v: 0 });
    expect(tank[2]).toEqual({ u: 0, v: 76 });
    atlasOffset(map, tank[2].u, tank[2].v, out, 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(76 / 256, 9);
    // The X1: side 1 is u + 128 — half the page.
    const x1 = ARENA_UNITS["la-cantina"].x1.uv;
    expect(x1[1]).toEqual({ u: 128, v: 0 });
    expect(x1[2]).toEqual({ u: 0, v: 0 });
    atlasOffset(map, x1[1].u, x1[1].v, out, 0);
    expect(out[0]).toBe(0.5);
    // A wider atlas (two pages side by side) halves a texel's width.
    atlasOffset(new THREE.Texture({ width: 512, height: 256 }), 128, 25, out, 0);
    expect(out[0]).toBe(0.25);
    expect(out[1]).toBeCloseTo(25 / 256, 9);
  });

  test("the RE's per-arena offsets: Hk's tank, Joke's turrets, the neutral capture states", () => {
    expect(ARENA_UNITS["hollywood-keys"].tank.uv[2]).toEqual({ u: 0, v: 102 });
    expect(ARENA_UNITS["bug-hunt"].jet.uv[2]).toEqual({ u: 0, v: 78 });
    expect(ARENA_UNITS["bug-hunt"].baseTurret.uv.slice(1)).toEqual([
      { u: 50, v: 0 },
      { u: 100, v: 0 },
    ]);
    // A NeutralTurret adds (fa, fb) x state: [neutral, taken by side 1, by side 2].
    expect(ARENA_UNITS["la-cantina"].neutralTurrets[0].uv).toEqual([
      { u: 0, v: 0 },
      { u: 60, v: 0 },
      { u: 120, v: 0 },
    ]);
    expect(ARENA_UNITS["hollywood-keys"].neutralTurrets[1].uv).toEqual([
      { u: 0, v: 0 },
      { u: 0, v: 33 },
      { u: 0, v: 66 },
    ]);
    // The Dreadnought's guns wear the hull's offset (RE mount.c 714-715).
    expect(ARENA_UNITS["la-cantina"].dreadnought.uv[2]).toEqual({ u: 0, v: 78 });
    expect(ARENA_UNITS["bug-hunt"].dreadnought.uv[2]).toEqual({ u: 0, v: 39 });
    for (const u of Object.values(ARENA_UNITS)) {
      expect(u.outpostFlag.cobj).toBe(28);
      expect(u.outpostFlag.uv).toEqual([
        { u: 0, v: 0 },
        { u: 0, v: 25 },
        { u: 0, v: 51 },
      ]);
    }
  });

  test("the vertex shader adds the instance's offset to the map lookup, masked", () => {
    const material = new THREE.MeshStandardMaterial();
    patchTeamUv(material);
    const shader = {
      vertexShader: "#include <common>\nvoid main() {\n#include <uv_vertex>\n}",
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain(`attribute vec2 ${TEAM_UV_ATTR};`);
    expect(shader.vertexShader).toContain(`vMapUv += ${TEAM_UV_ATTR} * ${TEAM_UV_MASK};`);
    expect(material.customProgramCacheKey()).toBe("teamUv");
  });

  test("the X1's beacon is masked off the offset; other units take it everywhere", () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    prepareTeamUvMask(g);
    expect(Array.from(g.getAttribute(TEAM_UV_MASK).array)).toEqual([1, 1, 1]);
    const x1 = new THREE.BufferGeometry();
    x1.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    x1.setAttribute("_teamuv", new THREE.BufferAttribute(new Float32Array([1, 0]), 1));
    prepareTeamUvMask(x1);
    expect(Array.from(x1.getAttribute(TEAM_UV_MASK).array)).toEqual([1, 0]);
    expect(x1.getAttribute("_teamuv")).toBeUndefined();
  });
});

describe("the Sky Captain by level", () => {
  test("the match's Warden difficulty picks the level band's model", () => {
    const byLevel = ARENA_UNITS["la-cantina"].skyCaptain.byLevel;
    const file = (d: number) => byLevel[wardenLevel(d)];
    // Difficulty 1-3 is levels 0-2 (Cobj 54), 10 is level 9 (Cobj 58).
    expect(file(1)).toBe("la-cantina/obj_054");
    expect(file(3)).toBe("la-cantina/obj_054");
    expect(file(4)).toBe("la-cantina/obj_056");
    expect(file(7)).toBe("la-cantina/obj_057");
    expect(file(10)).toBe("la-cantina/obj_058");
    // Joke draws one model for levels 0-8 and another for 9.
    expect(new Set(ARENA_UNITS["bug-hunt"].skyCaptain.byLevel.slice(0, 9)).size).toBe(1);
    expect(ARENA_UNITS["bug-hunt"].skyCaptain.byLevel[9]).toBe("bug-hunt/obj_084");
  });
});

describe("the Dreadnought's guns on their hull points", () => {
  test("Mp's four guns stand on hull vertices 36, 37, 35 and 34 (RE mount.c 526-546)", () => {
    const d = ARENA_UNITS["la-cantina"].dreadnought;
    expect(d.guns.map((g) => g.point)).toEqual([
      [-0.267578, 0.486328, 0.283203],
      [0.257812, 0.486328, 0.283203],
      [-0.263672, 0.794922, -0.404297],
      [0.253906, 0.794922, -0.404297],
    ]);
    // Guns 0/1 are one model, 2/3 the other, on every arena.
    for (const u of Object.values(ARENA_UNITS)) {
      const m = u.dreadnought.guns.map((g) => g.model);
      expect(m[0]).toBe(m[1]);
      expect(m[2]).toBe(m[3]);
      expect(m[0]).not.toBe(m[2]);
    }
  });

  test("a gun at yaw 0 is the hull's matrix moved to the point, in the hull's turn", () => {
    const point = bakedPoint([-0.267578, 0.486328, 0.283203], new THREE.Vector3());
    const hullPos = new THREE.Vector3(100, 2, 50);
    const yaw = 0.7; // sim yaw; three turns by -yaw about +y
    const hull = new THREE.Matrix4().compose(
      hullPos,
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw),
      new THREE.Vector3(1, 1, 1),
    );
    const out = gunMatrix(hull, point, 0, new THREE.Matrix4());
    const at = new THREE.Vector3().setFromMatrixPosition(out);
    const want = point
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw)
      .add(hullPos);
    expect(at.distanceTo(want)).toBeLessThan(1e-9);
    // Facing the hull's forward: the same rotation as the hull.
    const q = new THREE.Quaternion().setFromRotationMatrix(out);
    const qh = new THREE.Quaternion().setFromRotationMatrix(hull);
    expect(Math.abs(q.dot(qh))).toBeCloseTo(1, 9);
    // At yaw 0 the glb's +z forward is the sim's +x, so gun 0 (glb z +0.283,
    // forward of the hull's middle) lands at sim +x of the hull.
    const flat = gunMatrix(
      new THREE.Matrix4().makeTranslation(0, 0, 0),
      point,
      0,
      new THREE.Matrix4(),
    );
    const p0 = new THREE.Vector3().setFromMatrixPosition(flat);
    expect(p0.x).toBeCloseTo(0.283203, 6);
    expect(p0.y).toBeCloseTo(0.486328, 6);
    expect(p0.z).toBeCloseTo(0.267578, 6);
  });
});

describe("the guns ride the hull's frame (RE cact_mount_step -> cact_model_point)", () => {
  const joke = ARENA_UNITS["bug-hunt"].dreadnought;
  const hullTrack = UNIT_MODEL_FILES.find((f) => f.file === joke.hull)?.morph;

  test("Joke's hull gives every gun its point in each of its 20 frames", () => {
    expect(hullTrack?.frames).toBe(20);
    for (const g of joke.guns) {
      expect(g.byFrame?.length).toBe(20);
      expect(g.byFrame?.[0]).toEqual(g.point);
    }
    // RE pa_models.json, hull 35 vertex 99 (gun 0): frame 0 and frame 12,
    // where the walk has carried it 0.56 m up and 0.35 m aft.
    expect(joke.guns[0].byFrame?.[0]).toEqual([-0.277344, 1.103516, 0.554688]);
    expect(joke.guns[0].byFrame?.[12]).toEqual([-0.277344, 1.662109, 0.207031]);
    // The walk moves the points in y and z only, and every gun moves.
    for (const g of joke.guns) {
      const rows = g.byFrame ?? [];
      expect(new Set(rows.map((p) => p[0])).size).toBe(1);
      expect(new Set(rows.map((p) => `${p[1]},${p[2]}`)).size).toBeGreaterThan(10);
    }
    // Every other hull has one frame, so its guns have one point.
    for (const [mapId, u] of Object.entries(ARENA_UNITS)) {
      if (mapId === "bug-hunt") continue;
      for (const g of u.dreadnought.guns) expect(g.byFrame).toBeNull();
    }
  });

  test("a gun stands on the point of the frame the hull shows, baked like the hull", () => {
    const table = gunPointTable(joke.guns);
    expect(table.frames).toBe(20);
    const at = new THREE.Vector3();
    const want = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 20; k++) {
        bakedPoint(joke.guns[i].byFrame?.[k] ?? joke.guns[i].point, want);
        expect(gunPointOf(table, i, k, at).distanceTo(want)).toBeLessThan(1e-6);
      }
    }
    // Frame 0 and frame 12 are not one place: the table is not frame 0 again.
    const f0 = gunPointOf(table, 0, 0, new THREE.Vector3());
    expect(gunPointOf(table, 0, 12, at).distanceTo(f0)).toBeGreaterThan(0.5);
    // A frame past the track is frame 0's, as a frame-0 hull's would be.
    expect(gunPointOf(table, 0, 20, at).distanceTo(f0)).toBe(0);
    // A one-frame hull (Mp's) has one row: every frame is the guns' point.
    const mp = ARENA_UNITS["la-cantina"].dreadnought;
    const one = gunPointTable(mp.guns);
    expect(one.frames).toBe(1);
    bakedPoint(mp.guns[2].point, want);
    expect(gunPointOf(one, 2, 7, at).distanceTo(want)).toBeLessThan(1e-6);
  });

  test("walked twelve periods, the hull shows frame 12 and gun 0 stands on its point", () => {
    if (!hullTrack) throw new Error("no hull track");
    const t = new TrackClock();
    t.advance(0);
    // place() steps the hull's track by the distance it moved, then reads the
    // guns' points at the frame it returned.
    const metres = (12.5 * hullTrack.period) / 8192;
    let frame = t.frameOf(9, 3, hullTrack, 0, 0, 0);
    for (let x = 0.02; x <= metres; x += 0.02) {
      t.advance(1 / 60);
      frame = t.frameOf(9, 3, hullTrack, x, 0, 0);
    }
    expect(frame).toBe(12);
    const at = gunPointOf(gunPointTable(joke.guns), 0, frame, new THREE.Vector3());
    // The glb's (x, y, z) baked onto the sim's +x forward: (z, y, -x).
    expect(at.x).toBeCloseTo(0.207031, 6);
    expect(at.y).toBeCloseTo(1.662109, 6);
    expect(at.z).toBeCloseTo(0.277344, 6);
  });
});

describe("the tracks the units play (RE cact_anim_step)", () => {
  test("the table's tracks: Joke's wing beat, its tank and hull by distance", () => {
    const morph = (mapId: string, file: string) =>
      UNIT_MODEL_FILES.find((f) => f.file === file && f.usedBy.includes(mapId))?.morph;
    const joke = ARENA_UNITS["bug-hunt"];
    // Joke's jet is a skeleton: 15 frames at 10/300 s, baked to targets.
    expect(morph("bug-hunt", joke.jet.model)).toEqual({
      frames: 15,
      period: 10,
      drivenBy: "time",
      source: "skeleton",
    });
    // Its tank (Cobj 31) a frame per 575 world units, its hull (35) per 775.
    expect(morph("bug-hunt", joke.tank.model)).toEqual({
      frames: 14,
      period: 575,
      drivenBy: "distance",
      source: "morph",
    });
    expect(morph("bug-hunt", joke.dreadnought.hull)).toEqual({
      frames: 20,
      period: 775,
      drivenBy: "distance",
      source: "morph",
    });
    // Mp's rotor: tracks 0 and 1 link to each other over the same frames.
    expect(morph("la-cantina", ARENA_UNITS["la-cantina"].jet.model)).toEqual({
      frames: 3,
      period: 10,
      drivenBy: "time",
      source: "morph",
    });
    // Every other arena's tank and hull stand still: their models have one frame.
    for (const [mapId, u] of Object.entries(ARENA_UNITS)) {
      if (mapId === "bug-hunt") continue;
      expect(morph(mapId, u.tank.model) ?? null).toBeNull();
      expect(morph(mapId, u.dreadnought.hull) ?? null).toBeNull();
    }
  });

  const rotor = { frames: 3, period: 10, drivenBy: "time", source: "morph" } as const;
  const tread = { frames: 14, period: 575, drivenBy: "distance", source: "morph" } as const;

  test("a time track starts at frame 0 where the actor is first drawn", () => {
    const t = new TrackClock();
    t.advance(1); // a second of sim time before the jet appears
    expect(t.frameOf(7, 2, rotor, 0, 0, 0)).toBe(0);
    // 10/300 s a frame: 0.05 s is frame 1, 0.07 s frame 2, 0.1 s back to 0.
    t.advance(0.05);
    expect(t.frameOf(7, 2, rotor, 0, 0, 0)).toBe(1);
    t.advance(0.02);
    expect(t.frameOf(7, 2, rotor, 0, 0, 0)).toBe(2);
    t.advance(0.03);
    expect(t.frameOf(7, 2, rotor, 0, 0, 0)).toBe(0);
    // A second jet built now starts its own track at frame 0.
    expect(t.frameOf(8, 2, rotor, 5, 0, 5)).toBe(0);
    // A paused match stops the clock.
    t.advance(0);
    expect(t.frameOf(7, 2, rotor, 0, 0, 0)).toBe(0);
  });

  test("a distance track steps a frame per period travelled, not per second", () => {
    const t = new TrackClock();
    t.advance(0);
    expect(t.frameOf(3, 1, tread, 0, 0, 0)).toBe(0);
    // Standing still for a while: no frame passes.
    for (let i = 0; i < 30; i++) {
      t.advance(1 / 30);
      expect(t.frameOf(3, 1, tread, 0, 0, 0)).toBe(0);
    }
    // 575 world units is 0.0702 m: 0.1 m is one frame, past it.
    t.advance(1 / 30);
    expect(t.frameOf(3, 1, tread, 0.1, 0, 0)).toBe(1);
    // 14 frames are 0.983 m; a metre more, in 5 cm steps, wraps to frame 1 again.
    let x = 0.1;
    let frame = 1;
    for (let i = 0; i < 20; i++) {
      x += 0.05;
      t.advance(1 / 30);
      frame = t.frameOf(3, 1, tread, x, 0, 0);
    }
    const travelled = (x * 8192) / 575;
    expect(frame).toBe(Math.floor(travelled - 1e-9) % 14);
  });

  test("an id drawn again after a gap, or as another unit, is a new actor", () => {
    const t = new TrackClock();
    t.advance(0);
    t.frameOf(5, 1, tread, 0, 0, 0);
    t.advance(0.1);
    expect(t.frameOf(5, 1, tread, 0.2, 0, 0)).toBe(2);
    // Not drawn for a frame (it died), then drawn again: the track starts over.
    t.advance(0.1);
    t.advance(0.1);
    expect(t.frameOf(5, 1, tread, 0.4, 0, 0)).toBe(0);
    // The same id drawn as another archetype is another actor too.
    t.advance(0.1);
    expect(t.frameOf(5, 2, rotor, 0.4, 0, 0)).toBe(0);
    // A jump of metres in one frame is a respawn, not travel.
    t.advance(0.1);
    t.frameOf(5, 2, rotor, 0.4, 0, 0);
    t.advance(0.1);
    t.frameOf(5, 1, tread, 0.4, 0, 0);
    t.advance(0.1);
    expect(t.frameOf(5, 1, tread, 30, 0, 0)).toBe(0);
  });
});

describe("a round's model plays its track (RE missile_step_anim 0x004232c2)", () => {
  const k9 = { frames: 11, period: 870, drivenBy: "distance", source: "morph" } as const;
  /** A geometry with `targets` morph targets, as gen:units keeps them. */
  function morphed(targets: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    g.morphAttributes.position = Array.from(
      { length: targets },
      () => new THREE.BufferAttribute(new Float32Array(9), 3),
    );
    g.morphTargetsRelative = true;
    return g;
  }

  test("the root's `fcop.track` is played only on a model that kept its frames", () => {
    const extras = { fcop: { track: { frames: 11, period: 870, drivenBy: "distance" } } };
    expect(roundTrackOf(extras, morphed(10))).toEqual(k9);
    expect(roundTrackOf(extras, morphed(0))).toBeNull();
    expect(roundTrackOf({ fcop: {} }, morphed(10))).toBeNull();
  });

  test("the K-9 Drone runs a frame per 870 world units it flies, each from its launch", () => {
    const scene = new THREE.Scene();
    const greybox = createGreyboxMeshes(scene);
    const units = createArenaUnits(scene, greybox);
    units.playTrack(greybox.projK9, morphed(10), k9);
    const texture = greybox.projK9.mesh.morphTexture;
    if (!texture) throw new Error("no morph texture");
    const rows = texture.image.data as Float32Array;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const guns = new Float32Array(8);
    const frameAt = (x: number, slot = 0, id = 9): number => {
      pos.set(x, 1, 5);
      units.place(greybox.projK9, slot, id, ARCHETYPE.PROJECTILE, 0, x, 5, pos, quat, scale, guns);
      const row = rows.subarray(slot * 11, slot * 11 + 11);
      expect(row[0]).toBe(1);
      return row.findIndex((v, k) => k > 0 && v === 1);
    };
    units.begin(1 / 30);
    expect(frameAt(0)).toBe(-1); // frame 0: no target on
    units.end();
    // 0.11 m is 901 world units: one frame on.
    units.begin(1 / 30);
    expect(frameAt(0.11)).toBe(1);
    units.end();
    // Eleven frames, 1.17 m, and it loops: 1.3 m in all is 1302 wu past the loop.
    let x = 0.11;
    let frame = 1;
    for (let i = 0; i < 12; i++) {
      x += 0.1;
      units.begin(1 / 30);
      frame = frameAt(x);
      units.end();
    }
    const want = Math.floor((x * 8192) / 870 - 1e-9) % 11;
    expect(frame === -1 ? 0 : frame).toBe(want);
  });
});
