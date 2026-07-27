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

describe("the arena is decidable: a Warden beats an idle player", () => {
  // The counterpart to the stalemate test in golden07. A stalemate between two
  // idle players is the design (pillar 1 makes the player the tiebreaker); a
  // stalemate between a difficulty-8 Warden and an idle player is not — it means
  // nobody can win, and #31 recorded exactly that: 28 of 32 pads captured in ten
  // minutes and no result.
  //
  // With the ring turrets on their imported 6 m reach the Warden's pushes get
  // through and it razes the core in about three minutes. This is the single
  // strongest statement that the arena plays: the objective is achievable by a
  // party that is actually trying.
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

  it("wins on the base-destruction objective, inside ten minutes", () => {
    expect(state.winner).toBe(1);
    expect(state.coreHp[0]).toBe(0);
    expect(state.tick).toBeLessThan(5 * 60 * 30);
  });

  it("funds that push from capture income that is not absurd", () => {
    // #31's open question: 32 pads at POINTS_CAPTURE_TURRET = 3 is 96 points on a
    // map where a Juggernaut costs 50 and trickle is 1 per 10 s. Measured rather
    // than argued: the whole board is worth about two heavy units, and the Warden
    // reaches the objective on a fraction of it. That is a defensible economy, so
    // the reward per pad and the trickle are LEFT ALONE — this test records the
    // relation so a future change to either is a deliberate one.
    const boardValue = MAP.turretSpots.length * POINTS_CAPTURE_TURRET;
    expect(boardValue / COST_JUGGERNAUT).toBeGreaterThan(1);
    expect(boardValue / COST_JUGGERNAUT).toBeLessThan(3);
    // It captures a real share of the board on the way, rather than winning off
    // trickle alone or needing every pad.
    expect(captures).toBeGreaterThan(MAP.turretSpots.length / 2);
    expect(state.points[1]).toBeLessThan(boardValue + 60);
  });
});

describe("which PA arenas a Warden can actually finish", () => {
  // Pinned because the answer is currently "one of four", and that is a gap
  // against Phase 13's Definition of Done ("all four single-storey arenas play
  // under §9 — production runs, pads capture, the enemy core can be razed").
  //
  // Measured over three minutes against an idle player, difficulty 8. On the
  // three v14-imported arenas the Warden's units get 76-90% of the way to the
  // defended core and then stop dead: zero core hits, zero intrusion alarms, in
  // one case (proving-ground) after capturing all 29 pads. It is not the road —
  // every arena's Cnet graph reaches its cores to within 0.0 m and no lane edge
  // crosses a wall — and it is not ring density, since la-cantina's ring sits
  // TIGHTER around its core (median 20.1 m) than urban-jungle's (24.9 m) and
  // la-cantina is the one that works. Something about the last ~11 m of those
  // three bases is impassable to a produced unit, and it is a separate defect
  // from the reach bug this file was written for.
  //
  // WHEN THESE START FAILING, THAT IS THE FIX LANDING: move the arena into the
  // decidable list, do not delete the assertion.
  const DECIDABLE = [LA_CANTINA_ID];
  const NOT_YET = [URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID];

  function coreHits(id: string): number {
    const state = createSim(getMapById(id), 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
    const idle = createTickInputs();
    let hits = 0;
    for (let t = 0; t < 3 * 60 * 30 && state.winner < 0; t++) {
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        if (state.events.data[i * EVENT_STRIDE] === EV_CORE_HIT) hits += 1;
      }
    }
    return hits;
  }

  for (const id of DECIDABLE) {
    it(`${id}: the Warden reaches and damages the core`, () => {
      expect(coreHits(id)).toBeGreaterThan(0);
    });
  }

  for (const id of NOT_YET) {
    it(`${id}: the Warden still cannot reach the core (known gap)`, () => {
      expect(coreHits(id)).toBe(0);
    });
  }
});
