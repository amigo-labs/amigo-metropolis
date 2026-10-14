// What a Precinct Assault push runs into, measured rather than assumed.
//
// Issue #31 asked whether a lone unit is "meant to be this fragile" and proposed
// turret damage as the lever. Measuring first found the real answer: the ring
// turrets were not using their imported reach at all (spawnBaseTurret never set
// weaponProfile, so 32 of la-cantina's turrets fell through to the global 28 m).
// That is fixed since v15, and this file is the guard that keeps it fixed.
//
// SIM_VERSION 32 moved the model under this file onto the original's
// (docs/specs/fcop-fidelity.md R1, I6, I7): there is no destructible core, no
// free production and no "built-in base guns" — those were the Dreadnought's
// hull guns. A push wins by putting a Runner (tank) or Juggernaut (Dreadnought)
// into the enemy gate box. So the free-trickle measurements this file used to
// pin (two production streams annihilating at the mid-line, a trickle chipping a
// core) are gone with the trickle, and what is measured here is a BOUGHT push.
//
// The assertions are deliberately structural rather than transcribed counts:
// turret damage is still the pre-original 15 (the weapons package lands weapon
// 3's 100), so every number below that depends on it will move, and should be
// read as "where the arenas stand today", not as balance targets.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { COST_JUGGERNAUT, POINTS_CAPTURE_TURRET, STARTING_POINTS } from "../src/balance";
import { segmentBlocked } from "../src/collision";
import { EV_CAPTURE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import {
  BUG_HUNT_ID,
  getMapById,
  LA_CANTINA_ID,
  PROVING_GROUND_ID,
  URBAN_JUNGLE_ID,
} from "../src/map";
import { createSim, spawnUnit, step } from "../src/sim";

const MAP = getMapById(LA_CANTINA_ID);
const PA_ARENAS = [LA_CANTINA_ID, URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID];

interface Push {
  /** Closest any pushing unit came to the defended gate's centre, metres. */
  readonly closest: number;
  /** Tick of the breach (the outro's start), or -1. */
  readonly breachAt: number;
}

/**
 * Five minutes of team 1 pushing team 0's intact defence with `count` units of
 * `archetype`, bought at t = 0 and rolled out where a purchase puts them (the
 * ground console for a Runner, the Dreadnought record for a Juggernaut). Nobody
 * escorts and team 0 buys nothing: this measures the defence against the push.
 */
function push(mapId: string, archetype: number, count: number): Push {
  const map = getMapById(mapId);
  const state = createSim(map, 0xc0ffee);
  const idle = createTickInputs();
  const base = map.bases[1];
  const at =
    archetype === ARCHETYPE.JUGGERNAUT && base.juggernaut ? base.juggernaut : base.groundConsole;
  const ids: number[] = [];
  for (let k = 0; k < count; k++) {
    ids.push(spawnUnit(state, archetype, 1, at.x, at.y, undefined, false, at.layer));
  }
  const gate = map.bases[0].gate;
  let closest = Number.POSITIVE_INFINITY;
  let breachAt = -1;
  for (let t = 0; t < 5 * 60 * 30 && state.winner < 0; t++) {
    step(state, idle);
    if (breachAt < 0 && state.outroTimer > 0) breachAt = state.tick;
    let alive = 0;
    for (const id of ids) {
      if (!state.ent.alive[id] || state.ent.archetype[id] !== archetype) continue;
      alive += 1;
      const d = Math.hypot(state.ent.posX[id] - gate.x, state.ent.posY[id] - gate.y);
      if (d < closest) closest = d;
    }
    if (alive === 0 && breachAt < 0) break;
  }
  return { closest, breachAt };
}

describe("turret reach on the imported arenas", () => {
  it("no turret outranges the units it shoots at", () => {
    // THE invariant, and the one that broke. Every imported turret profile
    // engages at 12 m (engage_range 6144 = raw/512, fcop-re Q1). When the ring
    // lost its profile it fell back to the 28 m global and inverted this.
    //
    // Since SIM_VERSION 42 the units carry their own records too, and the
    // original answers the reach question with ONE number: tanks, jets, the
    // Fortress and the Dreadnought's guns all engage at the same 12 m as the
    // turrets (fcop-fidelity.md W3/W4). So a unit does not outreach a turret any
    // more (it did at Metropolis' 14 m); it is never outreached by one, which is
    // what this guards.
    //
    // Asserted against every TURRET profile the arena carries — the capturable
    // pads' and the ring's — because the failure was a missing reference, not a
    // wrong number.
    let shortestUnitReach = Number.POSITIVE_INFINITY;
    for (const b of MAP.bases) {
      for (const u of [b.runner, b.guardian, b.fortress, b.juggernaut]) {
        if (u === undefined) throw new Error("la-cantina must carry its unit records");
        shortestUnitReach = Math.min(shortestUnitReach, MAP.weapons[u.weapon].range);
      }
    }
    expect(shortestUnitReach).toBe(12);
    const turretProfiles = new Set<number>(MAP.turretParams);
    for (const base of MAP.bases) for (const t of base.turrets) turretProfiles.add(t.weapon);
    expect(turretProfiles.size).toBeGreaterThan(0);
    for (const k of turretProfiles) {
      expect(MAP.weapons[k].range).toBeLessThanOrEqual(shortestUnitReach);
    }
    // Belt and braces on the entity side: no live turret may hold the global
    // fallback profile on an arena that carries imported ones.
    const state = createSim(MAP, 1);
    for (const id of [...state.baseTurretEntity, ...state.neutralTurretEntity]) {
      if (id >= 0) expect(state.ent.weaponProfile[id]).toBeGreaterThanOrEqual(0);
    }
  });

  it("no standoff position exists against a base emplacement, on any arena", () => {
    // The finding Metropolis' own Warden's suppress goal (v20-v45) was built on, and
    // the reason it closed to 3 m instead of picking a firing position: the arenas'
    // wall lattice is dense city geometry, so a defending emplacement is not
    // shootable from range by ANYBODY. (The Sky Captain, v46, aims inside 12 m.)
    //
    // This is what ruled out the two cheaper readings of "the Warden holds a target
    // for 1-18% of the match". It is not out of position — there is nowhere to
    // stand. And it is not that a flying entity ought to see over walls: that would
    // delete the arenas' cover model for everything that flies, and since an
    // emplacement's own reach is 12 m it would make the Warden unanswerable.
    //
    // Sampled as a ring of directions per emplacement rather than as a single
    // segment, so the claim is "from no direction" and not "not from here".
    for (const id of PA_ARENAS) {
      const map = getMapById(id);
      const state = createSim(map, 1, {});
      const idle = createTickInputs();
      for (let t = 0; t < 30; t++) step(state, idle); // let every emplacement spawn
      const ent = state.ent;
      let emplacements = 0;
      let openNear = 0;
      let openFar = 0;
      const SAMPLES = 64;
      for (let e = 0; e < ent.high; e++) {
        if (!ent.alive[e] || ent.team[e] !== 0 || ent.archetype[e] !== ARCHETYPE.TURRET) continue;
        emplacements += 1;
        for (let s = 0; s < SAMPLES; s++) {
          // Directions off the unit circle. Test-side only — Math.cos/sin never
          // enter the sim (CLAUDE.md determinism rule 1).
          const a = (s / SAMPLES) * Math.PI * 2;
          for (const [r, bucket] of [
            [8, 0],
            [28, 1],
          ] as const) {
            const px = ent.posX[e] + Math.cos(a) * r;
            const py = ent.posY[e] + Math.sin(a) * r;
            if (segmentBlocked(map, px, py, ent.posX[e], ent.posY[e])) continue;
            if (bucket === 0) openNear += 1;
            else openFar += 1;
          }
        }
      }
      expect(emplacements).toBeGreaterThan(0);
      const total = emplacements * SAMPLES;
      // Point-blank is where the lattice stops mattering; standoff is where it is
      // absolute. Measured: 8-17% open at 8 m and 0-4% at 28 m, on all four.
      expect(openNear / total).toBeGreaterThan(0.02);
      expect(openFar / total).toBeLessThan(0.1);
      expect(openFar).toBeLessThan(openNear);
    }
  });
});

describe("an unescorted bought push against an intact defence, per arena", () => {
  // Measured at SIM_VERSION 44 (seed c0ffee, team 0 idle), with the original's
  // weapons on both sides (fcop-fidelity.md W3) and, since v44, the original's
  // route followers (U1/U2): a tank drives its side's Cnet at 1.98 m/s, steps
  // toward the nearest enemy within 16 m on 60 % of its steps and at random on
  // the rest, and NEVER stops to fight — its gun fires on the move. Until v43 a
  // unit halted at 12 m from the first thing it could see and traded there.
  //   lone Runner     la-cantina: breaches in 36-79 s (seeds c0ffee/1/2) — its
  //                   gate sits on the road a step past the ring, and a tank that
  //                   keeps driving crosses the 12 m reach in a few seconds; at
  //                   v42-v43 it halted 3.3 m out and died there.
  //                   urban-jungle, proving-ground, bug-hunt: dies 7-16 m out
  //                   after 56-97 s (it wanders the net first: 150-175 m of road
  //                   on average, against ~100 m by the old signposts).
  //   lone Juggernaut breaches all four in 63-104 s (was 36-62 s at 2.5 m/s);
  //                   it walks the net at random and its 3000 HP outlast the ring.
  // The Juggernaut half is the original's own shape — the Dreadnought is the
  // siege unit, one alive per side and 50 points. That a tank slips through on
  // la-cantina is the original's too, as far as these rules go: Mp's gate box is
  // on the tank road just past its ring.
  it("a lone Runner drives through la-cantina's ring and is stopped short on urban-jungle", () => {
    const lc = push(LA_CANTINA_ID, ARCHETYPE.RUNNER, 1);
    expect(lc.breachAt).toBeGreaterThan(0);
    const uj = push(URBAN_JUNGLE_ID, ARCHETYPE.RUNNER, 1);
    expect(uj.breachAt).toBe(-1);
  });

  it("a lone Runner does not get through an intact ring on proving-ground or bug-hunt", () => {
    for (const id of [PROVING_GROUND_ID, BUG_HUNT_ID]) {
      const r = push(id, ARCHETYPE.RUNNER, 1);
      expect(r.breachAt).toBe(-1);
      expect(r.closest).toBeGreaterThan(4);
    }
  });

  it("a Juggernaut breaks an intact defence on all four arenas", () => {
    for (const id of PA_ARENAS) {
      const r = push(id, ARCHETYPE.JUGGERNAUT, 1);
      expect(r.breachAt).toBeGreaterThan(0);
      expect(r.breachAt).toBeLessThan(2 * 60 * 30);
    }
  });

  it("breaches once the defenders are gone, on all four arenas", () => {
    // The objective is reachable on every arena: team 0's turrets are removed as
    // they respawn — the stand-in for a defence that has actually been beaten —
    // and one bought Runner drives the original road into the gate box.
    for (const id of PA_ARENAS) {
      const map = getMapById(id);
      const state = createSim(map, 0xc0ffee, {});
      const idle = createTickInputs();
      const c = map.bases[1].groundConsole;
      spawnUnit(state, ARCHETYPE.RUNNER, 1, c.x, c.y, undefined, false, c.layer);
      for (let t = 0; t < 5 * 60 * 30 && state.winner < 0; t++) {
        step(state, idle);
        for (let e = 0; e < state.ent.high; e++) {
          if (!state.ent.alive[e]) continue;
          if (state.ent.team[e] === 0 && state.ent.archetype[e] === ARCHETYPE.TURRET) {
            state.ent.alive[e] = 0;
          }
        }
      }
      expect(state.winner).toBe(1);
    }
  });
});

describe("a Warden vs an idle player on la-cantina", () => {
  // Since SIM_VERSION 46 the Warden is the original's Sky Captain (level 7 at
  // difficulty 8). Its 8 ring turrets count 16 (each twice, SIM_VERSION 49), so
  // it roams (fcop-fidelity.md U3), capturing pads (21 here); what breaches is
  // its free opening order: on this seed 5 tanks, which drive through the ring
  // the way a lone Runner does (above), at 46 s, before it has 30 points for an
  // outpost. Until v45 Metropolis' own Warden saved for a Juggernaut from pads
  // and kills and pushed it in (77-183 s).
  const state = createSim(MAP, 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
  const idle = createTickInputs();
  let captures = 0;
  const limit = 15 * 60 * 30;
  while (state.tick < limit && state.winner < 0) {
    step(state, idle);
    for (let i = 0; i < state.events.count; i++) {
      if (state.events.data[i * EVENT_STRIDE] === EV_CAPTURE) captures += 1;
    }
  }

  it("resolves the match through the gate inside fifteen minutes", () => {
    expect(state.winner).toBe(1);
    expect(state.tick).toBeLessThan(limit);
  });

  it("funds that push from capture income that is not absurd", () => {
    // #31's open question was whether 32 pads at 3 points each (96, nearly two
    // Juggernauts) was too much. The original answers it: a capture pays 1
    // (fcop-fidelity.md R7), so the whole board is worth less than one
    // Dreadnought, and a side funds its heavy push from pads AND kills. Recorded
    // as a relation so a change to either number is deliberate.
    const boardValue = MAP.turretSpots.length * POINTS_CAPTURE_TURRET;
    expect(boardValue / COST_JUGGERNAUT).toBeGreaterThan(0.5);
    expect(boardValue / COST_JUGGERNAUT).toBeLessThan(1);
    // The board alone does not fund the heavy push: the start plus every pad is
    // still short of a Juggernaut, so kills pay the rest. (The Sky Captain starts
    // on 0, not STARTING_POINTS; the relation is the human side's.)
    expect(STARTING_POINTS + boardValue).toBeLessThan(COST_JUGGERNAUT);
    expect(captures).toBeGreaterThan(0);
    expect(captures).toBeLessThanOrEqual(2 * MAP.turretSpots.length);
  });
});

describe("a d8 Warden (the Sky Captain at level 7) against an idle player", () => {
  // The original's captain, pinned as measured (SIM_VERSION 49; fcop-fidelity.md
  // U3, fcop-re/outposts.md Q2). It counts each of its live team turrets twice
  // (the turret and its base part), so its 8 (or 6) ring turrets give it 16 (12),
  // at or above the 10 that keeps it out of defend: against an idle player, with
  // no enemy tank near its home, it never defends. It roams — capturing neutral
  // turrets, claiming outposts with 30, buying a Juggernaut with 50 and Runners
  // at its outposts and base — and attacks behind its Juggernaut or tanks near
  // the player's base. Measured over seeds c0ffee/1/2/3/4: 17 of 20 resolve, in
  // 45-113 s. The three that do not are urban-jungle seeds 1, 3 and 4: once it
  // has captured the pads in reach and claimed an outpost it holds 2-3 points,
  // and an idle player who is never downed (roaming, it does not chase the
  // player) pays it nothing more, so nothing replaces its dead tanks.
  // (SIM_VERSION 46-48 counted each turret once, so it defended all match and
  // only its opening order breached: 17-19 of 20 on these seeds.)
  // Re-measured at SIM_VERSION 55 (captures by the original's octagonal
  // estimate, R12), over seeds c0ffee/1/2/3/4: 22 of 30 resolve, in 68-153 s,
  // every one on its opening order; the captain buys nothing more against an
  // idle player. Of the seeds below, these do not.
  const UNRESOLVED: Record<string, number[]> = {
    [LA_CANTINA_ID]: [4],
    [URBAN_JUNGLE_ID]: [2, 4],
    [PROVING_GROUND_ID]: [4],
  };
  const TWELVE_MINUTES = 12 * 60 * 30;
  for (const id of PA_ARENAS) {
    it(`${id}: d8 vs idle, it roams and breaches (or measurably does not)`, () => {
      for (const seed of [0xc0ffee, 2, 4]) {
        const state = createSim(getMapById(id), seed, {
          wardenPlayer: 1,
          wardenDifficulty: 8,
        });
        const idle = createTickInputs();
        let defend = 0;
        for (let t = 0; t < TWELVE_MINUTES && state.winner < 0; t++) {
          step(state, idle);
          if (state.captain.mode === 2) defend += 1;
        }
        expect(defend).toBe(0);
        if (UNRESOLVED[id]?.includes(seed)) {
          expect(state.winner).toBe(-1);
          continue;
        }
        expect(state.winner).toBe(1);
        expect(state.tick).toBeLessThan(3 * 60 * 30);
      }
    });
  }
});
