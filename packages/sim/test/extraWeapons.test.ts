// The original's five weapons Precinct Assault never offers (SIM_VERSION 90;
// fcop-fidelity.md W5): each behind its own SimOptions.extraWeapons bit, each
// running the original's code for its kind. Every number below is the RE's —
// the records (docs/specs/fcop-re/player-weapons.json) and the decompiled ticks
// (fcop-reverse-engineering src/game/actor/sustain_sphere.c, missile.c,
// type15.c, round_spawn.c, player_fire.c) — worked out here by hand rather
// than read back off the implementation.

import { describe, expect, test } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { AVATAR_HP_BY_DIFFICULTY, DIFFICULTY_NORMAL, WEAPON_RECORDS } from "../src/balance";
import { spawn } from "../src/entities";
import {
  EV_HIT,
  EV_SHOT,
  EVENT_STRIDE,
  SHOT_SLOT_SPECIAL,
  shotPayloadWeaponId,
} from "../src/events";
import { BTN_GUN, BTN_HEAVY, BTN_SPECIAL, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, hash, type SimState, step } from "../src/sim";
import {
  DEFAULT_LOADOUT,
  difficultyAmmo,
  EXTRA_WEAPON_FUSION_TORPEDO,
  EXTRA_WEAPON_GRENADE_LAUNCHER,
  EXTRA_WEAPON_K9_DRONE,
  EXTRA_WEAPON_PLASMA_FLARE,
  EXTRA_WEAPON_RIOT_SHIELD,
  EXTRA_WEAPONS_ALL,
  GUNS,
  HEAVIES,
  type Loadout,
  normalizeExtraWeapons,
  normalizeLoadout,
  PROJ_GRENADE,
  PROJ_K9,
  PROJ_PLASMA,
  PROJ_ROUND,
  PROJ_TORPEDO,
  SPECIALS,
  type WeaponDef,
} from "../src/weapons";

const AVATAR_HP = AVATAR_HP_BY_DIFFICULTY[DIFFICULTY_NORMAL];

function flatArena(heightAt?: (i: number, j: number) => number): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    const row: number[] = [];
    for (let i = 0; i < size; i++) row.push(heightAt ? heightAt(i, j) : 0);
    heights.push(row);
    water.push("0".repeat(size));
  }
  return {
    id: "flat-extra",
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

const ALL: readonly WeaponDef[] = [...GUNS, ...HEAVIES, ...SPECIALS];
const byCode = (code: number): WeaponDef => {
  const w = ALL.find((x) => x.code === code);
  if (!w) throw new Error(`no weapon 0x${code.toString(16)}`);
  return w;
};
const RIOT = byCode(0x05);
const K9 = byCode(0x15);
const TORPEDO = byCode(0x14);
const GRENADE = byCode(0x24);
const PLASMA = byCode(0x21);

/** P0 with `loadout` at (20, 30) facing +x, P1 `dx` m ahead facing away; one idle tick. */
function duel(loadout: Partial<Loadout>, dx: number, extraWeapons = EXTRA_WEAPONS_ALL, map = FLAT) {
  const sim = createSim(map, 1, { loadouts: [loadout, DEFAULT_LOADOUT], extraWeapons });
  const a0 = sim.avatarId[0];
  const a1 = sim.avatarId[1];
  sim.ent.posX[a1] = 20 + dx;
  sim.ent.posY[a1] = 30;
  sim.ent.yaw[a1] = Math.PI;
  sim.ent.aimX[a1] = -1;
  sim.ent.aimY[a1] = 0;
  const inputs = createTickInputs();
  // The frame clock starts at 0, where the shield's hold (0) is not passed yet.
  step(sim, inputs);
  return { sim, a0, a1, inputs };
}

function rounds(sim: SimState, kind: number): number[] {
  const out: number[] = [];
  for (let e = 0; e < sim.ent.high; e++) {
    if (
      sim.ent.alive[e] &&
      sim.ent.archetype[e] === ARCHETYPE.PROJECTILE &&
      sim.ent.mode[e] === kind
    ) {
      out.push(e);
    }
  }
  return out;
}

function shots(sim: SimState): number[] {
  const ids: number[] = [];
  for (let i = 0; i < sim.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (sim.events.data[o] !== EV_SHOT || sim.events.data[o + 2] > SHOT_SLOT_SPECIAL) continue;
    ids.push(shotPayloadWeaponId(sim.events.data[o + 3]));
  }
  return ids;
}

function hits(sim: SimState, target: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sim.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (sim.events.data[o] === EV_HIT && sim.events.data[o + 1] === target) {
      out.push(sim.events.data[o + 3]);
    }
  }
  return out;
}

