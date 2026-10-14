// The original's per-player difficulty (fcop-fidelity.md P1, P2, P13, W1;
// fcop-re/player-and-weapons.md §4, §5, §7): HARD / NORMAL / EASY sets the
// X1-Alpha's health (1000 / 1250 / 1500), scales its magazines (x1 / x1.25 /
// x1.5, the loader's shifts) and decides what deep water does to the walker —
// HARD sinks and drowns it, NORMAL and EASY change it to hover.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  AVATAR_HP,
  AVATAR_HP_BY_DIFFICULTY,
  DIFFICULTY_EASY,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
  DROWN_DEPTH,
  PICKUP_HEALTH,
  PICKUP_HEAVY_AMMO,
  PICKUP_POWER_HEAVY,
  POINTS_AVATAR_DOWN,
  RESPAWN_SUNK_TICKS,
  RESPAWN_TICKS,
  WALKER_SINK_PER_TICK,
} from "../src/balance";
import {
  EV_DEATH,
  EV_RESPAWN,
  EV_SUNK,
  EV_TRANSFORM,
  EV_TRANSFORM_REFUSED,
  EVENT_STRIDE,
} from "../src/events";
import { BTN_FORWARD, BTN_GUN, createTickInputs, TRANSFORM_CHORD } from "../src/inputs";
import {
  getMapById,
  LA_CANTINA_ID,
  type MapData,
  resolveHeight,
  VENICE_BEACH_ID,
  waterHeightAt,
} from "../src/map";
import {
  createSim,
  hash,
  MATCH_SLOT_HP_FRAC,
  MATCH_SNAPSHOT_LEN,
  MODE_HOVER,
  MODE_WALKER,
  matchSlotOffset,
  normalizeDifficulty,
  type SimState,
  step,
  writeMatchSnapshot,
} from "../src/sim";
import { difficultyAmmo, GUNS, HEAVIES, SPECIALS } from "../src/weapons";

const idle = createTickInputs();

function events(state: SimState, type: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < state.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (state.events.data[o] === type) {
      out.push([state.events.data[o + 1], state.events.data[o + 2], state.events.data[o + 3]]);
    }
  }
  return out;
}

/** The index in the event buffer of the first event of `type`, -1 for none. */
function eventIndex(state: SimState, type: number): number {
  for (let i = 0; i < state.events.count; i++) {
    if (state.events.data[i * EVENT_STRIDE] === type) return i;
  }
  return -1;
}

describe("health per difficulty (P1)", () => {
  it("is the record's 1000 scaled 100 / 125 / 150 %", () => {
    expect(AVATAR_HP_BY_DIFFICULTY).toEqual([1000, 1250, 1500]);
    expect(AVATAR_HP).toBe(1250);
  });

  it("spawns each player with its own pick's health, NORMAL by default", () => {
    const map = getMapById(LA_CANTINA_ID);
    const plain = createSim(map, 1);
    expect(plain.ent.hp[plain.avatarId[0]]).toBe(1250);
    expect(plain.ent.hp[plain.avatarId[1]]).toBe(1250);
    const hard = createSim(map, 1, { difficulties: [DIFFICULTY_HARD, DIFFICULTY_EASY] });
    expect(hard.ent.hp[hard.avatarId[0]]).toBe(1000);
    expect(hard.ent.hp[hard.avatarId[1]]).toBe(1500);
  });

  it("reports health against the player's own maximum", () => {
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 1, { difficulties: [DIFFICULTY_HARD, DIFFICULTY_EASY] });
    sim.ent.hp[sim.avatarId[0]] = 500;
    sim.ent.hp[sim.avatarId[1]] = 750;
    const out = new Float32Array(MATCH_SNAPSHOT_LEN);
    writeMatchSnapshot(sim, out);
    expect(out[matchSlotOffset(0) + MATCH_SLOT_HP_FRAC]).toBe(0.5);
    expect(out[matchSlotOffset(1) + MATCH_SLOT_HP_FRAC]).toBe(0.5);
  });

  it("fills to the pick's maximum at a health pickup", () => {
    for (const [d, max] of [
      [DIFFICULTY_HARD, 1000],
      [DIFFICULTY_EASY, 1500],
    ] as const) {
      const { sim, a0 } = onPickup(PICKUP_HEALTH, d);
      sim.ent.hp[a0] = 10;
      step(sim, idle);
      expect(sim.ent.hp[a0]).toBe(max);
    }
  });

  it("leaves the Warden's slot to its level", () => {
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 1, {
      wardenPlayer: 1,
      wardenDifficulty: 5,
      difficulties: [DIFFICULTY_EASY, DIFFICULTY_HARD],
    });
    expect(sim.difficulty[0]).toBe(DIFFICULTY_EASY);
    expect(sim.difficulty[1]).toBe(DIFFICULTY_NORMAL);
    expect(sim.ent.archetype[sim.avatarId[1]]).toBe(ARCHETYPE.WARDEN);
  });

  it("takes rows 0-2 only: anything else degrades to the nearest, NORMAL when unusable", () => {
    expect(normalizeDifficulty(undefined)).toBe(DIFFICULTY_NORMAL);
    expect(normalizeDifficulty(Number.NaN)).toBe(DIFFICULTY_NORMAL);
    expect(normalizeDifficulty(3)).toBe(DIFFICULTY_EASY); // the debug row is not taken
    expect(normalizeDifficulty(-1)).toBe(DIFFICULTY_HARD);
    expect(normalizeDifficulty(0.7)).toBe(DIFFICULTY_HARD);
  });
});

