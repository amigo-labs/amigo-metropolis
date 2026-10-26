// Every body's reference point (map.ts MapData.refHeights, sim.ts
// entityRefHeight): what the original aims at and measures to, its model's
// box-0 centre placed unshifted over its position (math_matrix_place_point
// 0x00458850), so a few centimetres; MUZZLE_HEIGHT where an arena imports none.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { MUZZLE_HEIGHT } from "../src/balance";
import { getMapById, TEST_MAP_ID } from "../src/map";
import { createSim, entityRefHeight, MODE_HOVER } from "../src/sim";

describe("reference heights", () => {
  it("are the models' box-0 centre y, 1/512 units read as world units", () => {
    const map = getMapById("la-cantina");
    // Mp: the X1's legs at the walker's frame and the hover's (Cobj 15).
    expect(map.refHeights.walker).toBe(189 / 8192);
    expect(map.refHeights.hover).toBe(88 / 8192);
    // A box can sit below its model's origin: Mp's tank.
    expect(map.refHeights.tank).toBe(-4 / 8192);
    expect(map.refHeights.neutral.length).toBe(map.turretSpots.length);
    expect(map.refHeights.skyCaptain.length).toBe(10);
  });

  it("follow the mech's form, and stand at the muzzle's height on a map with none", () => {
    const sim = createSim(getMapById("la-cantina"), 1);
    const a = sim.avatarId[0];
    expect(sim.ent.archetype[a]).toBe(ARCHETYPE.AVATAR);
    sim.ent.mode[a] = 0;
    expect(entityRefHeight(sim, a)).toBe(189 / 8192);
    sim.ent.mode[a] = MODE_HOVER;
    expect(entityRefHeight(sim, a)).toBe(88 / 8192);
    const test = createSim(getMapById(TEST_MAP_ID), 1);
    expect(entityRefHeight(test, test.avatarId[0])).toBe(MUZZLE_HEIGHT);
  });
});
