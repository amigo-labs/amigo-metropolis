import { describe, expect, test } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  SPECIAL_COOLDOWN_TICKS,
  SPECIAL_DAMAGE,
  SPECIAL_MINE_ARM_TICKS,
  SPECIAL_MINE_TRIGGER_RADIUS,
} from "../src/balance";
import { EV_SHOT, EVENT_STRIDE, shotPayloadWeaponId } from "../src/events";
import { BUTTON_FIRE1, BUTTON_FIRE2, BUTTON_FIRE3, createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { createSim, type SimState, step } from "../src/sim";
import {
  DEFAULT_LOADOUT,
  GUNS,
  HEAVIES,
  normalizeLoadout,
  PROJ_MINE,
  resolveLoadout,
  SPECIALS,
  weaponById,
} from "../src/weapons";

/**
 * Catalog ids of the avatar shots in this tick's event buffer.
 *
 * The avatar slots pack the id together with the shot's reach (events.ts
 * `weaponShotPayload`), so `c` is no longer the bare id these tests used to
 * compare against.
 */
function firedWeaponIds(sim: SimState): number[] {
  const ids: number[] = [];
  for (let i = 0; i < sim.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (sim.events.data[o] === EV_SHOT) ids.push(shotPayloadWeaponId(sim.events.data[o + 3]));
  }
  return ids;
}

describe("weapon catalog", () => {
  test("default kit matches historic balance numbers", () => {
    const kit = resolveLoadout(DEFAULT_LOADOUT);
    expect(kit.gun.name).toBe("Powered Mini-Gun");
    expect(kit.heavy.name).toBe("Hell Fire 2000");
    expect(kit.special.name).toBe("Mortar Launcher");
    expect(kit.gun.damage).toBe(PRIMARY_DAMAGE);
    expect(kit.heavy.damage).toBe(HEAVY_DAMAGE);
    expect(kit.heavy.ammo).toBe(AVATAR_AMMO_HEAVY);
    expect(kit.special.damage).toBe(SPECIAL_DAMAGE);
    expect(kit.special.ammo).toBe(AVATAR_AMMO_SPECIAL);
  });

  test("catalog is the ten original PA weapons", () => {
    expect(GUNS.map((w) => w.name)).toEqual([
      "Powered Mini-Gun",
      "Gatling Laser",
      "Flamethrower",
      "Electric Gun",
    ]);
    expect(HEAVIES.map((w) => w.name)).toEqual([
      "Hell Fire 2000",
      "Concussion Beam",
      "Hyper Velocity Rocket",
    ]);
    expect(SPECIALS.map((w) => w.name)).toEqual([
      "Mortar Launcher",
      "Pop-Up Mines",
      "Shockwave Generator",
    ]);
  });

  test("normalizeLoadout clamps out-of-range picks", () => {
    expect(normalizeLoadout({ gun: 99, heavy: -3, special: 1.7 })).toEqual({
      gun: GUNS.length - 1,
      heavy: 0,
      special: 1,
    });
  });

  test("every catalog id resolves uniquely", () => {
    const ids = new Set<number>();
    for (const w of [...GUNS, ...HEAVIES, ...SPECIALS]) {
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
 * The ten original Precinct Assault weapons, pinned against the original's
 * front-end bars (rules.md §2).
 *
 * Bars are 1/55, so they give ratios: each slot's index-0 weapon is the anchor,
 * `damage = anchorDamage * bar / anchorBar` and
 * `cooldown = anchorCooldown * anchorRate / rate`. Recomputed here from the raw
 * bar readings rather than restating balance.ts's results, so a hand-edit to
 * either side has to be justified.
 */
describe("original weapon table (rules.md §2)", () => {
  // panel, firing-rate bar, damage bar — measured off extracted/frontend/*.png
  // for the long-standing nine, and scale-matched from PA weapons-screen
  // captures for Pop-Up Mines and Shockwave Generator.
  const BARS = {
    "Powered Mini-Gun": { rate: 55, dmg: 3 },
    "Gatling Laser": { rate: 55, dmg: 3 },
    Flamethrower: { rate: 55, dmg: 9 },
    "Electric Gun": { rate: 28, dmg: 9 },
    "Hell Fire 2000": { rate: 42, dmg: 9 },
    "Concussion Beam": { rate: 21, dmg: 19 },
    "Hyper Velocity Rocket": { rate: 55, dmg: 11 },
    "Mortar Launcher": { rate: 28, dmg: 19 },
    "Pop-Up Mines": { rate: 55, dmg: 55 },
    "Shockwave Generator": { rate: 19, dmg: 28 },
  } as const;

  const ANCHOR = ["Powered Mini-Gun", "Hell Fire 2000", "Mortar Launcher"] as const;

  test("each slot's anchor is the default pick, unchanged", () => {
    for (const [slot, list] of [GUNS, HEAVIES, SPECIALS].entries()) {
      expect(list[0].name).toBe(ANCHOR[slot]);
    }
    expect(GUNS[0].damage).toBe(PRIMARY_DAMAGE);
    expect(GUNS[0].cooldownTicks).toBe(PRIMARY_COOLDOWN_TICKS);
    expect(HEAVIES[0].damage).toBe(HEAVY_DAMAGE);
    expect(HEAVIES[0].cooldownTicks).toBe(HEAVY_COOLDOWN_TICKS);
    expect(SPECIALS[0].damage).toBe(SPECIAL_DAMAGE);
    expect(SPECIALS[0].cooldownTicks).toBe(SPECIAL_COOLDOWN_TICKS);
  });

  test("every catalog weapon sits at its slot-anchored ratio", () => {
    for (const [slot, list] of [GUNS, HEAVIES, SPECIALS].entries()) {
      const anchorBars = BARS[ANCHOR[slot]];
      for (const w of list) {
        const bars = BARS[w.name as keyof typeof BARS];
        expect(bars).toBeDefined();
        expect(w.damage).toBe(Math.round((list[0].damage * bars.dmg) / anchorBars.dmg));
        expect(w.cooldownTicks).toBe(
          Math.round((list[0].cooldownTicks * anchorBars.rate) / bars.rate),
        );
      }
    }
  });

  test("the Concussion Beam is a Heavy, as in the original", () => {
    expect(HEAVIES.some((w) => w.name === "Concussion Beam")).toBe(true);
    expect(SPECIALS.some((w) => w.name === "Concussion Beam")).toBe(false);
  });

  test("the declared deviation is the Mini-Gun/Laser range, and only that", () => {
    const [mini, laser] = GUNS;
    expect(laser.damage).toBe(mini.damage);
    expect(laser.cooldownTicks).toBe(mini.cooldownTicks);
    expect(laser.range).toBeGreaterThan(mini.range);
  });
});

describe("loadout combat", () => {
  test("default loadout leaves the first shot hash path intact on test-128", () => {
    const map = getMapById("test-128");
    const a = createSim(map, 1, { loadouts: [DEFAULT_LOADOUT] });
    const b = createSim(map, 1);
    const idle = createTickInputs();
    step(a, idle);
    step(b, idle);
    expect(a.ent.ammoA[a.avatarId[0]]).toBe(b.ent.ammoA[b.avatarId[0]]);
    expect(a.ent.ammoB[a.avatarId[0]]).toBe(b.ent.ammoB[b.avatarId[0]]);
  });

  test("gatling laser uses its own ammo-free hitscan kit", () => {
    const map = getMapById("test-128");
    const sim = createSim(map, 2, { loadouts: [{ gun: 1, heavy: 0, special: 0 }] });
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].aimY = 0;
    inputs.players[0].buttons = BUTTON_FIRE1;
    step(sim, inputs);
    expect(sim.events.count).toBeGreaterThan(0);
    expect(firedWeaponIds(sim)).toContain(1);
  });

  test("concussion beam (heavy hitscan) spends heavy ammo", () => {
    const map = getMapById("test-128");
    const sim = createSim(map, 3, { loadouts: [{ gun: 0, heavy: 1, special: 0 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoA[id];
    expect(HEAVIES[1].name).toBe("Concussion Beam");
    expect(before).toBe(HEAVIES[1].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[id]).toBe(before - 1);
  });

  test("electric gun is ammo-free hitscan at catalog id 9", () => {
    const map = getMapById("test-128");
    expect(GUNS[3].name).toBe("Electric Gun");
    const sim = createSim(map, 5, { loadouts: [{ gun: 3, heavy: 0, special: 0 }] });
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE1;
    step(sim, inputs);
    expect(firedWeaponIds(sim)).toContain(9);
  });

  test("hyper velocity rocket spends heavy ammo", () => {
    const map = getMapById("test-128");
    expect(HEAVIES[2].name).toBe("Hyper Velocity Rocket");
    const sim = createSim(map, 6, { loadouts: [{ gun: 0, heavy: 2, special: 0 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoA[id];
    expect(before).toBe(HEAVIES[2].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[id]).toBe(before - 1);
  });

  test("pop-up mines place a charge without aim and spend special ammo", () => {
    const map = getMapById("test-128");
    expect(SPECIALS[1].name).toBe("Pop-Up Mines");
    const sim = createSim(map, 8, { loadouts: [{ gun: 0, heavy: 0, special: 1 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoB[id];
    expect(before).toBe(SPECIALS[1].ammo);
    const inputs = createTickInputs();
    // Zero aim — mines must still place.
    inputs.players[0].aimX = 0;
    inputs.players[0].aimY = 0;
    inputs.players[0].buttons = BUTTON_FIRE3;
    step(sim, inputs);
    expect(sim.ent.ammoB[id]).toBe(before - 1);
    let mineId = -1;
    for (let e = 0; e < sim.ent.high; e++) {
      if (
        sim.ent.alive[e] &&
        sim.ent.archetype[e] === ARCHETYPE.PROJECTILE &&
        sim.ent.mode[e] === PROJ_MINE
      ) {
        mineId = e;
        break;
      }
    }
    expect(mineId).toBeGreaterThanOrEqual(0);
    expect(sim.ent.timerB[mineId]).toBe(SPECIAL_MINE_ARM_TICKS - 1);
  });

  test("armed mine detonates on enemy avatar proximity", () => {
    const map = getMapById("test-128");
    const sim = createSim(map, 10, {
      loadouts: [
        { gun: 0, heavy: 0, special: 1 },
        { gun: 0, heavy: 0, special: 0 },
      ],
    });
    const a0 = sim.avatarId[0];
    const a1 = sim.avatarId[1];
    expect(a0).toBeGreaterThanOrEqual(0);
    expect(a1).toBeGreaterThanOrEqual(0);
    // test-128 co-locates both spawns — park the enemy clear before placing so
    // arming does not trip on the standing teammate-enemy.
    sim.ent.posX[a1] = sim.ent.posX[a0] + 40;
    sim.ent.posY[a1] = sim.ent.posY[a0];
    const place = createTickInputs();
    place.players[0].buttons = BUTTON_FIRE3;
    step(sim, place);
    let mineId = -1;
    for (let e = 0; e < sim.ent.high; e++) {
      if (sim.ent.alive[e] && sim.ent.mode[e] === PROJ_MINE) mineId = e;
    }
    expect(mineId).toBeGreaterThanOrEqual(0);
    const mx = sim.ent.posX[mineId];
    const my = sim.ent.posY[mineId];
    const idle = createTickInputs();
    for (let t = 0; t < SPECIAL_MINE_ARM_TICKS + 1; t++) step(sim, idle);
    expect(sim.ent.alive[mineId]).toBe(1);
    // Walk the enemy into the trigger (test-only state write — fuze only).
    sim.ent.posX[a1] = mx + SPECIAL_MINE_TRIGGER_RADIUS * 0.5;
    sim.ent.posY[a1] = my;
    const hpBefore = sim.ent.hp[a1];
    expect(hpBefore).toBeGreaterThan(0);
    step(sim, idle);
    expect(sim.ent.alive[mineId]).toBe(0);
    expect(sim.ent.hp[a1]).toBeLessThan(hpBefore);
  });

  test("shockwave generator fires without aim and damages nearby enemies", () => {
    const map = getMapById("test-128");
    expect(SPECIALS[2].name).toBe("Shockwave Generator");
    const sim = createSim(map, 11, {
      loadouts: [
        { gun: 0, heavy: 0, special: 2 },
        { gun: 0, heavy: 0, special: 0 },
      ],
    });
    const a0 = sim.avatarId[0];
    const a1 = sim.avatarId[1];
    // Put enemy next to p0.
    sim.ent.posX[a1] = sim.ent.posX[a0] + 2;
    sim.ent.posY[a1] = sim.ent.posY[a0];
    const hpBefore = sim.ent.hp[a1];
    const before = sim.ent.ammoB[a0];
    const inputs = createTickInputs();
    inputs.players[0].aimX = 0;
    inputs.players[0].aimY = 0;
    inputs.players[0].buttons = BUTTON_FIRE3;
    step(sim, inputs);
    expect(sim.ent.ammoB[a0]).toBe(before - 1);
    expect(sim.ent.hp[a1]).toBeLessThan(hpBefore);
  });
});
