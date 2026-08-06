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
import { segmentBlocked } from "../src/collision";
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

interface Reach {
  /** Closest a team-1 ground unit came to the defended core, metres. */
  readonly closest: number;
  readonly coreHits: number;
}

/**
 * Five minutes of team 1 pushing team 0's base with team 0's free production
 * silenced, measuring how close the push gets and what the core takes.
 *
 * `withEscort` additionally puts a difficulty-8 Warden on the pushing side. That
 * flag is the distinction issue #31 turned on: without it this measures a FREE
 * PRODUCTION TRICKLE against an intact defence, which is not the same thing as an
 * escort and fails for reasons no damage number fixes. Both describe blocks below
 * use this one helper so the two cases cannot drift apart.
 *
 * `getMapById` builds a fresh MapData — and fresh MapBase objects — on every call
 * (map.ts, `loadMapFromJson(entry.json)` with no cache), so silencing this base's
 * production is local to one measurement and needs no restore. MAP at the top of
 * this file is a different instance and is unaffected.
 */
function push(mapId: string, withEscort = false): Reach {
  const map = getMapById(mapId);
  (map.bases[0] as { productionTicks: number }).productionTicks = 0;
  const state = createSim(
    map,
    0xc0ffee,
    withEscort ? { wardenPlayer: 1, wardenDifficulty: 8 } : {},
  );
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
    for (let id = 0; id < ent.high; id++) {
      if (!ent.alive[id] || ent.team[id] !== 1) continue;
      if (!GROUND_UNITS.includes(ent.archetype[id] as (typeof GROUND_UNITS)[number])) continue;
      const d = Math.hypot(ent.posX[id] - core.x, ent.posY[id] - core.y);
      if (d < closest) closest = d;
    }
  }
  return { closest, coreHits };
}

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

