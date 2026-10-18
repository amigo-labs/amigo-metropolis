// The results page's statistics (SIM_VERSION 76; fcop-fidelity.md V7): the
// original's twenty player_stat keys per side, each raised where its
// definition says (RE extracted/presentation/results.json stats[], with the C it
// cites), read back through writeResultsSnapshot.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { COST_OUTPOST_CLAIM, FRAME_CLOCK_PER_TICK, POINTS_AVATAR_DOWN } from "../src/balance";
import { BTN_ACTION, createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID, sampleHeight } from "../src/map";
import {
  claimOutpostSlot,
  createSim,
  hash,
  hitscan,
  MODE_HOVER,
  type SimState,
  spawnUnit,
  step,
} from "../src/sim";
import {
  RESULTS_SNAPSHOT_LEN,
  resultsSlotOffset,
  STAT_CURRENT_POINTS,
  STAT_DREADNOUGHTS_CREATED,
  STAT_DREADNOUGHTS_DESTROYED,
  STAT_FIRST_DEATH,
  STAT_FIRST_OUTPOST,
  STAT_FORTRESSES_CREATED,
  STAT_FORTRESSES_DESTROYED,
  STAT_JETS_CREATED,
  STAT_JETS_DESTROYED,
  STAT_KEYS,
  STAT_OUTPOSTS_CLAIMED,
  STAT_POINTS_SCORED,
  STAT_TANKS_CREATED,
  STAT_TANKS_DESTROYED,
  STAT_TIME_HOVER,
  STAT_TIME_WALKER,
  STAT_TOTAL_TIME,
  STAT_TURRETS_CLAIMED,
  STAT_TURRETS_DESTROYED,
  STAT_WALKER_DEATHS,
  STAT_WALKER_KILLS,
  unitStatKey,
  writeResultsSnapshot,
} from "../src/stats";

const map = getMapById(LA_CANTINA_ID);
const idle = createTickInputs();
// Open ground on la-cantina with no neutral turret, outpost or base within 10 m
// (warden.test.ts "a player's down").
const X = 152;
const Y = 128;

const snap = new Float32Array(RESULTS_SNAPSHOT_LEN);
function stat(state: SimState, slot: number, key: number): number {
  writeResultsSnapshot(state, snap);
  return snap[resultsSlotOffset(slot) + key];
}

/** Stands player `p`'s mech at (x, y) on the ground. */
function standAt(state: SimState, p: number, x: number, y: number): number {
  const a = state.avatarId[p];
  state.ent.posX[a] = x;
  state.ent.posY[a] = y;
  state.ent.height[a] = sampleHeight(state.map, x, y);
  state.ent.entLayer[a] = 0;
  return a;
}

/** Steps until player `p`'s mech is down, or `limit` ticks. */
function untilDown(state: SimState, p: number, limit: number, each?: () => void): void {
  for (let t = 0; t < limit && state.avatarId[p] >= 0; t++) {
    each?.();
    step(state, idle);
  }
}

describe("the results snapshot", () => {
  it("lays out twenty keys per slot, slot-major", () => {
    expect(STAT_KEYS).toBe(20);
    expect(RESULTS_SNAPSHOT_LEN).toBe(40);
    expect(resultsSlotOffset(1)).toBe(20);
    // The page's key order (results.c's scripts: 0x40 + key).
    expect([STAT_TANKS_DESTROYED, STAT_TANKS_CREATED, STAT_JETS_DESTROYED]).toEqual([0, 1, 2]);
    expect([STAT_TURRETS_DESTROYED, STAT_TURRETS_CLAIMED]).toEqual([8, 9]);
    expect([STAT_WALKER_KILLS, STAT_WALKER_DEATHS, STAT_OUTPOSTS_CLAIMED]).toEqual([10, 11, 12]);
    expect([STAT_CURRENT_POINTS, STAT_POINTS_SCORED, STAT_FIRST_DEATH]).toEqual([13, 14, 15]);
    expect([STAT_FIRST_OUTPOST, STAT_TIME_WALKER, STAT_TIME_HOVER]).toEqual([16, 17, 18]);
    expect(STAT_TOTAL_TIME).toBe(19);
  });

  it("starts at zero but for the points, and is a pure read", () => {
    const state = createSim(map, 7);
    const before = hash(state);
    for (let s = 0; s < 2; s++) {
      for (let k = 0; k < STAT_KEYS; k++) {
        expect(stat(state, s, k)).toBe(k === STAT_CURRENT_POINTS ? state.points[s] : 0);
      }
    }
    expect(hash(state)).toBe(before);
  });
});

