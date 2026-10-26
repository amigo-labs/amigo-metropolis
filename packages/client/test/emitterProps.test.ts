// The type-96 Props and type-97 DCSQuads in three (fcop-fidelity.md G13;
// render/emitterProps.ts, render/decals.ts): the orientation snd_emit_build
// and pyro_place give them, through the one mapping every record angle takes
// (render/recordYaw.ts), and the turn and frames snd_emit_draw_block steps.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { FCOP_ARENA_AUDIO } from "../src/audio/fcopAudio.generated";
import {
  SCENERY_PLACEMENTS,
  type SceneryProp,
  type SceneryQuad,
} from "../src/render/arenaScenery.generated";
import { quadGeometry, quadMatrix, quadRotation } from "../src/render/decals";
import { cellXOf, cellZOf } from "../src/render/drawWindow";
import {
  emitterCell,
  emitterCentre,
  emitterFrame,
  emitterHungAt,
  emitterMatrix,
  emitterOrientation,
  emitterPropAt,
  emitterYaw,
} from "../src/render/emitterProps";
import { recordTurn } from "../src/render/recordYaw";

const UP = new THREE.Vector3(0, 1, 0);

function prop(over: Partial<SceneryProp>): SceneryProp {
  return {
    record: "Cact 1",
    cobj: 61,
    x: 10,
    y: 20,
    h: 1.5,
    yaw: 0,
    pitch: 0,
    roll: 0,
    scale: [64, 64, 64],
    spin: 0,
    swing: 0,
    park: 0,
    anim: "none",
    period: 0,
    sound: 0,
    quad: 0xffff,
    leaf: -1,
    ...over,
  };
}

/** v * M + p in the game's frame, then three's (z, y, x): the original's placement. */
function original(m: number[][], v: THREE.Vector3): THREE.Vector3 {
  const c = [v.x, v.y, v.z];
  const w = [0, 1, 2].map((j) => c[0] * m[0][j] + c[1] * m[1][j] + c[2] * m[2][j]);
  return new THREE.Vector3(w[2], w[1], w[0]);
}

describe("the cell a Prop hangs in (snd_emit_build 0x0042f942..0x0042fa88)", () => {
  test("its box's centre, placed as its model is: the matrix's image of the centre", () => {
    const out = new Float32Array(2);
    const centre = [0.3, 0.7, 4] as const;
    for (const p of [
      prop({}),
      prop({ yaw: 1024 }),
      prop({ yaw: 300, pitch: 200, scale: [64, 80, 96] }),
    ]) {
      emitterCentre(p, centre, out);
      const at = new THREE.Vector3(...centre).applyMatrix4(emitterMatrix(p, new THREE.Matrix4()));
      expect(out[0]).toBeCloseTo(at.x, 5);
      expect(out[1]).toBeCloseTo(at.z, 5);
    }
  });

  test("a spinning Prop's orientation is flattened first", () => {
    const out = new Float32Array(2);
    // Tilted, the centre's height would swing it sideways; flattened it does not.
    emitterCentre(prop({ spin: 4, pitch: 512 }), [0, 2, 0], out);
    expect([out[0], out[1]]).toEqual([10, 20]);
  });

  test("22 Props hang in another cell than their origin's: lamps and arms reaching out", () => {
    const moved: Record<string, number> = {};
    for (const [mapId, t] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const p of t.props) {
        const [z, x] = emitterCell(t, p);
        if (z === cellZOf(p.x) && x === cellXOf(p.y)) continue;
        const key = `${mapId}/${p.cobj}`;
        moved[key] = (moved[key] ?? 0) + 1;
      }
    }
    expect(moved).toEqual({
      "proving-ground/66": 3,
      "proving-ground/65": 1,
      "bug-hunt/65": 3,
      "bug-hunt/64": 1,
      "hollywood-keys/61": 7,
      "hollywood-keys/62": 5,
      "hollywood-keys/68": 2,
    });
  });

  test("every emitter the audio lists is a Prop, found where it stands", () => {
    const out = new Float32Array(2);
    for (const [mapId, data] of Object.entries(FCOP_ARENA_AUDIO)) {
      const t = SCENERY_PLACEMENTS[mapId] ?? null;
      for (const e of data.emitters) {
        const p = t?.props.find(
          (q) => q.sound === e.sound && Math.abs(q.x - e.x) <= 0.01 && Math.abs(q.y - e.z) <= 0.01,
        );
        expect({ mapId, found: !!p }).toEqual({ mapId, found: true });
        if (!p || !t) continue;
        expect(emitterPropAt(t, e.x, e.z, e.sound)).toBe(p);
        const c = t.propModels[p.cobj].centre;
        emitterHungAt(t, e.x, e.z, e.sound, out);
        const want = emitterCentre(p, c, new Float32Array(2));
        expect([out[0], out[1]]).toEqual([want[0], want[1]]);
      }
    }
  });
});

