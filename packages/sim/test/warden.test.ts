// The Warden is the original's Sky Captain (SIM_VERSION 46; fcop-fidelity.md U3;
// fcop-re/ai-and-rules.md §1). It runs inside the sim off sim state + sim PRNG
// only, so a Warden match must be exactly as deterministic as a human one
// (golden #4 pins a full match; these tests pin the captain's rules directly).
//
// Until v45 the Warden was Metropolis' own: 450 HP, 10 m/s, a 42 m cannon, a
// goal ladder of defend / buy / push / suppress / capture / escort / harass, and
// no level. The tests of that ladder went with it.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  CFUN_DELTA_PER_TICK,
  COST_OUTPOST_CLAIM,
  POINTS_AVATAR_DOWN,
  SKY_RETHINK_BASE,
  SKY_RETHINK_JITTER,
  SKY_RETHINK_JITTER_DEFEND,
  SKY_RETHINK_PER_LEVEL,
  SKY_TURN_RATE,
  STARTING_POINTS,
  skyMaxHp,
  skyRespawnTicks,
  skySpeed,
  TICK_DT,
  UNIT_QUEUES,
  WARDEN_ALTITUDE,
  WEAPON_UNITS_PER_TICK,
  wardenLevel,
} from "../src/balance";
import {
  EV_CLAIM,
  EV_DEATH,
  EV_PURCHASE,
  EV_SHOT,
  EVENT_STRIDE,
  SHOT_SLOT_HITSCAN,
} from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID, sampleHeight } from "../src/map";
import { claimOutpostSlot, createSim, hash, type SimState, spawnUnit, step } from "../src/sim";
import {
  SKY_CRUISE,
  SKY_ENGAGE,
  SKY_MODE_ATTACK,
  SKY_MODE_DEFEND,
  SKY_MODE_ROAM,
  SKY_QUEUE_BASE_JETS,
  SKY_QUEUE_BASE_TANKS,
} from "../src/warden";

const idle = createTickInputs();
const LC = getMapById(LA_CANTINA_ID);

function wardenSim(difficulty: number, seed = 0xc0ffee, mapId = LA_CANTINA_ID): SimState {
  return createSim(getMapById(mapId), seed, { wardenPlayer: 1, wardenDifficulty: difficulty });
}

