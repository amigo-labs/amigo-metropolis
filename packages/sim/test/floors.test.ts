// The ground that hurts the enemy mech (fcop-fidelity.md P11): each base's floor
// (the original's surface codes 14/15) on the five floored arenas, and Hk's two
// spawn guards instead.
//
// Damage is read off the EV_HIT events with no attacker (b = -1), so a ring
// turret that happens to shoot the intruder does not blur the count.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_RADIUS,
  CFUN_DELTA_PER_TICK,
  STARTING_POINTS,
  SURFACE_REACH,
} from "../src/balance";
import { EV_HIT, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import {
  getMapById,
  HOLLYWOOD_KEYS_ID,
  LA_CANTINA_ID,
  MAP_REGISTRY,
  type MapData,
  resolveHeight,
  URBAN_JUNGLE_ID,
  VENICE_BEACH_ID,
} from "../src/map";
import { createSim, type SimState, step } from "../src/sim";

const idle = createTickInputs();

/** The damage `target` took from no one (the ground) this tick. */
function groundDamage(state: SimState, target: number): number {
  let sum = 0;
  const d = state.events.data;
  for (let i = 0; i < state.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (d[o] === EV_HIT && d[o + 1] === target && d[o + 2] === -1) sum += d[o + 3];
  }
  return sum;
}

/** The centre of a floor cell of `mask` value `want`, nearest (x, y). */
function floorCell(map: MapData, want: number, x: number, y: number): { x: number; y: number } {
  const m = map.floorMasks[0];
  let best = { x: -1, y: -1 };
  let bestD = Infinity;
  for (let j = 0; j < map.size; j++) {
    for (let i = 0; i < map.size; i++) {
      if (m[j * map.size + i] !== want) continue;
      const d = (i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: i + 0.5, y: j + 0.5 };
      }
    }
  }
  return best;
}

function standAt(state: SimState, id: number, x: number, y: number): void {
  state.ent.posX[id] = x;
  state.ent.posY[id] = y;
  state.ent.height[id] = resolveHeight(state.map, x, y, 0);
}

describe("the bases' floors (codes 14/15)", () => {
  for (const mapId of [LA_CANTINA_ID, URBAN_JUNGLE_ID]) {
    const map = getMapById(mapId);

    it(`${mapId}: hurt the enemy mech 1 a movement step, 37.5 a second, crediting no one`, () => {
      const state = createSim(map, 1);
      const a0 = state.avatarId[0];
      // Team 0's mech beside team 1's spawn, on the floor that hurts team 0.
      const s1 = map.spawns[1];
      const cell = floorCell(map, 1, s1.x + 3, s1.y);
      standAt(state, a0, cell.x, cell.y);
      let took = 0;
      for (let t = 0; t < 4; t++) {
        step(state, idle);
        took += groundDamage(state, a0);
      }
      // 1.25 steps a tick: 1, 1, 1, 2.
      expect(took).toBe(5);
      for (let t = 0; t < 26; t++) {
        step(state, idle);
        took += groundDamage(state, a0);
      }
      expect(took).toBe(37); // 30 ticks = 37.5 steps, the half step still to come
      expect(state.points[1]).toBe(STARTING_POINTS);
    });

    it(`${mapId}: spare the base's own mech`, () => {
      const state = createSim(map, 1);
      const a1 = state.avatarId[1];
      const s1 = map.spawns[1];
      const cell = floorCell(map, 1, s1.x + 3, s1.y);
      standAt(state, a1, cell.x, cell.y);
      let took = 0;
      for (let t = 0; t < 30; t++) {
        step(state, idle);
        took += groundDamage(state, a1);
      }
      expect(took).toBe(0);
    });
  }

  it("count each mech's own steps, by its carry of the clock's eighths", () => {
    // A down stops the mech's steps until it is back (walker.ts walkerEighths
    // runs for a live mech only), so its carry returns out of phase with the
    // tick: the floor hurts it by its own 1, 1, 1, 2, not the tick's.
    const map = getMapById(LA_CANTINA_ID);
    const state = createSim(map, 1);
    state.ent.hp[state.avatarId[0]] = 0;
    step(state, idle);
    while (state.avatarId[0] < 0) step(state, idle);
    const a0 = state.avatarId[0];
    const s1 = map.spawns[1];
    const cell = floorCell(map, 1, s1.x + 3, s1.y);
    const took: number[] = [];
    const own: number[] = [];
    const byTick: number[] = [];
    for (let k = 0; k < 8; k++) {
      standAt(state, a0, cell.x, cell.y);
      const t = state.tick;
      byTick.push(Math.floor(((t + 1) * 10) / 8) - Math.floor((t * 10) / 8));
      step(state, idle);
      took.push(groundDamage(state, a0));
      own.push(state.walker.steps[0]);
    }
    expect(own.reduce((x, y) => x + y, 0)).toBe(10); // 1.25 a tick
    expect(took).toEqual(own);
    expect(took).not.toEqual(byTick);
  });

  it("reach the feet only within SURFACE_REACH", () => {
    const map = getMapById(LA_CANTINA_ID);
    const state = createSim(map, 1);
    const a0 = state.avatarId[0];
    const s1 = map.spawns[1];
    const cell = floorCell(map, 1, s1.x + 3, s1.y);
    standAt(state, a0, cell.x, cell.y);
    state.ent.height[a0] += SURFACE_REACH + 0.5;
    step(state, idle);
    expect(groundDamage(state, a0)).toBe(0);
  });

  it("is refused while the mech is invulnerable", () => {
    const map = getMapById(LA_CANTINA_ID);
    const state = createSim(map, 1);
    const a0 = state.avatarId[0];
    const s1 = map.spawns[1];
    const cell = floorCell(map, 1, s1.x + 3, s1.y);
    standAt(state, a0, cell.x, cell.y);
    state.buffInvuln[0] = 10;
    const hp = state.ent.hp[a0];
    step(state, idle);
    expect(state.ent.hp[a0]).toBe(hp);
  });
});

