// The arena's scenery as the original stands it (fcop-fidelity.md G2, G10):
// render/props.ts draws render/arenaScenery.generated.ts, which gen:scenery reads
// out of each mission's type-11 records and scripts. These pin what a
// screenshot cannot: the yaw convention, the heights the records' layers give,
// and which model stands at an outpost before and after its claim.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMapById, resolveHeight } from "@metropolis/sim";
import * as THREE from "three";
import { SCENERY_PLACEMENTS, type SceneryPlacement } from "../src/render/arenaScenery.generated";
import { ARENA_UNITS } from "../src/render/arenaUnits.generated";
import { MAP_ALIGN } from "../src/render/mapAlign.generated";
import { propMatrices, propMorphFrame, propShown, terminalBaseOf } from "../src/render/props";
import { recordTurn } from "../src/render/recordYaw";

const UP = new THREE.Vector3(0, 1, 0);
/** The arena import's committed RE artifacts (gen:palogic, gen:parules). */
const FCOP_DIR = join(import.meta.dir, "..", "..", "..", "tools", "generators", "fcop");

/** Where three puts the model's +z for a record's yaw, as a sim (x, y) heading. */
function heading(yaw: number): [number, number] {
  const v = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, recordTurn(yaw));
  return [v.x, v.z];
}

// The yaw convention itself is pinned in recordYaw.test.ts and the screens'
// facing in tools/generators/test/kioskFacing.test.ts.
describe("a record's yaw", () => {
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
  test("every placement stands where the arena import's actors put the same model", () => {
    // Two readings of the same records: the RE's actor extraction that the arena
    // import reads (gen:palogic, tools/generators/fcop/<mission>-logic.json, its
    // type-11 `props`, moved into the sim's frame by the terrain's measured
    // shift) and gen:scenery's own read of the mission bytes must agree on where
    // every model is, record for record.
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      const align = MAP_ALIGN[mapId];
      const shiftX = align.x + align.minX;
      const shiftY = align.z + align.minZ;
      const logic = JSON.parse(
        readFileSync(join(FCOP_DIR, `${scenery.mission.toLowerCase()}-logic.json`), "utf8"),
      ) as { props: { x: number; z: number; objId: number }[] };
      const records = logic.props.map((q) => ({
        model: q.objId,
        x: q.x + shiftX,
        y: q.z + shiftY,
      }));
      expect(scenery.placements.length).toBe(records.length);
      for (const p of scenery.placements) {
        const same = records.filter(
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
      const want = new THREE.Quaternion().setFromAxisAngle(UP, recordTurn(r.yaw));
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

describe("a base's heavy terminals", () => {
  // fn30 / fn31 request two type-11 terminals when they open the base's
  // Dreadnought and Fortress zones (RE extracted/data/<Mission>/fun_code.txt):
  // the scenery table's always-standing records the sim's map names, drawn
  // only while MATCH_SLOT_TERMINALS says they stand.
  test("each base's two terminals, one by each of its heavy zones", () => {
    for (const [mapId, scenery] of Object.entries(SCENERY_PLACEMENTS)) {
      const map = getMapById(mapId);
      map.bases.forEach((b, t) => {
        const hz = b.heavyZones;
        if (!hz) throw new Error(`${mapId}: base ${t} has no heavy zones`);
        const mine = scenery.placements.filter((p) => terminalBaseOf(map, p) === t);
        expect({ mapId, t, n: mine.length }).toEqual({ mapId, t, n: 2 });
        expect(mine.map((p) => p.record).sort()).toEqual(
          hz.terminals.map((id) => `Csac ${id}`).sort(),
        );
        // Neither claim-bound nor an outpost's: the poll alone stands them.
        expect(mine.every((p) => p.show === "always" && p.outpost === -1)).toBe(true);
        for (const zone of [hz.juggernaut, hz.fortress]) {
          const near = mine.filter((p) => Math.hypot(p.x - zone.x, p.y - zone.y) < 0.6);
          expect({ mapId, t, near: near.length }).toEqual({ mapId, t, near: 1 });
        }
      });
    }
  });

  test("on Mp they are Cobj 34 (the Dreadnought's) and 35 (the Fortress's)", () => {
    const map = getMapById("la-cantina");
    const p = SCENERY_PLACEMENTS["la-cantina"].placements;
    for (let t = 0; t < 2; t++) {
      const hz = map.bases[t].heavyZones;
      if (!hz) throw new Error("no heavy zones");
      const at = (zone: { x: number; y: number }) =>
        p.find((q) => terminalBaseOf(map, q) === t && Math.hypot(q.x - zone.x, q.y - zone.y) < 0.6);
      expect(at(hz.juggernaut)?.cobj).toBe(34);
      expect(at(hz.fortress)?.cobj).toBe(35);
    }
  });

  test("nothing else is a base terminal", () => {
    const map = getMapById("la-cantina");
    const others = SCENERY_PLACEMENTS["la-cantina"].placements.filter(
      (p) => terminalBaseOf(map, p) < 0,
    );
    expect(others.some((p) => p.cobj === 34 || p.cobj === 35)).toBe(false);
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