/** Power slot `slot` of P0 as a pickup does: its B magazine and burst counter. */
function powerSlot(sim: SimState, w: WeaponDef): void {
  sim.powerAmmo[w.slot] = difficultyAmmo(w.b.ammoCap, DIFFICULTY_NORMAL);
  sim.burstLeft[w.slot] = w.b.rounds;
}

describe("the Spielregeln switch (SimOptions.extraWeapons)", () => {
  const PICKS: readonly [number, WeaponDef][] = [
    [EXTRA_WEAPON_RIOT_SHIELD, RIOT],
    [EXTRA_WEAPON_K9_DRONE, K9],
    [EXTRA_WEAPON_GRENADE_LAUNCHER, GRENADE],
    [EXTRA_WEAPON_FUSION_TORPEDO, TORPEDO],
    [EXTRA_WEAPON_PLASMA_FLARE, PLASMA],
  ];
  const key = ["gun", "heavy", "special"] as const;
  const lastPa = [3, 2, 2];

  test("the bits are 0 Riot Shield, 1 K-9, 2 Grenade, 3 Fusion Torpedo, 4 Plasma Flare", () => {
    expect(PICKS.map(([b]) => b)).toEqual([1, 2, 4, 8, 16]);
    expect(EXTRA_WEAPONS_ALL).toBe(31);
    for (const [bit, w] of PICKS) expect(w.extraBit).toBe(bit);
    expect(normalizeExtraWeapons(undefined)).toBe(0);
    expect(normalizeExtraWeapons(Number.NaN)).toBe(0);
    expect(normalizeExtraWeapons(0x3f)).toBe(0x1f);
    expect(normalizeExtraWeapons(5.9)).toBe(5);
  });

  for (const [bit, w] of PICKS) {
    test(`${w.name} needs its bit (${bit}), and only its bit`, () => {
      const pick = { [key[w.slot]]: w.index };
      // Off by default, the original's PA: refused onto the slot's last PA weapon.
      expect(normalizeLoadout(pick)[key[w.slot]]).toBe(lastPa[w.slot]);
      expect(normalizeLoadout(pick, EXTRA_WEAPONS_ALL & ~bit)[key[w.slot]]).toBe(lastPa[w.slot]);
      expect(normalizeLoadout(pick, bit)[key[w.slot]]).toBe(w.index);
      // ... in the sim too: a peer's or a replay's loadout cannot smuggle it in.
      const off = createSim(FLAT, 1, { loadouts: [pick as Partial<Loadout>] });
      const on = createSim(FLAT, 1, { loadouts: [pick as Partial<Loadout>], extraWeapons: bit });
      const arr = [off.loadoutGun, off.loadoutHeavy, off.loadoutSpecial][w.slot];
      const arrOn = [on.loadoutGun, on.loadoutHeavy, on.loadoutSpecial][w.slot];
      expect(arr[0]).toBe(lastPa[w.slot]);
      expect(arrOn[0]).toBe(w.index);
    });
  }

  test("a match offering none hashes as before; one offering any hashes the switch", () => {
    const a = createSim(FLAT, 1);
    const b = createSim(FLAT, 1, { extraWeapons: 0 });
    const c = createSim(FLAT, 1, { extraWeapons: EXTRA_WEAPON_K9_DRONE });
    expect(hash(a)).toBe(hash(b));
    expect(hash(c)).not.toBe(hash(a));
  });
});

