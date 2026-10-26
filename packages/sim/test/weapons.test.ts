// The X1-Alpha's weapons are the original's records (fcop-fidelity.md W1, W2,
// P1; fcop-re/player-and-weapons.md §5, §7, player-weapons.json). The catalogue's
// numbers are checked against the evidence file itself, and the delivery rules
// — lock-only hitscan, the cooldown machine, the missiles, the ballistic solve,
// the blast falloff, the mines and the pulse — on a flat arena.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import {
  AVATAR_HP,
  AVATAR_LOCK_RANGE,
  DIFFICULTY_EASY,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
  MINE_RADIUS,
  PICKUP_POWER_GUN,
  PICKUP_POWER_HEAVY,
  PICKUP_POWER_SPECIAL,
  TICK_HZ,
  WEAPON_UNITS_PER_TICK,
} from "../src/balance";
import {
  directionAxis,
  EV_DEATH,
  EV_EXPLOSION,
  EV_KILL_PUSH,
  EV_SHOT,
  EVENT_STRIDE,
  SHOT_SLOT_SPECIAL,
  shotPayloadWeaponId,
  shotPayloadWeaponReach,
  weaponShotPayload,
} from "../src/events";
import { BTN_GUN, BTN_HEAVY, BTN_SPECIAL, createTickInputs } from "../src/inputs";
import {
  getMapById,
  LA_CANTINA_ID,
  loadMapFromJson,
  type MapJson,
  resolveHeight,
} from "../src/map";
import { createSim, type SimState, step } from "../src/sim";
import {
  DEFAULT_LOADOUT,
  difficultyAmmo,
  EXTRA_WEAPONS_ALL,
  GUNS,
  gapUnits,
  HEAVIES,
  NOT_ADOPTED_CODES,
  normalizeLoadout,
  PROJ_HEAVY,
  PROJ_HYPER,
  PROJ_MINE,
  PROJ_MORTAR,
  resolveLoadout,
  SPECIALS,
  type WeaponDef,
  weaponById,
} from "../src/weapons";

const EVIDENCE = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "..", "..", "docs", "specs", "fcop-re", "player-weapons.json"),
    "utf8",
  ),
) as { weapons: Record<string, Record<string, Record<string, unknown>>> };

/** A record's magazine on the default NORMAL pick. */
const normal = (raw: number) => difficultyAmmo(raw, DIFFICULTY_NORMAL);

const ALL: readonly WeaponDef[] = [...GUNS, ...HEAVIES, ...SPECIALS];

function evidence(w: WeaponDef, block: "A_normal" | "B_powered"): Record<string, unknown> {
  const key = `0x${w.code.toString(16).padStart(2, "0")}`;
  return EVIDENCE.weapons[key][block];
}

/**
 * Catalog ids of the AVATAR shots in this tick's event buffer (the avatar slots
 * pack the id with the shot's reach; events.ts `weaponShotPayload`).
 */
function firedWeaponIds(sim: SimState): number[] {
  const ids: number[] = [];
  for (let i = 0; i < sim.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (sim.events.data[o] !== EV_SHOT) continue;
    if (sim.events.data[o + 2] > SHOT_SLOT_SPECIAL) continue; // not an avatar slot
    ids.push(shotPayloadWeaponId(sim.events.data[o + 3]));
  }
  return ids;
}