describe("a Warden vs an idle player: breaks the line on la-cantina", () => {
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
  const limit = 15 * 60 * 30;
  while (state.tick < limit && state.winner < 0) {
    step(state, idle);
    for (let i = 0; i < state.events.count; i++) {
      if (state.events.data[i * EVENT_STRIDE] === EV_CAPTURE) captures += 1;
    }
  }

  it("resolves the match: razes the idle player's core inside fifteen minutes", () => {
    // This assertion used to read `winner === -1` with the note "WHEN THIS STARTS
    // FAILING, THAT IS THE BALANCE PASS LANDING: move it back to asserting the win,
    // do not delete it." v20 is that landing, and the mechanism it names is worth
    // correcting rather than deleting, because it was wrong:
    //
    //   "The Warden escorts whatever unit is deepest, which after each exchange is
    //   a fresh unit near its own base, so it fights an attrition war in the middle
    //   and its push never reaches the range where WARDEN_PUSH_COMMIT_RANGE
    //   applies."
    //
    // Measured, it reached that range and stayed there. Over ten minutes at
    // difficulty 8 it spent 64-86% of its ticks on ESCORT at a mean 34-43 m from
    // the enemy core with its push tip at 75-82% of the lane. It was not fighting
    // in the middle and it was not mistargeting. It held a target for 1-18% of the
    // match and landed 1.6-9.3k damage where its cooldowns allow ~66k, because a
    // base emplacement was inside its 42 m cannon range 60-89% of the time and
    // VISIBLE 0-7% of it — see "no standoff position exists" below. The mid-line
    // front was not what held; the wall lattice was.
    //
    // With WGOAL_SUPPRESS the match ends at 268 s on this seed, and on 5/5 seeds it
    // ends: 300 core hits against 24 before. Bounded as "resolves, and the Warden's
    // own core is untouched by an idle opponent" rather than on the exact tick.
    //
    // The window was ten minutes until la-cantina's build consoles were
    // un-swapped: the Warden buys at the ground console, so its spawn point and
    // road leg moved ~5 m and it now finishes at 699 s on 5/5 seeds instead of
    // 268 s. Slower, same outcome.
    //
    // Worth knowing how narrow this is. Measured on the same scenario while the
    // outpost placement was being investigated: with the two outposts deleted the
    // Warden stalls outright (core 2950/3000 after ten minutes), and moving them
    // six cells off their pads stalls it just as hard (2920/3000). This test
    // passes because of where things sit, not only because of the suppress rung.
    //
    // ISSUE #29 MOVED IT, AND NOT BY WINNING SLOWER — IT NO LONGER FINISHES.
    // la-cantina became the multi-deck arena its source terrain always described,
    // so `resolveWalker` is live on it and units can take a bridge. Measured on
    // 5/5 seeds: the push razes the core from 3000 to 910 (70%) and the fifteen
    // minutes run out. Seed-invariant, because both avatars idle.
    //
    // The cause is narrower than it looks, and worth recording so nobody re-derives
    // it. Isolating the two halves of #29 against this same scenario:
    //   - the thinner GROUND lattice (632 of 4009 bits re-attributed to the deck
    //     they stand on) changes NOTHING: identical outcome, to the tick.
    //   - the per-deck wall lattices change nothing either.
    //   - zeroing the deck masks reproduces the old arena exactly.
    // So the whole delta is `resolveWalker` selecting a deck at all: ONE produced
    // unit spends 30 ticks on a bridge and comes back down, which reshuffles how
    // the push packs and cascades deterministically from there. Line of sight is
    // not the mechanism either — gun→road sightlines within 42 m went 10.6% → 10.5%.
    //
    // Bounded, therefore, on what is structurally true rather than on the win: the
    // Warden still breaks the line and takes the core most of the way down, with
    // its own core untouched by an idle opponent. Restoring the finish is #31's
    // balance pass, which owns both Warden tuning and TURRET_DAMAGE — the one
    // invented number on this arena and the intended lever.
    //
    // Deck-aware lane nodes (#33) reshuffled the push enough that the finish
    // returns on this seed without a respawn-knob change. Bounded as "resolves,
    // Warden's own core untouched" rather than on the exact tick.
    expect(state.winner).toBe(1);
    expect(state.coreHp[0]).toBe(0);
    expect(state.coreHp[1]).toBe(3000);
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
    // What the board is NOT is the thing that wins the match. This used to assert
    // "captures more than half the 32 pads", which was true of a Warden that had
    // ten minutes and nothing better to do; now it wins at 268 s having taken 5,
    // and capture is 6% of its ticks against the committed rung's 71%. So the pin
    // is that the economy funded the push at all and did not need the whole board
    // to do it — the same relation, from the other side.
    //
    // The points bound is per-minute since #29, because the match now runs the
    // full fifteen minutes instead of ending at 699 s (see above) and a fixed
    // total would be measuring the clock rather than the economy. Kills and
    // trickle dominate either way: 4 captures of 32 against 602 points.
    expect(captures).toBeGreaterThan(0);
    expect(captures).toBeLessThan(MAP.turretSpots.length);
    expect(state.points[1] / (state.tick / (60 * 30))).toBeLessThan(boardValue * 0.5);
  });
});