describe("Riot Shield (0x05, sustain_sphere.c)", () => {
  test("the records: 1.6 m and 20 a tick as issued, 2.4 m and 40 powered, a round every 18 units", () => {
    expect(RIOT.a.rec.w0e).toBe(819); // 819 / 512 = 1.6 m
    expect(RIOT.a.damage).toBe(20);
    expect(RIOT.a.ammoCap).toBe(600);
    expect(RIOT.a.roundGap).toBe(18); // raw 1 * 4096 / 218
    expect(RIOT.b.rec.w0e).toBe(1228); // 2.4 m
    expect(RIOT.b.rec.w10).toBe(2048); // the reach box, 4 m
    expect(RIOT.b.damage).toBe(40);
    expect(RIOT.b.ammoCap).toBe(300);
  });

  test("the trigger toggles it: held it stays up, a fresh press puts it down", () => {
    const { sim, inputs } = duel({ gun: RIOT.index }, 30);
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    expect(sim.shield.flags[0] & 1).toBe(1);
    for (let t = 0; t < 30; t++) step(sim, inputs);
    expect(sim.shield.flags[0] & 1).toBe(1);
    // Released past the 0x3c-unit hold (7 ticks), then pressed: down.
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 7; t++) step(sim, inputs);
    expect(sim.shield.flags[0] & 1).toBe(1); // it stays up untouched
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    expect(sim.shield.flags[0] & 1).toBe(0);
    // Held, it stays down; the next press after a release puts it up again.
    for (let t = 0; t < 10; t++) step(sim, inputs);
    expect(sim.shield.flags[0] & 1).toBe(0);
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 7; t++) step(sim, inputs);
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    expect(sim.shield.flags[0] & 1).toBe(1);
  });

  test("its radius springs toward the record's: rate += ((2 (819 - r) - 8 rate) * 10) >> 8", () => {
    const { sim, inputs } = duel({ gun: RIOT.index }, 30);
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    let r = 0;
    let rate = 0;
    for (let t = 0; t < 40; t++) {
      rate = (((2 * (819 - r) - 8 * rate) * 10) >> 8) + rate;
      r += rate;
      expect(sim.shield.radius[0]).toBe(r);
      step(sim, inputs);
    }
    expect(Math.abs(r - 819)).toBeLessThan(40);
  });

  test("it spends a round every 18 units while up, held or not, and drops at an empty magazine", () => {
    const { sim, inputs } = duel({ gun: RIOT.index }, 30);
    const full = difficultyAmmo(600, DIFFICULTY_NORMAL);
    expect(sim.gunAmmo[0]).toBe(full);
    inputs.players[0].buttons = BTN_GUN;
    step(sim, inputs);
    expect(sim.gunAmmo[0]).toBe(full - 1);
    // Held: the trigger's own spend, one a call, a call every 2 ticks (18 units).
    for (let t = 0; t < 20; t++) step(sim, inputs);
    expect(sim.gunAmmo[0]).toBe(full - 11);
    // Released: the sphere's spend, once the hold has passed, one every 2 ticks.
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 26; t++) step(sim, inputs);
    expect(sim.gunAmmo[0]).toBe(full - 21);
    sim.gunAmmo[0] = 2;
    for (let t = 0; t < 6; t++) step(sim, inputs);
    expect(sim.gunAmmo[0]).toBe(0);
    expect(sim.shield.flags[0] & 1).toBe(0);
    expect(sim.shield.radius[0]).toBe(0);
  });

  test("it hurts what touches it 20 a tick, in front only as issued (a half sphere)", () => {
    const { sim, a1, inputs } = duel({ gun: RIOT.index }, 1.5);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < 12; t++) step(sim, inputs);
    expect(hits(sim, a1)).toEqual([20]);
    const before = sim.ent.hp[a1];
    step(sim, inputs);
    expect(sim.ent.hp[a1]).toBe(before - 20);
    // Behind the mech the half sphere of block A does nothing.
    sim.ent.posX[a1] = 18.5;
    step(sim, inputs);
    expect(hits(sim, a1)).toEqual([]);
  });

  test("powered it is the whole sphere, 40 a tick, behind as well", () => {
    const { sim, a1, inputs } = duel({ gun: RIOT.index }, -1.5);
    powerSlot(sim, RIOT);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < 12; t++) step(sim, inputs);
    expect(sim.shield.flags[0] & 4).toBe(4);
    // At least the sphere's own 40; a charged arc on the body's side adds 40 more.
    const h = hits(sim, a1);
    expect(h.length).toBeGreaterThan(0);
    for (const d of h) expect(d).toBe(40);
    expect(sim.powerAmmo[0]).toBeLessThan(difficultyAmmo(300, DIFFICULTY_NORMAL));
  });

  test("a powered sphere destroys an enemy round inside it (1000 to types 2, 7 and 0x0f)", () => {
    const { sim, inputs } = duel({ gun: RIOT.index }, 30);
    powerSlot(sim, RIOT);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < 12; t++) step(sim, inputs);
    // An enemy round held still 2.2 m behind the mech: inside the 2.4 m sphere,
    // outside its own contact reach of the mech.
    const e = sim.ent;
    const a0 = sim.avatarId[0];
    const r = spawn(e, ARCHETYPE.PROJECTILE, 1);
    e.posX[r] = e.posX[a0] - 2.2;
    e.posY[r] = e.posY[a0];
    e.height[r] = e.height[a0];
    e.hp[r] = 1;
    e.timerA[r] = 100;
    e.mode[r] = PROJ_ROUND;
    e.ownerId[r] = -1;
    e.cooldownC[r] = -1;
    step(sim, inputs);
    expect(e.alive[r] === 1 && e.mode[r] === PROJ_ROUND).toBe(false);
  });

  test("its sphere is in the avatar snapshot: radius in metres, whole or half", async () => {
    const {
      AVATAR_SNAP_SHIELD_RADIUS,
      AVATAR_SNAP_SHIELD_FLAGS,
      AVATAR_SNAPSHOT_LEN,
      writeAvatarSnapshot,
    } = await import("../src/avatarSnapshot");
    const { sim, inputs } = duel({ gun: RIOT.index }, 30);
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    writeAvatarSnapshot(sim, out);
    expect(out[AVATAR_SNAP_SHIELD_RADIUS]).toBe(0);
    inputs.players[0].buttons = BTN_GUN;
    for (let t = 0; t < 30; t++) step(sim, inputs);
    writeAvatarSnapshot(sim, out);
    expect(out[AVATAR_SNAP_SHIELD_RADIUS]).toBeCloseTo(sim.shield.radius[0] / 512, 5);
    expect(out[AVATAR_SNAP_SHIELD_FLAGS] & 1).toBe(0);
  });
});

