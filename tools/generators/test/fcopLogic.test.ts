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
//   2. Pin the scales. Positions and rotations are documented; the distance,
//      trigger, delay and slew scales were read from the retail code
//      (docs/specs/fcop-re/ranges-turrets-capture.md) and are applied in
//      fcopLogic.ts. They are load-bearing for balance, so they get explicit
//      expectations with the evidence attached rather than living only in a
//      comment.

import { describe, expect, test } from "bun:test";
import conftLogic from "../fcop/conft-logic.json";
import hkLogic from "../fcop/hk-logic.json";
import jokeLogic from "../fcop/joke-logic.json";
import logic from "../fcop/mp-logic.json";
import ovmpLogic from "../fcop/ovmp-logic.json";
import slimLogic from "../fcop/slim-logic.json";
import {
  fovToCos,
  orbitLeashToCells,
  orbitPatrolToCells,
  ROTATION_TURN,
  rangeToCells,
  rotToYaw,
  targetingDelayToSimTicks,
  toSimTicks,
  triggerHalfExtent,
  turnSpeedToRadPerTick,
  turnSpeedToUnitsPerEngineTick,
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
    expect(logic.dreadnoughts.length).toBe(2);
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

  // Type 28 is the Dreadnought, not a team base (fcop-re/ranges-turrets-capture.md
  // top + Q4; fcop-logic.md §8.1): 2 per arena, team-symmetric, 3000 HP, four
  // hull guns, a limit-1 spawner (5 s period, shut in PA), each driving its own
  // Cnet from node 0.
  test("type 28 matches the Dreadnought record in fcop-logic.md §8.1", () => {
    expect(logic.dreadnoughts.map((b) => b.team).sort()).toEqual([1, 2]);
    for (const d of logic.dreadnoughts) {
      expect(d.health).toBe(3000);
      expect(d.spawnTicks).toBe(300);
      expect(toSimTicks(d.spawnTicks, TICK_HZ)).toBe(150); // 5 s spawner period
      expect(d.spawnLimit).toBe(1);
      expect(d.gunCount).toBe(4);
      expect(d.gun.weaponId).toBe(3);
      expect(d.gun.engageRangeRaw).toBe(6144);
      expect(d.gun.targetingDelayRaw).toBe(16);
      // Its own route block: the same 1024/1228 a tank carries.
      expect(d.moveSpeed).toBe(1024);
      expect(d.acceleration).toBe(1228);
      // Each side's Dreadnought drives its own lane graph.
      expect([1, 2]).toContain(d.netId);
    }
    expect(logic.dreadnoughts[0].netId).not.toBe(logic.dreadnoughts[1].netId);
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

  test("each net's node 0 is where that side's Dreadnought spawns", () => {
    // fcop-logic.md §8.1: the Dreadnought is bound to its Cnet and starts at
    // node 0, next to the HQ. This is the invariant that makes "base -> lane ->
    // enemy base" work.
    for (const base of logic.dreadnoughts) {
      const net = logic.nets.find((n) => n.netId === base.netId);
      expect(net).toBeDefined();
      const node = net?.nodes[0];
      expect(Math.abs((node?.x ?? 0) - base.x)).toBeLessThan(0.5);
      expect(Math.abs((node?.z ?? 0) - base.z)).toBeLessThan(0.5);
    }
  });

  test("every net node carries its ground_cast surface selector", () => {
    // This field IS the node's elevation (fcop-logic.md §3.1) — actor `height` and
    // Cnet `height_offset` are 0.0 everywhere because Y is not stored as a number,
    // it is raycast against terrain, and this is the raycast's mode. It was decoded
    // by the extractor but dropped on the way into this artifact, which is what
    // made the elevation look absent from the data.
    for (const net of logic.nets) {
      for (const node of net.nodes) {
        expect(node.groundCast).toBeGreaterThanOrEqual(0);
        expect(node.groundCast).toBeLessThanOrEqual(3);
      }
    }
    // Mp: 10 LOW (5 per net, the four under-bridge road nodes plus one), rest HIGH.
    // Pinned because a regeneration that silently dropped the field again would
    // otherwise read as "all HIGH", which is a valid-looking arena on the flat.
    const tally = new Map<number, number>();
    for (const net of logic.nets) {
      for (const node of net.nodes) {
        tally.set(node.groundCast, (tally.get(node.groundCast) ?? 0) + 1);
      }
    }
    expect(tally.get(1)).toBe(10); // LOW
    expect(tally.get(0)).toBe(273); // HIGH
    expect(tally.get(3)).toBeUndefined(); // no MIDDLE on Mp
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
    // Both X1Alpha players are watched, and so is each Dreadnought.
    for (const s of logic.spawns) expect(watched.has(s.id)).toBe(true);
    for (const b of logic.dreadnoughts) expect(watched.has(b.id)).toBe(true);
    for (const t of logic.triggers) expect(t.watchesActor).toBeGreaterThan(0);
  });

  test("each base has one gate box, watching the enemy Dreadnought and tanks", () => {
    // fcop-re/ai-and-rules.md §5: the gate trigger set (no retrigger, no action
    // button) watches the enemy's five tank templates and its Dreadnought — not
    // jets, not the avatar. Entering it is the win. enrichArena reads the gate
    // from the one watching the Dreadnought.
    const gates = logic.triggers.filter(
      (t) => !t.flags.includes("retrigger") && !t.flags.includes("action_button"),
    );
    expect(gates.length).toBe(12); // 6 per base, one box
    for (const d of logic.dreadnoughts) {
      const watching = gates.filter((t) => t.watchesActor === d.id);
      expect(watching.length).toBe(1);
      expect(watching[0].widthRaw).toBe(2457);
      expect(watching[0].lengthRaw).toBe(1843);
      // It stands in the OTHER side's base: nearer the other Dreadnought.
      const other = logic.dreadnoughts.find((o) => o.id !== d.id);
      const dOwn = Math.hypot(watching[0].x - d.x, watching[0].z - d.z);
      const dOther = Math.hypot(watching[0].x - (other?.x ?? 0), watching[0].z - (other?.z ?? 0));
      expect(dOther).toBeLessThan(dOwn);
    }
    for (const s of logic.spawns) {
      expect(gates.some((t) => t.watchesActor === s.id)).toBe(false);
    }
  });
});

describe("raw-unit conversions read from the retail code", () => {
  // fcop-re/ranges-turrets-capture.md Q1: `cact_shooter_acquire` loads
  // engage_range with `shl 4` and compares it against world-unit deltas, 8192 wu
  // = 1 m, so metres = raw / 512. The scale used to be an inferred 1/1024 — half
  // the reach. If this expectation ever changes, arena balance changes with it.
  test("engage_range 6144 is 12 m", () => {
    expect(rangeToCells(6144)).toBe(12);
    // Weapon 3's own range field is the same 6144 and flies its rounds 12 m.
    expect(rangeToCells(512)).toBe(1); // aircraft standoff
  });

  test("aircraft search and orbit figures", () => {
    // target_detection_range takes the same `shl 4` (0x00420796).
    expect(rangeToCells(28672)).toBe(56); // jets
    expect(rangeToCells(32358)).toBeCloseTo(63.2, 1); // Fortress, captain craft
    // orbit_area: leash half-extent raw/1024, destinations drawn in +-raw/2048.
    expect(orbitLeashToCells(24576)).toBe(24);
    expect(orbitLeashToCells(20480)).toBe(20);
    expect(orbitPatrolToCells(24576)).toBe(12);
    expect(orbitLeashToCells(30720)).toBe(30); // heavy gunship
  });

  test("trigger extents are halved, then shifted by 4 against world units", () => {
    // Half-extent raw/1024 m (the intruder radius is added by the sim's test).
    expect(triggerHalfExtent(20480)).toBe(20); // Mp base zone: 40 x 24 m
    expect(triggerHalfExtent(12288)).toBe(12);
    expect(triggerHalfExtent(2457)).toBeCloseTo(2.4, 2); // gate: 4.8 x 3.6 m
    expect(triggerHalfExtent(1843)).toBeCloseTo(1.8, 2);
  });

  test("spawner periods are 1/60 s and halve into sim ticks", () => {
    expect(toSimTicks(300, TICK_HZ)).toBe(150); // 5 s Dreadnought/tank/jet spawner
    // Respawn delays are stored negative; magnitude is what counts.
    expect(toSimTicks(-1500, TICK_HZ)).toBe(750); // 25 s neutral turret
    expect(toSimTicks(-2250, TICK_HZ)).toBe(1125); // 37.5 s base turret
    expect(toSimTicks(-3000, TICK_HZ)).toBe(1500); // 50 s pickup
    // Never zero, or a cooldown would fire every tick.
    expect(toSimTicks(0, TICK_HZ)).toBe(1);
    expect(toSimTicks(1, TICK_HZ)).toBe(1);
  });

  test("targeting_delay is 1/16 s, not the spawner unit", () => {
    // trunc(raw * 4096 / 218) engine ticks at 300 Hz (0x0044ea83).
    expect(targetingDelayToSimTicks(32, TICK_HZ)).toBe(60); // 601 ticks = 2.0 s
    expect(targetingDelayToSimTicks(16, TICK_HZ)).toBe(30); // 300 ticks = 1.0 s
    expect(targetingDelayToSimTicks(0, TICK_HZ)).toBe(1);
  });

  test("a record angle is the sim yaw, 4096 = 360 degrees, a turret gun's too", () => {
    expect(ROTATION_TURN).toBe(4096);
    // The one mapping (fcop-fidelity.md G12; render/recordYaw.ts): sim yaw = a.
    expect(rotToYaw(0)).toBe(0);
    expect(rotToYaw(1024)).toBeCloseTo(Math.PI / 2, 10);
    expect(rotToYaw(2048)).toBeCloseTo(Math.PI, 10);
    expect(rotToYaw(-1024)).toBeCloseTo(-Math.PI / 2, 10);
    // In (-PI, PI]: three quarters of a turn is a quarter the other way.
    expect(rotToYaw(3072)).toBeCloseTo(-Math.PI / 2, 10);
    expect(rotToYaw(-2048)).toBeCloseTo(Math.PI, 10);
    // No quarter-turn bias for a turret gun: turret_construct (0x0041c222)
    // stores the record's +0x34 as its rest yaw unchanged.
    for (const raw of [0, 512, 1024, 3072, 4095]) {
      const d = rotToYaw(raw) - (raw * 2 * Math.PI) / 4096;
      expect(Math.abs(Math.sin(d / 2))).toBeLessThan(1e-12);
    }
  });

  test("fov 4096 means omnidirectional", () => {
    // fovToCos returns cos(fov/2), the threshold a dot product is compared
    // against. Every Mp shooter carries fov 4096 — a full circle — so -1 ("no
    // restriction") is what the sim will actually see on this arena.
    expect(fovToCos(4096)).toBe(-1);
    expect(fovToCos(2048)).toBeCloseTo(0, 10); // 180° total -> cos(90°) = 0
    expect(fovToCos(1024)).toBeCloseTo(Math.SQRT1_2, 10); // 90° total -> cos(45°)
  });

  test("gun slew is the retail /218 rate block: 2457 -> 290 deg/s", () => {
    // turn_rate = (raw * 16 / 218) >> 4 units (4096 = 360°) per 1/300 s.
    expect(turnSpeedToUnitsPerEngineTick(2457)).toBe(11);
    const slew = turnSpeedToRadPerTick(2457, TICK_HZ);
    expect(((slew * TICK_HZ) / Math.PI) * 180).toBeCloseTo(290.04, 1);
  });
});

/**
 * The cross-arena shape of `ground_cast`, because the reading that makes it an
 * elevation depends on comparing arenas, not on any one of them.
 *
 * `bun run tools/generators/analyzeGroundCast.ts` measures the rest against the
 * private RE dumps: LOW lands on a cell that carries a deck 83-100% of the time
 * against 10-25% for HIGH, and only at the +16 frame. That part cannot run in CI,
 * so what CI pins is the distribution those measurements were taken from — if
 * these counts move, the numbers in fcop-logic.md §3.1 are stale.
 */
describe("ground_cast across the six arenas", () => {
  const ARENA = {
    conft: conftLogic,
    slim: slimLogic,
    mp: logic,
    joke: jokeLogic,
    hk: hkLogic,
    ovmp: ovmpLogic,
  } as const;

  const tallyOf = (mission: keyof typeof ARENA): Map<number, number> => {
    const t = new Map<number, number>();
    for (const net of ARENA[mission].nets) {
      for (const n of net.nodes) t.set(n.groundCast, (t.get(n.groundCast) ?? 0) + 1);
    }
    return t;
  };

  test("LOW is a small, consistent minority on the single-storey arenas", () => {
    // 10-13 LOW per arena. This is the distribution that made the field look like
    // a render flag rather than an elevation: LOW appears even where there is only
    // one surface to select. It is not noise — on a single-storey CELL, LOW and
    // HIGH resolve to the same height, so LOW there costs nothing, and the nodes
    // carrying it are the ones sitting under a bridge.
    expect(tallyOf("conft").get(1)).toBe(12);
    expect(tallyOf("slim").get(1)).toBe(13);
    expect(tallyOf("mp").get(1)).toBe(10);
    expect(tallyOf("joke").get(1)).toBe(13);
    expect(tallyOf("ovmp").get(1)).toBe(11);
  });

  test("Hk is the arena built on a deck, and says so", () => {
    const t = tallyOf("hk");
    // Hk's base surface is the canal floor and its city is a layer above it. Its
    // owned road network is 130 HIGH nodes plus 10 MIDDLE and NOT ONE LOW — the
    // whole network is up on the city deck, which the flattening drops 2 m onto
    // the canal floor.
    expect(t.get(0)).toBe(130); // HIGH
    expect(t.get(3)).toBe(10); // MIDDLE — the only arena that uses it
    // The 41 LOW are entirely net 3, the campaign leftover enrichArena's
    // ownedNets() drops. Reading them as part of the arena is what made Hk look
    // like a counter-example to the whole reading.
    const leftover = hkLogic.nets.find((n) => n.netId === 3);
    expect(leftover?.nodes.length).toBe(41);
    expect(leftover?.nodes.every((n) => n.groundCast === 1)).toBe(true);
    expect(t.get(1)).toBe(41);
  });

  test("MIDDLE appears only where there is a middle surface to select", () => {
    // Semantics worth a test rather than a comment: of the six arenas only Hk
    // stacks three surfaces under its road, and only Hk uses MIDDLE.
    for (const m of ["conft", "slim", "mp", "joke", "ovmp"] as const) {
      expect(tallyOf(m).get(3)).toBeUndefined();
    }
    expect(tallyOf("hk").get(3)).toBe(10);
  });

  test("NONE is never used", () => {
    // So the sim only ever has to implement three modes.
    for (const m of ["conft", "slim", "mp", "joke", "hk", "ovmp"] as const) {
      expect(tallyOf(m).get(2)).toBeUndefined();
    }
  });
});