// Flat 16×16 grid, 4 m cells, no water. P0 spawns at (20, 30) facing +x on its
// pad; P1 spawns far north. Tests move the avatars where they need them.
function flatArena(): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  return {
    id: "flat-weapons",
    size,
    cellSize: 4,
    waterLevel: -10,
    heights,
    water,
    spawns: [
      { x: 20, y: 30, yaw: 0 },
      { x: 30, y: 58, yaw: 0 },
    ],
    basePlots: [
      { x: 20, y: 30, radius: 6 },
      { x: 30, y: 58, radius: 6 },
    ],
    bases: [
      {
        gate: { x: 2, y: 2, radius: 2 },
        core: [14, 30],
        groundConsole: [20, 24],
        airConsole: [20, 36],
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 2 },
        core: [36, 58],
        groundConsole: [30, 52],
        airConsole: [24, 58],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

const FLAT = loadMapFromJson(flatArena());

/** A duel on the flat arena: p0 at (20, 30) facing +x, p1 `dx` m east of it. */
function duel(
  loadout: Partial<typeof DEFAULT_LOADOUT>,
  dx: number,
  dy = 0,
  extraWeapons = EXTRA_WEAPONS_ALL,
) {
  const sim = createSim(FLAT, 1, { loadouts: [loadout, DEFAULT_LOADOUT], extraWeapons });
  const a0 = sim.avatarId[0];
  const a1 = sim.avatarId[1];
  sim.ent.posX[a1] = 20 + dx;
  sim.ent.posY[a1] = 30 + dy;
  // p1 faces away so it never locks p0.
  sim.ent.yaw[a1] = Math.PI;
  sim.ent.aimX[a1] = -1;
  sim.ent.aimY[a1] = 0;
  return { sim, a0, a1, inputs: createTickInputs() };
}

function projectiles(sim: SimState, kind: number): number[] {
  const out: number[] = [];
  for (let e = 0; e < sim.ent.high; e++) {
    if (sim.ent.alive[e] && sim.ent.archetype[e] === ARCHETYPE.PROJECTILE) {
      if (sim.ent.mode[e] === kind) out.push(e);
    }
  }
  return out;
}

describe("weapon catalog", () => {
  test("default kit is the original's: Mini-Gun, Hell Fire 2000, Mortar", () => {
    const kit = resolveLoadout(DEFAULT_LOADOUT);
    expect(kit.gun.name).toBe("Powered Mini-Gun");
    expect(kit.heavy.name).toBe("Hell Fire 2000");
    expect(kit.special.name).toBe("Mortar Launcher");
    expect([kit.gun.code, kit.heavy.code, kit.special.code]).toEqual([0x00, 0x10, 0x20]);
  });

  test("catalog is the ten PA weapons, then the five extras, mapped to their codes", () => {
    expect(GUNS.map((w) => [w.name, w.code])).toEqual([
      ["Powered Mini-Gun", 0x00],
      ["Gatling Laser", 0x01],
      ["Flamethrower", 0x02],
      ["Electric Gun", 0x03],
      ["Riot Shield", 0x05],
    ]);
    expect(HEAVIES.map((w) => [w.name, w.code])).toEqual([
      ["Hell Fire 2000", 0x10],
      ["Concussion Beam", 0x12],
      ["Hyper Velocity Rocket", 0x13],
      ["K-9 Drone", 0x15],
      ["Fusion Torpedo", 0x14],
    ]);
    expect(SPECIALS.map((w) => [w.name, w.code])).toEqual([
      ["Mortar Launcher", 0x20],
      ["Pop-Up Mines", 0x22],
      ["Shockwave Generator", 0x23],
      ["Grenade Launcher", 0x24],
      ["Plasma Flare", 0x21],
    ]);
    // All fifteen of the original's records are in the catalogue now.
    expect(NOT_ADOPTED_CODES).toEqual([]);
    expect(new Set(ALL.map((w) => w.code)).size).toBe(15);
    // The ten Precinct Assault offers need no bit; each of the five has its own.
    expect(ALL.filter((w) => w.extraBit === 0).length).toBe(10);
    expect(ALL.map((w) => w.extraBit).filter((b) => b !== 0)).toEqual([1, 2, 8, 4, 16]);
  });

  test("normalizeLoadout clamps out-of-range picks", () => {
    // Without the extra weapons the last pick is the slot's last PA weapon,
    // where it was before the five were appended.
    expect(normalizeLoadout({ gun: 99, heavy: -3, special: 1.7 })).toEqual({
      gun: 3,
      heavy: 0,
      special: 1,
    });
    expect(normalizeLoadout({ gun: 99, heavy: 99, special: 99 }, EXTRA_WEAPONS_ALL)).toEqual({
      gun: GUNS.length - 1,
      heavy: HEAVIES.length - 1,
      special: SPECIALS.length - 1,
    });
  });

  test("every catalog id resolves uniquely", () => {
    const ids = new Set<number>();
    for (const w of ALL) {
      expect(ids.has(w.id)).toBe(false);
      ids.add(w.id);
      expect(weaponById(w.id)?.name).toBe(w.name);
    }
  });

  test("slot and index fields agree with each list's position", () => {
    for (const [slot, list] of [GUNS, HEAVIES, SPECIALS].entries()) {
      for (const [index, w] of list.entries()) {
        expect(w.slot as number).toBe(slot);
        expect(w.index).toBe(index);
      }
    }
  });
});

/**
 * Every number against docs/specs/fcop-re/player-weapons.json, both blocks. The
 * file's derived SI values are the evidence; the catalogue converts the raw
 * halfwords the way the loader does, and the two must agree.
 */
describe("the original's records (fcop-fidelity.md W1)", () => {
  test("damage, ammunition on every difficulty, and gaps", () => {
    for (const w of ALL) {
      for (const [blk, ev] of [
        [w.a, evidence(w, "A_normal")],
        [w.b, evidence(w, "B_powered")],
      ] as const) {
        const raw = ev.raw as Record<string, number>;
        expect(blk.damage).toBe(ev.damage as number);
        // The tables hold the record's own magazines, HARD's; each difficulty
        // scales them the way the stock and the ceiling do.
        const start = ev.ammo_start as Record<string, number>;
        const cap = ev.ammo_cap as Record<string, number>;
        expect(blk.ammo).toBe(start.hard);
        expect(blk.ammoCap).toBe(cap.hard);
        for (const [d, key] of [
          [DIFFICULTY_HARD, "hard"],
          [DIFFICULTY_NORMAL, "normal"],
          [DIFFICULTY_EASY, "easy"],
        ] as const) {
          expect(difficultyAmmo(blk.ammo, d)).toBe(start[key]);
          expect(difficultyAmmo(blk.ammoCap, d)).toBe(cap[key]);
        }
        expect(blk.rounds).toBe(raw.rounds_per_burst);
        const units = ev.gap_units_1_300s as Record<string, number>;
        expect(blk.burstGap).toBe(units.burst);
        expect(blk.roundGap).toBe(units.round);
      }
    }
  });

  test("gaps are raw * 4096 / 218, truncated toward zero", () => {
    expect(gapUnits(8)).toBe(150); // Hell Fire: 0.5 s
    expect(gapUnits(16)).toBe(300); // 1.0 s
    expect(gapUnits(32)).toBe(601); // 2.003 s
    expect(gapUnits(48)).toBe(901);
    expect(gapUnits(1)).toBe(18);
    expect(gapUnits(-2)).toBe(-37); // the Hyper Velocity Rocket's carried gap
  });

  test("ranges, blasts, speeds and gravities", () => {
    for (const w of ALL) {
      for (const [blk, ev] of [
        [w.a, evidence(w, "A_normal")],
        [w.b, evidence(w, "B_powered")],
      ] as const) {
        if (typeof ev.range_m === "number") expect(blk.range).toBeCloseTo(ev.range_m, 2);
        if (typeof ev.blast_radius_m === "number" && w.delivery === "hitscan") {
          expect(blk.blast).toBeCloseTo(ev.blast_radius_m, 2);
        }
        const m = ev.missile as Record<string, number> | undefined;
        if (m !== undefined) {
          expect(blk.speed).toBeCloseTo(m.top_speed_m_s, 2);
          expect(blk.launchSpeed).toBeCloseTo(m.launch_speed_m_s, 2);
          expect(blk.accel).toBeCloseTo(m.accel_m_s2, 1);
          expect(blk.range).toBeCloseTo(m.range_m, 2);
          expect(blk.blast).toBeCloseTo(m.blast_radius_m, 2);
        }
        const b = ev.ballistic as Record<string, number> | undefined;
        if (b !== undefined) {
          expect(blk.launchSpeed).toBeCloseTo(b.launch_speed_m_s, 2);
          expect(blk.gravity).toBeCloseTo(b.gravity_m_s2, 2);
          expect(blk.blast).toBeCloseTo(b.blast_radius_m, 2);
        }
        const beam = ev.beam as Record<string, number> | undefined;
        if (beam !== undefined) {
          expect(blk.range).toBeCloseTo(beam.range_m, 2);
          expect(blk.blast).toBeCloseTo(beam.blast_radius_m, 2);
        }
        const mine = ev.mine as Record<string, number> | undefined;
        if (mine !== undefined) {
          expect(blk.blast).toBeCloseTo(mine.blast_radius_m, 1);
          expect(blk.reach).toBeCloseTo(mine.trigger_radius_m_plus_half_extent, 2);
        }
        const shock = ev.shockwave as Record<string, number> | undefined;
        if (shock !== undefined) expect(blk.blast).toBeCloseTo(shock.radius_m, 2);
      }
    }
  });

  test("the Mortar's flat reach is v² / g = 9.67 m", () => {
    expect(SPECIALS[0].range).toBeCloseTo(9.67, 2);
  });
});

describe("the cooldown machine (`player_fire_slot`)", () => {
  test("a gap-0 gun fires on every tick it is held: 30 rounds a second", () => {
    expect(WEAPON_UNITS_PER_TICK).toBe(10);
    const { sim, a1, inputs } = duel({ gun: 0 }, 8);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < TICK_HZ; t++) step(sim, inputs);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - TICK_HZ);
    expect(sim.gunAmmo[0]).toBe(normal(GUNS[0].a.ammoCap) - TICK_HZ);
  });

  test("the Electric Gun's 18-unit gap fires on every other tick", () => {
    const { sim, a1, inputs } = duel({ gun: 3 }, 8);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < TICK_HZ; t++) step(sim, inputs);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 15 * 3);
  });

  test("the Hyper Velocity Rocket fires four rounds on four ticks, then waits", () => {
    const { sim, a0, inputs } = duel({ heavy: 2 }, 30);
    inputs.players[0].buttons = BTN_HEAVY;
    const fired: number[] = [];
    for (let t = 0; t < 80; t++) {
      step(sim, inputs);
      if (firedWeaponIds(sim).includes(HEAVIES[2].id)) fired.push(t);
    }
    // 450 - 3 * 37 = 339 units after the fourth: 34 ticks, so a 37-tick cycle.
    expect(fired.slice(0, 8)).toEqual([0, 1, 2, 3, 37, 38, 39, 40]);
    expect(sim.ent.ammoA[a0]).toBe(normal(HEAVIES[2].a.ammoCap) - fired.length);
  });

  test("the Mortar's 601-unit gap is 61 ticks: the cooldown floors at zero", () => {
    const { sim, inputs } = duel({ special: 0 }, 30);
    inputs.players[0].buttons = BTN_SPECIAL;
    const fired: number[] = [];
    for (let t = 0; t < 130; t++) {
      step(sim, inputs);
      if (firedWeaponIds(sim).includes(SPECIALS[0].id)) fired.push(t);
    }
    // Special fires from the latch's HELD state, so the first round is the
    // second tick's; the gap after it is the same 61.
    expect(fired).toEqual([1, 62, 123]);
  });

  test("Special fires from the second tick it is held: a one-tick tap fires nothing", () => {
    // `player_fire_buttons` reads Special from the button latch, which reaches
    // "held" on the second frame a button is down; Gun and Heavy fire on the
    // first. Tapped every other tick, the Mortar never goes off.
    const { sim, inputs } = duel({ special: 0 }, 30);
    const fired: number[] = [];
    for (let t = 0; t < 40; t++) {
      inputs.players[0].buttons = t % 2 === 0 ? BTN_SPECIAL : 0;
      step(sim, inputs);
      if (firedWeaponIds(sim).length > 0) fired.push(t);
    }
    expect(fired).toEqual([]);
    expect(sim.ent.cooldownC[sim.avatarId[0]]).toBe(0);
    // Held, it fires on the second tick, never the first.
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(firedWeaponIds(sim)).toEqual([]);
    step(sim, inputs);
    expect(firedWeaponIds(sim)).toEqual([SPECIALS[0].id]);
    // Gun and Heavy, pressed on the same first tick, both go out at once.
    const both = duel({ gun: 0, heavy: 0, special: 0 }, 8);
    both.inputs.players[0].buttons = BTN_GUN | BTN_HEAVY | BTN_SPECIAL;
    step(both.sim, both.inputs);
    expect(firedWeaponIds(both.sim).sort()).toEqual([GUNS[0].id, HEAVIES[0].id].sort());
  });

  test("a kept-round block (flag 4) makes Special fire on the press instead", () => {
    // The two flag-4 records (the Plasma Flare, the Grenade Launcher) are extra
    // weapons; here the Mortar's block A borrows the flag for this test only.
    for (const w of ALL) expect((w.a.flags & 4) !== 0).toBe(w.code === 0x21 || w.code === 0x24);
    const a = SPECIALS[0].a as { flags: number };
    const flags = a.flags;
    a.flags = flags | 4;
    try {
      const { sim, inputs } = duel({ special: 0 }, 30);
      inputs.players[0].buttons = BTN_SPECIAL;
      step(sim, inputs);
      expect(firedWeaponIds(sim)).toEqual([SPECIALS[0].id]);
      // An edge, not a level: held on, it does not fire again.
      for (let t = 0; t < 70; t++) {
        step(sim, inputs);
        expect(firedWeaponIds(sim)).toEqual([]);
      }
    } finally {
      a.flags = flags;
    }
  });

  test("an empty magazine fires nothing", () => {
    const { sim, a1, inputs } = duel({ gun: 0 }, 8);
    sim.gunAmmo[0] = 2;
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < 10; t++) step(sim, inputs);
    expect(sim.gunAmmo[0]).toBe(0);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 2);
  });
});

