// The contact sweep (sim contact.ts; fcop-fidelity.md G1, I6, P4): a round
// meets a body as the original's `cact_pair_test` 0x00450190 decides -- the
// spheres about the two reference points, the coarse cylinder, then the hit
// boxes both ways round -- on the arena's own models, the round's own included.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { octagonalNorm, roundContact, X1_COCKPIT_SHAPE, X1_LEGS_SHAPE } from "../src/contact";
import { spawn } from "../src/entities";
import { getMapById, LA_CANTINA_ID, type MapData, TEST_MAP_ID } from "../src/map";
import { createSim, type SimState, spawnUnit } from "../src/sim";

/** A round of world weapon `weapon` (its arena's model) at (x, y, h), flying along +x. */
function round(state: SimState, weapon: number, x: number, y: number, h: number): number {
  const id = spawn(state.ent, ARCHETYPE.PROJECTILE, 1);
  state.ent.posX[id] = x;
  state.ent.posY[id] = y;
  state.ent.height[id] = h;
  state.ent.shape[id] = state.map.shapes.worldRounds[weapon];
  return id;
}

const at = (_map: MapData) => ({ x: 120, y: 120 });

describe("the octagon", () => {
  it("is cact_octagonal_norm's two regimes", () => {
    expect(octagonalNorm(3, 0)).toBe(3);
    expect(octagonalNorm(0, -4)).toBe(4);
    // Below the joint: max + 0.234375 min.
    expect(octagonalNorm(4, 2)).toBe(4 + 2 * 0.234375);
    // On the diagonal: (75 + 106) / 128, sqrt(2) to four places.
    expect(octagonalNorm(1, 1)).toBe(181 / 128);
  });
});

describe("a round against a body", () => {
  it("meets the walker's legs and its cockpit, which stands on the legs' point 0", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const a = state.avatarId[0];
    const { x, y } = at(state.map);
    ent.posX[a] = x;
    ent.posY[a] = y;
    ent.height[a] = 0;
    ent.yaw[a] = 0;
    state.walker.legs.frame[0] = 0;
    state.walker.cockpit.frame[0] = 0;
    // Weapon 1, the tank's round: a 1.02 m segment along its flight, radius 0.51 m.
    const r = round(state, 1, x - 0.3, y, 0.3);
    expect(roundContact(state, r, a, 1, 0, 0)).toBe(1);
    // Over the legs' box (0.74 m) but inside the cockpit's on the legs' point 0
    // (0.74 m up, its box 0.18 m deep about 0.02 m): the partner's own sphere.
    ent.height[r] = 0.85;
    expect(roundContact(state, r, a, 1, 0, 0)).toBe(1);
    // Over the cockpit too.
    ent.height[r] = 1.2;
    expect(roundContact(state, r, a, 1, 0, 0)).toBe(0);
    // Beside it, 0.8 m off its flank: the old flat circle (0.553 + 0.5) took it.
    ent.height[r] = 0.3;
    ent.posY[r] = y + 0.8;
    expect(roundContact(state, r, a, 1, 0, 0)).toBe(0);
  });

  it("follows the legs' frame: the crouch lowers the mech under a round the stand meets", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const a = state.avatarId[0];
    const { x, y } = at(state.map);
    ent.posX[a] = x;
    ent.posY[a] = y;
    ent.height[a] = 0;
    ent.yaw[a] = 0;
    state.walker.cockpit.frame[0] = 0;
    // Just over the crouched cockpit's top, inside the standing one's.
    const r = round(state, 2, x - 0.3, y, 0.85);
    state.walker.legs.frame[0] = 0;
    expect(roundContact(state, r, a, 1, 0, 0)).toBe(1);
    state.walker.legs.frame[0] = 225; // the crouch's last frame (track 3)
    expect(roundContact(state, r, a, 1, 0, 0)).toBe(0);
    // The tables are the shipped Cobjs': the legs' box top 378 -> 300.
    const top = (f: number) =>
      (X1_LEGS_SHAPE.boxes[f * 8 + 1] + X1_LEGS_SHAPE.boxes[f * 8 + 4]) * 512;
    expect(top(0)).toBe(378);
    expect(top(225)).toBe(300);
    expect(X1_COCKPIT_SHAPE.frames).toBe(30);
  });

  it("turns the tank's box with its hull's yaw: long ahead, narrow abeam", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const { x, y } = at(state.map);
    const tank = spawnUnit(state, ARCHETYPE.RUNNER, 0, x, y);
    ent.height[tank] = 0;
    // Weapon 2's round (Cobj 13: a disc 0.02 m across) 0.62 m to the side, at
    // the box's middle height, flying past along +x.
    const r = round(state, 2, x, y + 0.62, 0.2);
    // Its hull's matrix (route.ts orient), its box's middle 0.2 m up.
    ent.height[tank] = 0.207;
    state.route.hullPitch[tank] = 0;
    state.route.hullBank[tank] = 0;
    // Facing +x the tank is 1.05 m wide (0.52 a side): the round passes.
    state.route.hullYaw[tank] = 0;
    expect(roundContact(state, r, tank, 1, 0, 0)).toBe(0);
    // Facing +y its 1.52 m length reaches out to it.
    state.route.hullYaw[tank] = 1024;
    expect(roundContact(state, r, tank, 1, 0, 0)).toBe(1);
    // The entity's own yaw (the cursor's, which its shooter turns) is not it.
    ent.yaw[tank] = 0;
    expect(roundContact(state, r, tank, 1, 0, 0)).toBe(1);
  });

  it("measures from the model's origin: a route follower's position is its origin", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const { x, y } = at(state.map);
    const tank = spawnUnit(state, ARCHETYPE.RUNNER, 0, x, y);
    ent.height[tank] = 0;
    state.route.hullYaw[tank] = 0;
    state.route.hullPitch[tank] = 0;
    state.route.hullBank[tank] = 0;
    // Its box spans -0.207..0.19 m about its origin (Cobj 30's box 0).
    const r = round(state, 2, x, y, 0.15);
    expect(roundContact(state, r, tank, 0, 1, 0)).toBe(1);
    ent.height[r] = 0.25;
    expect(roundContact(state, r, tank, 0, 1, 0)).toBe(0);
    ent.height[r] = -0.15;
    expect(roundContact(state, r, tank, 0, 1, 0)).toBe(1);
  });

  it("meets a neutral turret's gun on its base's point 0, a metre up", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const t = state.neutralTurretEntity[0];
    const { x, y } = { x: ent.posX[t], y: ent.posY[t] };
    const h = ent.height[t];
    ent.yaw[t] = ent.restYaw[t];
    // Mp's base (Cobj 32) stands 0..1.0 m; its gun (31) on its point 0, 1.03..1.62 m.
    const r = round(state, 2, x - 0.3, y, h + 1.4);
    expect(roundContact(state, r, t, 1, 0, 0)).toBe(1);
    ent.height[r] = h + 0.5;
    expect(roundContact(state, r, t, 1, 0, 0)).toBe(1);
    ent.height[r] = h + 1.8;
    expect(roundContact(state, r, t, 1, 0, 0)).toBe(0);
  });

  it("leaves a body or round with no imported model to the flat circle", () => {
    const state = createSim(getMapById(TEST_MAP_ID), 1);
    const r = round(state, 1, 10, 10, 0);
    expect(state.ent.shape[r]).toBe(-1);
    expect(roundContact(state, r, state.avatarId[0], 1, 0, 0)).toBe(-1);
  });
});