describe("Created and Destroyed (spawn.c csac_credit_spawn, csac_on_spawned_death)", () => {
  it("credits a unit's spawn to the side it joins, by class", () => {
    const state = createSim(map, 7);
    spawnUnit(state, ARCHETYPE.RUNNER, 0, X, Y);
    spawnUnit(state, ARCHETYPE.GUARDIAN, 1, X, Y);
    spawnUnit(state, ARCHETYPE.JUGGERNAUT, 1, X, Y);
    spawnUnit(state, ARCHETYPE.FORTRESS, 0, X, Y);
    spawnUnit(state, ARCHETYPE.RUNNER, 0, X, Y + 2);
    expect(stat(state, 0, STAT_TANKS_CREATED)).toBe(2);
    expect(stat(state, 0, STAT_FORTRESSES_CREATED)).toBe(1);
    expect(stat(state, 0, STAT_JETS_CREATED)).toBe(0);
    expect(stat(state, 1, STAT_JETS_CREATED)).toBe(1);
    expect(stat(state, 1, STAT_DREADNOUGHTS_CREATED)).toBe(1);
    expect(stat(state, 1, STAT_TANKS_CREATED)).toBe(0);
    // Nothing is destroyed by a spawn.
    for (const k of [0, 2, 4, 6]) expect(stat(state, 0, k) + stat(state, 1, k)).toBe(0);
  });

  it("counts a unit's death as a loss of the side it was on, whoever killed it", () => {
    const state = createSim(map, 7);
    const archs = [ARCHETYPE.RUNNER, ARCHETYPE.GUARDIAN, ARCHETYPE.JUGGERNAUT, ARCHETYPE.FORTRESS];
    for (const arch of archs) {
      const id = spawnUnit(state, arch, 1, X, Y);
      state.ent.hp[id] = 0;
      state.ent.aux[id] = 0; // nobody's hit
    }
    step(state, idle);
    expect(stat(state, 1, STAT_TANKS_DESTROYED)).toBe(1);
    expect(stat(state, 1, STAT_JETS_DESTROYED)).toBe(1);
    expect(stat(state, 1, STAT_DREADNOUGHTS_DESTROYED)).toBe(1);
    expect(stat(state, 1, STAT_FORTRESSES_DESTROYED)).toBe(1);
    for (const k of [0, 2, 4, 6]) expect(stat(state, 0, k)).toBe(0);
  });

  it("keys the class rows as the original's class byte does", () => {
    expect(unitStatKey(ARCHETYPE.RUNNER, false)).toBe(0);
    expect(unitStatKey(ARCHETYPE.RUNNER, true)).toBe(1);
    expect(unitStatKey(ARCHETYPE.FORTRESS, true)).toBe(7);
    expect(unitStatKey(ARCHETYPE.AVATAR, true)).toBe(-1);
    expect(unitStatKey(ARCHETYPE.TURRET, false)).toBe(-1);
  });
});

