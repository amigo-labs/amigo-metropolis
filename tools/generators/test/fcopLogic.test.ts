// Contract test for the COMMITTED original Precinct Assault logic
// (tools/generators/fcop/mp-logic.json) and for the raw-unit conversions that
// interpret it.
//
// Two jobs:
//   1. Pin the data. The arena generator turns this into packages/sim/maps/
//      la-cantina.json, so a silently truncated or reordered artifact would
//      silently reshape the arena. The counts and the team symmetry below are
//      exactly the structure docs/specs/fcop-logic.md §8 describes, so this is
//      also a check that the decode still means what the spec says.
//   2. Pin the INFERRED scales. Positions and rotations are documented, but the
//      distance and timing scales are derived in fcopLogic.ts from geometry.
//      They are load-bearing for balance, so they get explicit expectations with
//      the reasoning attached rather than living only in a comment.

import { describe, expect, test } from "bun:test";
import logic from "../fcop/mp-logic.json";
import {
  fovToCos,
  ROTATION_TURN,
  rangeToCells,
  rotToYaw,
  toSimTicks,
  turnSpeedToRadPerTick,
} from "../fcopLogic";

/** packages/sim/src/balance.ts TICK_HZ — duplicated so this stays dep-free. */
const TICK_HZ = 30;