describe("a Prop's footprint and quadtree (snd_emit_build 0x0042fa7f, gen:scenery)", () => {
  test("gen:scenery's anchor, in world units, hangs every Prop in the cell this one does", () => {
    // gen:scenery computes the footprint from its own anchor (exact 3DBB
    // halfwords, world units) and names the quadtree of that anchor's cell;
    // the client hangs the Prop by `emitterCell`. One cell, or the footprint
    // describes another cell's quarters.
    let n = 0;
    for (const [mapId, t] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const p of t.props) {
        expect(p.leaf, `${mapId} ${p.record}`).toBeGreaterThanOrEqual(0);
        const tree = t.leafTrees[p.leaf];
        expect([tree.cz, tree.cx], `${mapId} ${p.record}`).toEqual(emitterCell(t, p));
        n++;
      }
    }
    expect(n).toBe(89 + 75 + 75 + 151);
  });

  test("every footprint covers a quarter, and the trees are 21 pairs of distinct cells", () => {
    for (const [mapId, t] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const p of t.props) {
        expect(p.quad, `${mapId} ${p.record}`).toBeGreaterThan(0);
        expect(p.quad).toBeLessThanOrEqual(0xffff);
      }
      const cells = new Set(t.leafTrees.map((l) => `${l.cz},${l.cx}`));
      expect(cells.size).toBe(t.leafTrees.length);
      for (const l of t.leafTrees) expect(l.spheres.length).toBe(42);
    }
  });

  test("a footprint is its box about its anchor: a point Prop sets the one quarter it is in", () => {
    // Every quarter a footprint sets is one its anchor's box reaches: the box
    // about the client's anchor, widened by a quarter, contains each set
    // quarter's square (the half extents are not in the table, so this bounds
    // them by the model's own size, 8 m).
    for (const t of Object.values(SCENERY_PLACEMENTS)) {
      for (const p of t.props) {
        const c = t.propModels[p.cobj].centre;
        const at = emitterCentre(p, c, new Float32Array(2));
        const [cz, cx] = emitterCell(t, p);
        // The quarter the anchor itself stands in is always set: x along the
        // map's y, z along its x, at 0x8000 >> (4 x + z).
        const ax = Math.floor((at[1] - cx * 16) / 4);
        const az = Math.floor((at[0] - 16 - cz * 16) / 4);
        expect(p.quad & (0x8000 >> (4 * ax + az)), p.record).not.toBe(0);
        for (let e = 0; e < 16; e++) {
          if ((p.quad & (0x8000 >> e)) === 0) continue;
          const qx = e >> 2;
          const qz = e & 3;
          // Quarter (x, z): map y from cx * 16 + 4 qx, map x from 16 + cz * 16 + 4 qz.
          const mx = 16 + cz * 16 + qz * 4 + 2;
          const my = cx * 16 + qx * 4 + 2;
          expect(Math.abs(mx - at[0])).toBeLessThan(8 + 2);
          expect(Math.abs(my - at[1])).toBeLessThan(8 + 2);
        }
      }
    }
  });
});

describe("a Prop's matrix", () => {
  test("with a yaw only, is the one mapping's turn", () => {
    for (const yaw of [0, 220, 1024, 1738, 2582, 3500]) {
      const m = emitterMatrix(prop({ yaw }), new THREE.Matrix4());
      const want = new THREE.Matrix4().compose(
        new THREE.Vector3(10, 1.5, 20),
        new THREE.Quaternion().setFromAxisAngle(UP, recordTurn(yaw)),
        new THREE.Vector3(1, 1, 1),
      );
      m.elements.forEach((e, i) => {
        expect(e).toBeCloseTo(want.elements[i], 9);
      });
    }
  });

  test("lands every glb vertex where v * (scaled Mz Mx My) puts the Cobj's", () => {
    const p = prop({ yaw: 700, pitch: 24, roll: 90, scale: [23, 32, 51] });
    const m = emitterMatrix(p, new THREE.Matrix4());
    const o = emitterOrientation(p);
    for (const cobj of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0.3, 0.9, -0.2)]) {
      // The RE's glb is the Cobj with its x negated.
      const glb = new THREE.Vector3(-cobj.x, cobj.y, cobj.z);
      const got = glb.applyMatrix4(m);
      const want = original(o, cobj).add(new THREE.Vector3(10, 1.5, 20));
      expect(got.distanceTo(want)).toBeLessThan(1e-9);
    }
    // Not mirrored: the two mirrors cancel.
    expect(m.determinant()).toBeGreaterThan(0);
  });
});