describe("hitscan damages only the lock (fcop-fidelity.md W2)", () => {
  test("a target ahead inside 12 m is locked and hit", () => {
    const { sim, a1, inputs } = duel({ gun: 0 }, 11.5);
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 1);
  });

  test("past 12 m nothing is locked and nothing is hit", () => {
    const { sim, a1, inputs } = duel({ gun: 0 }, AVATAR_LOCK_RANGE + 0.5);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < 10; t++) step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP);
  });

  test("the line does nothing to what it crosses without a lock", () => {
    // An uncaptured neutral turret is not lockable (its skip flag), so a Mini-Gun
    // aimed straight through it from 6 m hits nothing — the old any-body-on-the-
    // line hitscan would have chewed through its 500 HP.
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 3);
    const t = sim.neutralTurretEntity[0];
    const a0 = sim.avatarId[0];
    const hp = sim.ent.hp[t];
    sim.ent.posX[a0] = sim.ent.posX[t] - 6;
    sim.ent.posY[a0] = sim.ent.posY[t];
    sim.ent.height[a0] = sim.ent.height[t];
    sim.ent.yaw[a0] = 0;
    sim.ent.aimX[a0] = 1;
    sim.ent.aimY[a0] = 0;
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_GUN;
    for (let k = 0; k < 30; k++) step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    expect(sim.ent.hp[t]).toBe(hp);
  });

  test("the shot's reach is the distance to the lock", () => {
    const { sim, inputs } = duel({ gun: 0 }, 7);
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    for (let i = 0; i < sim.events.count; i++) {
      const o = i * EVENT_STRIDE;
      if (sim.events.data[o] !== EV_SHOT || sim.events.data[o + 2] !== 0) continue;
      expect(shotPayloadWeaponReach(sim.events.data[o + 3])).toBeCloseTo(7, 1);
    }
  });
});