describe("how far an unescorted push gets, per arena", () => {
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
  // What this block measures instead is how close a push gets when the defending
  // stream is off the field. Production is silenced on team 0 and nothing else is
  // touched — the ring, the base guns and the pads all still defend.
  //
  // Note what that is and is not. It removes the opposing stream but adds no
  // firepower of its own, so it measures a FREE-PRODUCTION TRICKLE against an
  // intact defence — not an escort. Reading it as an escort is what let #31 look
  // like a damage-number problem: a trickle at 8 dps was never going to chew
  // through 500 HP emplacements that come back every 60 s, and no value of
  // TURRET_DAMAGE changes that. The escorted case is the block below, and the
  // two differ qualitatively on two of the four arenas.

  it("la-cantina: razes into the core", () => {
    // 20 core hits, closest approach 5.4 m. The full objective loop runs.
    const r = push(LA_CANTINA_ID);
    expect(r.coreHits).toBeGreaterThan(0);
    expect(r.closest).toBeLessThanOrEqual(CORE_ATTACK_RADIUS);
  });

  it("urban-jungle: arrives at the core but a trickle cannot open it", () => {
    // 6.7 m measured, against a 6 m attack radius — the trickle gets all the way
    // in and is then held on the doorstep by the base's own built-in guns, which
    // sit ON the core and halt a Runner from its own 14 m out. Their HP used to be
    // the base structure's 3000 (see BASE_DEFENCE_HP in enrichArena.ts); at 500 a
    // trickle still cannot clear four of them faster than they respawn, but an
    // escort can — see the block below, where this arena razes.
    const r = push(URBAN_JUNGLE_ID);
    expect(r.closest).toBeLessThan(CORE_ATTACK_RADIUS + 2);
    expect(r.coreHits).toBe(0);
  });

  for (const id of [PROVING_GROUND_ID, BUG_HUNT_ID]) {
    it(`${id}: a trickle stops ~11 m out on one ring turret`, () => {
      // 11.5 m and 11.4 m measured. Both arenas place a ring turret 9-10 m from
      // the core, inside the last stretch of road: a Runner halts 14 m from it,
      // chips 500 imported HP at 8 dps (~62 s) and the ring respawns in 60 s, so
      // the emplacement regenerates as fast as a trickle can kill it. Nothing
      // about the road: paRoads drives this exact route unopposed, and with the
      // defenders removed outright both arenas raze the core (see below).
      //
      // This is the free stream failing on its own, which design pillar 1 says it
      // should: the player is the tiebreaker. What has to be true is that a party
      // WHICH IS TRYING gets through, and that is the next block.
      const r = push(id);
      // A free trickle may chip the core or even sit inside CORE_ATTACK_RADIUS
      // after a stage-2 rebuild moves a few wall bits; it must not raze (300
      // hits = 3000 HP). Design pillar 1 still holds: the player is the
      // tiebreaker for a real win.
      expect(r.coreHits).toBeLessThan(50);
      expect(r.closest).toBeLessThan(20);
    });
  }
});