describe("a spinning Prop", () => {
  test("turns clock * spin, and a negative spin one unit short of the mirror", () => {
    expect(emitterYaw(8, 0, 0, 0)).toBe(0);
    expect(emitterYaw(8, 0, 0, 100)).toBe(800);
    expect(emitterYaw(8, 0, 0, 600)).toBe(4800 - 4096);
    // 0xfff - ((-(clock * spin)) & 0xfff) = (clock * spin - 1) & 0xfff.
    expect(emitterYaw(-2, 0, 0, 100)).toBe((4096 - 200 - 1) & 0xfff);
    expect(emitterYaw(-2, 0, 0, 0)).toBe(0xfff);
  });

  test("with a swing, rocks about its park and back", () => {
    // spin 8, 60 degrees (682): over one sweep of the spin's angle the swing
    // runs 0 -> -amp/2 -> 0 -> +amp/2 -> 0, doubled: +-amp about the park.
    const at = (now: number) => emitterYaw(8, 682, 1024, now);
    expect(at(0)).toBe(1024);
    const sweep = Array.from({ length: 512 }, (_, k) => {
      const a = at(k);
      return a > 2048 ? a - 4096 : a;
    });
    expect(Math.min(...sweep)).toBeGreaterThanOrEqual(1024 - 682);
    expect(Math.max(...sweep)).toBeLessThanOrEqual(1024 + 682);
    expect(Math.min(...sweep)).toBeLessThan(1024 - 600);
    expect(Math.max(...sweep)).toBeGreaterThan(1024 + 600);
  });
});

describe("a Prop's frames", () => {
  test("loop one per period, or go there and back", () => {
    const loop = prop({ anim: "loop", period: 37 });
    expect([0, 36, 37, 37 * 8, 37 * 9].map((n) => emitterFrame(loop, 9, n))).toEqual([
      0, 0, 1, 8, 0,
    ]);
    const back = prop({ anim: "boomerang", period: 10 });
    expect([0, 10, 30, 40, 50, 60, 80].map((n) => emitterFrame(back, 5, n))).toEqual([
      0, 1, 3, 4, 3, 2, 0,
    ]);
    expect(emitterFrame(prop({}), 9, 1000)).toBe(0);
  });
});

function quadOf(over: Partial<SceneryQuad>): SceneryQuad {
  return {
    record: "Cact 2",
    decal: 1,
    x: 3,
    y: 4,
    h: 1.2,
    yaw: 0,
    pitch: 0,
    roll: 0,
    halfX: 1.6,
    halfZ: 0.8,
    tint: [64, 64, 64],
    blend: 2,
    twoSided: false,
    ...over,
  };
}

describe("a DCSQuad", () => {
  test("stands its corners where pyro_place turns them", () => {
    for (const yaw of [0, 545, 1235, 3333]) {
      const q = quadOf({ yaw });
      const m = quadMatrix(q, new THREE.Matrix4());
      const a = (yaw * 2 * Math.PI) / 4096;
      const my = [
        [Math.cos(a), 0, -Math.sin(a)],
        [0, 1, 0],
        [Math.sin(a), 0, Math.cos(a)],
      ];
      // Corner (-x, +z) of the quad's own frame, three's (z, 0, x) unit corner.
      const corner = new THREE.Vector3(-q.halfX, 0, q.halfZ);
      const want = original(my, corner).add(new THREE.Vector3(q.x, q.h, q.y));
      const got = new THREE.Vector3(1, 0, -1).applyMatrix4(m);
      expect(got.distanceTo(want)).toBeLessThan(1e-9);
      expect(quadRotation(q, new THREE.Matrix4()).determinant()).toBeCloseTo(1, 9);
    }
  });

  test("faces up, the rect's (u, v) on corner (-x, +z)", () => {
    const g = quadGeometry({ file: "dcs-01.png", w: 63, h: 64 });
    const p = g.getAttribute("position");
    const idx = g.getIndex();
    if (!idx) throw new Error("no index");
    const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx.getX(i));
    const n = v(1)
      .sub(v(0))
      .cross(v(2).sub(v(0)));
    expect(n.y).toBeGreaterThan(0);
    const uv = g.getAttribute("uv");
    expect([uv.getX(0), uv.getY(0)]).toEqual([0, 1]);
    expect(uv.getX(1)).toBeCloseTo(62 / 63, 6);
  });

  test("on Slim, Joke and Hk: the additive haze of one cloud each", () => {
    for (const id of ["proving-ground", "bug-hunt", "hollywood-keys"]) {
      const s = SCENERY_PLACEMENTS[id];
      expect(Object.keys(s.decals).length).toBe(1);
      for (const q of s.quads) {
        expect([q.blend, q.twoSided, q.pitch, q.roll]).toEqual([2, false, 0, 0]);
        expect(q.halfX).toBeGreaterThan(1.3);
      }
    }
  });
});