describe("missiles", () => {
  test("Hell Fire 2000 launches slow, accelerates and homes on the lock", () => {
    const { sim, a1, inputs } = duel({ heavy: 0 }, 9, 1.5);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [m] = projectiles(sim, PROJ_HEAVY);
    expect(m).toBeDefined();
    // Launch at an eighth of top speed (1.98 m/s), 71 m/s² to 15.8 m/s; the
    // projectile system already flew it one tick.
    expect(sim.ent.cooldownA[m]).toBeCloseTo(
      HEAVIES[0].a.launchSpeed + HEAVIES[0].a.accel / TICK_HZ,
      3,
    );
    expect(sim.ent.cooldownC[m]).toBe(a1);
    step(sim, inputs);
    expect(sim.ent.cooldownA[m]).toBeGreaterThan(HEAVIES[0].a.launchSpeed);
    for (let t = 0; t < 40 && sim.ent.alive[m]; t++) step(sim, inputs);
    // It found the target 1.5 m off its launch line and dealt its 25: no blast.
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 25);
  });

  // The killer's push (RE M3-OP): a body a missile-class round's contact kills
  // dies with the round's heading and damage word in its death's context.
  test("a Hell Fire's killing contact carries its heading and damage to the death", () => {
    const { sim, a1, inputs } = duel({ heavy: 0 }, 6);
    sim.ent.hp[a1] = 10;
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    let push = -1;
    let death = -1;
    let dir = 0;
    let damage = 0;
    for (let t = 0; t < 60 && death < 0; t++) {
      step(sim, inputs);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const kind = sim.events.data[o];
        if (kind === EV_KILL_PUSH && sim.events.data[o + 1] === a1) {
          push = i;
          dir = sim.events.data[o + 2];
          damage = sim.events.data[o + 3];
        }
        if (kind === EV_DEATH && sim.events.data[o + 1] === a1) death = i;
      }
    }
    expect(death).toBeGreaterThan(0);
    expect(push).toBe(death - 1); // just before the death
    expect(damage).toBe(25);
    // Fired along +x at a target straight ahead.
    expect(directionAxis(dir, 0)).toBeGreaterThan(0.95);
    expect(Math.abs(directionAxis(dir, 1))).toBeLessThan(0.1);
  });

  test("a Mortar shell's kill carries no push: it is no missile", () => {
    const { sim, a1, inputs } = duel({ special: 0 }, 7);
    sim.ent.hp[a1] = 10;
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    let pushes = 0;
    let died = false;
    for (let t = 0; t < 120 && !died; t++) {
      step(sim, inputs);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (sim.events.data[o] === EV_KILL_PUSH) pushes++;
        if (sim.events.data[o] === EV_DEATH && sim.events.data[o + 1] === a1) died = true;
      }
    }
    expect(died).toBe(true);
    expect(pushes).toBe(0);
  });

  test("a missile without a lock flies straight and ends at its 16 m range", () => {
    const { sim, inputs } = duel({ heavy: 0 }, 0, 25);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [m] = projectiles(sim, PROJ_HEAVY);
    expect(sim.ent.cooldownC[m]).toBe(-1);
    let lastX = 0;
    while (sim.ent.alive[m]) {
      lastX = sim.ent.posX[m];
      step(sim, inputs);
    }
    expect(lastX - 20).toBeGreaterThan(15);
    expect(lastX - 20).toBeLessThan(17);
  });

  test("the Hyper Velocity Rocket is lead-aimed at a moving lock", () => {
    const { sim, a1, inputs } = duel({ heavy: 2 }, 10);
    sim.ent.velY[a1] = 3; // the target is crossing at 3 m/s
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    const [r] = projectiles(sim, PROJ_HYPER);
    expect(sim.ent.velY[r]).toBeGreaterThan(0); // aimed ahead of it, not at it
    expect(sim.ent.cooldownC[r]).toBe(-1); // and not homing
  });
});