describe("Ovmp's slippery patches (code 4)", () => {
  it("lie in four small patches beside the bases, on venice-beach alone", () => {
    for (const { id } of MAP_REGISTRY) {
      const map = getMapById(id);
      let cells = 0;
      for (const v of map.floorMasks[0] ?? []) if (v === 4) cells++;
      expect(map.modeFloors).toBe(id === VENICE_BEACH_ID);
      // The original's 14 samples, each a sim cell: three patches of 2 x 2 and
      // one of 2 x 1 (RE precinct-assault.md).
      expect(cells).toBe(id === VENICE_BEACH_ID ? 14 : 0);
    }
  });
});

describe("Hk's spawn guards", () => {
  const map = getMapById(HOLLYWOOD_KEYS_ID);

  it("carry no floor, and two guards, each about one spawn and hurting the other team", () => {
    expect(map.floorMasks.length).toBe(0);
    expect(map.spawnGuards.length).toBe(2);
    for (const g of map.spawnGuards) {
      const own = map.spawns[g.hurtsTeam ^ 1];
      expect(Math.abs(own.x - g.x)).toBeLessThan(g.halfW);
      expect(Math.abs(own.y - g.y)).toBeLessThan(g.halfL);
    }
  });

  it("hits the enemy mech for 25, then at most once a reset period", () => {
    const state = createSim(map, 1);
    const k = map.spawnGuards.findIndex((g) => g.hurtsTeam === 0);
    const g = map.spawnGuards[k];
    // fn45 / fn46: 60 time units, 300 engine ticks, 30 sim ticks of 10.
    expect(g.resetPeriod).toBe(300);
    const period = g.resetPeriod / CFUN_DELTA_PER_TICK;
    const a0 = state.avatarId[0];
    const hits: number[] = [];
    for (let t = 0; t < 3 * period + 1; t++) {
      // Hold it inside the box (the guard's own corner, clear of the spawn).
      standAt(state, a0, g.x + g.halfW - 1, g.y);
      state.ent.hp[a0] = 1000;
      step(state, idle);
      const d = groundDamage(state, a0);
      if (d > 0) {
        expect(d).toBe(g.damage);
        hits.push(t);
      }
    }
    expect(hits[0]).toBe(0);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.length).toBeLessThanOrEqual(4);
    for (let n = 2; n < hits.length; n++) expect(hits[n] - hits[n - 1]).toBe(period);
  });

  it("leaves the base's own mech alone, and one outside the box", () => {
    const state = createSim(map, 1);
    const g = map.spawnGuards.find((q) => q.hurtsTeam === 0);
    if (!g) throw new Error("no guard");
    const a0 = state.avatarId[0];
    const a1 = state.avatarId[1];
    const r = ARCHETYPE_RADIUS[ARCHETYPE.AVATAR];
    standAt(state, a1, g.x, g.y);
    standAt(state, a0, g.x + g.halfW + r + 0.5, g.y);
    for (let t = 0; t < 40; t++) {
      step(state, idle);
      expect(groundDamage(state, a0)).toBe(0);
      expect(groundDamage(state, a1)).toBe(0);
    }
  });
});
