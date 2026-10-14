// Contract test for the COMMITTED Precinct Assault rule data
// (tools/generators/fcop/<mission>-rules.json, written by fcopRules.ts from the
// RE repo's tools/logic/pa_rules_data.py).
//
// Two jobs, as for the logic artifact:
//   1. The two artifacts describe the same records: the X1Alphas, the shop
//      triggers and the pickups carry the same ids and positions in both, so the
//      enrich stage can pair them by id.
//   2. Pin the values the RE file's own check pins (tests/pa_rules_data_check.py):
//      a regenerated artifact that moves one of them is a different reading of
//      the original, and has to say so here.

import { describe, expect, test } from "bun:test";
import conftLogic from "../fcop/conft-logic.json";
import conftRules from "../fcop/conft-rules.json";
import hkLogic from "../fcop/hk-logic.json";
import hkRules from "../fcop/hk-rules.json";
import jokeLogic from "../fcop/joke-logic.json";
import jokeRules from "../fcop/joke-rules.json";
import mpLogic from "../fcop/mp-logic.json";
import mpRules from "../fcop/mp-rules.json";
import ovmpLogic from "../fcop/ovmp-logic.json";
import ovmpRules from "../fcop/ovmp-rules.json";
import slimLogic from "../fcop/slim-logic.json";
import slimRules from "../fcop/slim-rules.json";
import type { FcopRules } from "../fcopRules";

interface LogicLike {
  mission: string;
  spawns: { id: number; x: number; z: number }[];
  pickups: { id: number; x: number; z: number }[];
  triggers: { id: number; x: number; z: number; widthRaw: number; lengthRaw: number }[];
}

const PAIRS: [LogicLike, FcopRules][] = [
  [mpLogic, mpRules as FcopRules],
  [conftLogic, conftRules as FcopRules],
  [slimLogic, slimRules as FcopRules],
  [jokeLogic, jokeRules as FcopRules],
  [hkLogic, hkRules as FcopRules],
  [ovmpLogic, ovmpRules as FcopRules],
];

describe("committed rule artifacts", () => {
  for (const [logic, rules] of PAIRS) {
    describe(rules.mission, () => {
      test("names its arena and its source", () => {
        expect(rules.mission).toBe(logic.mission);
        expect(rules.source.repo).toBe("amigo-labs/fcop-reverse-engineering");
        expect(rules.source.commit).toMatch(/^[0-9a-f]{40}$/);
      });

      test("carries the logic artifact's X1Alphas, slot 0 = actor 12", () => {
        expect(rules.x1alpha.map((x) => [x.id, x.slot])).toEqual([
          [12, 0],
          [16, 1],
        ]);
        for (const x of rules.x1alpha) {
          const s = logic.spawns.find((p) => p.id === x.id);
          expect(s).toBeDefined();
          expect(x.x).toBeCloseTo(s?.x ?? Number.NaN, 3);
          expect(x.z).toBeCloseTo(s?.z ?? Number.NaN, 3);
          // A negative facing is the hover flag, never a direction.
          expect(x.hover).toBe(x.facingRaw < 0);
        }
      });

      test("sells at the logic artifact's trigger boxes", () => {
        expect(rules.buyTriggers.length).toBe(4);
        for (const b of rules.buyTriggers) {
          const t = logic.triggers.find((p) => p.id === b.id);
          expect(t).toBeDefined();
          expect([b.widthRaw, b.lengthRaw]).toEqual([t?.widthRaw ?? -1, t?.lengthRaw ?? -1]);
        }
      });

      test("places its pickups where the logic artifact does", () => {
        for (const p of rules.pickups) {
          const q = logic.pickups.find((r) => r.id === p.template);
          expect(q).toBeDefined();
          expect(p.x).toBeCloseTo(q?.x ?? Number.NaN, 3);
          expect(p.z).toBeCloseTo(q?.z ?? Number.NaN, 3);
        }
      });

      test("asks only for spawners it carries", () => {
        const have = new Set(rules.spawners.map((s) => s.template));
        for (const q of rules.queues) expect(have.has(q.template)).toBe(true);
        for (const z of rules.heavyZones) expect(have.has(z.template)).toBe(true);
        for (const b of rules.buyTriggers) expect(have.has(b.template)).toBe(true);
      });

      test("has one Dreadnought and one Fortress zone a slot, 50 points each", () => {
        expect(rules.heavyZones.map((z) => [z.slot, z.unit, z.price])).toEqual([
          [0, "dreadnought", 50],
          [0, "flying_fortress", 50],
          [1, "dreadnought", 50],
          [1, "flying_fortress", 50],
        ]);
        expect(rules.heavyEnable.map((e) => e.pointsAtLeast)).toEqual([50, 50]);
      });
    });
  }
});

