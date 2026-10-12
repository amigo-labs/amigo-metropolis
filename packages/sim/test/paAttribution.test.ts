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
import { COST_JUGGERNAUT, POINTS_CAPTURE_TURRET, UNIT_RANGE } from "../src/balance";
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
    // engages at 12 m (engage_range 6144 = raw/512, fcop-re Q1) while the
    // shortest-ranged ground unit answers from 14 m, so a unit can always shoot a
    // turret from outside its reach. When the ring lost its profile it fell back
    // to the 28 m global and inverted this.
    //
    // Asserted against every TURRET profile the arena carries — the capturable
    // pads' and the ring's — because the failure was a missing reference, not a
    // wrong number. (The Juggernaut's hull-gun profile is a unit weapon.)
    const shortestUnitReach = Math.min(
      UNIT_RANGE[ARCHETYPE.RUNNER],
      UNIT_RANGE[ARCHETYPE.GUARDIAN],
      UNIT_RANGE[ARCHETYPE.FORTRESS],
    );
    const turretProfiles = new Set<number>(MAP.turretParams);
    for (const base of MAP.bases) for (const t of base.turrets) turretProfiles.add(t.weapon);
    expect(turretProfiles.size).toBeGreaterThan(0);
    for (const k of turretProfiles) expect(MAP.weapons[k].range).toBeLessThan(shortestUnitReach);
    // Belt and braces on the entity side: no live turret may hold the global
    // fallback profile on an arena that carries imported ones.
    const state = createSim(MAP, 1);
    for (const id of [...state.baseTurretEntity, ...state.neutralTurretEntity]) {
      if (id >= 0) expect(state.ent.weaponProfile[id]).toBeGreaterThanOrEqual(0);
    }
  });

  it("no standoff position exists against a base emplacement, on any arena", () => {
    // The finding v20's WGOAL_SUPPRESS is built on, and the reason it closes to 3 m
    // instead of picking a firing position: the arenas' wall lattice is dense city
    // geometry, so a defending emplacement is not shootable from range by ANYBODY.
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
  // Measured at SIM_VERSION 32 (seed c0ffee, team 0 idle), with turret damage
  // still the pre-original 15 per 2.0 s:
  //   lone Runner     la-cantina dies 3.3 m from the gate, urban-jungle dies
  //                   16.1 m out; proving-ground and bug-hunt breach after
  //                   ~154 s of chipping the ring from outside its 12 m reach.
  //   lone Juggernaut breaches all four in 35-52 s: 3000 HP and four 100-damage
  //                   guns against 7.5 dps emplacements.
  // The Juggernaut half is the original's own shape — the Dreadnought is the
  // siege unit, one alive per side and 50 points. The Runner half is today's
  // turret damage; the weapons package moves both (fcop-fidelity.md W3).
  it("a lone Runner is held at the gate on la-cantina and short of it on urban-jungle", () => {
    const lc = push(LA_CANTINA_ID, ARCHETYPE.RUNNER, 1);
    expect(lc.breachAt).toBe(-1);
    expect(lc.closest).toBeLessThan(10);
    const uj = push(URBAN_JUNGLE_ID, ARCHETYPE.RUNNER, 1);
    expect(uj.breachAt).toBe(-1);
  });

  it("a lone Runner needs minutes, not seconds, where it does get through", () => {
    for (const id of [PROVING_GROUND_ID, BUG_HUNT_ID]) {
      const r = push(id, ARCHETYPE.RUNNER, 1);
      if (r.breachAt >= 0) expect(r.breachAt).toBeGreaterThan(2 * 60 * 30);
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
  // With nothing produced for free, the idle player fields no units at all, so
  // the Warden's bought waves meet only the turret line. Measured at v32: it
  // breaches at 79 s on this seed (capture 44% of its ticks, then the committed
  // push: escort 20%, suppress 15%). At v33 (the original's economy: a 10-point
  // start, no trickle, +1 a capture) it breaches at 160 s: a difficulty-8 Warden
  // saves for its Juggernaut, and with no trickle the 50 points come from pads
  // (capture 73% of its ticks), then the Juggernaut push (escort 10%, suppress
  // 11%) wins. The long history of this describe — the stalled pushes of v15-v30
  // against a free production stream — ended with the stream.
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
    // The board is not what wins the match: the Warden takes some pads and wins
    // without needing the whole board.
    expect(captures).toBeGreaterThan(0);
    expect(captures).toBeLessThan(MAP.turretSpots.length);
  });
});

describe("a d8 Warden match RESOLVES on every imported arena", () => {
  // The last open item of issue #31 / PLAN Phase 13, pinned so it cannot
  // silently regress: a difficulty-8 Warden against an idle player wins through
  // the gate on all four arenas. Seeds 2 and 4 are in the set because they are
  // the two that once stalled urban-jungle (a standing mill of produced units at
  // the base exit, before the v30 jam relief); c0ffee is the suite's usual seed.
  //
  // Twelve minutes, not ten, since v33: the original's economy has no trickle and
  // a 10-point start, and a difficulty-8 Warden saves for its 50-point Juggernaut
  // before it buys anything. Measured worst cases: la-cantina 166 s,
  // urban-jungle 352 s, proving-ground 664 s, bug-hunt 621 s (were 79/98/96/83 s).
  // The Warden's spending rules are ours until the Sky Captain lands (U3).
  const TWELVE_MINUTES = 12 * 60 * 30;
  for (const id of PA_ARENAS) {
    it(`${id}: d8 vs idle breaches within twelve minutes on the stall seeds`, () => {
      for (const seed of [0xc0ffee, 2, 4]) {
        const state = createSim(getMapById(id), seed, {
          wardenPlayer: 1,
          wardenDifficulty: 8,
        });
        const idle = createTickInputs();
        for (let t = 0; t < TWELVE_MINUTES && state.winner < 0; t++) step(state, idle);
        expect(state.winner).toBe(1);
        expect(state.tick).toBeLessThanOrEqual(TWELVE_MINUTES);
      }
    });
  }
});