describe("the Warden is the Sky Captain", () => {
  it("spawns as the captain's craft on the configured slot", () => {
    const sim = wardenSim(5);
    const wid = sim.avatarId[1];
    expect(sim.ent.archetype[wid]).toBe(ARCHETYPE.WARDEN);
    expect(sim.ent.hp[wid]).toBe(skyMaxHp(4));
    const ground = sampleHeight(sim.map, sim.ent.posX[wid], sim.ent.posY[wid]);
    expect(sim.ent.height[wid]).toBeGreaterThanOrEqual(ground + WARDEN_ALTITUDE - 0.001);
    expect(sim.ent.archetype[sim.avatarId[0]]).toBe(ARCHETYPE.AVATAR);
    const plain = createSim(LC, 1);
    expect(plain.wardenPlayer).toBe(-1);
    expect(plain.ent.archetype[plain.avatarId[1]]).toBe(ARCHETYPE.AVATAR);
  });

  it("clamps the difficulty into 1–10 and plays it as level 0–9", () => {
    expect(wardenSim(0).wardenDifficulty).toBe(1);
    expect(wardenSim(99).wardenDifficulty).toBe(10);
    expect(wardenSim(7.9).wardenDifficulty).toBe(7);
    expect(wardenSim(Number.NaN).wardenDifficulty).toBe(1);
    const fractional = createSim(LC, 1, {
      wardenPlayer: 0.5,
      wardenDifficulty: 5,
    });
    expect(fractional.wardenPlayer).toBe(0);
    expect(fractional.ent.archetype[fractional.avatarId[0]]).toBe(ARCHETYPE.WARDEN);
    expect([1, 5, 8, 10].map(wardenLevel)).toEqual([0, 4, 7, 9]);
  });

  it("takes its health, speed and respawn from its level", () => {
    // fcop-re/ai-and-rules.md §1.3: the construct's formulas on the record's 1000
    // HP and 1843 raw speed, and the crash landing's (14 - L) * 150 units.
    const hp = [250, 250, 500, 500, 750, 750, 1000, 1000, 1125, 1250];
    const speed = [2.72, 3.01, 3.31, 3.6, 3.75, 3.9, 4.05, 4.2, 4.36, 4.51];
    const respawn = [7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5];
    for (let l = 0; l <= 9; l++) {
      expect(skyMaxHp(l)).toBe(hp[l]);
      expect(Math.abs(skySpeed(l) - speed[l])).toBeLessThan(0.006); // the table rounds
      expect(skyRespawnTicks(l) / 30).toBeCloseTo(respawn[l], 5);
    }
    // And it flies at that speed.
    const sim = wardenSim(10, 1, LA_CANTINA_ID);
    const wid = sim.avatarId[1];
    step(sim, idle);
    const x = sim.ent.posX[wid];
    const y = sim.ent.posY[wid];
    step(sim, idle);
    const d = Math.hypot(sim.ent.posX[wid] - x, sim.ent.posY[wid] - y);
    expect(d).toBeCloseTo(skySpeed(9) * TICK_DT, 4);
  });

  it("is deterministic, and the level changes the match", () => {
    const a = wardenSim(7, 123);
    const b = wardenSim(7, 123);
    for (let t = 0; t < 900; t++) {
      step(a, idle);
      step(b, idle);
      if (hash(a) !== hash(b)) throw new Error(`warden runs diverged at tick ${t}`);
    }
    const low = wardenSim(1, 42);
    const high = wardenSim(10, 42);
    let diverged = false;
    for (let t = 0; t < 900 && !diverged; t++) {
      step(low, idle);
      step(high, idle);
      diverged = hash(low) !== hash(high);
    }
    expect(diverged).toBe(true);
  });

  it("starts its budget at 0, and its fall pays the enemy 10 at once", () => {
    // A one-viewport game starts the captain's Current Points at zero
    // (0x004214fc); the player starts on 10 (R2).
    const sim = wardenSim(1);
    expect(sim.points[1]).toBe(0);
    expect(sim.points[0]).toBe(STARTING_POINTS);
    sim.points[1] = 25;
    sim.ent.hp[sim.avatarId[1]] = -10;
    step(sim, idle);
    expect(sim.avatarId[1]).toBe(-1);
    expect(sim.points[0]).toBe(STARTING_POINTS + POINTS_AVATAR_DOWN);
    expect(sim.points[1]).toBe(25 - POINTS_AVATAR_DOWN);
  });

  it("respawns after (14 - L) * 150 engine units, whole, roaming", () => {
    const sim = wardenSim(5);
    // Four of its eight ring turrets down (they rebuild after 37.5 s): eight
    // parts, under the ten that keep it roaming.
    const n0 = sim.map.bases[0].turrets.length;
    for (let k = n0 + 4; k < sim.baseTurretEntity.length; k++) {
      sim.ent.hp[sim.baseTurretEntity[k]] = 0;
    }
    step(sim, idle);
    sim.ent.hp[sim.avatarId[1]] = -10;
    step(sim, idle);
    const ticks = skyRespawnTicks(4);
    expect(ticks).toBe(150);
    expect(sim.respawnTimer[1]).toBe(ticks - 1);
    for (let t = 0; t < ticks - 1; t++) step(sim, idle);
    const reborn = sim.avatarId[1];
    expect(reborn).toBeGreaterThanOrEqual(0);
    expect(sim.ent.hp[reborn]).toBe(skyMaxHp(4));
    // Respawn sets mode 0 and a decision on the next tick, which (fewer than ten
    // own turret parts) promotes it straight back to defend.
    expect(sim.captain.mode).toBe(SKY_MODE_ROAM);
    expect(sim.captain.think).toBe(0);
    step(sim, idle);
    expect(sim.captain.mode).toBe(SKY_MODE_DEFEND);
  });

  it("rethinks every 848 - 80 L engine units, jittered by its mode", () => {
    for (const d of [1, 10]) {
      const sim = wardenSim(d, 9, LA_CANTINA_ID);
      const l = d - 1;
      // The construct's decision reloads in the construct's mode (defend), and
      // leaves it: la-cantina's 8 ring turrets count 16.
      step(sim, idle);
      let reload = sim.captain.think;
      expect(sim.captain.mode).toBe(SKY_MODE_ROAM);
      expect(reload).toBeLessThanOrEqual(SKY_RETHINK_BASE - SKY_RETHINK_PER_LEVEL * l);
      expect(reload).toBeGreaterThan(
        SKY_RETHINK_BASE - SKY_RETHINK_PER_LEVEL * l - SKY_RETHINK_JITTER_DEFEND,
      );
      // Roaming, the next one comes up to 255 units later instead.
      sim.captain.think = 0;
      step(sim, idle);
      reload = sim.captain.think;
      expect(reload).toBeGreaterThanOrEqual(SKY_RETHINK_BASE - SKY_RETHINK_PER_LEVEL * l);
      expect(reload).toBeLessThan(
        SKY_RETHINK_BASE - SKY_RETHINK_PER_LEVEL * l + SKY_RETHINK_JITTER,
      );
    }
    expect(SKY_RETHINK_JITTER).toBe(256);
  });

  it("gets a free opening order of ten base units from level 1, none at level 0", () => {
    const queued = (sim: SimState, q: number) => sim.unitQueue[1 * UNIT_QUEUES + q];
    const l0 = wardenSim(1, 3, LA_CANTINA_ID);
    expect(queued(l0, SKY_QUEUE_BASE_TANKS) + queued(l0, SKY_QUEUE_BASE_JETS)).toBe(0);
    for (let seed = 1; seed <= 20; seed++) {
      const sim = wardenSim(8, seed, LA_CANTINA_ID);
      const tanks = queued(sim, SKY_QUEUE_BASE_TANKS);
      const jets = queued(sim, SKY_QUEUE_BASE_JETS);
      expect(tanks + jets).toBe(10);
      expect(tanks).toBeGreaterThanOrEqual(9 - 7);
      expect(tanks).toBeLessThanOrEqual(9 - 7 + 3);
      expect(sim.points[1]).toBe(0); // unpaid
    }
    // The scripts spawn them one a period from a random phase: on Mp a tank per
    // 3.38 s (fn19, 203 units, 1015 engine ticks: 101 and 102 ticks apart) and a
    // jet per 0.97 s (fn17, 58 units, 290: 29 ticks). Until SIM_VERSION 79 the
    // captain's team on Mp held slot 0's base and its fn18 (202 units, 1010), a
    // queue the original never feeds the captain; until 84 the periods were
    // rounded to sim ticks (102, 29).
    const sim = wardenSim(8, 1, LA_CANTINA_ID);
    const base = sim.map.bases[1].queuePeriod;
    expect([base.tank, base.jet]).toEqual([1015, 290]);
    const tankTicks = Math.ceil(base.tank / CFUN_DELTA_PER_TICK);
    const jetPeriod = base.jet / CFUN_DELTA_PER_TICK;
    const jetTicks: number[] = [];
    let firstTank = -1;
    for (let t = 0; t < tankTicks + 1; t++) {
      step(sim, idle);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (sim.events.data[o] !== EV_PURCHASE) continue;
        const arch = sim.events.data[o + 3];
        if (arch === ARCHETYPE.GUARDIAN) jetTicks.push(t);
        if (arch === ARCHETYPE.RUNNER && firstTank < 0) firstTank = t;
      }
    }
    expect(firstTank).toBeGreaterThanOrEqual(0); // within the first period
    expect(jetTicks[0]).toBeLessThan(jetPeriod);
    for (let n = 1; n < jetTicks.length; n++) expect(jetTicks[n] - jetTicks[n - 1]).toBe(jetPeriod);
  });
});