describe("pinned values (pa_rules_data_check.py)", () => {
  test("Mp's mechs face each other along z; Conft's start along x", () => {
    expect(mpRules.x1alpha.map((x) => x.facingRaw)).toEqual([3072, 1024]);
    expect(conftRules.x1alpha.map((x) => x.facingRaw)).toEqual([0, 2048]);
  });

  test("only Hk spawns in hover form", () => {
    expect(hkRules.x1alpha.map((x) => x.facingRaw)).toEqual([-3072, -1024]);
    for (const r of [mpRules, conftRules, slimRules, jokeRules, ovmpRules]) {
      expect(r.x1alpha.every((x) => !x.hover)).toBe(true);
    }
  });

  test("Mp's base tanks queue at 202 and 203 units", () => {
    const base = mpRules.queues.filter((q) => q.kind === "tank" && q.outpost === null);
    expect(base.map((q) => [q.slot, q.periodUnits])).toEqual([
      [0, 202],
      [1, 203],
    ]);
  });

  test("the heavy zones poll every 5 s, 2.5 s on Joke and Slim", () => {
    expect(mpRules.heavyEnable.map((e) => e.pollUnits)).toEqual([300, 305]);
    expect(slimRules.heavyEnable.map((e) => e.pollUnits)).toEqual([150, 153]);
    expect(jokeRules.heavyEnable.map((e) => e.pollUnits)).toEqual([150, 153]);
  });

  test("lifts: Conft four, Slim and Joke two on the spawns, two stops 921 raw apart", () => {
    expect(conftRules.lifts.length).toBe(4);
    expect(mpRules.lifts.length + hkRules.lifts.length + ovmpRules.lifts.length).toBe(0);
    for (const r of [slimRules, jokeRules]) {
      expect(r.lifts.map((l) => l.tag).sort()).toEqual([14, 15]);
      for (const l of r.lifts) expect(l.stopsRaw).toEqual([0, 921]);
    }
  });

  test("only Hk and Ovmp carry water; every other arena's floors are 14 and 15", () => {
    expect(hkRules.surface.waterLevels.length).toBeGreaterThan(0);
    expect(ovmpRules.surface.waterLevels.length).toBeGreaterThan(0);
    for (const r of [mpRules, conftRules, slimRules, jokeRules]) {
      expect(r.surface.waterLevels.length).toBe(0);
      expect(r.damageFloors.map((f) => [f.code, f.hurtsSlot])).toEqual([
        [14, 0],
        [15, 1],
      ]);
    }
    expect(hkRules.damageFloors.length).toBe(0);
    expect(hkRules.spawnGuards.map((g) => [g.id, g.hurtsSlot, g.damage])).toEqual([
      [377, 0, 25],
      [378, 1, 25],
    ]);
  });

  test("every pickup is collected inside a +-4 m (x) by +-1.6 m (z, y) box", () => {
    for (const r of [mpRules, conftRules, slimRules, jokeRules, hkRules, ovmpRules]) {
      for (const p of r.pickups) expect(p.halfRaw).toEqual([819, 819, 2048]);
    }
  });
});