describe("magazines per difficulty (W1)", () => {
  it("are the records' own on HARD and + raw >> 2 / + raw >> 1 on NORMAL / EASY", () => {
    // Mini-Gun 6000, Hell Fire 145, Mortar 25 on HARD (player-weapons.json).
    expect([GUNS[0].a.ammoCap, HEAVIES[0].a.ammoCap, SPECIALS[0].a.ammoCap]).toEqual([
      6000, 145, 25,
    ]);
    expect([6000, 145, 25].map((v) => difficultyAmmo(v, DIFFICULTY_NORMAL))).toEqual([
      7500, 181, 31,
    ]);
    expect([6000, 145, 25].map((v) => difficultyAmmo(v, DIFFICULTY_EASY))).toEqual([9000, 217, 37]);
  });

  it("fill the three A magazines at the spawn", () => {
    const map = getMapById(LA_CANTINA_ID);
    for (const [d, gun, heavy, special] of [
      [DIFFICULTY_HARD, 6000, 145, 25],
      [DIFFICULTY_NORMAL, 7500, 181, 31],
      [DIFFICULTY_EASY, 9000, 217, 37],
    ] as const) {
      const sim = createSim(map, 1, { difficulties: [d] });
      const a0 = sim.avatarId[0];
      expect([sim.gunAmmo[0], sim.ent.ammoA[a0], sim.ent.ammoB[a0]]).toEqual([gun, heavy, special]);
    }
  });

  it("are refilled to the pick's ceiling by an ammo pickup", () => {
    for (const [d, heavy] of [
      [DIFFICULTY_HARD, 145],
      [DIFFICULTY_EASY, 217],
    ] as const) {
      const { sim, a0 } = onPickup(PICKUP_HEAVY_AMMO, d);
      sim.ent.ammoA[a0] = 3;
      step(sim, idle);
      expect(sim.ent.ammoA[a0]).toBe(heavy);
    }
  });

  it("give block B its pick's ceiling at a power-up", () => {
    // Hell Fire B: 15 on HARD, 18 on NORMAL, 22 on EASY.
    for (const [d, b] of [
      [DIFFICULTY_HARD, 15],
      [DIFFICULTY_NORMAL, 18],
      [DIFFICULTY_EASY, 22],
    ] as const) {
      const { sim } = onPickup(PICKUP_POWER_HEAVY, d);
      step(sim, idle);
      expect(sim.powerAmmo[1]).toBe(b);
    }
  });

  it("refill to the pick's ceilings at the respawn, with the pick's health", () => {
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 1, { difficulties: [DIFFICULTY_EASY] });
    const a0 = sim.avatarId[0];
    sim.gunAmmo[0] = 1;
    sim.ent.hp[a0] = 0;
    step(sim, idle);
    expect(sim.avatarId[0]).toBe(-1);
    for (let t = 0; t < RESPAWN_TICKS && sim.avatarId[0] < 0; t++) step(sim, idle);
    const back = sim.avatarId[0];
    expect(back).toBeGreaterThanOrEqual(0);
    expect(sim.ent.hp[back]).toBe(1500);
    expect([sim.gunAmmo[0], sim.ent.ammoA[back], sim.ent.ammoB[back]]).toEqual([9000, 217, 37]);
  });
});