describe("Turrets Claimed and Destroyed (turret.c turret_score_capture / _death)", () => {
  /** Player `p` takes neutral turret spot `k` with a press of the Action Key beside it. */
  function capture(state: SimState, p: number, k: number): number {
    const ent = state.ent;
    const tid = state.neutralTurretEntity[k];
    const a = state.avatarId[p];
    const press = createTickInputs();
    for (const buttons of [0, BTN_ACTION]) {
      ent.posX[a] = ent.posX[tid] - 2;
      ent.posY[a] = ent.posY[tid];
      ent.height[a] = ent.height[tid];
      press.players[p].buttons = buttons;
      step(state, press);
    }
    return tid;
  }

  it("counts a capture for the capturer, and the turret's death for the side that held it", () => {
    const state = createSim(map, 1);
    const tid = capture(state, 0, 1);
    expect(state.ent.ownerId[tid]).toBe(0);
    expect(stat(state, 0, STAT_TURRETS_CLAIMED)).toBe(1);
    expect(stat(state, 1, STAT_TURRETS_CLAIMED)).toBe(0);
    // Player 1's side destroys it: player 0 lost it, and player 1 scores.
    state.ent.hp[tid] = 0;
    state.ent.aux[tid] = 2;
    step(state, idle);
    expect(stat(state, 0, STAT_TURRETS_DESTROYED)).toBe(1);
    expect(stat(state, 1, STAT_TURRETS_DESTROYED)).toBe(0);
    expect(stat(state, 1, STAT_POINTS_SCORED)).toBe(1);
  });

  it("counts nothing for a neutral turret's death", () => {
    const state = createSim(map, 1);
    const tid = state.neutralTurretEntity[1];
    state.ent.hp[tid] = 0;
    step(state, idle);
    for (const s of [0, 1]) expect(stat(state, s, STAT_TURRETS_DESTROYED)).toBe(0);
  });

  it("counts a tank's capture for its side", () => {
    const state = createSim(map, 1);
    const tid = state.neutralTurretEntity[1];
    const ent = state.ent;
    const u = spawnUnit(state, ARCHETYPE.RUNNER, 1, ent.posX[tid] - 1, ent.posY[tid]);
    ent.height[u] = ent.height[tid];
    step(state, idle);
    expect(ent.ownerId[tid]).toBe(1);
    expect(stat(state, 1, STAT_TURRETS_CLAIMED)).toBe(1);
  });
});