describe("arced rounds", () => {
  test("the Mortar lobs to 8 m ahead with no lock, under its own 6 m/s² gravity", () => {
    const { sim, inputs } = duel({ special: 0 }, 0, 25);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs); // Special goes out on the second tick it is held
    inputs.players[0].buttons = 0;
    const [s] = projectiles(sim, PROJ_MORTAR);
    const h0 = sim.ent.height[s];
    let apex = h0;
    let x = 0;
    while (sim.ent.alive[s]) {
      apex = Math.max(apex, sim.ent.height[s]);
      x = sim.ent.posX[s];
      step(sim, inputs);
    }
    // The high root of the solve: a steep lob (62°) that comes down 8 m out.
    expect(apex - h0).toBeGreaterThan(3);
    expect(x - 20).toBeGreaterThan(8.6 - 0.6);
    expect(x - 20).toBeLessThan(8.6 + 0.6);
  });

  test("the Mortar lands on the lock and its blast falls off with distance", () => {
    const { sim, a1, inputs } = duel({ special: 0 }, 7);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs); // fires on the second tick held
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 120; t++) step(sim, inputs);
    const lost = AVATAR_HP - sim.ent.hp[a1];
    // Lands within a contact radius of the target: 200 * (3.2 - d) / 3.2.
    expect(lost).toBeGreaterThan(100);
    expect(lost).toBeLessThanOrEqual(200);
  });
});