describe("the captain's mode machine (fcop-re/ai-and-rules.md §1.5)", () => {
  /** Kills all but `keep` of the captain's (team 1's) ring turrets. */
  function thinRing(sim: SimState, keep: number): void {
    const n0 = sim.map.bases[0].turrets.length;
    for (let k = n0 + keep; k < sim.baseTurretEntity.length; k++) {
      sim.ent.hp[sim.baseTurretEntity[k]] = 0;
    }
  }
  /** Steps once with a decision on that tick. */
  function decideNow(sim: SimState): void {
    sim.captain.think = 0;
    step(sim, idle);
  }

  it("defends while fewer than five of its team turrets stand, flying at the player", () => {
    // fcop-re/outposts.md Q2: each live team turret counts twice (the turret and
    // its base part), against 10. la-cantina's ring is 8 (16): it roams; with 4
    // left (8) it defends; with 5 (10) it roams again.
    const sim = wardenSim(8, 5, LA_CANTINA_ID);
    step(sim, idle);
    expect(sim.captain.mode).toBe(SKY_MODE_ROAM);
    thinRing(sim, 4);
    step(sim, idle); // the deaths
    decideNow(sim);
    expect(sim.captain.mode).toBe(SKY_MODE_DEFEND);
    expect(sim.captain.move).toBe(sim.avatarId[0]);
    expect(sim.captain.fly).toBe(SKY_ENGAGE);
    const five = wardenSim(8, 5, LA_CANTINA_ID);
    step(five, idle);
    thinRing(five, 5);
    step(five, idle);
    decideNow(five);
    expect(five.captain.mode).toBe(SKY_MODE_ROAM);
  });

  it("counts its outposts' plate turrets once they stand, never a captured neutral", () => {
    const sim = wardenSim(8, 5, LA_CANTINA_ID);
    step(sim, idle);
    thinRing(sim, 4);
    step(sim, idle);
    // Three neutral turrets it captured: type 36, not counted.
    let taken = 0;
    for (let k = 0; k < sim.neutralTurretEntity.length && taken < 3; k++) {
      const tid = sim.neutralTurretEntity[k];
      if (tid < 0 || sim.ent.ownerId[tid] >= 0) continue;
      sim.ent.team[tid] = 1;
      sim.ent.ownerId[tid] = 1;
      taken += 1;
    }
    decideNow(sim);
    expect(sim.captain.mode).toBe(SKY_MODE_DEFEND);
    // An owned outpost's two plate turrets stand from its claim's spawner pass:
    // 4 + 2 = 6 team turrets, 12.
    sim.points[1] = COST_OUTPOST_CLAIM;
    expect(claimOutpostSlot(sim, 1, 0)).toBe(true);
    step(sim, idle);
    decideNow(sim);
    expect(sim.captain.mode).toBe(SKY_MODE_ROAM);
  });

  it("defends home against an enemy tank within 64 m, aiming once inside 12 m", () => {
    const sim = wardenSim(8, 5, LA_CANTINA_ID);
    const home = LC.spawns[1];
    const wid = sim.avatarId[1];
    const tank = spawnUnit(sim, ARCHETYPE.RUNNER, 0, home.x + 6, home.y);
    sim.ent.timerA[tank] = -1; // parked
    sim.ent.hp[tank] = 1e6;
    sim.ent.posX[wid] = home.x;
    sim.ent.posY[wid] = home.y;
    step(sim, idle);
    expect(sim.captain.mode).toBe(SKY_MODE_DEFEND);
    expect(sim.captain.move).toBe(tank);
    expect(sim.captain.aim).toBe(tank);
  });

  it("roams from the start: claims outposts and buys a Dreadnought from its points", () => {
    // la-cantina's 8 ring turrets count 16 >= 10. The player holds outposts 0-2,
    // so one is left to claim.
    const sim = wardenSim(8, 5, LA_CANTINA_ID);
    sim.outpostOwner[0] = 0;
    sim.outpostOwner[1] = 0;
    sim.outpostOwner[2] = 0;
    sim.points[1] = 85;
    let claims = 0;
    let dreads = 0;
    step(sim, idle);
    for (let i = 0; i < sim.events.count; i++) {
      const o = i * EVENT_STRIDE;
      if (sim.events.data[o] === EV_CLAIM && sim.events.data[o + 2] === 1) claims += 1;
      if (
        sim.events.data[o] === EV_PURCHASE &&
        sim.events.data[o + 2] === 1 &&
        sim.events.data[o + 3] === ARCHETYPE.JUGGERNAUT
      ) {
        dreads += 1;
      }
    }
    expect(sim.captain.mode).toBe(SKY_MODE_ROAM);
    // Roaming or attacking it claims every free outpost while it has 30 (-30),
    // then, roaming, a Dreadnought with none near the player's base (-50).
    expect(claims).toBe(1);
    expect(sim.outpostOwner[3]).toBe(1);
    expect(dreads).toBe(1);
    expect(sim.points[1]).toBe(85 - 30 - 50);
  });

  it("attacks — escorts — once its Dreadnought nears the player's base", () => {
    const sim = wardenSim(8, 5, LA_CANTINA_ID);
    const pbase = LC.spawns[0];
    const dread = spawnUnit(sim, ARCHETYPE.JUGGERNAUT, 1, pbase.x, pbase.y + 30);
    sim.ent.timerA[dread] = -1;
    sim.ent.hp[dread] = 1e6;
    step(sim, idle);
    // Score: its own Dreadnought within 60 m of the player's base is worth 10.
    expect(sim.captain.mode).toBe(SKY_MODE_ATTACK);
    expect(sim.captain.move).toBe(dread);
  });

  it("goes home below its threshold, faster, and is restored there", () => {
    const sim = wardenSim(8, 5, LA_CANTINA_ID);
    const wid = sim.avatarId[1];
    step(sim, idle);
    const cruise = sim.captain.speed;
    // 15 m out from home, heading home: it flies its heading and turns toward
    // what it steers at (units.ts steerHeading), so a craft facing away would
    // first run on and divert to a pickup nearer than home.
    const home = LC.spawns[1];
    sim.ent.posX[wid] = home.x;
    sim.ent.posY[wid] = home.y + 15;
    sim.ent.velX[wid] = 0;
    sim.ent.velY[wid] = -cruise;
    sim.ent.hp[wid] = 50; // well below a quarter (defend halves the ~half threshold)
    step(sim, idle);
    expect(sim.captain.fly).toBe(SKY_CRUISE);
    expect(sim.captain.aim).toBe(-1);
    // Level 7: speed += speed >> (4 - 7 / 4) = an eighth.
    expect(sim.captain.speed).toBeCloseTo(cruise * 1.125, 6);
    expect(sim.captain.destX).toBeCloseTo(home.x, 5);
    expect(sim.captain.destY).toBeCloseTo(home.y, 5);
    let restoredAt = -1;
    for (let t = 0; t < 30 * 120 && restoredAt < 0; t++) {
      step(sim, idle);
      if (sim.ent.hp[wid] === skyMaxHp(7)) restoredAt = t;
    }
    expect(restoredAt).toBeGreaterThan(0);
    expect(sim.captain.speed).toBeCloseTo(cruise, 6);
    expect(sim.captain.turn).toBe(SKY_TURN_RATE); // the boost home is undone too
  });
});