describe("Walker Deaths, Walker Kills and First Death (player.c player_op4)", () => {
  it("counts every down, and stamps the first on the frame clock", () => {
    const state = createSim(map, 3);
    standAt(state, 0, X, Y);
    for (let t = 0; t < 9; t++) step(state, idle);
    const a = state.avatarId[0];
    state.ent.hp[a] = 0;
    state.ent.aux[a] = 0;
    const tick = state.tick;
    step(state, idle);
    expect(state.avatarId[0]).toBe(-1);
    expect(stat(state, 0, STAT_WALKER_DEATHS)).toBe(1);
    expect(stat(state, 0, STAT_FIRST_DEATH)).toBe((tick + 1) * FRAME_CLOCK_PER_TICK);
    // Nobody's hit: nobody's kill.
    expect(stat(state, 1, STAT_WALKER_KILLS)).toBe(0);
    while (state.avatarId[0] < 0) step(state, idle);
    state.ent.hp[state.avatarId[0]] = 0;
    step(state, idle);
    expect(stat(state, 0, STAT_WALKER_DEATHS)).toBe(2);
    expect(stat(state, 0, STAT_FIRST_DEATH)).toBe((tick + 1) * FRAME_CLOCK_PER_TICK);
  });

  it("credits the other slot's Walker Kills when its own mech's fire put the mech down", () => {
    const state = createSim(map, 3);
    const foe = standAt(state, 0, X, Y);
    const me = standAt(state, 1, X - 6, Y);
    state.ent.hp[foe] = 1;
    hitscan(state, me, 1, 1, 0, 12, 10);
    step(state, idle);
    expect(state.avatarId[0]).toBe(-1);
    expect(stat(state, 1, STAT_WALKER_KILLS)).toBe(1);
    expect(stat(state, 0, STAT_WALKER_KILLS)).toBe(0);
    expect(stat(state, 0, STAT_WALKER_DEATHS)).toBe(1);
  });

  it("credits nobody when the other side's tank did it", () => {
    const state = createSim(map, 5);
    const foe = standAt(state, 0, X, Y);
    state.ent.hp[foe] = 1;
    spawnUnit(state, ARCHETYPE.RUNNER, 1, X + 5, Y);
    untilDown(state, 0, 150, () => standAt(state, 1, 20, 20));
    expect(state.avatarId[0]).toBe(-1);
    expect(stat(state, 0, STAT_WALKER_DEATHS)).toBe(1);
    expect(stat(state, 1, STAT_WALKER_KILLS)).toBe(0);
  });

  it("credits the Sky Captain's own fire to its side, and counts its own deaths", () => {
    const state = createSim(map, 5, { wardenPlayer: 1, wardenDifficulty: 10 });
    const wid = state.avatarId[1];
    const foe = standAt(state, 0, X, Y);
    state.ent.hp[foe] = 1;
    untilDown(state, 0, 60, () => {
      state.ent.posX[wid] = X - 6;
      state.ent.posY[wid] = Y;
      state.captain.move = -1;
      state.captain.destX = X + 1;
      state.captain.destY = Y;
      state.captain.think = 1e6;
    });
    expect(state.avatarId[0]).toBe(-1);
    expect(stat(state, 1, STAT_WALKER_KILLS)).toBe(1);
    expect(stat(state, 0, STAT_WALKER_KILLS)).toBe(0);
    // The captain goes down, by no one's hit: its deaths and its First Death,
    // and no kill for the player.
    const w = state.avatarId[1];
    state.ent.hp[w] = 0;
    const tick = state.tick;
    step(state, idle);
    expect(stat(state, 1, STAT_WALKER_DEATHS)).toBe(1);
    expect(stat(state, 1, STAT_FIRST_DEATH)).toBe((tick + 1) * FRAME_CLOCK_PER_TICK);
    expect(stat(state, 0, STAT_WALKER_KILLS)).toBe(0);
  });

  /** A Sky Captain match with the captain at (x, y) on 1 health. */
  function captainAt(x: number, y: number): SimState {
    const state = createSim(map, 5, { wardenPlayer: 1, wardenDifficulty: 1 });
    const w = state.avatarId[1];
    state.ent.posX[w] = x;
    state.ent.posY[w] = y;
    state.ent.hp[w] = 1;
    return state;
  }

  it("credits the player's Walker Kills when its own fire brings the Sky Captain down", () => {
    // aircraft.c 0x00420e1c..0x00420e57: the captain's remembered killer (+0x8c)
    // resolves to team slot 0's mech, and that mech's block +0x14 rises.
    const state = captainAt(X, Y);
    const me = standAt(state, 0, X - 6, Y);
    hitscan(state, me, 0, 1, 0, 12, 10);
    step(state, idle);
    expect(state.avatarId[1]).toBe(-1);
    expect(stat(state, 0, STAT_WALKER_KILLS)).toBe(1);
    expect(stat(state, 1, STAT_WALKER_DEATHS)).toBe(1);
    expect(stat(state, 1, STAT_WALKER_KILLS)).toBe(0);
  });

  it("credits nobody when the player's tank brings the Sky Captain down", () => {
    const state = captainAt(X, Y);
    standAt(state, 0, 20, 20);
    const tank = spawnUnit(state, ARCHETYPE.RUNNER, 0, X - 6, Y);
    hitscan(state, tank, 0, 1, 0, 12, 10);
    step(state, idle);
    expect(state.avatarId[1]).toBe(-1);
    expect(stat(state, 1, STAT_WALKER_DEATHS)).toBe(1);
    expect(stat(state, 0, STAT_WALKER_KILLS)).toBe(0);
  });

  it("forgets the player's hits on the Sky Captain when it comes back", () => {
    const state = captainAt(X, Y);
    const me = standAt(state, 0, X - 6, Y);
    state.ent.hp[state.avatarId[1]] = 100;
    hitscan(state, me, 0, 1, 0, 12, 10); // a hit that does not bring it down
    expect(state.rivalHit[1]).toBe(1);
    state.ent.hp[state.avatarId[1]] = 0;
    step(state, idle);
    while (state.avatarId[1] < 0) step(state, idle);
    expect(state.rivalHit[1]).toBe(0);
  });
});

describe("Points Scored (state word 31)", () => {
  it("adds every point earned and keeps them through a purchase and a down", () => {
    const state = createSim(map, 3);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 1, X, Y);
    state.ent.hp[id] = 0;
    step(state, idle);
    expect(stat(state, 0, STAT_POINTS_SCORED)).toBe(1);
    expect(stat(state, 0, STAT_CURRENT_POINTS)).toBe(state.points[0]);
    // A down: +10 to the other side (at the respawn), -10 here, and Scored keeps.
    state.points[0] = 40;
    claimOutpostSlot(state, 0, 0);
    expect(state.points[0]).toBe(40 - COST_OUTPOST_CLAIM);
    expect(stat(state, 0, STAT_POINTS_SCORED)).toBe(1);
    state.ent.hp[state.avatarId[0]] = 0;
    step(state, idle);
    for (let t = 0; t < 400 && state.avatarId[0] < 0; t++) step(state, idle);
    expect(state.avatarId[0]).toBeGreaterThanOrEqual(0);
    expect(stat(state, 1, STAT_POINTS_SCORED)).toBe(POINTS_AVATAR_DOWN);
    expect(stat(state, 0, STAT_POINTS_SCORED)).toBe(1);
  });
});