describe("K-9 Drone (0x15, missile.c CACT_MISSILE_KIND_HUG)", () => {
  test("the records: 150 a drone every 3 s; powered a burst of three, 200, every 4 s", () => {
    expect(K9.a.damage).toBe(150);
    expect(K9.a.burstGap).toBe(901); // raw 48
    expect(K9.a.ammoCap).toBe(25);
    expect(K9.b.rounds).toBe(3);
    expect(K9.b.damage).toBe(200);
    expect(K9.b.burstGap).toBe(1202); // raw 64
    expect(K9.b.ammoCap).toBe(18);
    expect(K9.a.range).toBeCloseTo(16, 6);
  });

  test("it launches at 16 wu a unit and gains trunc(10 * 34 / 16) = 21 a tick to its cap of 128 (4.69 m/s)", () => {
    const { sim, inputs } = duel({ heavy: K9.index }, 12);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [d] = rounds(sim, PROJ_K9);
    // Its own first tick ran in the tick that launched it.
    const want = [37, 58, 79, 100, 121, 128, 128];
    expect(sim.ent.cooldownA[d]).toBe(37);
    for (let i = 1; i < want.length; i++) {
      step(sim, inputs);
      expect(sim.ent.cooldownA[d]).toBe(want[i]);
    }
    expect((128 * 300) / 8192).toBeCloseTo(4.6875, 6);
    // Twice its damage as health: 300.
    expect(sim.ent.hp[d]).toBe(300);
  });

  test("it homes on the lock and strikes it for 150", () => {
    const { sim, a1, inputs } = duel({ heavy: K9.index }, 8);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    expect(sim.lockTarget[0]).toBe(a1);
    for (let t = 0; t < 90 && rounds(sim, PROJ_K9).length > 0; t++) step(sim, inputs);
    expect(rounds(sim, PROJ_K9)).toEqual([]);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 150);
  });

  test("a body it strikes costs it the larger of that body's health and 2, and it hunts again", () => {
    const { sim, a1, inputs } = duel({ heavy: K9.index }, 8);
    sim.ent.hp[a1] = 120; // weaker than the drone's 300
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    let d = -1;
    for (let t = 0; t < 90; t++) {
      [d] = rounds(sim, PROJ_K9);
      step(sim, inputs);
      if (hits(sim, a1).length > 0) break;
    }
    expect(sim.ent.alive[d]).toBe(1);
    expect(sim.ent.hp[d]).toBe(300 - 120);
    expect(sim.ent.timerC[d]).toBe(4); // ACQUIRE
  });

  test("without a lock it coasts its 16 m from the launch point and ends", () => {
    const { sim, a1, inputs } = duel({ heavy: K9.index }, 0);
    sim.ent.posY[a1] = 50; // nothing ahead
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [d] = rounds(sim, PROJ_K9);
    const x0 = sim.ent.posX[d];
    let last = x0;
    for (let t = 0; t < 200 && sim.ent.alive[d]; t++) {
      last = sim.ent.posX[d];
      step(sim, inputs);
    }
    expect(sim.ent.alive[d] === 1 && sim.ent.mode[d] === PROJ_K9).toBe(false);
    expect(last - x0).toBeGreaterThan(15.5);
    expect(last - x0).toBeLessThanOrEqual(16.2);
  });

  test("it hugs the ground: under 0.25 m of clearance it is lifted 1/16 m and slowed by half", () => {
    // A slope rising ahead: 0 at the mech, 1.5 m two cells on.
    const hill = loadMapFromJson(flatArena((i) => (i >= 7 ? 48 : 0))); // 48 * 1/32 m
    const { sim, a1, inputs } = duel({ heavy: K9.index }, 11, EXTRA_WEAPONS_ALL, hill);
    sim.ent.height[a1] = 1.5;
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [d] = rounds(sim, PROJ_K9);
    let avoided = false;
    for (let t = 0; t < 120 && sim.ent.alive[d] && sim.ent.mode[d] === PROJ_K9; t++) {
      const sp = sim.ent.cooldownA[d];
      step(sim, inputs);
      if (sim.ent.timerC[d] === 3) {
        avoided = true;
        expect(sim.ent.cooldownA[d]).toBeLessThanOrEqual(Math.max(sp, 1));
      }
    }
    expect(avoided).toBe(true);
    expect(sim.ent.hp[a1]).toBe(AVATAR_HP - 150);
  });

  test("powered: three drones on three ticks, then 1202 units (121 ticks)", () => {
    const { sim, inputs } = duel({ heavy: K9.index }, 12);
    powerSlot(sim, K9);
    inputs.players[0].buttons = BTN_HEAVY;
    const fired: number[] = [];
    for (let t = 0; t < 130; t++) {
      step(sim, inputs);
      if (shots(sim).includes(K9.id)) fired.push(t);
    }
    expect(fired.slice(0, 4)).toEqual([0, 1, 2, 123]);
    expect(sim.ent.hp[rounds(sim, PROJ_K9)[0] ?? 0]).toBeDefined();
  });
});

