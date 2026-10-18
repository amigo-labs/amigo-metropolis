// The arena's scenery as the original stands it (fcop-fidelity.md G2, G10):
// render/props.ts draws render/arenaScenery.generated.ts, which gen:scenery reads
// out of each mission's type-11 records and scripts. These pin what a
// screenshot cannot: the yaw convention, the heights the records' layers give,
// and which model stands at an outpost before and after its claim.

import { describe, expect, test } from "bun:test";
import { getMapById, resolveHeight } from "@metropolis/sim";
import * as THREE from "three";
import { SCENERY_PLACEMENTS, type SceneryPlacement } from "../src/render/arenaScenery.generated";
import { ARENA_UNITS } from "../src/render/arenaUnits.generated";
import { propMatrices, propMorphFrame, propShown, propTurn } from "../src/render/props";

const UP = new THREE.Vector3(0, 1, 0);

/** Where three puts the model's +z for a record's yaw, as a sim (x, y) heading. */
function heading(yaw: number): [number, number] {
  const v = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, propTurn(yaw));
  return [v.x, v.z];
}

describe("a record's yaw", () => {
  test("carries the model's +z onto the sim's (cos yaw, sin yaw), as My(yaw) does", () => {
    // RE fcop/matrix.h: My(a) carries +Z toward +X, the game's x is the sim's
    // y and its z the sim's x. 4096 a turn.
    for (const yaw of [0, 512, 1024, 1536, 2048, 2560, 3072, 3584]) {
      const a = (yaw * 2 * Math.PI) / 4096;
      const [x, y] = heading(yaw);
      expect(x).toBeCloseTo(Math.cos(a), 9);
      expect(y).toBeCloseTo(Math.sin(a), 9);
    }
  });

  test("is the turn a unit of the same sim yaw is drawn with", () => {
    // A unit bakes a quarter turn into its geometry and turns by -yaw
    // (unitMeshes.ts, main.ts): the same rotation, so a prop and a unit of one
    // heading face one way.
    for (const yaw of [0, 1024, 2048, 3072, 700]) {
      const a = (yaw * 2 * Math.PI) / 4096;
      const unit = new THREE.Quaternion()
        .setFromAxisAngle(UP, -a)
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2));
      const prop = new THREE.Quaternion().setFromAxisAngle(UP, propTurn(yaw));
      expect(Math.abs(unit.dot(prop))).toBeCloseTo(1, 9);
    }
  });

  test("the base terminals stand mirror images about the base's middle", () => {
    // Mp's Dreadnought and Flying Fortress terminals (Csac 50/52 and 54/56)
    // flank each base's lane: mirrored positions, mirrored headings.
    const p = SCENERY_PLACEMENTS["la-cantina"].placements;
    const at = (record: string) => {
      const q = p.find((r) => r.record === record);
      if (!q) throw new Error(record);
      return q;
    };
    for (const [l, r] of [
      ["Csac 50", "Csac 52"],
      ["Csac 54", "Csac 56"],
    ]) {
      const [a, b] = [at(l), at(r)];
      const mid = (a.x + b.x) / 2;
      const [ax, ay] = heading(a.yaw);
      const [bx, by] = heading(b.yaw);
      expect(Math.sign(mid - a.x)).toBe(Math.sign(ax));
      expect(Math.sign(mid - b.x)).toBe(Math.sign(bx));
      expect(ax).toBeCloseTo(-bx, 9);
      expect(ay).toBeCloseTo(by, 9);
    }
  });
});

describe("where the records stand", () => {
  test("every placement stands where its map's import put the same model", () => {
    // Two readings of the same records: enrichArena's `props` and gen:scenery's
    // table must agree on where every model is, record for record.
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      const map = getMapById(mapId);
      expect(scenery.placements.length).toBe(map.props.length);
      for (const p of scenery.placements) {
        const same = map.props.filter(
          (q) => q.model === p.cobj && Math.hypot(q.x - p.x, q.y - p.y) < 0.001,
        );
        expect({ mapId, record: p.record, found: same.length }).toEqual({
          mapId,
          record: p.record,
          found: 1,
        });
      }
    }
  });

  test("La Cantina's flags stand on the outposts' platforms, not inside them", () => {
    // RE turret_part.c: layer byte 0 is the topmost surface. The outposts'
    // corner flags stand on the platforms at 0.66-1.0 m; the sim's ground under
    // them is the floor 1.5-3 m below, where the flags used to stand.
    const map = getMapById("la-cantina");
    const flags = SCENERY_PLACEMENTS["la-cantina"].placements.filter((p) => p.cobj === 28);
    expect(flags.length).toBe(16);
    for (const f of flags) {
      expect(f.h).toBeGreaterThan(0.6);
      expect(f.h).toBeLessThanOrEqual(1);
      expect(f.h - resolveHeight(map, f.x, f.y, 0)).toBeGreaterThan(0.7);
    }
  });

  test("every arena's flags, Hk's kiosks too, stand on their decks", () => {
    // The flags with a surface above the ground were drawn under it on
    // proving-ground, bug-hunt and hollywood-keys as well; Hk's base kiosks
    // and terminals stand on the bases' deck at -0.97 m, two metres up.
    const raised = (mapId: string) => {
      const map = getMapById(mapId);
      return SCENERY_PLACEMENTS[mapId].placements.filter(
        (p) => p.h - resolveHeight(map, p.x, p.y, 0) > 0.3,
      );
    };
    expect(raised("la-cantina").map((p) => p.cobj)).toEqual(new Array(16).fill(28));
    expect(raised("proving-ground").length).toBe(8);
    expect(raised("bug-hunt").length).toBe(8);
    const hk = raised("hollywood-keys");
    expect(hk.filter((p) => p.cobj === 28).length).toBe(16);
    expect(hk.filter((p) => p.cobj !== 28).every((p) => p.h === -0.9687)).toBe(true);
    expect(hk.length).toBe(24);
    expect(raised("urban-jungle")).toEqual([]);
    expect(raised("venice-beach")).toEqual([]);
  });

  test("the matrices stand each model's origin at its record and turn it by its yaw", () => {
    const p = SCENERY_PLACEMENTS["la-cantina"].placements.slice(0, 3);
    const m = propMatrices(p);
    const matrix = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    p.forEach((r, i) => {
      matrix.fromArray(m, i * 16).decompose(pos, q, s);
      expect([pos.x, pos.y, pos.z]).toEqual([Math.fround(r.x), Math.fround(r.h), Math.fround(r.y)]);
      const want = new THREE.Quaternion().setFromAxisAngle(UP, propTurn(r.yaw));
      expect(Math.abs(q.dot(want))).toBeCloseTo(1, 6);
    });
  });
});

