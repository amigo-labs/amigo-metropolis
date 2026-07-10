// Edge-blocker wall collision (collision.ts): the pure helpers and their
// wiring into avatar/unit movement. The empty-array early-out is THE no-op
// invariant that keeps wall-free maps hash-identical — pinned here and proven
// end-to-end by the regenerated goldens.
import { describe, expect, it } from "bun:test";
import { crossesWallX, crossesWallY } from "../src/collision";
import { BUTTON_TRANSFORM, createTickInputs } from "../src/inputs";
import { createTestMap, loadMapFromJson, type MapData, type MapJson } from "../src/map";
import { createSim, step } from "../src/sim";

/** Minimal walled map: 4×4 points (3×3 cells), cellSize 1, flat ground. */
function walledMap(walls: { v?: [number, number][]; h?: [number, number][] }): MapData {
  const size = 4;
  const wallsV = new Uint8Array(size * size);
  const wallsH = new Uint8Array(size * size);
  for (const [i, j] of walls.v ?? []) wallsV[j * size + i] = 1; // line x=i, cell row j
  for (const [i, j] of walls.h ?? []) wallsH[j * size + i] = 1; // line y=j, cell col i
  const base = createTestMap();
  return {
    ...base,
    id: "walled-4",
    size,
    cellSize: 1,
    heights: new Float32Array(size * size),
    waterMask: new Uint8Array(size * size),
    wallsV,
    wallsH,
  };
}

describe("crossesWallX/Y basics", () => {
  it("returns false on maps with empty wall arrays (no-op invariant)", () => {
    const map = createTestMap();
    expect(map.wallsV.length).toBe(0);
    expect(map.wallsH.length).toBe(0);
    expect(crossesWallX(map, 10, 10.3, 5)).toBe(false);
    expect(crossesWallY(map, 5, 10, 10.3)).toBe(false);
  });

  it("blocks an x move across a vertical segment, both directions", () => {
    const map = walledMap({ v: [[2, 1]] }); // line x=2, cell row y∈[1,2]
    expect(crossesWallX(map, 1.8, 2.1, 1.5)).toBe(true); // eastward
    expect(crossesWallX(map, 2.2, 1.9, 1.5)).toBe(true); // westward
  });

  it("does not block moves that stay within one cell column", () => {
    const map = walledMap({ v: [[2, 1]] });
    expect(crossesWallX(map, 2.1, 2.9, 1.5)).toBe(false); // east of the line
    expect(crossesWallX(map, 1.2, 1.9, 1.5)).toBe(false); // west of the line
  });

  it("only blocks in the segment's own cell row", () => {
    const map = walledMap({ v: [[2, 1]] });
    expect(crossesWallX(map, 1.8, 2.1, 0.5)).toBe(false); // row 0: no segment
    expect(crossesWallX(map, 1.8, 2.1, 2.5)).toBe(false); // row 2: no segment
    expect(crossesWallX(map, 1.8, 2.1, 1.0)).toBe(true); // y=1.0 belongs to row 1
  });

  it("blocks a y move across a horizontal segment symmetrically", () => {
    const map = walledMap({ h: [[1, 2]] }); // line y=2, cell col x∈[1,2]
    expect(crossesWallY(map, 1.5, 1.8, 2.1)).toBe(true); // southward
    expect(crossesWallY(map, 1.5, 2.2, 1.9)).toBe(true); // northward
    expect(crossesWallY(map, 0.5, 1.8, 2.1)).toBe(false); // col 0: no segment
    expect(crossesWallY(map, 1.5, 2.1, 2.9)).toBe(false); // south of the line
  });

  it("moving away from a line you stand on is not a crossing", () => {
    const map = walledMap({ v: [[2, 1]] });
    expect(crossesWallX(map, 2.0, 2.3, 1.5)).toBe(false); // on line, going east
    expect(crossesWallX(map, 2.0, 1.7, 1.5)).toBe(true); // on line, going west crosses it
  });

  it("clamps the lateral cell index at the map edges", () => {
    const map = walledMap({ v: [[2, 2]], h: [[2, 2]] });
    // y beyond the last cell row clamps to row size-2 = 2.
    expect(crossesWallX(map, 1.8, 2.1, 3.0)).toBe(true);
    // x beyond the last cell column clamps to col size-2 = 2.
    expect(crossesWallY(map, 3.0, 1.8, 2.1)).toBe(true);
  });

  it("respects cellSize when locating lines and rows", () => {
    const base = walledMap({ v: [[2, 1]] });
    const map: MapData = { ...base, cellSize: 2 }; // line at world x=4, row y∈[2,4)
    expect(crossesWallX(map, 3.8, 4.1, 3)).toBe(true);
    expect(crossesWallX(map, 3.8, 4.1, 1)).toBe(false); // row 0 in cell units
    expect(crossesWallX(map, 1.8, 2.1, 3)).toBe(false); // world x=2 is inside cell 0
  });
});