describe("committed Mp logic artifact", () => {
  test("identifies its source", () => {
    expect(logic.mission).toBe("Mp");
    expect(logic.mapId).toBe("la-cantina");
    expect(logic.source.repo).toBe("amigo-labs/fcop-reverse-engineering");
    // A real 40-hex sha, so the artifact can always be traced to an extraction.
    expect(logic.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("carries the full Precinct Assault actor set", () => {
    expect(logic.spawns.length).toBe(2);
    expect(logic.bases.length).toBe(2);
    expect(logic.turrets.length).toBe(32);
    expect(logic.neutrals.length).toBe(32);
    expect(logic.pickups.length).toBe(8);
    expect(logic.triggers.length).toBe(30);
    expect(logic.units.length).toBe(10);
    expect(logic.aircraft.length).toBe(12);
    expect(logic.props.length).toBe(36);
    expect(logic.nets.length).toBe(2);
    expect(logic.nets.map((n) => n.nodes.length)).toEqual([143, 140]);
  });

  test("is ordered deterministically by actor id", () => {
    for (const group of [logic.turrets, logic.neutrals, logic.pickups, logic.triggers]) {
      const ids = group.map((a) => a.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
    expect(logic.nets.map((n) => n.netId)).toEqual([1, 2]);
  });

  // fcop-logic.md §8.1: 2 per arena, team-symmetric, HP 3000, 4 built-in
  // defence weapons, 5 s cadence, each bound to its own Cnet.
  test("bases match the TeamBase model in fcop-logic.md §8.1", () => {
    expect(logic.bases.map((b) => b.team).sort()).toEqual([1, 2]);
    for (const base of logic.bases) {
      expect(base.health).toBe(3000);
      expect(base.spawnTicks).toBe(300);
      expect(toSimTicks(base.spawnTicks, TICK_HZ)).toBe(150); // 5 s
      expect(base.spawnLimit).toBe(1);
      expect(base.defenceWeaponCount).toBe(4);
      expect(base.defenceWeapon.engageRangeRaw).toBe(6144);
      expect(base.defenceWeapon.targetingDelayRaw).toBe(16);
      // Each base drives its own lane graph, so the two nets are the two teams'.
      expect([1, 2]).toContain(base.netId);
    }
    expect(logic.bases[0].netId).not.toBe(logic.bases[1].netId);
  });

  test("turrets are team-symmetric and capturables are neutral", () => {
    const teams = logic.turrets.filter((t) => t.team === 1).length;
    expect(teams).toBe(16);
    expect(logic.turrets.filter((t) => t.team === 2).length).toBe(16);
    for (const t of logic.neutrals) expect(t.team).toBe(0);
    for (const t of [...logic.turrets, ...logic.neutrals]) {
      expect(t.health).toBe(500);
      expect(t.shooter.engageRangeRaw).toBe(6144);
      expect(t.turnSpeedRaw).toBe(2457);
    }
  });

  test("each net's node 0 sits on its own base", () => {
    // fcop-logic.md §8.1: the base is bound to its Cnet, and the graph starts
    // there. This is the invariant that makes "base -> lane -> enemy base" work.
    for (const base of logic.bases) {
      const net = logic.nets.find((n) => n.netId === base.netId);
      expect(net).toBeDefined();
      const node = net?.nodes[0];
      expect(Math.abs((node?.x ?? 0) - base.x)).toBeLessThan(0.5);
      expect(Math.abs((node?.z ?? 0) - base.z)).toBeLessThan(0.5);
    }
  });

  test("net adjacency is a fixed stride of 4 with -1 for absent edges", () => {
    for (const net of logic.nets) {
      for (const [i, node] of net.nodes.entries()) {
        expect(node.neighbours.length).toBe(4);
        for (const nb of node.neighbours) {
          expect(nb === -1 || (nb >= 0 && nb < net.nodes.length)).toBe(true);
          expect(nb).not.toBe(i); // no self-loops
        }
      }
    }
  });

  test("every pickup grants exactly one distinct power-up", () => {
    // The 8 pickups are the 8 original grant kinds, one each — so mapping them
    // onto sim effects loses nothing.
    const kinds = logic.pickups.map(
      (p) => p.grants.filter((g) => g !== "is_set" && g !== "pickup_consume")[0],
    );
    expect(new Set(kinds).size).toBe(8);
    expect([...kinds].sort()).toEqual([
      "invisibility",
      "power_up_gun",
      "power_up_heavy",
      "power_up_special",
      "reload_gun",
      "reload_heavy",
      "reload_special",
      "restore_health",
    ]);
  });

  test("base-intrusion triggers watch named actors (fcop-logic.md §8.6)", () => {
    const watched = new Set(logic.triggers.map((t) => t.watchesActor));
    // Both X1Alpha players are watched, and so is each TeamBase.
    for (const s of logic.spawns) expect(watched.has(s.id)).toBe(true);
    for (const b of logic.bases) expect(watched.has(b.id)).toBe(true);
    for (const t of logic.triggers) expect(t.watchesActor).toBeGreaterThan(0);
  });
});

describe("inferred raw-unit conversions", () => {
  // The scale that matters most: every Mp shooter carries engage_range 6144.
  // 1024 is derived from placement geometry (all 64 turrets sit 1.9-8.4 cells
  // from a lane node, so the weapon's reach is short) plus the aircraft fields
  // (target_detection_range 28672 -> 28 cells, orbit_area 24576 -> 24 cells).
  // If this expectation ever changes, arena balance changes with it.
  test("engage_range 6144 is 6 cells", () => {
    expect(rangeToCells(6144)).toBe(6);
    expect(rangeToCells(4096)).toBe(4);
    expect(rangeToCells(5120)).toBe(5);
  });

  test("aircraft patrol figures land on a ~96-cell playfield", () => {
    expect(rangeToCells(28672)).toBe(28); // target_detection_range
    expect(rangeToCells(24576)).toBe(24); // orbit_area_x, light aircraft
    expect(rangeToCells(30720)).toBe(30); // orbit_area_x, heavy gunship
  });

  test("original 60 Hz tick counts halve into sim ticks", () => {
    expect(toSimTicks(300, TICK_HZ)).toBe(150); // 5 s production cadence
    expect(toSimTicks(32, TICK_HZ)).toBe(16); // turret fire cooldown
    expect(toSimTicks(16, TICK_HZ)).toBe(8); // base defence cooldown
    // Respawn delays are stored negative; magnitude is what counts.
    expect(toSimTicks(-1500, TICK_HZ)).toBe(750); // 25 s neutral turret
    expect(toSimTicks(-2250, TICK_HZ)).toBe(1125); // 37.5 s base turret
    expect(toSimTicks(-3000, TICK_HZ)).toBe(1500); // 50 s pickup
    // Never zero, or a cooldown would fire every tick.
    expect(toSimTicks(0, TICK_HZ)).toBe(1);
    expect(toSimTicks(1, TICK_HZ)).toBe(1);
  });

  test("rotation follows the documented 4096 = 360 degrees", () => {
    expect(ROTATION_TURN).toBe(4096);
    expect(rotToYaw(0)).toBeCloseTo(0, 10); // negative factor yields -0
    expect(rotToYaw(1024)).toBeCloseTo(-Math.PI / 2, 10);
    expect(rotToYaw(2048)).toBeCloseTo(-Math.PI, 10);
    // Turret rotations are biased by a quarter turn before conversion.
    expect(rotToYaw(1024, true)).toBeCloseTo(0, 10);
  });

  test("fov 4096 means omnidirectional", () => {
    // fovToCos returns cos(fov/2), the threshold a dot product is compared
    // against. Every Mp shooter carries fov 4096 — a full circle — so -1 ("no
    // restriction") is what the sim will actually see on this arena.
    expect(fovToCos(4096)).toBe(-1);
    expect(fovToCos(2048)).toBeCloseTo(0, 10); // 180° total -> cos(90°) = 0
    expect(fovToCos(1024)).toBeCloseTo(Math.SQRT1_2, 10); // 90° total -> cos(45°)
  });

  test("gun slew is positive and sane", () => {
    const slew = turnSpeedToRadPerTick(2457, TICK_HZ);
    expect(slew).toBeGreaterThan(0);
    // ~216 deg/s: a 90-degree turn in about half a second.
    expect(slew * TICK_HZ).toBeCloseTo(3.769, 2);
  });
});