/** A la-cantina avatar of difficulty `d` standing on the first pickup of `kind`. */
function onPickup(kind: number, d: number) {
  const map = getMapById(LA_CANTINA_ID);
  const sim = createSim(map, 1, { difficulties: [d] });
  const k = map.pickups.findIndex((p) => p.kind === kind);
  expect(k).toBeGreaterThanOrEqual(0);
  const a0 = sim.avatarId[0];
  sim.ent.posX[a0] = map.pickups[k].x;
  sim.ent.posY[a0] = map.pickups[k].y;
  sim.ent.height[a0] = resolveHeight(map, map.pickups[k].x, map.pickups[k].y, 0);
  return { sim, a0 };
}

/** The first Ovmp cell with the water plate (deck 1) on it, at its centre. */
function plateCell(map: MapData): { x: number; y: number } {
  let k = 0;
  while (!(map.waterMask[k] === 1 && map.layerMask[0][k] === 1)) k++;
  return { x: (k % map.size) + 0.5, y: Math.floor(k / map.size) + 0.5 };
}

/** An Ovmp walker of difficulty `d` (slot 0) put on the water plate. */
function onWater(d: number) {
  const map = getMapById(VENICE_BEACH_ID);
  const sim = createSim(map, 1, { difficulties: [d] });
  const a0 = sim.avatarId[0];
  const { x, y } = plateCell(map);
  sim.ent.posX[a0] = x;
  sim.ent.posY[a0] = y;
  sim.ent.height[a0] = resolveHeight(map, x, y, 1);
  sim.ent.entLayer[a0] = 1;
  expect(sim.ent.mode[a0]).toBe(MODE_WALKER);
  return { sim, map, a0, x, y, surface: waterHeightAt(map, x, y) };
}

