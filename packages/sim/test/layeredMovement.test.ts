// Layered movement: entLayer state, avatar transitions, per-deck unit rules.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { crossesWallX, segmentBlocked } from "../src/collision";
import { spawn } from "../src/entities";
import { createSim, createTickInputs, getMapById, hash, step } from "../src/index";
import { DISTRICT_01_ID, LAYERED_TEST_ID, loadMapFromJson, type MapJson } from "../src/map";
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

describe("per-deck wall collision (issue #29)", () => {
  // The point of a lattice per deck: a bridge's parapet stops you ON the bridge
  // and not on the road it spans. Built on `tiny()`-style raw JSON rather than the
  // committed arenas so the geometry is unambiguous — one deck, one wall bit.
  function twoStorey(deckWall: boolean): MapJson {
    const size = 4;
    return {
      id: "t",
      size,
      cellSize: 1,
      waterLevel: -10,
      // Ground flat at 0, deck flat at 2 m (64 quanta) over the whole grid.
      heights: Array.from({ length: size }, () => Array.from({ length: size }, () => 0)),
      water: Array.from({ length: size }, () => "0".repeat(size)),
      wallsV: Array.from({ length: size }, () => "0".repeat(size)),
      wallsH: Array.from({ length: size }, () => "0".repeat(size)),
      layers: [
        {
          heights: Array.from({ length: size }, () => Array.from({ length: size }, () => 64)),
          mask: Array.from({ length: size }, () => "1".repeat(size)),
          // Block the x = 2 line in every row, on the DECK only.
          wallsV: deckWall
            ? Array.from({ length: size }, () => "0010")
            : Array.from({ length: size }, () => "0".repeat(size)),
          wallsH: Array.from({ length: size }, () => "0".repeat(size)),
        },
      ],
      spawns: [
        { x: 0, y: 0, yaw: 0 },
        { x: 3, y: 3, yaw: 0 },
      ],
      basePlots: [
        { x: 0, y: 0, radius: 1 },
        { x: 3, y: 3, radius: 1 },
      ],
      bases: [
        {
          gate: { x: 0, y: 1, radius: 1 },
          core: [0, 0],
          groundConsole: [0, 0],
          airConsole: [0, 0],
          pad: { x: 0, y: 0, radius: 1 },
          turrets: [],
        },
        {
          gate: { x: 3, y: 2, radius: 1 },
          core: [3, 3],
          groundConsole: [3, 3],
          airConsole: [3, 3],
          pad: { x: 3, y: 3, radius: 1 },
          turrets: [],
        },
      ],
      lanes: [],
      turretSpots: [],
      outpostSpots: [],
      dummySpots: [],
    };
  }

  it("a deck wall blocks a mover ON the deck", () => {
    const map = loadMapFromJson(twoStorey(true));
    // Crossing the x = 2 line, in row 1.
    expect(crossesWallX(map, 1.5, 2.5, 1.5, 1)).toBe(true);
  });

  it("...and does NOT block the ground beneath it", () => {
    const map = loadMapFromJson(twoStorey(true));
    expect(crossesWallX(map, 1.5, 2.5, 1.5, 0)).toBe(false);
  });

  it("layer 0 reads the map's own lattice, deck or no deck", () => {
    const withDeckWall = loadMapFromJson(twoStorey(true));
    const without = loadMapFromJson(twoStorey(false));
    // Identical on the ground: the deck's lattice is not consulted for layer 0.
    expect(crossesWallX(withDeckWall, 1.5, 2.5, 1.5, 0)).toBe(
      crossesWallX(without, 1.5, 2.5, 1.5, 0),
    );
  });

  it("segmentBlocked takes the same layer argument", () => {
    const map = loadMapFromJson(twoStorey(true));
    expect(segmentBlocked(map, 1.5, 1.5, 3.5, 1.5, 1)).toBe(true);
    expect(segmentBlocked(map, 1.5, 1.5, 3.5, 1.5, 0)).toBe(false);
    // Default argument is layer 0 — the pre-#29 signature and behaviour.
    expect(segmentBlocked(map, 1.5, 1.5, 3.5, 1.5)).toBe(false);
  });

  it("a deck beyond the lattice list falls back to layer 0's walls", () => {
    const map = loadMapFromJson(twoStorey(true));
    // Only one deck exists; asking about layer 5 must not read out of bounds.
    expect(crossesWallX(map, 1.5, 2.5, 1.5, 5)).toBe(false);
  });
});