describe("the captain's weapons (fcop-re/ai-and-rules.md §1.4)", () => {
  /** The captain parked 6 m from the player's mech, facing it. */
  function duel(difficulty: number, behind = false) {
    const sim = wardenSim(difficulty, 5, LA_CANTINA_ID);
    const ent = sim.ent;
    const wid = sim.avatarId[1];
    const foe = sim.avatarId[0];
    ent.hp[wid] = 1e6;
    sim.captain.threshold = -1;
    const park = () => {
      ent.posX[wid] = 120;
      ent.posY[wid] = 100;
      ent.posX[foe] = 126;
      ent.posY[foe] = 100;
      sim.captain.move = -1;
      sim.captain.destX = behind ? 119 : 127;
      sim.captain.destY = 100;
      sim.captain.think = 1e6;
    };
    return { sim, ent, foe, park };
  }

  it("fires its gun every other tick for 2, a missile per 0.5 s for 25", () => {
    const { sim, ent, foe, park } = duel(10);
    ent.hp[foe] = 1e6;
    let gun = 0;
    for (let t = 0; t < 60; t++) {
      park();
      const before = ent.hp[foe];
      step(sim, idle);
      if (before - ent.hp[foe] === 2) gun += 1;
    }
    expect(sim.captain.aim).toBe(foe);
    // 18 engine units between rounds, the rate machine's clamp: every 2nd tick.
    expect(gun).toBeGreaterThanOrEqual(25);
    expect(gun).toBeLessThanOrEqual(31);
  });

  it("at level 0 fires its gun only within ±22.5° of its heading", () => {
    // Flying away from the target (destination behind it): no gun round goes
    // out. (Its bomb keeps its record's arc, which was not read: all round.)
    const { sim, ent, foe, park } = duel(1, true);
    ent.hp[foe] = 1e6;
    let gun = 0;
    for (let t = 0; t < 60; t++) {
      park();
      step(sim, idle);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (
          sim.events.data[o] === EV_SHOT &&
          sim.events.data[o + 1] === sim.avatarId[1] &&
          sim.events.data[o + 2] === SHOT_SLOT_HITSCAN
        ) {
          gun += 1;
        }
      }
    }
    expect(sim.captain.aim).toBe(foe);
    expect(gun).toBe(0);
    // Facing it, the same level fires.
    const front = duel(1);
    front.ent.hp[front.foe] = 1e6;
    for (let t = 0; t < 30; t++) {
      front.park();
      step(front.sim, idle);
    }
    expect(front.ent.hp[front.foe]).toBeLessThan(1e6);
  });
});

