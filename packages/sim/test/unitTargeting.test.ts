// How PA units pick what to shoot and what to fly at (SIM_VERSION 45;
// fcop-fidelity.md U1/U2's targeting and I2; fcop-re/ranges-turrets-capture.md
// Q3, fcop-re/ai-and-rules.md §4, camera-and-movement.md "Aircraft").
//
// - Every unit's shooter is the original's: it keeps a target while it lives,
//   stays hostile and stays in its 12 m reach, and searches for another only on
//   its targeting delay (2.0 s for the tank and the jet, 1.0 s for the
//   Dreadnought and the Fortress). Until v44 a unit re-picked the nearest enemy
//   in reach every tick.
// - A jet or Flying Fortress is the original's aircraft: it searches every
//   3.0-4.7 s for the nearest enemy within its detection range (56 / 63.2 m),
//   flies at it inside its patrol leash, circles inside the 1 m standoff instead
//   of stopping, and fires only while engaging.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  FORTRESS_DETECT_RANGE,
  GUARDIAN_AIRCRAFT_SPEED,
  GUARDIAN_DETECT_RANGE,
  GUARDIAN_LEASH_X,
} from "../src/balance";
import { segmentBlocked } from "../src/collision";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";

const map = getMapById(LA_CANTINA_ID);
const idle = createTickInputs();

/** A team-0 Runner held still somewhere with clear lines 5 m east and 8 m west. */
function heldRunner(): { state: SimState; r: number; x: number; y: number } {
  const state = createSim(map, 1);
  const ent = state.ent;
  const nodes = map.laneGraph?.nodes ?? [];
  for (const n of nodes) {
    if (segmentBlocked(map, n.x, n.y, n.x + 5, n.y)) continue;
    if (segmentBlocked(map, n.x, n.y, n.x - 8, n.y)) continue;
    const r = spawnUnit(state, ARCHETYPE.RUNNER, 0, n.x, n.y);
    ent.timerA[r] = -1; // halted where it stands: this file is about its gun
    ent.hp[r] = 1e6;
    return { state, r, x: n.x, y: n.y };
  }
  throw new Error("no open node on la-cantina");
}

describe("a PA unit's shooter keeps its target and re-searches on its delay", () => {
  it("keeps a target that stays valid even when a nearer enemy arrives", () => {
    const { state, r, x, y } = heldRunner();
    const ent = state.ent;
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    const park = () => {
      ent.posX[foe] = x - 8;
      ent.posY[foe] = y;
    };
    park();
    step(state, idle);
    expect(ent.cooldownC[r] - 1).toBe(foe);
    // A team-1 Runner pulls up 5 m away, nearer than the avatar. Held still.
    const near = spawnUnit(state, ARCHETYPE.RUNNER, 1, x + 5, y);
    ent.timerA[near] = -1;
    ent.hp[near] = 1e6;
    for (let t = 0; t < 150; t++) {
      park();
      step(state, idle);
      expect(ent.cooldownC[r] - 1).toBe(foe);
    }
  });

  it("finds a new target only a full 2.0 s search period after losing one", () => {
    const { state, r, x, y } = heldRunner();
    const ent = state.ent;
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    ent.posX[foe] = x - 8;
    ent.posY[foe] = y;
    step(state, idle); // tick 0: found at once, the search clock reloads to 601
    expect(ent.cooldownC[r] - 1).toBe(foe);
    // It leaves; an enemy Runner is in reach from the same tick on.
    const near = spawnUnit(state, ARCHETYPE.RUNNER, 1, x + 5, y);
    ent.timerA[near] = -1;
    ent.hp[near] = 1e6;
    let found = -1;
    for (let k = 1; k < 200 && found < 0; k++) {
      ent.posX[foe] = x - 40;
      step(state, idle);
      if (ent.cooldownC[r] - 1 === near) found = k;
    }
    // The tank's round falls due 30 ticks after the first (1.0 s refire) and drops
    // the lost target; the countdown then runs 601 units = 61 ticks down while the
    // round waits. The old every-tick nearest pick switched at once.
    expect(found).toBeGreaterThanOrEqual(85);
    expect(found).toBeLessThanOrEqual(95);
  });
});

describe("a PA jet is the original's aircraft", () => {
  function jetWith(dx: number, dy: number, archetype: number = ARCHETYPE.GUARDIAN) {
    const state = createSim(map, 5);
    const ent = state.ent;
    const c = map.bases[0].airConsole;
    const g = spawnUnit(state, archetype, 0, c.x, c.y);
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    const park = () => {
      ent.posX[foe] = c.x + dx;
      ent.posY[foe] = c.y + dy;
    };
    park();
    return { state, ent, g, foe, park, c };
  }

  it("flies at a target inside its leash and circles it without ever stopping", () => {
    const { state, ent, g, foe, park } = jetWith(10, 6);
    let near = 0;
    for (let t = 0; t < 30 * 20; t++) {
      park();
      step(state, idle);
      const v = Math.hypot(ent.velX[g], ent.velY[g]);
      expect(v).toBeCloseTo(GUARDIAN_AIRCRAFT_SPEED, 5);
      if (t > 30 * 6) {
        const d = Math.hypot(ent.posX[g] - ent.posX[foe], ent.posY[g] - ent.posY[foe]);
        if (d < 4) near += 1;
      }
    }
    expect(ent.ammoB[g] - 1).toBe(foe);
    expect(near / (30 * 14)).toBeGreaterThan(0.9);
  });

  it("stays on its leash chasing a target outside it", () => {
    // 50 m east: inside the jet's 56 m detection, far outside its ±24 m leash.
    const { state, ent, g, park, c } = jetWith(50, 0);
    let maxDx = 0;
    for (let t = 0; t < 30 * 60; t++) {
      park();
      step(state, idle);
      maxDx = Math.max(maxDx, Math.abs(ent.posX[g] - c.x));
    }
    expect(ent.ammoB[g]).toBeGreaterThan(0); // it holds the target...
    expect(maxDx).toBeLessThan(GUARDIAN_LEASH_X + 0.5); // ...and never chases it off the leash
  });

  it("detects at 56 m (jet) and 63.2 m (Flying Fortress)", () => {
    expect(GUARDIAN_DETECT_RANGE).toBe(56);
    expect(FORTRESS_DETECT_RANGE).toBeCloseTo(63.2, 1);
    const jet = jetWith(60, 0);
    jet.state.ent.posX[jet.foe] = jet.ent.posX[jet.g] + 60;
    step(jet.state, idle);
    expect(jet.ent.ammoB[jet.g]).toBe(0);
    const fort = jetWith(60, 0, ARCHETYPE.FORTRESS);
    fort.state.ent.posX[fort.foe] = fort.ent.posX[fort.g] + 60;
    step(fort.state, idle);
    expect(fort.ent.ammoB[fort.g] - 1).toBe(fort.foe);
  });
});