describe("mines and the pulse", () => {
  // The dropped round (RE M3-OP): 0x0044d6a0 stores gravity 0x10000 and no
  // velocity; the type-0x0f tick falls `gravity * delta / 300`, 0x10000 * 10 /
  // 300 = 2184 wu/s a tick, and the tick that settles it expires it.
  test("a mine leaves the muzzle with no speed and falls 2184 wu/s a tick", () => {
    const { sim, inputs } = duel({ special: 1 }, 30);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs); // dropped on the second tick held, and ticked once
    inputs.players[0].buttons = 0;
    const [mine] = projectiles(sim, PROJ_MINE);
    expect(sim.ent.velX[mine]).toBe(0);
    expect(sim.ent.velY[mine]).toBe(0);
    expect(sim.ent.timerB[mine]).toBe(-2184);
    step(sim, inputs);
    expect(sim.ent.timerB[mine]).toBe(-4368);
    expect(sim.ent.timerA[mine]).toBe(1503 - 20); // the record's 5.01 s, two deltas spent
  });

  test("nobody near: it bounces, and goes off where it settles, not at its 5 s lifetime", () => {
    const { sim, a1, inputs } = duel({ special: 1 }, 30);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [mine] = projectiles(sim, PROJ_MINE);
    let ticks = 0;
    let bounces = 0;
    let lastVh = 0;
    let lastH = 0;
    let lastLife = 0;
    let lastVhSeen = sim.ent.timerB[mine];
    while (sim.ent.alive[mine] && ticks < 5 * TICK_HZ) {
      lastVh = sim.ent.timerB[mine];
      lastH = sim.ent.height[mine];
      lastLife = sim.ent.timerA[mine];
      step(sim, inputs);
      ticks++;
      if (sim.ent.alive[mine] && lastVhSeen < 0 && sim.ent.timerB[mine] > 0) bounces++;
      lastVhSeen = sim.ent.timerB[mine];
    }
    expect(sim.ent.alive[mine]).toBe(0);
    expect(bounces).toBeGreaterThan(0);
    // The tick it went: at the ground, slower than 0x1800 wu/s, life to spare.
    expect(lastH).toBeLessThanOrEqual(MINE_RADIUS);
    expect(Math.abs(lastVh)).toBeLessThan(0x1800);
    expect(lastLife).toBeGreaterThan(10);
    expect(ticks).toBeLessThan(2 * TICK_HZ);
    // It went off (a blast), not quietly.
    let blasts = 0;
    for (let i = 0; i < sim.events.count; i++) {
      if (sim.events.data[i * EVENT_STRIDE] === EV_EXPLOSION) blasts++;
    }
    expect(blasts).toBe(1);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP); // 30 m away
  });

  test("an enemy within 2 m + its radius springs it: flung down, it pops up and goes off 300 units later", () => {
    const { sim, a0, a1, inputs } = duel({ special: 1 }, 30);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [mine] = projectiles(sim, PROJ_MINE);
    // p0 walks off; p1 steps 2.2 m from it (inside 2 + its radius).
    sim.ent.posX[a0] = 0.5;
    sim.ent.posY[a0] = 0.5;
    sim.ent.posX[a1] = sim.ent.posX[mine] + 2.2;
    sim.ent.posY[a1] = sim.ent.posY[mine];
    step(sim, inputs);
    expect(sim.ent.cooldownA[mine]).toBe(1);
    expect(sim.ent.cooldownC[mine]).toBe(0);
    expect(sim.ent.aimX[mine]).toBe(0x8000);
    expect(sim.ent.timerA[mine]).toBe(300 - 10);
    let rose = false;
    let ticks = 1;
    while (sim.ent.alive[mine] && ticks < 60) {
      step(sim, inputs);
      ticks++;
      if (sim.ent.alive[mine] && sim.ent.timerB[mine] > 0) rose = true;
    }
    expect(rose).toBe(true);
    expect(sim.ent.alive[mine]).toBe(0);
    expect(ticks).toBeLessThanOrEqual(30);
    // 600 * (5.6 - 2.2) / 5.6, truncated.
    expect(AVATAR_HP - sim.ent.hp[a1]).toBe(Math.floor((600 * (5.599609375 - 2.2)) / 5.599609375));
  });

  test("the Shockwave Generator hits everything within 6 m for its full 300", () => {
    const { sim, a1, inputs } = duel({ special: 2 }, 5);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP); // the first tick held is not yet "held"
    step(sim, inputs);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 300);
  });

  test("the Concussion Beam bursts at the lock for 50", () => {
    const { sim, a1, inputs } = duel({ heavy: 1 }, 6);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 50);
  });
});