describe("a player's down (fcop-re/ai-and-rules.md §1.8; player_op4 0x004477ea)", () => {
  // Open ground with no neutral turret, outpost or base within 10 m: a capture
  // is an engine credit too, and would zero the rethink on its own.
  const X = 152;
  const Y = 128;

  /** The player's mech parked at (X, Y), one hit from down. */
  function frail(sim: SimState): number {
    const foe = sim.avatarId[0];
    sim.ent.posX[foe] = X;
    sim.ent.posY[foe] = Y;
    sim.ent.height[foe] = sampleHeight(sim.map, X, Y);
    sim.ent.entLayer[foe] = 0;
    sim.ent.hp[foe] = 1;
    return foe;
  }

  /** The tick's EV_DEATH killer for `id`, or undefined. */
  function killerOf(sim: SimState, id: number): number | undefined {
    for (let i = 0; i < sim.events.count; i++) {
      const o = i * EVENT_STRIDE;
      if (sim.events.data[o] === EV_DEATH && sim.events.data[o + 1] === id) {
        return sim.events.data[o + 2];
      }
    }
    return undefined;
  }

  it("zeroes the captain's rethink at the down when its own fire put the mech down", () => {
    const sim = wardenSim(10, 5, LA_CANTINA_ID);
    const wid = sim.avatarId[1];
    const foe = frail(sim);
    let killer: number | undefined;
    for (let t = 0; t < 60 && killer === undefined; t++) {
      sim.ent.posX[wid] = X - 6;
      sim.ent.posY[wid] = Y;
      sim.captain.move = -1;
      sim.captain.destX = X + 1;
      sim.captain.destY = Y;
      sim.captain.think = 1e6;
      step(sim, idle);
      killer = killerOf(sim, foe);
    }
    expect(killer).toBe(1);
    // Zeroed by the down itself, the tick it happened: the next tick decides.
    expect(sim.captain.think).toBe(0);
  });

  it("leaves it alone when its tank did it, and at the respawn", () => {
    const sim = wardenSim(10, 5, LA_CANTINA_ID);
    const wid = sim.avatarId[1];
    const foe = frail(sim);
    spawnUnit(sim, ARCHETYPE.RUNNER, 1, X + 5, Y);
    const away = () => {
      // The captain far off, not deciding: only its tank is near the mech.
      sim.ent.posX[wid] = 20;
      sim.ent.posY[wid] = 20;
      sim.captain.move = -1;
      sim.captain.destX = 20;
      sim.captain.destY = 20;
    };
    let killer: number | undefined;
    for (let t = 0; t < 150 && killer === undefined; t++) {
      away();
      sim.captain.think = 1e6;
      step(sim, idle);
      killer = killerOf(sim, foe);
    }
    // The captain's side put it down, so the points go its way at the respawn,
    // but the hit was not the captain's: no credit, no rethink.
    expect(killer).toBe(1);
    expect(sim.captain.think).toBe(1e6 - WEAPON_UNITS_PER_TICK);
    while (sim.respawnTimer[0] > 1) {
      away();
      step(sim, idle);
    }
    const before = sim.captain.think;
    away();
    step(sim, idle);
    expect(sim.avatarId[0]).toBeGreaterThanOrEqual(0);
    expect(sim.captain.think).toBe(before - WEAPON_UNITS_PER_TICK);
  });
});
