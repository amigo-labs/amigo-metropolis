// Layered MapData: schema + resolveHeight + the synthetic layered-test map.
import { describe, expect, it } from "bun:test";
import {
  getMapById,
  HEIGHT_SCALE,
  LAYERED_TEST_ID,
  loadMapFromJson,
  MAP_REGISTRY,
  type MapJson,
  resolveHeight,
  sampleHeight,
} from "../src/map";

// Minimal 2×2 base map (mirror of district01.test.ts `tiny()`), extendable with layers.
function tiny(): MapJson {
  return {
    id: "t",
    size: 2,
    cellSize: 1,
    waterLevel: 0,
    heights: [
      [0, 0],
      [0, 0],
    ],
    water: ["00", "00"],
    spawns: [
      { x: 0, y: 0, yaw: 0 },
      { x: 1, y: 1, yaw: 0 },
    ],
    basePlots: [
      { x: 0, y: 0, radius: 1 },
      { x: 1, y: 1, radius: 1 },
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
        gate: { x: 1, y: 0, radius: 1 },
        core: [1, 1],
        groundConsole: [1, 1],
        airConsole: [1, 1],
        pad: { x: 1, y: 1, radius: 1 },
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

describe("layered MapData", () => {
  it("single-story maps get empty layer arrays", () => {
    const m = loadMapFromJson(tiny());
    expect(m.layerHeights.length).toBe(0);
    expect(m.layerMask.length).toBe(0);
  });

  it("parses one upper layer: heights (1/32 m ints) + present mask", () => {
    const raw = tiny();
    raw.layers = [
      {
        heights: [
          [64, 64],
          [64, 64],
        ],
        mask: ["11", "10"],
      },
    ];
    const m = loadMapFromJson(raw);
    expect(m.layerHeights.length).toBe(1);
    expect(m.layerHeights[0][0]).toBeCloseTo(64 * HEIGHT_SCALE, 6); // 2.0 m
    expect(m.layerMask[0][0]).toBe(1);
    expect(m.layerMask[0][3]).toBe(0); // row 1 col 1 = '0'
  });

  it("rejects a layer with a wrong-length height row", () => {
    const raw = tiny();
    raw.layers = [{ heights: [[64, 64], [64]], mask: ["11", "11"] }];
    expect(() => loadMapFromJson(raw)).toThrow("layer");
  });

  it("rejects a layer mask with a non-0/1 char", () => {
    const raw = tiny();
    raw.layers = [
      {
        heights: [
          [64, 64],
          [64, 64],
        ],
        mask: ["11", "1x"],
      },
    ];
    expect(() => loadMapFromJson(raw)).toThrow("non-0/1");
  });

  // Per-deck wall lattices (issue #29). A deck's parapet must block ON the deck
  // and not on the ground beneath it, which is the conflation that used to turn
  // la-cantina's bridges into walls across the road they span.
  it("parses a per-deck wall lattice, keeping it distinct from layer 0's", () => {
    const raw = tiny();
    raw.wallsV = ["00", "00"];
    raw.wallsH = ["00", "00"];
    raw.layers = [
      {
        heights: [
          [64, 64],
          [64, 64],
        ],
        mask: ["11", "11"],
        wallsV: ["01", "01"],
        wallsH: ["00", "00"],
      },
    ];
    const map = loadMapFromJson(raw);
    expect(map.layerWallsV.length).toBe(1);
    expect(map.layerWallsH.length).toBe(1);
    // Deck blocks the x = 1 line; the ground does not.
    expect(map.layerWallsV[0][0 * 2 + 1]).toBe(1);
    expect(map.wallsV[0 * 2 + 1]).toBe(0);
  });

  it("a deck without its own walls shares layer 0's, and stays a no-op", () => {
    const raw = tiny();
    raw.wallsV = ["01", "01"];
    raw.wallsH = ["00", "00"];
    raw.layers = [
      {
        heights: [
          [64, 64],
          [64, 64],
        ],
        mask: ["11", "11"],
      },
    ];
    const map = loadMapFromJson(raw);
    // Empty arrays are THE no-op path: collision takes its pre-#29 branch.
    expect(map.layerWallsV.length).toBe(0);
    expect(map.layerWallsH.length).toBe(0);
  });

  it("rejects a deck that brings only one of the two wall arrays", () => {
    const raw = tiny();
    raw.layers = [
      {
        heights: [
          [64, 64],
          [64, 64],
        ],
        mask: ["11", "11"],
        wallsV: ["01", "01"],
      },
    ];
    expect(() => loadMapFromJson(raw)).toThrow("both be present or both be absent");
  });
});

describe("resolveHeight", () => {
  it("layer 0 is bit-identical to sampleHeight", () => {
    const raw = tiny();
    raw.heights = [
      [10, 20],
      [30, 40],
    ];
    raw.layers = [
      {
        heights: [
          [100, 100],
          [100, 100],
        ],
        mask: ["11", "11"],
      },
    ];
    const m = loadMapFromJson(raw);
    expect(resolveHeight(m, 0.5, 0.5, 0)).toBe(sampleHeight(m, 0.5, 0.5));
  });

  it("layer 1 samples the upper deck", () => {
    const raw = tiny();
    raw.layers = [
      {
        heights: [
          [96, 96],
          [96, 96],
        ],
        mask: ["11", "11"],
      },
    ]; // 3.0 m
    const m = loadMapFromJson(raw);
    expect(resolveHeight(m, 0.5, 0.5, 1)).toBeCloseTo(3.0, 6);
  });

  it("layer >= 1 on a single-story map falls back to base height", () => {
    const m = loadMapFromJson(tiny());
    expect(resolveHeight(m, 0.5, 0.5, 1)).toBe(sampleHeight(m, 0.5, 0.5));
  });
});

describe("layered-test map", () => {
  const m = getMapById(LAYERED_TEST_ID);
  it("loads with two extra layers", () => {
    expect(m.size).toBe(8);
    expect(m.layerHeights.length).toBe(2);
    expect(m.layerMask.length).toBe(2);
  });
  it("is not offered in the menu registry (debug-only, like test-128)", () => {
    expect(MAP_REGISTRY.some((info) => info.id === LAYERED_TEST_ID)).toBe(false);
  });
  it("has the roof deck present in the far corner", () => {
    // roof (layer 2 → layerHeights index 1) present at (i=6, j=6)
    expect(m.layerMask[1][6 * 8 + 6]).toBe(1);
    expect(resolveHeight(m, 6 * 2, 6 * 2, 2)).toBeCloseTo(6.0, 6);
  });
});