describe("EV_SHOT payload", () => {
  test("a positive reach never packs to zero", () => {
    // Zero is how the renderer spells "no reach travelled with this shot", and
    // it falls back to the weapon's nominal range there.
    for (const reach of [0.049, 0.01, 0.0001]) {
      expect(shotPayloadWeaponReach(weaponShotPayload(0, reach))).toBeCloseTo(0.1, 10);
    }
    expect(shotPayloadWeaponReach(weaponShotPayload(0, 0))).toBe(0);
    expect(shotPayloadWeaponId(weaponShotPayload(9, 0.01))).toBe(9);
  });

  test("reach round-trips at the resolution it is stored in", () => {
    for (const reach of [0.1, 3.7, 14, 39.9]) {
      expect(shotPayloadWeaponReach(weaponShotPayload(1, reach))).toBeCloseTo(reach, 10);
    }
  });
});

describe("ammunition", () => {
  test("spawn fills all three A magazines to their NORMAL ceilings", () => {
    const sim = createSim(FLAT, 1, { loadouts: [{ gun: 1, heavy: 2, special: 1 }] });
    const a0 = sim.avatarId[0];
    expect(sim.gunAmmo[0]).toBe(6250);
    expect(sim.ent.ammoA[a0]).toBe(150);
    expect(sim.ent.ammoB[a0]).toBe(37);
  });

  test("the default loadout leaves the first shot's hash path intact", () => {
    const map = getMapById("test-128");
    const a = createSim(map, 1, { loadouts: [DEFAULT_LOADOUT] });
    const b = createSim(map, 1);
    const idle = createTickInputs();
    step(a, idle);
    step(b, idle);
    expect(a.ent.ammoA[a.avatarId[0]]).toBe(b.ent.ammoA[b.avatarId[0]]);
    expect(a.ent.ammoB[a.avatarId[0]]).toBe(b.ent.ammoB[b.avatarId[0]]);
  });

  test("every weapon fires its own catalog id", () => {
    for (const w of ALL) {
      const loadout = {
        gun: 0,
        heavy: 0,
        special: 0,
        [["gun", "heavy", "special"][w.slot]]: w.index,
      };
      const { sim, inputs } = duel(loadout, 8);
      // One idle tick first: the Riot Shield's toggle flips only once the
      // frame clock is past its hold, which starts at 0.
      step(sim, inputs);
      inputs.players[0].buttons = [BTN_GUN, BTN_HEAVY, BTN_SPECIAL][w.slot];
      step(sim, inputs);
      const fired = firedWeaponIds(sim);
      // Special: the second tick held (a kept-round weapon fires on the press).
      if (w.slot === 2) {
        step(sim, inputs);
        fired.push(...firedWeaponIds(sim));
      }
      expect(fired).toContain(w.id);
    }
  });
});

