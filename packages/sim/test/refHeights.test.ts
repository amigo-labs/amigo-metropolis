// Every body's reference point (map.ts MapData.refHeights, sim.ts
// entityRefHeight): what the original aims at and measures to, its model's
// box-0 centre placed through the orientation (math_matrix_place_point
// 0x00458850: `(M * src) >> 12` with M in 16.16, so the box's 1/512 m units as
// metres; a turret's gun from its base's attach point 0); MUZZLE_HEIGHT where
// an arena imports none. Until SIM_VERSION 109 the halfword was read as one
// world unit, 1/16 of this.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { MUZZLE_HEIGHT } from "../src/balance";
import { getMapById, TEST_MAP_ID } from "../src/map";
import { createSim, entityRefHeight } from "../src/sim";

describe("reference heights", () => {
  it("are the models' box-0 centre y, 1/512 m units", () => {
    const map = getMapById("la-cantina");
    // Mp: the X1's legs at the walker's frame and the hover's (Cobj 15).
    expect(map.refHeights.walker).toBe(189 / 512);
    expect(map.refHeights.hover).toBe(88 / 512);
    // Mp's tank: its box's centre sits just below its model's origin, which the
    // client draws grounded, 0.207031 m over the position (gen:units' lift).
    expect(map.refHeights.tank).toBeCloseTo(0.207031 - 4 / 512, 4);
    expect(map.shapes.tank?.ly).toBe(0.207031);
    // A type-8 turret's gun (Cobj 20, centre 193) on its base's point 0
    // (Cobj 21, 0.337891 m up).
    expect(map.refHeights.baseTurret).toBeCloseTo(0.337891 + 193 / 512, 4);
    expect(map.refHeights.neutral.length).toBe(map.turretSpots.length);
    expect(map.refHeights.skyCaptain.length).toBe(10);
  });

  it("follow the mech's legs' frame, and stand at the muzzle's height on a map with none", () => {
    const sim = createSim(getMapById("la-cantina"), 1);
    const a = sim.avatarId[0];
    expect(sim.ent.archetype[a]).toBe(ARCHETYPE.AVATAR);
    sim.walker.legs.frame[0] = 0;
    expect(entityRefHeight(sim, a)).toBe(189 / 512);
    sim.walker.legs.frame[0] = 359;
    expect(entityRefHeight(sim, a)).toBe(88 / 512);
    // The crouch lowers it with the legs (track 3).
    sim.walker.legs.frame[0] = 220;
    expect(entityRefHeight(sim, a)).toBe(152 / 512);
    const test = createSim(getMapById(TEST_MAP_ID), 1);
    expect(entityRefHeight(test, test.avatarId[0])).toBe(MUZZLE_HEIGHT);
  });
});
