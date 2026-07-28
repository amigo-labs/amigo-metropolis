// What actually kills a Precinct Assault push, measured rather than assumed.
//
// Issue #31 asks whether a lone unit is "meant to be this fragile" and proposes
// turret damage as the lever. Running this measurement first is what found the
// real answer: the ring turrets were not using their imported reach at all.
// spawnBaseTurret never set weaponProfile, so 32 of la-cantina's 72 turrets fell
// through to the global TURRET_RANGE of 28 m against an engage_range of 6 m in
// the extracted data. Every unit death in a 5-minute idle match came from a
// turret shooting from 16-28 m — outside the 14 m a Runner can answer from — and
// the two production streams never engaged each other at all. That is fixed in
// v15, and this file is the guard that keeps it fixed.
//
// The assertions are deliberately structural rather than transcribed counts: the
// exact damage split is a balance number that #31 is still expected to move,
// while "no turret outranges the units it is shooting at" is the invariant that
// broke. Where a number IS pinned it is bounded loosely, so a balance pass
// reports as a balance pass and not as a regression here.
//
// Attribution is exact, not inferred from positions. systemTargeting pushes
// EV_SHOT with the *shooter entity id* immediately before applyDamage pushes
// EV_HIT for that same shot (sim.ts systemTargeting), so walking one tick's
// event buffer in order pairs every hit with the entity that caused it.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  CORE_ATTACK_RADIUS,
  COST_JUGGERNAUT,
  PA_PRODUCTION_ALIVE_LIMIT,
  POINTS_CAPTURE_TURRET,
  UNIT_RANGE,
} from "../src/balance";
import { EV_CAPTURE, EV_CORE_HIT, EV_HIT, EV_SHOT, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import {
  BUG_HUNT_ID,
  getMapById,
  LA_CANTINA_ID,
  PROVING_GROUND_ID,
  URBAN_JUNGLE_ID,
} from "../src/map";
import { createSim, step } from "../src/sim";

const MAP = getMapById(LA_CANTINA_ID);

const GROUND_UNITS = [
  ARCHETYPE.RUNNER,
  ARCHETYPE.GUARDIAN,
  ARCHETYPE.JUGGERNAUT,
  ARCHETYPE.FORTRESS,
] as const;

/**
 * Damage source, resolved from the sim's stable id registries rather than from
 * `ent.archetype[shooter]`.
 *
 * The archetype array cannot be trusted for this: a shooter that dies later in
 * the same tick has its slot released before the events are read, and a released
 * slot reads back as archetype 0 — AVATAR. Attributing that way reported 76
 * "avatar" shots in a match where both avatars stood still. The turret registries
 * and `avatarId` are assigned once and never recycled, so classifying by
 * membership is exact.
 */
type Source = "turret" | "avatar" | "unit";

interface Attribution {
  /** Damage dealt, keyed by source. */
  readonly damage: Map<Source, number>;
  /** Shots fired, keyed by source. */
  readonly shots: Map<Source, number>;
  /** Total damage dealt to anything. */
  total: number;
  /** Closest a team-0 unit ever got to the enemy core, as a fraction travelled. */
  deepestPush: number;
  /** Ground units alive, averaged over the run. */
  meanAlive: number;
}

/**
 * Idle 5-minute match on la-cantina. Same map and seed as golden07's stalemate
 * test, so this measures the very situation that issue describes: nobody
 * escorting, both production streams meeting in the middle.
 */
function measure(): Attribution {
  const map = MAP;
  const state = createSim(map, 0xc0ffee);
  const idle = createTickInputs();
  const damage = new Map<Source, number>();
  const shots = new Map<Source, number>();
  let total = 0;
  let deepestPush = 0;
  let aliveSum = 0;
  const ticks = 5 * 60 * 30;

  const spawn = map.spawns[0];
  const foeCore = map.bases[1].core;
  const laneLength = Math.hypot(foeCore.x - spawn.x, foeCore.y - spawn.y);

  // Every turret entity on the arena: ring, built-in base defence and capturable
  // pad. Assigned at createSim and stable for the match.
  const turretIds = new Set<number>([
    ...state.baseTurretEntity,
    ...state.baseDefenceEntity,
    ...state.neutralTurretEntity,
  ]);
  const avatarIds = new Set<number>(state.avatarId);
  const classify = (id: number): Source =>
    turretIds.has(id) ? "turret" : avatarIds.has(id) ? "avatar" : "unit";

  for (let t = 0; t < ticks; t++) {
    step(state, idle);
    const ent = state.ent;

    // Attribute this tick's hits. `shooter` carries forward from the last
    // EV_SHOT: an AoE weapon emits one shot and several hits, and crediting all
    // of them to that shot is the correct reading.
    //
    // Buckets are keyed by SHOOTER, and resolved through `classify` rather than
    // through the archetype array — see the Source doc comment.
    let src: Source | undefined;
    for (let i = 0; i < state.events.count; i++) {
      const o = i * EVENT_STRIDE;
      const type = state.events.data[o];
      if (type === EV_SHOT) {
        src = classify(state.events.data[o + 1]);
        shots.set(src, (shots.get(src) ?? 0) + 1);
        continue;
      }
      if (type !== EV_HIT || src === undefined) continue;
      const dealt = state.events.data[o + 3];
      damage.set(src, (damage.get(src) ?? 0) + dealt);
      total += dealt;
    }

    let alive = 0;
    for (let id = 0; id < ent.high; id++) {
      if (!ent.alive[id]) continue;
      const kind = ent.archetype[id];
      if (!GROUND_UNITS.includes(kind as (typeof GROUND_UNITS)[number])) continue;
      alive += 1;
      if (ent.team[id] !== 0) continue;
      const left = Math.hypot(ent.posX[id] - foeCore.x, ent.posY[id] - foeCore.y);
      const progress = (laneLength - left) / laneLength;
      if (progress > deepestPush) deepestPush = progress;
    }
    aliveSum += alive;
  }

  return { damage, shots, total, deepestPush, meanAlive: aliveSum / ticks };
}

describe("what kills a Precinct Assault push on la-cantina", () => {
  const m = measure();
  const fromTurrets = m.damage.get("turret") ?? 0;
  const fromUnits = m.damage.get("unit") ?? 0;

  it("no turret outranges the units it shoots at", () => {
    // THE invariant, and the one that broke. Every imported turret profile
    // engages at 6 m while the shortest-ranged ground unit answers from 14 m, so
    // a unit can always shoot a turret from outside its reach. When the ring lost
    // its profile it fell back to the 28 m global and inverted this: turrets
    // killed units from 16-28 m, and the units could not reply at all.
    //
    // Asserted against every profile the arena carries rather than against the
    // ring specifically, because the failure was a missing reference, not a wrong
    // number — a future shooter that forgets its profile fails here too.
    const shortestUnitReach = Math.min(...GROUND_UNITS.map((k) => UNIT_RANGE[k]));
    for (const w of MAP.weapons) expect(w.range).toBeLessThan(shortestUnitReach);
    // Belt and braces on the entity side: no live turret may hold the global
    // fallback profile on an arena that carries imported ones.
    const state = createSim(MAP, 1);
    for (const id of [
      ...state.baseTurretEntity,
      ...state.baseDefenceEntity,
      ...state.neutralTurretEntity,
    ]) {
      if (id >= 0) expect(state.ent.weaponProfile[id]).toBeGreaterThanOrEqual(0);
    }
    // ...and the core is attackable from closer still, so a push has to survive
    // the unit line, then the turret line, then close to the core.
    expect(CORE_ATTACK_RADIUS).toBeLessThan(shortestUnitReach);
  });

  it("kills unescorted pushes with enemy UNITS, not with the turret line", () => {
    // The consequence, and the answer to #31's "is a lone unit meant to be this
    // fragile": the two production streams annihilate each other at the mid-line,
    // nowhere near either base, so the turret rings never contribute at all.
    // Before v15 this read the other way round — turrets dealt 100% of it.
    //
    // Turret damage is therefore NOT the lever for making unescorted pushes
    // survive; it only governs the last few metres at a base, which is where the
    // player is supposed to be doing the work (design pillar 1).
    expect(m.total).toBeGreaterThan(0);
    expect(fromUnits).toBeGreaterThan(fromTurrets * 4);
    expect(m.shots.get("avatar") ?? 0).toBe(0); // both avatars idle, as scripted
  });

  it("never gets a unit near the enemy core unescorted", () => {
    // The other half of the stalemate that golden07 pins: not just "no winner"
    // but "not even close". Pinned loosely — this is the number a balance pass
    // is trying to move, and a tighter bound would fail for the right reason
    // but read like a regression.
    expect(m.deepestPush).toBeGreaterThan(0.2);
    expect(m.deepestPush).toBeLessThan(0.7);
  });

  it("settles below the production ceiling, so the ceiling is not the cap", () => {
    // PA_PRODUCTION_ALIVE_LIMIT is 8 per base, i.e. 16 across the arena. The
    // steady state sits under half that: units die about as fast as they are
    // made, so raising the limit changes nothing. Worth knowing before anyone
    // tries it — #31 says as much and this is the proof, not the assumption.
    expect(m.meanAlive).toBeLessThan(PA_PRODUCTION_ALIVE_LIMIT);
    expect(m.meanAlive).toBeGreaterThan(1); // ...but the loop IS running
  });
});

describe("a Warden vs an idle player: plays the board, does not break the line", () => {
  // This describe used to assert the opposite — "wins on the base-destruction
  // objective inside ten minutes" — and that win did not survive the road fix
  // (issue #30). What it was resting on is worth stating exactly, because it is
  // the reason the assertion flipped rather than a balance drift:
  //
  //   the old graph arrival radius was WAYPOINT_RADIUS, 3 m. A unit 3 m from a
  //   node counted as arrived, read the signpost, and if the NEXT node was also
  //   within 3 m it chained straight through it. On Mp's last stretch — nodes at
  //   12, 10, 9, 6 and 5 m from the core — a single unhalted tick at node #46
  //   carried a unit through #47 and #48 to "past the road", and it then beelined
  //   the core from 10 m out, skipping the ring emplacements the road runs past.
  //   That is what got units to the core, and it was waypoint skipping, not a
  //   siege: on the SAME committed walls, a 3 m radius scores 128 core hits in
  //   three minutes and 0.5 m scores 0.
  //
  // Now every unit walks the whole road, both streams arrive intact, and they
  // annihilate at the mid-line — which is the design (pillar 1 makes the player
  // the tiebreaker) and exactly what the idle-vs-idle stalemate in golden07 pins.
  // The objective is still reachable: golden07 razes a core once the defence is
  // beaten, and the describe below measures how close a push gets when the enemy
  // stream is off the field. What is NOT yet true is that a Warden can beat that
  // stream on its own, and that is #31's balance pass, quantified there.
  const state = createSim(MAP, 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
  const idle = createTickInputs();
  let captures = 0;
  const limit = 10 * 60 * 30;
  while (state.tick < limit && state.winner < 0) {
    step(state, idle);
    for (let i = 0; i < state.events.count; i++) {
      if (state.events.data[i * EVENT_STRIDE] === EV_CAPTURE) captures += 1;
    }
  }

  it("does not resolve the match in ten minutes (known gap — issue #31)", () => {
    // WHEN THIS STARTS FAILING, THAT IS THE BALANCE PASS LANDING: move it back to
    // asserting the win, do not delete it. The lever is NOT turret damage — 15
    // down to 5 changes nothing measurable here, and neither does the built-in
    // base guns' 3000 HP — it is that a ring turret regenerates as fast as a
    // Runner trickle can kill it (500 imported HP at 8 dps is ~62 s against a
    // 60 s respawn), and that nothing in the Warden's play is aimed at the
    // objective rather than at the board.
    expect(state.winner).toBe(-1);
    expect(state.coreHp[0]).toBe(3000);
    expect(state.coreHp[1]).toBe(3000);
    expect(state.tick).toBe(limit);
  });

  it("funds that push from capture income that is not absurd", () => {
    // #31's open question: 32 pads at POINTS_CAPTURE_TURRET = 3 is 96 points on a
    // map where a Juggernaut costs 50 and trickle is 1 per 10 s. Measured rather
    // than argued: the whole board is worth about two heavy units. That is a
    // defensible economy, so the reward per pad and the trickle are LEFT ALONE —
    // this test records the relation so a future change to either is deliberate.
    const boardValue = MAP.turretSpots.length * POINTS_CAPTURE_TURRET;
    expect(boardValue / COST_JUGGERNAUT).toBeGreaterThan(1);
    expect(boardValue / COST_JUGGERNAUT).toBeLessThan(3);
    // It captures a real share of the board rather than sitting on trickle: 25 of
    // 32 pads measured. The points bound is loose and now covers a full ten
    // minutes of trickle on top of the board — the match no longer ends early.
    expect(captures).toBeGreaterThan(MAP.turretSpots.length / 2);
    expect(state.points[1]).toBeLessThan(boardValue * 4);
  });
});

describe("how far an escorted push gets, per arena", () => {
  // The old version of this block asked "which arenas can a Warden finish" and
  // recorded one of four, with the note that "the last ~11 m of those three bases
  // is impassable" and the explicit ruling-out: "It is not the road — every
  // arena's Cnet graph reaches its cores and no lane edge crosses a wall."
  //
  // It WAS the road, and that ruling-out is what hid it: the Cnet was checked, the
  // two legs the sim invents around it were not. Produced units on Slim and Joke
  // could not leave their own base, and on Conft team 0 could neither leave its
  // own nor enter the enemy's. That is fixed and pinned deterministically in
  // paRoads.test.ts — one unopposed unit now drives console to core on all four
  // arenas at both ground step lengths.
  //
  // What this block measures instead is the thing the road fix does NOT settle:
  // how close a push gets when the defending stream is off the field, which is
  // what escorting achieves and therefore the closest thing to "the objective is
  // achievable". Production is silenced on team 0 and nothing else is touched —
  // the ring, the base guns and the pads all still defend.
  interface Reach {
    /** Closest a team-1 ground unit came to the defended core, metres. */
    readonly closest: number;
    readonly coreHits: number;
  }

  function escortedPush(id: string): Reach {
    // `getMapById` builds a fresh MapData — and fresh MapBase objects — on every
    // call (map.ts, `loadMapFromJson(entry.json)` with no cache), so silencing
    // this base's production is local to this measurement and needs no restore.
    // MAP at the top of this file is a different instance and is unaffected.
    const map = getMapById(id);
    (map.bases[0] as { productionTicks: number }).productionTicks = 0;
    const state = createSim(map, 0xc0ffee, {});
    const idle = createTickInputs();
    let coreHits = 0;
    let closest = Number.POSITIVE_INFINITY;
    const core = map.bases[0].core;
    for (let t = 0; t < 5 * 60 * 30 && state.winner < 0; t++) {
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        if (state.events.data[i * EVENT_STRIDE] === EV_CORE_HIT) coreHits += 1;
      }
      const ent = state.ent;
      for (let id2 = 0; id2 < ent.high; id2++) {
        if (!ent.alive[id2] || ent.team[id2] !== 1) continue;
        if (!GROUND_UNITS.includes(ent.archetype[id2] as (typeof GROUND_UNITS)[number])) continue;
        const d = Math.hypot(ent.posX[id2] - core.x, ent.posY[id2] - core.y);
        if (d < closest) closest = d;
      }
    }
    return { closest, coreHits };
  }

  it("la-cantina: razes into the core", () => {
    // 20 core hits, closest approach 5.4 m. The full objective loop runs.
    const r = escortedPush(LA_CANTINA_ID);
    expect(r.coreHits).toBeGreaterThan(0);
    expect(r.closest).toBeLessThanOrEqual(CORE_ATTACK_RADIUS);
  });

  it("urban-jungle: arrives at the core but is held on the doorstep", () => {
    // 6.7 m measured, against a 6 m attack radius — the push gets all the way in
    // and is then held by the base's own built-in gun, which sits ON the core with
    // the base's 3000 HP and halts a Runner from 14 m out. That gun's HP is ours,
    // not extracted (the original stores no per-gun health), so it is a balance
    // question and #31's, not a road one.
    const r = escortedPush(URBAN_JUNGLE_ID);
    expect(r.closest).toBeLessThan(CORE_ATTACK_RADIUS + 2);
    expect(r.coreHits).toBe(0); // when this flips, move it up to la-cantina's form
  });

  for (const id of [PROVING_GROUND_ID, BUG_HUNT_ID]) {
    it(`${id}: stops ~11 m out on one ring turret (known gap — issue #31)`, () => {
      // 11.5 m and 11.4 m measured. Both arenas place a ring turret 9-10 m from
      // the core, inside the last stretch of road: a Runner halts 14 m from it,
      // chips 500 imported HP at 8 dps (~62 s) and the ring respawns in 60 s, so
      // the emplacement regenerates as fast as a trickle can kill it. Nothing
      // about the road: paRoads drives this exact route unopposed.
      //
      // WHEN THIS STARTS FAILING, THAT IS THE BALANCE PASS LANDING — move the
      // arena to la-cantina's form above, do not delete the assertion.
      const r = escortedPush(id);
      expect(r.coreHits).toBe(0);
      expect(r.closest).toBeGreaterThan(CORE_ATTACK_RADIUS);
      expect(r.closest).toBeLessThan(15);
    });
  }
});