describe("an outpost before and after its claim", () => {
  const flagCobj = 28;

  test("four flags, one console until the claim, two terminals from it", () => {
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      const map = getMapById(mapId);
      expect(ARENA_UNITS[mapId].outpostFlag.cobj).toBe(flagCobj);
      map.outposts.forEach((o, k) => {
        const of = (f: (p: SceneryPlacement) => boolean) =>
          scenery.placements.filter((p) => p.outpost === k && f(p));
        const flags = of((p) => p.cobj === flagCobj);
        const consoles = of((p) => p.show === "unclaimed");
        const terminals = of((p) => p.show === "claimed");
        expect({ mapId, k, flags: flags.length }).toEqual({ mapId, k, flags: 4 });
        expect(flags.every((p) => p.show === "always")).toBe(true);
        expect(consoles.map((p) => p.cobj)).toEqual([29]);
        expect(terminals.length).toBe(2);
        // The console is on the pad the outpost is bought at; the terminals
        // at the activation spot (tanks) and the claim spot (jets).
        const [c] = consoles;
        const spot = map.outpostSpots[k];
        expect(Math.hypot(c.x - spot.x, c.y - spot.y)).toBeLessThan(1);
        for (const pad of [o.tankPad, o.jetPad]) {
          const near = terminals.filter((t) => Math.hypot(t.x - pad.x, t.y - pad.y) < 0.8);
          expect({ mapId, k, near: near.length }).toEqual({ mapId, k, near: 1 });
        }
      });
      // Nothing else waits on a claim.
      const bound = scenery.placements.filter((p) => p.show !== "always");
      expect(bound.length).toBe(map.outposts.length * 3);
    }
  });

  test("on Mp the claim terminal is Cobj 33 and the activation terminal 27", () => {
    // RE pa_models.json `terminal`: 33 nearest the outpost_claim zone, 27 the
    // outpost_activation zone; 29 is the placed console the activation destroys.
    const map = getMapById("la-cantina");
    const p = SCENERY_PLACEMENTS["la-cantina"].placements;
    map.outposts.forEach((o, k) => {
      const at = (pad: { x: number; y: number }) =>
        p.find(
          (t) =>
            t.outpost === k && t.show === "claimed" && Math.hypot(t.x - pad.x, t.y - pad.y) < 0.8,
        );
      expect(at(o.tankPad)?.cobj).toBe(27);
      expect(at(o.jetPad)?.cobj).toBe(33);
    });
  });

  test("what stands when", () => {
    const p = (show: SceneryPlacement["show"]) => ({ show }) as SceneryPlacement;
    expect(propShown(p("always"), false)).toBe(true);
    expect(propShown(p("always"), true)).toBe(true);
    expect(propShown(p("unclaimed"), false)).toBe(true);
    expect(propShown(p("unclaimed"), true)).toBe(false);
    expect(propShown(p("claimed"), false)).toBe(false);
    expect(propShown(p("claimed"), true)).toBe(true);
  });
});

describe("the flags' cloth", () => {
  test("every arena's flag plays its six frames, a frame per 20/300 s", () => {
    for (const scenery of Object.values(SCENERY_PLACEMENTS)) {
      expect(scenery.morphs).toEqual({ 28: { frames: 6, period: 20 } });
    }
  });

  test("frame 0 at the mission's start, looping, every flag on the same frame", () => {
    const cloth = { frames: 6, period: 20 };
    expect(propMorphFrame(cloth, 0)).toBe(0);
    expect(propMorphFrame(cloth, 0.066)).toBe(0);
    expect(propMorphFrame(cloth, 0.067)).toBe(1);
    expect(propMorphFrame(cloth, 0.34)).toBe(5);
    expect(propMorphFrame(cloth, 0.4)).toBe(0);
    expect(propMorphFrame(cloth, 0.4 + 0.2)).toBe(3);
  });
});