describe("Outposts Claimed and First Outpost (state word 33; view +0x24, sky_ai +0x4c)", () => {
  it("counts a player's outposts and stamps its first on its next live tick", () => {
    const state = createSim(map, 3);
    state.points[0] = 100;
    step(state, idle);
    expect(claimOutpostSlot(state, 0, 2)).toBe(true);
    expect(stat(state, 0, STAT_OUTPOSTS_CLAIMED)).toBe(1);
    expect(stat(state, 0, STAT_FIRST_OUTPOST)).toBe(0);
    const tick = state.tick;
    step(state, idle);
    expect(stat(state, 0, STAT_FIRST_OUTPOST)).toBe((tick + 1) * FRAME_CLOCK_PER_TICK);
    claimOutpostSlot(state, 0, 3);
    step(state, idle);
    expect(stat(state, 0, STAT_OUTPOSTS_CLAIMED)).toBe(2);
    expect(stat(state, 0, STAT_FIRST_OUTPOST)).toBe((tick + 1) * FRAME_CLOCK_PER_TICK);
  });

  it("stamps the Sky Captain's at its first claim", () => {
    const state = createSim(map, 3, { wardenPlayer: 1, wardenDifficulty: 5 });
    for (let t = 0; t < 4; t++) step(state, idle);
    state.points[1] = 100;
    expect(claimOutpostSlot(state, 1, 0)).toBe(true);
    const at = (state.tick + 1) * FRAME_CLOCK_PER_TICK;
    expect(stat(state, 1, STAT_FIRST_OUTPOST)).toBe(at);
    step(state, idle);
    claimOutpostSlot(state, 1, 1);
    expect(stat(state, 1, STAT_FIRST_OUTPOST)).toBe(at);
    expect(stat(state, 1, STAT_OUTPOSTS_CLAIMED)).toBe(2);
  });
});

describe("Time as Walker, Time as Hovercraft and Total Time (view +0x28 / +0x2c)", () => {
  it("adds a live mech's ticks to its form's timer, and nothing while it is down", () => {
    const state = createSim(map, 3);
    for (let t = 0; t < 30; t++) step(state, idle);
    expect(stat(state, 0, STAT_TIME_WALKER)).toBe(30 * FRAME_CLOCK_PER_TICK);
    expect(stat(state, 0, STAT_TIME_HOVER)).toBe(0);
    state.ent.mode[state.avatarId[0]] = MODE_HOVER;
    for (let t = 0; t < 12; t++) step(state, idle);
    expect(stat(state, 0, STAT_TIME_HOVER)).toBe(12 * FRAME_CLOCK_PER_TICK);
    expect(stat(state, 0, STAT_TOTAL_TIME)).toBe(42 * FRAME_CLOCK_PER_TICK);
    state.ent.hp[state.avatarId[0]] = 0;
    step(state, idle);
    for (let t = 0; t < 20; t++) step(state, idle);
    expect(state.avatarId[0]).toBe(-1);
    expect(stat(state, 0, STAT_TOTAL_TIME)).toBe(42 * FRAME_CLOCK_PER_TICK);
  });

  it("gives the Sky Captain's side no form timers and the player's Total Time", () => {
    const state = createSim(map, 3, { wardenPlayer: 1, wardenDifficulty: 5 });
    for (let t = 0; t < 25; t++) step(state, idle);
    expect(stat(state, 1, STAT_TIME_WALKER)).toBe(0);
    expect(stat(state, 1, STAT_TIME_HOVER)).toBe(0);
    expect(stat(state, 1, STAT_TOTAL_TIME)).toBe(stat(state, 0, STAT_TOTAL_TIME));
    expect(stat(state, 0, STAT_TOTAL_TIME)).toBe(25 * FRAME_CLOCK_PER_TICK);
  });

  it("stops counting when the match is decided", () => {
    const state = createSim(map, 3);
    for (let t = 0; t < 5; t++) step(state, idle);
    state.winner = 0;
    for (let t = 0; t < 5; t++) step(state, idle);
    expect(stat(state, 0, STAT_TOTAL_TIME)).toBe(5 * FRAME_CLOCK_PER_TICK);
  });
});