// --- End-to-end: a walled arena through the JSON loader + avatar stepper ----

// 16×16 flat grid, cellSize 4 → 60 m square. A full-height vertical wall on
// grid line i=4 (world x=16) blocks the corridor east of the spawn at x=12.
function walledArenaJson(): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  const wallsV: string[] = [];
  const wallsH: string[] = [];
  const vRow = `${"0".repeat(4)}1${"0".repeat(size - 5)}`;
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
    wallsV.push(vRow);
    wallsH.push("0".repeat(size));
  }
  return {
    id: "walled-arena-test",
    size,
    cellSize: 4,
    waterLevel: -10,
    heights,
    water,
    wallsV,
    wallsH,
    spawns: [
      { x: 12, y: 30, yaw: 0 },
      { x: 50, y: 30, yaw: 0 },
    ],
    basePlots: [
      { x: 12, y: 30, radius: 8 },
      { x: 50, y: 30, radius: 8 },
    ],
    bases: [
      {
        gate: { x: 2, y: 2, radius: 2 },
        core: [4, 30],
        groundConsole: [12, 22],
        airConsole: [12, 38],
        pad: { x: 12, y: 30, radius: 8 },
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 2 },
        core: [56, 30],
        groundConsole: [50, 22],
        airConsole: [50, 38],
        pad: { x: 50, y: 30, radius: 8 },
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

describe("avatar vs wall (loader + stepper end-to-end)", () => {
  const inputs = createTickInputs();
  const p0 = inputs.players[0];
  const reset = (): void => {
    for (const p of inputs.players) {
      p.moveX = 0;
      p.moveY = 0;
      p.aimX = 0;
      p.aimY = 0;
      p.buttons = 0;
    }
  };

  it("loads the wall rows into dense arrays", () => {
    const map = loadMapFromJson(walledArenaJson());
    expect(map.wallsV.length).toBe(16 * 16);
    expect(map.wallsV[5 * 16 + 4]).toBe(1);
    expect(map.wallsH.length).toBe(16 * 16);
  });

  it("rejects a lone wall array", () => {
    const raw = walledArenaJson();
    raw.wallsH = undefined;
    expect(() => loadMapFromJson(raw)).toThrow("both");
  });

  it("walker is blocked by the wall on flat ground and slides along it", () => {
    reset();
    const sim = createSim(loadMapFromJson(walledArenaJson()), 1);
    p0.moveX = 127; // due east into the wall at x=16
    p0.moveY = 40; // plus a southward slide component
    const startY = sim.ent.posY[0];
    for (let i = 0; i < 120; i++) step(sim, inputs); // 4 s — plenty to reach it
    expect(sim.ent.posX[0]).toBeLessThan(16); // never crosses the line
    expect(sim.ent.posX[0]).toBeGreaterThan(15); // but got right up to it
    expect(sim.ent.posY[0]).toBeGreaterThan(startY + 5); // slide continued
  });

  it("hover is blocked too — walls are physical, not a terrain rule", () => {
    reset();
    const sim = createSim(loadMapFromJson(walledArenaJson()), 1);
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p0.buttons = 0;
    for (let i = 0; i < 60; i++) step(sim, inputs); // let the transform settle
    p0.moveX = 127;
    for (let i = 0; i < 120; i++) step(sim, inputs);
    expect(sim.ent.posX[0]).toBeLessThan(16);
  });
});
