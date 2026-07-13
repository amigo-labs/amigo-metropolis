// Layered movement: entLayer state, avatar transitions, per-deck unit rules.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { spawn } from "../src/entities";
import { createSim, createTickInputs, getMapById, hash, step } from "../src/index";
import { DISTRICT_01_ID, LAYERED_TEST_ID } from "../src/map";
import { separateGroundUnits, snapUnitHeight } from "../src/units";

function drive(
  sim: ReturnType<typeof createSim>,
  moveX: number,
  moveY: number,
  ticks: number,
): void {
  const inputs = createTickInputs();
  for (let t = 0; t < ticks; t++) {
    inputs.players[0].moveX = moveX;
    inputs.players[0].moveY = moveY;
    step(sim, inputs);
  }
}

describe("entLayer state", () => {
  it("exists, sized to the entity cap, zeroed at start", () => {
    const sim = createSim(getMapById(DISTRICT_01_ID), 1);
    expect(sim.ent.entLayer.length).toBeGreaterThan(0);
    let sum = 0;
    for (const v of sim.ent.entLayer) sum += v;
    expect(sum).toBe(0);
  });

  it("does NOT change the hash on a single-story map (No-op invariant)", () => {
    const sim = createSim(getMapById(DISTRICT_01_ID), 1);
    const before = hash(sim);
    sim.ent.entLayer[0] = 2; // poke a layer byte
    expect(hash(sim)).toBe(before); // single-story → entLayer not hashed
  });

  it("DOES change the hash on a layered map", () => {
    const sim = createSim(getMapById(LAYERED_TEST_ID), 1);
    const id = sim.avatarId[0];
    const before = hash(sim);
    sim.ent.entLayer[id] = 1;
    expect(hash(sim)).not.toBe(before);
  });
});

describe("avatar layer transitions (layered-test)", () => {
  it("walks up the ramp onto the mid deck (layer 1, ~3 m)", () => {
    const sim = createSim(getMapById(LAYERED_TEST_ID), 1);
    expect(sim.ent.entLayer[sim.avatarId[0]]).toBe(0);
    // spawn at (2,2); layer 1 ramp rises with +x (cols 2..5: 0→3 m). Drive east.
    drive(sim, 127, 0, 120);
    expect(sim.ent.entLayer[sim.avatarId[0]]).toBe(1);
    expect(sim.ent.height[sim.avatarId[0]]).toBeGreaterThan(2.5);
  });

  it("stays on the base layer on flat ground west of the ramp", () => {
    const sim = createSim(getMapById(LAYERED_TEST_ID), 1);
    drive(sim, -127, 0, 6); // west, toward the map edge on flat ground
    expect(sim.ent.entLayer[sim.avatarId[0]]).toBe(0);
    expect(sim.ent.height[sim.avatarId[0]]).toBeCloseTo(0, 1);
  });
});

describe("units are layer-aware and separate per deck", () => {
  it("a ground unit over the mid deck snaps to the deck height and layer 1", () => {
    const sim = createSim(getMapById(LAYERED_TEST_ID), 1);
    const id = spawn(sim.ent, ARCHETYPE.RUNNER, 0);
    sim.ent.posX[id] = 12; // over the mid deck (layer 1 present, ~3 m)
    sim.ent.posY[id] = 14;
    sim.ent.height[id] = 3; // near deck height so it is reachable
    snapUnitHeight(sim, id, false);
    expect(sim.ent.entLayer[id]).toBe(1);
    expect(sim.ent.height[id]).toBeCloseTo(3.0, 1);
  });

  it("friendly units on DIFFERENT decks are not pushed apart", () => {
    const sim = createSim(getMapById(LAYERED_TEST_ID), 1);
    const a = spawn(sim.ent, ARCHETYPE.RUNNER, 0);
    const b = spawn(sim.ent, ARCHETYPE.RUNNER, 0);
    // same (x,y): one on the deck (layer 1), one on the roof (layer 2)
    sim.ent.posX[a] = 12;
    sim.ent.posY[a] = 12;
    sim.ent.height[a] = 3;
    sim.ent.entLayer[a] = 1;
    sim.ent.posX[b] = 12;
    sim.ent.posY[b] = 12;
    sim.ent.height[b] = 6;
    sim.ent.entLayer[b] = 2;
    separateGroundUnits(sim);
    expect(sim.ent.posX[a]).toBe(12); // different layers → no push
    expect(sim.ent.posX[b]).toBe(12);
  });

  it("friendly units on the SAME deck ARE pushed apart", () => {
    const sim = createSim(getMapById(LAYERED_TEST_ID), 1);
    const a = spawn(sim.ent, ARCHETYPE.RUNNER, 0);
    const b = spawn(sim.ent, ARCHETYPE.RUNNER, 0);
    sim.ent.posX[a] = 12;
    sim.ent.posY[a] = 12;
    sim.ent.height[a] = 3;
    sim.ent.entLayer[a] = 1;
    sim.ent.posX[b] = 12;
    sim.ent.posY[b] = 12;
    sim.ent.height[b] = 3;
    sim.ent.entLayer[b] = 1;
    separateGroundUnits(sim);
    // exactly stacked on one deck → split along +x by id order
    expect(sim.ent.posX[b]).toBeGreaterThan(sim.ent.posX[a]);
  });
});