describe("deep water on HARD: the walker sinks and drowns (P13)", () => {
  it("sinks 0xc0 wu a movement step, 0.879 m/s, from the tick after it reached the water", () => {
    const { sim, a0, surface } = onWater(DIFFICULTY_HARD);
    step(sim, idle); // reaches the water: the marker, no sinking yet
    expect(sim.avatarSinking[0]).toBe(1);
    expect(sim.ent.mode[a0]).toBe(MODE_WALKER);
    expect(sim.ent.height[a0]).toBeCloseTo(surface, 6);
    const before = sim.ent.height[a0];
    for (let t = 0; t < 30; t++) {
      const h = sim.ent.height[a0];
      step(sim, idle);
      expect(h - sim.ent.height[a0]).toBeCloseTo(WALKER_SINK_PER_TICK, 9);
      expect(sim.ent.timerB[a0]).toBe(0); // the vertical velocity is held at zero
    }
    // A second of it: 0xc0 wu x 37.5 steps = 7200 wu.
    expect(WALKER_SINK_PER_TICK).toBe(240 / 8192);
    expect(before - sim.ent.height[a0]).toBeCloseTo(7200 / 8192, 6);
  });

  it("drowns 61 ticks (2.03 s) after it reached the water, credited to nobody", () => {
    const { sim, a0, surface } = onWater(DIFFICULTY_HARD);
    let died = -1;
    let sunkFirst = false;
    let killer = 0;
    for (let t = 1; t <= 120 && died < 0; t++) {
      step(sim, idle);
      const deaths = events(sim, EV_DEATH).filter((e) => e[0] === a0);
      if (deaths.length > 0) {
        died = t;
        killer = deaths[0][1];
        const sunk = events(sim, EV_SUNK);
        expect(sunk).toEqual([[a0, 0, 0]]);
        sunkFirst = eventIndex(sim, EV_SUNK) < eventIndex(sim, EV_DEATH);
      } else {
        // Alive, it never got deeper than 1.75 m below the water.
        expect(surface - sim.ent.height[a0]).toBeLessThanOrEqual(
          DROWN_DEPTH + WALKER_SINK_PER_TICK,
        );
      }
    }
    // Tick 1 reaches the water; ticks 2-61 sink 60 x 240 = 14,400 wu > 0x3800;
    // tick 62's check, before its movement, finds it: the original's 75 steps
    // (2.0 s) and the frame that reads them.
    expect(died).toBe(62);
    expect(died - 1).toBe(61);
    expect(killer).toBe(-1);
    expect(sunkFirst).toBe(true);
  });

  it("comes back 0.5 s later, at the spawn, with HARD's health and its marker gone", () => {
    const { sim, map } = onWater(DIFFICULTY_HARD);
    let t = 0;
    while (sim.avatarId[0] >= 0 && t < 120) {
      step(sim, idle);
      t += 1;
    }
    expect(sim.avatarId[0]).toBe(-1);
    // systemSpawning runs after damage/death in the same tick.
    expect(sim.respawnTimer[0]).toBe(RESPAWN_SUNK_TICKS - 1);
    expect(RESPAWN_SUNK_TICKS).toBe(15);
    let back = -1;
    for (let i = 0; i < RESPAWN_SUNK_TICKS && back < 0; i++) {
      step(sim, idle);
      if (events(sim, EV_RESPAWN).length > 0) back = i + 1;
    }
    expect(back).toBe(RESPAWN_SUNK_TICKS - 1);
    const a = sim.avatarId[0];
    expect(sim.ent.hp[a]).toBe(1000);
    expect(sim.ent.posX[a]).toBeCloseTo(map.spawns[0].x, 4);
    expect(sim.avatarSinking[0]).toBe(0);
  });

  it("still pays the down's points at the respawn, as every down does (R4)", () => {
    const { sim } = onWater(DIFFICULTY_HARD);
    sim.points[0] = 30;
    sim.points[1] = 0;
    while (sim.avatarId[0] >= 0) step(sim, idle);
    expect(sim.points[1]).toBe(0); // nothing at the down
    while (sim.avatarId[0] < 0) step(sim, idle);
    expect(sim.points[1]).toBe(POINTS_AVATAR_DOWN);
    expect(sim.points[0]).toBe(30 - POINTS_AVATAR_DOWN);
  });

  it("cuts every button while it sinks: no drive, no fire, no transform", () => {
    const { sim, a0 } = onWater(DIFFICULTY_HARD);
    step(sim, idle);
    const x = sim.ent.posX[a0];
    const y = sim.ent.posY[a0];
    const gun = sim.gunAmmo[0];
    const press = createTickInputs();
    press.players[0].buttons = BTN_FORWARD | BTN_GUN;
    for (let t = 0; t < 10; t++) step(sim, press);
    expect(sim.ent.posX[a0]).toBe(x);
    expect(sim.ent.posY[a0]).toBe(y);
    expect(sim.gunAmmo[0]).toBe(gun);
    press.players[0].buttons = TRANSFORM_CHORD;
    step(sim, press);
    expect(events(sim, EV_TRANSFORM_REFUSED)).toEqual([]);
    expect(events(sim, EV_TRANSFORM)).toEqual([]);
    expect(sim.ent.mode[a0]).toBe(MODE_WALKER);
  });

  it("loses its invulnerability in the water", () => {
    const { sim } = onWater(DIFFICULTY_HARD);
    expect(sim.buffInvuln.length).toBe(2);
    sim.buffInvuln[0] = 500;
    step(sim, idle);
    expect(sim.buffInvuln[0]).toBe(0);
  });
});

describe("deep water on NORMAL and EASY: the walker changes to hover (P13)", () => {
  for (const d of [DIFFICULTY_NORMAL, DIFFICULTY_EASY]) {
    it(`asks for the hover on its own (difficulty ${d}), and never sinks`, () => {
      const { sim, a0, surface } = onWater(d);
      step(sim, idle);
      expect(sim.ent.mode[a0]).toBe(MODE_HOVER);
      expect(sim.avatarSinking[0]).toBe(0);
      for (let t = 0; t < 90; t++) step(sim, idle);
      expect(sim.avatarId[0]).toBe(a0);
      expect(sim.ent.height[a0]).toBeGreaterThan(surface);
    });
  }
});

describe("the hash", () => {
  it("is a NORMAL match's own when every player is NORMAL", () => {
    const map = getMapById(LA_CANTINA_ID);
    const a = createSim(map, 7);
    const b = createSim(map, 7, { difficulties: [DIFFICULTY_NORMAL, DIFFICULTY_NORMAL] });
    for (let t = 0; t < 60; t++) {
      step(a, idle);
      step(b, idle);
      expect(hash(b)).toBe(hash(a));
    }
  });

  it("covers the difficulties and the sinking marker", () => {
    const map = getMapById(LA_CANTINA_ID);
    const a = createSim(map, 7, { difficulties: [DIFFICULTY_HARD] });
    const b = createSim(map, 7, { difficulties: [DIFFICULTY_HARD] });
    expect(hash(b)).toBe(hash(a));
    b.avatarSinking[0] = 1;
    expect(hash(b)).not.toBe(hash(a));
  });
});