describe("Fusion Torpedo (0x14, missile.c with CACT_MISSILE_FALLOFF)", () => {
  test("the records: 100 in a 1 m blast every second; powered 150 in 2 m", () => {
    expect(TORPEDO.a.damage).toBe(100);
    expect(TORPEDO.a.blast).toBe(1);
    expect(TORPEDO.a.burstGap).toBe(300);
    expect(TORPEDO.a.ammoCap).toBe(40);
    expect(TORPEDO.b.damage).toBe(150);
    expect(TORPEDO.b.blast).toBe(2);
    expect(TORPEDO.b.ammoCap).toBe(10);
    expect((((6144 / 300) | 0) * 16 * 300) / 8192).toBeCloseTo(11.72, 2);
  });

  test("it launches at 40 wu a unit (1.46 m/s) and gains 12 a tick to 320 (11.7 m/s)", () => {
    const { sim, inputs } = duel({ heavy: TORPEDO.index }, 14);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [d] = rounds(sim, PROJ_TORPEDO);
    expect(sim.ent.cooldownA[d]).toBe(40 + 12);
    for (let t = 0; t < 30; t++) step(sim, inputs);
    expect(sim.ent.cooldownA[d]).toBe(320);
    expect(sim.ent.hp[d]).toBe(40);
  });

  test("its blast loses flown * damage / range: struck at 8 m it does 100, then 50 in its blast", () => {
    const { sim, a1, inputs } = duel({ heavy: TORPEDO.index }, 9);
    inputs.players[0].buttons = BTN_HEAVY;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [d] = rounds(sim, PROJ_TORPEDO);
    const lx = sim.roundLaunch[d * 4];
    let x = lx;
    for (let t = 0; t < 120 && sim.ent.alive[d]; t++) {
      x = sim.ent.posX[d];
      step(sim, inputs);
      if (hits(sim, a1).length > 0) {
        const h = hits(sim, a1);
        // The collision's 100, then the blast's: 100 - flown/16 m of 100, cut
        // again by the distance to the body over 1 m.
        expect(h[0]).toBe(100);
        break;
      }
    }
    expect(sim.ent.hp[a1]).toBeLessThanOrEqual(AVATAR_HP - 100);
    expect(x - lx).toBeGreaterThan(6);
  });
});

