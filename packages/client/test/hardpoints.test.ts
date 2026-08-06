// Hardpoint cycling for the weapons screen. Pure, so it runs without a DOM.
//
// The slot lengths differ (4 guns, 3 heavies, 3 specials) and that asymmetry is
// the whole risk here: a shared modulo would silently fit the wrong weapon.

import { describe, expect, test } from "bun:test";
import { GUNS, HEAVIES, SPECIALS } from "@metropolis/sim";
import {
  cycleHardpoint,
  fittedWeapons,
  HARDPOINTS,
  loadoutSummary,
  stepHardpoint,
  weaponBarFractions,
} from "../src/menu/hardpoints";
import { weaponArtSlug, weaponIconUrl, weaponPanelUrl } from "../src/menu/weaponArt";

const KIT = { gun: 0, heavy: 0, special: 0 };

describe("HARDPOINTS", () => {
  test("is the original's slot order and carries the real catalogs", () => {
    expect(HARDPOINTS.map((h) => h.label)).toEqual(["Gun", "Heavy", "Special"]);
    expect(HARDPOINTS[0].list).toBe(GUNS);
    expect(HARDPOINTS[1].list).toBe(HEAVIES);
    expect(HARDPOINTS[2].list).toBe(SPECIALS);
  });
});

describe("cycleHardpoint", () => {
  test("steps forward within a slot and leaves the others alone", () => {
    expect(cycleHardpoint(KIT, 0, 1)).toEqual({ gun: 1, heavy: 0, special: 0 });
    expect(cycleHardpoint(KIT, 1, 1)).toEqual({ gun: 0, heavy: 1, special: 0 });
    expect(cycleHardpoint(KIT, 2, 1)).toEqual({ gun: 0, heavy: 0, special: 1 });
  });

  test("wraps at the end of each slot, using that slot's own length", () => {
    const lastGun = { ...KIT, gun: GUNS.length - 1 };
    expect(cycleHardpoint(lastGun, 0, 1).gun).toBe(0);
    const lastHeavy = { ...KIT, heavy: HEAVIES.length - 1 };
    expect(cycleHardpoint(lastHeavy, 1, 1).heavy).toBe(0);
    const lastSpecial = { ...KIT, special: SPECIALS.length - 1 };
    expect(cycleHardpoint(lastSpecial, 2, 1).special).toBe(0);
  });

  test("wraps backwards from the first option to the last", () => {
    // JS % keeps the dividend's sign, so this is where a naive modulo yields -1
    // and the screen renders `undefined`.
    expect(cycleHardpoint(KIT, 0, -1).gun).toBe(GUNS.length - 1);
    expect(cycleHardpoint(KIT, 1, -1).heavy).toBe(HEAVIES.length - 1);
    expect(cycleHardpoint(KIT, 2, -1).special).toBe(SPECIALS.length - 1);
  });

  test("a full cycle through any slot returns to where it started", () => {
    for (let h = 0; h < 3; h++) {
      const hardpoint = h as 0 | 1 | 2;
      let kit = KIT;
      for (let i = 0; i < HARDPOINTS[h].list.length; i++) {
        kit = cycleHardpoint(kit, hardpoint, 1);
      }
      expect(kit).toEqual(KIT);
    }
  });

  test("every reachable index resolves to a real weapon", () => {
    for (let h = 0; h < 3; h++) {
      const spec = HARDPOINTS[h];
      let kit = KIT;
      for (let i = 0; i < spec.list.length * 2 + 1; i++) {
        kit = cycleHardpoint(kit, h as 0 | 1 | 2, 1);
        expect(spec.list[kit[spec.key]]).toBeDefined();
      }
    }
  });
});

describe("stepHardpoint", () => {
  test("moves one slot at a time", () => {
    expect(stepHardpoint(0, 1)).toBe(1);
    expect(stepHardpoint(1, 1)).toBe(2);
    expect(stepHardpoint(2, -1)).toBe(1);
  });

  test("clamps instead of wrapping — the rack has a top and a bottom", () => {
    expect(stepHardpoint(0, -1)).toBe(0);
    expect(stepHardpoint(2, 1)).toBe(2);
  });
});

describe("loadoutSummary", () => {
  test("names all three fitted weapons in slot order", () => {
    expect(loadoutSummary(KIT)).toBe(`${GUNS[0].name} · ${HEAVIES[0].name} · ${SPECIALS[0].name}`);
  });
});

describe("weaponBarFractions", () => {
  test("anchors rate and damage within the slot", () => {
    // Index-0 gun is the slot's rate floor (shortest cooldown among equals) and
    // a low damage bar relative to the flamethrower / electric.
    const mini = weaponBarFractions(GUNS[0], GUNS);
    expect(mini.rate).toBe(1);
    expect(mini.damage).toBeLessThan(1);
    const flame = weaponBarFractions(GUNS[2], GUNS);
    expect(flame.damage).toBeGreaterThan(mini.damage);
  });

  test("stays in [0, 1]", () => {
    for (const list of [GUNS, HEAVIES, SPECIALS]) {
      for (const w of list) {
        const b = weaponBarFractions(w, list);
        expect(b.rate).toBeGreaterThanOrEqual(0);
        expect(b.rate).toBeLessThanOrEqual(1);
        expect(b.damage).toBeGreaterThanOrEqual(0);
        expect(b.damage).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("fittedWeapons", () => {
  test("returns the three catalog entries for a loadout", () => {
    const fitted = fittedWeapons({ gun: 1, heavy: 0, special: 2 });
    expect(fitted[0]).toBe(GUNS[1]);
    expect(fitted[1]).toBe(HEAVIES[0]);
    expect(fitted[2]).toBe(SPECIALS[2]);
  });
});

describe("weaponArt", () => {
  test("slugs every catalog name to a stable icon/panel path", () => {
    expect(weaponArtSlug("Powered Mini-Gun")).toBe("powered-mini-gun");
    expect(weaponArtSlug("Hell Fire 2000")).toBe("hell-fire-2000");
    expect(weaponArtSlug("Pop-Up Mines")).toBe("pop-up-mines");
    for (const w of [...GUNS, ...HEAVIES, ...SPECIALS]) {
      expect(weaponIconUrl(w.name)).toBe(`/ui/weapons/icons/${weaponArtSlug(w.name)}.png`);
      expect(weaponPanelUrl(w.name)).toBe(`/ui/weapons/panels/${weaponArtSlug(w.name)}.png`);
    }
  });
});