/**
 * The power-up is the original's (fcop-fidelity.md P8; fcop-re/player-and-
 * weapons.md §6): a slot's power pickup fills that slot's block-B magazine, the
 * slot fires block B until it is empty and then block A again, and a down loses
 * it. It replaced Metropolis' x2 damage for 15 s.
 */
describe("the power-up: the slot's block B (fcop-fidelity.md P8)", () => {
  /** A la-cantina avatar standing on the first pickup of `kind`. */
  function onPickup(kind: number, loadout: Partial<typeof DEFAULT_LOADOUT> = {}) {
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 1, { loadouts: [loadout] });
    const k = map.pickups.findIndex((p) => p.kind === kind);
    expect(k).toBeGreaterThanOrEqual(0);
    const a0 = sim.avatarId[0];
    sim.ent.posX[a0] = map.pickups[k].x;
    sim.ent.posY[a0] = map.pickups[k].y;
    sim.ent.height[a0] = resolveHeight(map, map.pickups[k].x, map.pickups[k].y, 0);
    return { sim, a0, inputs: createTickInputs() };
  }

  test("each slot's pickup fills its own B magazine to the NORMAL ceiling", () => {
    for (const [kind, slot, w] of [
      [PICKUP_POWER_GUN, 0, GUNS[0]],
      [PICKUP_POWER_HEAVY, 1, HEAVIES[0]],
      [PICKUP_POWER_SPECIAL, 2, SPECIALS[0]],
    ] as const) {
      const { sim, inputs } = onPickup(kind);
      step(sim, inputs);
      expect(sim.powerAmmo[slot]).toBe(normal(w.b.ammoCap));
      for (let s = 0; s < 3; s++) if (s !== slot) expect(sim.powerAmmo[s]).toBe(0);
    }
    expect(normal(HEAVIES[0].b.ammoCap)).toBe(18); // Hell Fire B: 15 x 1.25
  });

  test("a powered Hell Fire fires its B block — three missiles — until empty, then A", () => {
    const { sim, a0, inputs } = onPickup(PICKUP_POWER_HEAVY);
    step(sim, inputs);
    sim.powerAmmo[1] = 2;
    const ammoA = sim.ent.ammoA[a0];
    inputs.players[0].buttons = BTN_HEAVY;
    const volleys: number[] = [];
    for (let t = 0; t < 60; t++) {
      const before = projectiles(sim, PROJ_HEAVY).length;
      step(sim, inputs);
      const after = projectiles(sim, PROJ_HEAVY).length;
      if (firedWeaponIds(sim).includes(HEAVIES[0].id)) volleys.push(after - before);
    }
    // Two B volleys of three (225-unit gap: 23 ticks), then A's single missile.
    expect(volleys.slice(0, 3)).toEqual([3, 3, 1]);
    expect(sim.powerAmmo[1]).toBe(0);
    expect(sim.ent.ammoA[a0]).toBeLessThan(ammoA + 1);
  });

  test("a powered Mini-Gun splashes 2 in 1 m at the line's end even with no lock", () => {
    const { sim, inputs } = duel({ gun: 0 }, 0, 25);
    sim.powerAmmo[0] = 750;
    // An enemy 12.5 m ahead: past the lock, inside a metre of the line's 12 m end.
    const a1 = sim.avatarId[1];
    sim.ent.posX[a1] = 20 + 12.3;
    sim.ent.posY[a1] = 30;
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    // 2 * (1 - 0.3) / 1, truncated: 1.
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 1);
    expect(sim.powerAmmo[0]).toBe(749);
  });

  test("a powered Mortar bursts into four fragments at its apex", () => {
    const { sim, inputs } = duel({ special: 0 }, 0, 25);
    sim.powerAmmo[2] = 12;
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    step(sim, inputs); // fires on the second tick held
    inputs.players[0].buttons = 0;
    expect(projectiles(sim, PROJ_MORTAR).length).toBe(1);
    let most = 1;
    for (let t = 0; t < 120; t++) {
      step(sim, inputs);
      most = Math.max(most, projectiles(sim, PROJ_MORTAR).length);
    }
    expect(most).toBe(4);
    expect(sim.powerAmmo[2]).toBe(11);
  });

  test("going down loses it", () => {
    const { sim, a0, inputs } = onPickup(PICKUP_POWER_SPECIAL);
    step(sim, inputs);
    expect(sim.powerAmmo[2]).toBeGreaterThan(0);
    sim.ent.hp[a0] = -1;
    step(sim, inputs);
    expect(sim.powerAmmo[2]).toBe(0);
  });
});