describe("Grenade Launcher (0x24, type15.c and round_spawn.c)", () => {
  test("the records: 400 in a 4.2 m blast, 7.6 m/s against 8 m/s² (7.3 m of reach); powered two, 600", () => {
    expect(GRENADE.a.damage).toBe(400);
    expect(GRENADE.a.blast).toBeCloseTo(4.199, 3);
    expect(GRENADE.a.launchSpeed).toBeCloseTo(7.617, 3);
    expect(GRENADE.a.gravity).toBe(8);
    expect(GRENADE.range).toBeCloseTo(7.25, 2);
    expect(GRENADE.a.fuseUnits).toBe(901);
    expect(GRENADE.a.flags & 4).toBe(4); // a kept round
    expect(GRENADE.b.rounds).toBe(2);
    expect(GRENADE.b.damage).toBe(600);
    expect(GRENADE.b.ammoCap).toBe(16);
  });

  test("its fuse is 901 + 901 * (rand & 0x1f) / 64 units: 3.0 to 4.5 s", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed < 40; seed++) {
      const sim = createSim(FLAT, seed, {
        loadouts: [{ special: GRENADE.index }],
        extraWeapons: EXTRA_WEAPON_GRENADE_LAUNCHER,
      });
      const inputs = createTickInputs();
      step(sim, inputs);
      inputs.players[0].buttons = BTN_SPECIAL;
      step(sim, inputs);
      const [g] = rounds(sim, PROJ_GRENADE);
      // Its first tick ran: one delta spent.
      const life = sim.ent.timerA[g] + 10;
      const j = Math.round(((life - 901) * 64) / 901);
      expect(life).toBe(901 + Math.trunc((901 * j) / 64));
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(31);
      seen.add(j);
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  test("it falls 2184 wu/s a tick, and a bounce keeps -5/8 of the vertical and 7/8 of the horizontal", () => {
    const { sim, a1, inputs } = duel({ special: GRENADE.index }, 30);
    sim.ent.posY[a1] = 60; // no lock: 8 m ahead at muzzle height
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [g] = rounds(sim, PROJ_GRENADE);
    let bounced = false;
    for (let t = 0; t < 200 && sim.ent.alive[g] && !bounced; t++) {
      const vx = sim.ent.velX[g];
      const vh = sim.ent.timerB[g];
      const above = sim.ent.height[g] > 0;
      step(sim, inputs);
      if (!sim.ent.alive[g]) break;
      if (above) {
        expect(sim.ent.timerB[g]).toBe(vh > 0 && 2184 > vh ? 0 : vh - 2184);
        expect(sim.ent.velX[g]).toBe(vx);
      } else {
        expect(sim.ent.timerB[g]).toBe(Math.trunc((-5 * vh) / 8));
        expect(sim.ent.velX[g]).toBe(Math.trunc((7 * vx) / 8));
        bounced = true;
      }
    }
    expect(bounced).toBe(true);
  });

  test("at the ground it settles, and goes off, once every axis is under 0x1800 wu/s", () => {
    const { sim, a1, inputs } = duel({ special: GRENADE.index }, 30);
    sim.ent.posY[a1] = 60;
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    const [g] = rounds(sim, PROJ_GRENADE);
    // At the ground with 0x17ff on every axis: no bounce, it rests and goes off.
    sim.ent.height[g] = 0;
    sim.ent.velX[g] = 0x17ff;
    sim.ent.velY[g] = -0x17ff;
    sim.ent.timerB[g] = -0x17ff;
    step(sim, inputs);
    expect(rounds(sim, PROJ_GRENADE)).toEqual([]);
    // One wu/s more on one axis, and it bounces instead.
    inputs.players[0].buttons = BTN_SPECIAL;
    for (let t = 0; t < 40 && rounds(sim, PROJ_GRENADE).length === 0; t++) {
      step(sim, inputs);
      inputs.players[0].buttons = inputs.players[0].buttons === 0 ? BTN_SPECIAL : 0;
    }
    const [h] = rounds(sim, PROJ_GRENADE);
    sim.ent.height[h] = 0;
    sim.ent.velX[h] = 0x1800;
    sim.ent.velY[h] = 0;
    sim.ent.timerB[h] = -0x1000;
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    expect(sim.ent.alive[h]).toBe(1);
    expect(sim.ent.velX[h]).toBe(Math.trunc((7 * 0x1800) / 8));
    expect(sim.ent.timerB[h]).toBe(Math.trunc((5 * 0x1000) / 8));
  });

  test("the second Special press sets it off; a third fires again", () => {
    const { sim, a1, inputs } = duel({ special: GRENADE.index }, 4);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(shots(sim)).toEqual([GRENADE.id]);
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    const [g] = rounds(sim, PROJ_GRENADE);
    expect(sim.keptRound[0]).toBe(g);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(shots(sim)).toEqual([]);
    expect(rounds(sim, PROJ_GRENADE)).toEqual([]);
    expect(sim.keptRound[0]).toBe(-1);
    // Its blast: 400 falling off linearly over 4.2 m.
    const h = hits(sim, a1);
    expect(h.length).toBe(1);
    expect(h[0]).toBeGreaterThan(0);
    expect(h[0]).toBeLessThan(400);
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 31; t++) step(sim, inputs); // the 300-unit burst gap
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(shots(sim)).toEqual([GRENADE.id]);
  });

  test("it goes off against a body it meets", () => {
    const { sim, a1, inputs } = duel({ special: GRENADE.index }, 5);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 60 && rounds(sim, PROJ_GRENADE).length > 0; t++) step(sim, inputs);
    expect(rounds(sim, PROJ_GRENADE)).toEqual([]);
    expect(sim.ent.hp[a1]).toBeLessThan(AVATAR_HP);
  });
});

