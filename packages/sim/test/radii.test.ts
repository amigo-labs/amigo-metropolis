// Every body's hit radius is the original's (SIM_VERSION 78; fcop-fidelity.md
// G1): an actor's radius_68, its own model's 3DBB box for the frame it holds,
// raw / 512 m — read per arena from its own mission's models
// (tools/generators/fcop/<mission>-models.json, MapData.radii) and picked per
// body by sim.ts entityRadius -- the mech's by its legs' frame (SIM_VERSION 109).

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { ARCHETYPE_RADIUS, AVATAR_HOVER_RADIUS, SKY_RADIUS } from "../src/balance";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID, sampleHeight } from "../src/map";
import {
  createSim,
  entityRadius,
  hitscan,
  MODE_HOVER,
  MODE_WALKER,
  spawnUnit,
  step,
} from "../src/sim";

const raw = (v: number) => v / 512;

describe("the arenas' radii", () => {
  it("carry each mission's own models", () => {
    const lc = getMapById(LA_CANTINA_ID).radii;
    expect(lc.walker).toBe(raw(283));
    expect(lc.hover).toBe(raw(232));
    expect(lc.tank).toBe(raw(483));
    expect(lc.dreadnought).toBe(raw(663));
    expect(lc.baseTurret).toBe(raw(333));
    expect(new Set(lc.neutral)).toEqual(new Set([raw(463)]));
    expect(lc.skyCaptain).toEqual([671, 671, 671, 952, 952, 952, 994, 994, 994, 1155].map(raw));
    // Mp's are the defaults.
    expect(lc.walker).toBe(ARCHETYPE_RADIUS[ARCHETYPE.AVATAR]);
    expect(lc.hover).toBe(AVATAR_HOVER_RADIUS);
    expect(lc.skyCaptain).toEqual(SKY_RADIUS);
    // Joke's bugs, and its Sky Captain.
    const joke = getMapById("bug-hunt").radii;
    expect([joke.tank, joke.jet, joke.fortress, joke.dreadnought]).toEqual(
      [369, 286, 603, 757].map(raw),
    );
    expect(joke.skyCaptain).toEqual([903, 903, 903, 903, 903, 903, 903, 903, 903, 755].map(raw));
    // Hk's own tank, its second neutral set, its Sky Captains.
    const hk = getMapById("hollywood-keys").radii;
    expect(hk.tank).toBe(raw(646));
    expect(new Set(hk.neutral)).toEqual(new Set([raw(443), raw(463)]));
    expect(hk.skyCaptain).toEqual([812, 812, 812, 1009, 1009, 1009, 994, 994, 994, 994].map(raw));
  });
});

describe("entityRadius", () => {
  it("gives the mech its legs' frame's, and every spawn its arena's model", () => {
    const state = createSim(getMapById("hollywood-keys"), 1, {
      wardenPlayer: 1,
      wardenDifficulty: 10,
    });
    const r = state.map.radii;
    const a = state.avatarId[0];
    // The walker's pose (frame 0) and the hover's (359) are the two poses'
    // radii; the crouch's frames (track 3, 212-225) fold the legs to 250.
    state.walker.legs.frame[0] = 0;
    expect(entityRadius(state, a)).toBe(r.walker);
    state.walker.legs.frame[0] = 359;
    expect(entityRadius(state, a)).toBe(r.hover);
    state.walker.legs.frame[0] = 220;
    expect(entityRadius(state, a)).toBe(raw(250));
    // The form alone moves nothing: the frame is the radius.
    state.ent.mode[a] = MODE_HOVER;
    state.walker.legs.frame[0] = 0;
    expect(entityRadius(state, a)).toBe(r.walker);
    expect(entityRadius(state, state.avatarId[1])).toBe(r.skyCaptain[9]);
    const tank = spawnUnit(state, ARCHETYPE.RUNNER, 0, 120, 120);
    expect(entityRadius(state, tank)).toBe(raw(646));
    for (let k = 0; k < state.neutralTurretEntity.length; k++) {
      expect(entityRadius(state, state.neutralTurretEntity[k])).toBe(r.neutral[k]);
    }
    expect(entityRadius(state, state.baseTurretEntity[0])).toBe(r.baseTurret);
  });

  it("is what the hit tests measure: a ray 0.5 m off hits the walker, misses the hover", () => {
    const X = 152;
    const Y = 128;
    for (const [mode, hit] of [
      [MODE_WALKER, true],
      [MODE_HOVER, false],
    ] as const) {
      const state = createSim(getMapById(LA_CANTINA_ID), 3);
      const ent = state.ent;
      const foe = state.avatarId[0];
      const me = state.avatarId[1];
      ent.posX[foe] = X;
      ent.posY[foe] = Y;
      ent.height[foe] = sampleHeight(state.map, X, Y);
      ent.mode[foe] = mode;
      // The legs' frame is the radius (the walker's 0, the hover's 359).
      state.walker.legs.frame[0] = mode === MODE_HOVER ? 359 : 0;
      ent.posX[me] = X - 6;
      ent.posY[me] = Y + 0.5;
      ent.height[me] = sampleHeight(state.map, X - 6, Y + 0.5);
      const hp = ent.hp[foe];
      hitscan(state, me, 1, 1, 0, 12, 10);
      expect(ent.hp[foe] < hp).toBe(hit);
      step(state, createTickInputs());
    }
  });
});
