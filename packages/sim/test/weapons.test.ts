import { describe, expect, test } from "bun:test";
import {
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  SPECIAL_COOLDOWN_TICKS,
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

  test("slot and index fields agree with each list's position", () => {
    // The Concussion Beam moved slot; a stale `slot`/`index` field would make
    // weaponInSlot and the menu disagree about what the player picked.
    for (const [slot, list] of [GUNS, HEAVIES, SPECIALS].entries()) {
      for (const [index, w] of list.entries()) {
        expect(w.slot as number).toBe(slot);
        expect(w.index).toBe(index);
      }
    }
  });
});

/**
 * The eleven weapons Metropolis shares with Future Cop, pinned against the
 * original's own front-end bars.
 *
 * Bars are 1/55, so they give ratios: each slot's index-0 weapon is the anchor,
 * `damage = anchorDamage * bar / anchorBar` and
 * `cooldown = anchorCooldown * anchorRate / rate`. Recomputed here from the raw
 * bar readings rather than restating balance.ts's results, so a hand-edit to
 * either side has to be justified.
 */
describe("original weapon table (rules.md §2)", () => {
  // panel, firing-rate bar, damage bar — measured off extracted/frontend/*.png.
  const BARS = {
    "Powered Mini-Gun": { rate: 55, dmg: 3 },
    "Gatling Laser": { rate: 55, dmg: 3 },
    Flamethrower: { rate: 55, dmg: 9 },
    "Electric Gun": { rate: 28, dmg: 9 },
    "Hell Fire 2000": { rate: 42, dmg: 9 },
    "Concussion Beam": { rate: 21, dmg: 19 },
    "Hyper Velocity Rocket": { rate: 55, dmg: 11 },
    "Fusion Torpedo": { rate: 22, dmg: 37 },
    "Mortar Launcher": { rate: 28, dmg: 19 },
    "Plasma Flare": { rate: 28, dmg: 24 },
    "Grenade Launcher": { rate: 28, dmg: 37 },
  } as const;

  const ANCHOR = ["Powered Mini-Gun", "Hell Fire 2000", "Plasma Flare"] as const;

  test("each slot's anchor is the default pick, unchanged", () => {
    // This is why no golden moved: the anchors ARE the historic numbers, so the
    // default loadout comes out bit-identical.
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

  test("every shared weapon sits at its slot-anchored ratio", () => {
    for (const [slot, list] of [GUNS, HEAVIES, SPECIALS].entries()) {
      const anchorBars = BARS[ANCHOR[slot]];
      for (const w of list) {
        const bars = BARS[w.name as keyof typeof BARS];
        if (!bars) continue; // Cluster Bomb / Rail Cannon — ours, nothing to match
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
    // The bars cannot tell the two apart (both 55/55 and 3/55). Adopting that
    // literally would ship two identical picks, so reach separates them —
    // deliberately, and nothing else about them differs.
    const [mini, laser] = GUNS;
    expect(laser.damage).toBe(mini.damage);
    expect(laser.cooldownTicks).toBe(mini.cooldownTicks);
    expect(laser.range).toBeGreaterThan(mini.range);
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

  test("concussion beam (heavy hitscan) spends heavy ammo", () => {
    // It sat in the Special slot until the original's table said otherwise
    // (`Beam Cannon`, id 0x12 — a Heavy). Moving it changes which button fires it
    // and which ammo pool it draws from, which is what this pins.
    const map = getMapById("test-128");
    const sim = createSim(map, 3, { loadouts: [{ gun: 0, heavy: 3, special: 0 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoA[id];
    expect(HEAVIES[3].name).toBe("Concussion Beam");
    expect(before).toBe(HEAVIES[3].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[id]).toBe(before - 1);
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

  test("electric gun is ammo-free hitscan at catalog id 9", () => {
    const map = getMapById("test-128");
    expect(GUNS[3].name).toBe("Electric Gun");
    const sim = createSim(map, 5, { loadouts: [{ gun: 3, heavy: 0, special: 0 }] });
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE1;
    step(sim, inputs);
    let found = false;
    for (let i = 0; i < sim.events.count; i++) {
      const o = i * 4;
      if (sim.events.data[o] === 1 /* EV_SHOT */ && sim.events.data[o + 3] === 9) found = true;
    }
    expect(found).toBe(true);
  });

  test("hyper velocity rocket spends heavy ammo", () => {
    const map = getMapById("test-128");
    expect(HEAVIES[4].name).toBe("Hyper Velocity Rocket");
    const sim = createSim(map, 6, { loadouts: [{ gun: 0, heavy: 4, special: 0 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoA[id];
    expect(before).toBe(HEAVIES[4].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[id]).toBe(before - 1);
  });

  test("fusion torpedo spends heavy ammo", () => {
    const map = getMapById("test-128");
    expect(HEAVIES[5].name).toBe("Fusion Torpedo");
    const sim = createSim(map, 7, { loadouts: [{ gun: 0, heavy: 5, special: 0 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoA[id];
    expect(before).toBe(HEAVIES[5].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[id]).toBe(before - 1);
  });

  test("grenade launcher spends special ammo", () => {
    const map = getMapById("test-128");
    expect(SPECIALS[2].name).toBe("Grenade Launcher");
    const sim = createSim(map, 8, { loadouts: [{ gun: 0, heavy: 0, special: 2 }] });
    const id = sim.avatarId[0];
    const before = sim.ent.ammoB[id];
    expect(before).toBe(SPECIALS[2].ammo);
    const inputs = createTickInputs();
    inputs.players[0].aimX = 127;
    inputs.players[0].buttons = BUTTON_FIRE3;
    step(sim, inputs);
    expect(sim.ent.ammoB[id]).toBe(before - 1);
  });
});
