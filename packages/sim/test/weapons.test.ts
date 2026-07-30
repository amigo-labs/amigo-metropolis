import { describe, expect, test } from "bun:test";
import {
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  HEAVY_DAMAGE,
  PRIMARY_DAMAGE,
  SPECIAL_DAMAGE,
} from "../src/balance";
import { BUTTON_FIRE1, BUTTON_FIRE2, BUTTON_FIRE3, createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { createSim, step } from "../src/sim";
import {
  DEFAULT_LOADOUT,
  GUNS,
  HEAVIES,
  normalizeLoadout,
  resolveLoadout,
  SPECIALS,
  weaponById,
} from "../src/weapons";

describe("weapon catalog", () => {
  test("default kit matches historic balance numbers", () => {
    const kit = resolveLoadout(DEFAULT_LOADOUT);
    expect(kit.gun.damage).toBe(PRIMARY_DAMAGE);
    expect(kit.heavy.damage).toBe(HEAVY_DAMAGE);
    expect(kit.heavy.ammo).toBe(AVATAR_AMMO_HEAVY);
    expect(kit.special.damage).toBe(SPECIAL_DAMAGE);
    expect(kit.special.ammo).toBe(AVATAR_AMMO_SPECIAL);
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
});

describe("loadout combat", () => {
  test("default loadout leaves the first shot hash path intact on test-128", () => {
    // Smoke: createSim + one idle tick still works with explicit default loadout.
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
    const id = sim.avatarId[0];
    expect(id).toBeGreaterThanOrEqual(0);
    // Point aim +X and fire gun once.
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].aimY = 0;
    inputs.players[0].buttons = BUTTON_FIRE1;
    step(sim, inputs);
    expect(sim.events.count).toBeGreaterThan(0);
    // Event c carries weapon id 1 (Gatling Laser).
    let found = false;
    for (let i = 0; i < sim.events.count; i++) {
      const o = i * 4;
      if (sim.events.data[o] === 1 /* EV_SHOT */ && sim.events.data[o + 3] === 1) found = true;
    }
    expect(found).toBe(true);
  });

  test("concussion beam (special hitscan) spends special ammo", () => {
    const map = getMapById("test-128");
    const sim = createSim(map, 3, { loadouts: [{ gun: 0, heavy: 0, special: 2 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoB[id];
    expect(before).toBe(SPECIALS[2].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE3;
    step(sim, inputs);
    expect(sim.ent.ammoB[id]).toBe(before - 1);
  });

  test("rail cannon heavy spends heavy ammo", () => {
    const map = getMapById("test-128");
    const sim = createSim(map, 4, { loadouts: [{ gun: 0, heavy: 2, special: 0 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoA[id];
    expect(before).toBe(HEAVIES[2].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[id]).toBe(before - 1);
  });
});