describe("Plasma Flare (0x21, the arced shell, kept)", () => {
  test("the records: 250 in a 6 m blast every 2 s, 7.6 m/s against 5.2 m/s² (11.2 m); powered four of 200", () => {
    expect(PLASMA.a.damage).toBe(250);
    expect(PLASMA.a.blast).toBe(6);
    expect(PLASMA.a.burstGap).toBe(601);
    expect(PLASMA.a.gravity).toBeCloseTo(5.199, 3);
    expect(PLASMA.range).toBeCloseTo(11.16, 2);
    expect(PLASMA.a.ammoCap).toBe(30);
    expect(PLASMA.a.flags & 4).toBe(4);
    expect(PLASMA.b.kind).toBe(0x14); // bursts into four at the apex
    expect(PLASMA.b.damage).toBe(200);
    expect(PLASMA.b.burstGap).toBe(901);
    expect(PLASMA.b.ammoCap).toBe(15);
    expect(WEAPON_RECORDS[0x21].a.range).toBe(2662);
  });

  test("Special fires it on the press, and the second press sets it off where it is", () => {
    const { sim, a1, inputs } = duel({ special: PLASMA.index }, 10);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(shots(sim)).toEqual([PLASMA.id]);
    // Held: an edge, not a level.
    step(sim, inputs);
    expect(shots(sim)).toEqual([]);
    const [f] = rounds(sim, PROJ_PLASMA);
    expect(sim.keptRound[0]).toBe(f);
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 4; t++) step(sim, inputs);
    const x = sim.ent.posX[f];
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    expect(rounds(sim, PROJ_PLASMA)).toEqual([]);
    // Set off short of the mech 10 m away: its 6 m blast reaches nothing there.
    expect(x).toBeLessThan(sim.ent.posX[a1] - 6);
    expect(hits(sim, a1)).toEqual([]);
  });

  test("left alone it lands on the lock for its 250 (falloff over 6 m)", () => {
    const { sim, a1, inputs } = duel({ special: PLASMA.index }, 10);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    let dealt = 0;
    for (let t = 0; t < 120 && dealt === 0; t++) {
      step(sim, inputs);
      for (const h of hits(sim, a1)) dealt += h;
    }
    expect(dealt).toBeGreaterThan(150);
    expect(dealt).toBeLessThanOrEqual(250);
  });

  test("powered it bursts into four at the top of its arc", () => {
    const { sim, inputs } = duel({ special: PLASMA.index }, 10);
    powerSlot(sim, PLASMA);
    inputs.players[0].buttons = BTN_SPECIAL;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    let most = 0;
    for (let t = 0; t < 60; t++) {
      step(sim, inputs);
      most = Math.max(most, rounds(sim, PROJ_PLASMA).length);
    }
    expect(most).toBe(4);
  });
});