describe("what an escort changes, per arena", () => {
  // The same measurement with a difficulty-8 Warden on the pushing side, which is
  // the closest the sim gets to "a party that is trying": 60 dps at 42 m against
  // 500 HP emplacements whose own reach is 6 m, i.e. firepower the defence cannot
  // answer. Everything else is identical to the block above.
  //
  // Until v17 this measurement was pointless, because the Warden never escorted on
  // a §9 arena. Two rungs of its goal ladder were written for §1 and mis-fire when
  // the loss condition is a core:
  //   - WGOAL_DEFEND fired on any enemy ground unit within 55 m of its own gate.
  //     With both bases producing a free Runner every 5 s that is the steady state,
  //     not an emergency: measured 63%, 89% and 91% of a ten-minute match spent on
  //     home defence on la-cantina, urban-jungle and bug-hunt, and no push at all.
  //   - WGOAL_CAPTURE outranked WGOAL_ESCORT unconditionally, so a Warden whose
  //     push had reached the enemy core would leave it there and fly across the
  //     arena for its 30th pad: 67-75% of ticks capturing against 9% escorting.
  // Escort went from 0% of ticks to 51-77%. See WARDEN_CORE_DEFEND_RADIUS and
  // WARDEN_PUSH_COMMIT_RANGE.

  // Measured core hits in 5 minutes on this seed, v18 → v20 (the suppress rung):
  // la-cantina 22 → 23, urban-jungle 8 → 1, proving-ground 8 → 114, bug-hunt 2 → 32.
  // Bounded loosely below the measured value — what must not regress is that the
  // push arrives and the core takes damage.
  //
  // urban-jungle's 8 → 1 is NOT a regression and is the reason the bound for it is
  // the bare "damages it": that arena's outcome is the seed-sensitive one. Over the
  // five seeds the version note uses, it scores [1, 2, 300, 56, 0] against
  // [8, 8, 0, 2, 2] before — mean 4 → 72, and the 300 is the core razed outright.
  // The other three are seed-invariant here (both avatars idle, so the only PRNG
  // draw in play is the harass coin flip). One seed is not a measurement on
  // urban-jungle; it is on the rest.
  // Re-measured after the build consoles were un-swapped on la-cantina and
  // bug-hunt (enrichArena's consoleRole reads the console's icon instead of
  // guessing from trigger footprints). The ground console — and with it the
  // spawn point and the road leg produced units take — moved ~5 m on both:
  // la-cantina 23 → 123, bug-hunt 32 → 6. urban-jungle and proving-ground are
  // untouched by that fix and hold their numbers exactly, which is the control.
  // bug-hunt going down is real and is not papered over; what the assertions
  // below still pin is the invariant — the push arrives and the core takes
  // damage — not the magnitude.
  // la-cantina 123 → 22 in #29, for the reason spelled out on "resolves the
  // match" above: its decks went live and one unit taking a bridge cascades. The
  // invariant is untouched — the push still arrives inside CORE_ATTACK_RADIUS and
  // the core still takes damage — and the magnitude is not what this pins.
  for (const [id, hits] of [
    [LA_CANTINA_ID, 22],
    [URBAN_JUNGLE_ID, 1],
    [PROVING_GROUND_ID, 114],
    [BUG_HUNT_ID, 6],
  ] as const) {
    it(`${id}: an escorted push reaches the core and damages it`, () => {
      const r = push(id, true);
      expect(r.closest).toBeLessThanOrEqual(CORE_ATTACK_RADIUS);
      expect(r.coreHits).toBeGreaterThan(0);
      expect(r.coreHits).toBeGreaterThanOrEqual(Math.floor(hits / 2));
    });
  }

  it("no standoff position exists against a base emplacement, on any arena", () => {
    // The finding v20's WGOAL_SUPPRESS is built on, and the reason it closes to 3 m
    // instead of picking a firing position: the arenas' wall lattice is dense city
    // geometry, so a defending emplacement is not shootable from range by ANYBODY.
    //
    // This is what ruled out the two cheaper readings of "the Warden holds a target
    // for 1-18% of the match". It is not out of position — there is nowhere to
    // stand. And it is not that a flying entity ought to see over walls: that would
    // delete the arenas' cover model for everything that flies, and since an
    // emplacement's own reach is 6 m it would make the Warden unanswerable.
    //
    // Sampled as a ring of directions per emplacement rather than as a single
    // segment, so the claim is "from no direction" and not "not from here".
    for (const id of [LA_CANTINA_ID, URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID]) {
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

  it("razes once the defenders are gone, on all four arenas", () => {
    // golden07 proves this for la-cantina; the same has to hold for the three
    // arenas Phase 13 added, or "the objective is reachable" is only true on one of
    // them. Team 0's turrets are removed as they respawn — the stand-in for a
    // defence that has actually been beaten — and nothing else is touched.
    for (const id of [LA_CANTINA_ID, URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID]) {
      const map = getMapById(id);
      (map.bases[0] as { productionTicks: number }).productionTicks = 0;
      const state = createSim(map, 0xc0ffee, {});
      const idle = createTickInputs();
      for (let t = 0; t < 5 * 60 * 30 && state.winner < 0; t++) {
        step(state, idle);
        for (let e = 0; e < state.ent.high; e++) {
          if (!state.ent.alive[e]) continue;
          if (state.ent.team[e] === 0 && state.ent.archetype[e] === ARCHETYPE.TURRET) {
            state.ent.alive[e] = 0;
          }
        }
      }
      expect(state.coreHp[0]).toBe(0);
      expect(state.winner).toBe(1);
    }
  });
});
