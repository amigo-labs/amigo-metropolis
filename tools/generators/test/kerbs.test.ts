// The kerb rule (tools/generators/kerbs.ts, fcop-fidelity.md P15) on a hand-made
// mesh: two floors meet at x = 2 across one wall bit, and the faces along the
// edge say whether it is a step or a wall.

import { describe, expect, it } from "bun:test";
import { loadMapFromJson, type MapJson } from "@metropolis/sim";
import { type Lattice, openKerbs } from "../kerbs";

const SIZE = 4;

/** A 4 x 4 map, ground at 0, one wall bit on the x = 2 line in row 1. */
function map(): ReturnType<typeof loadMapFromJson> {
  const none = Array.from({ length: SIZE }, () => "0".repeat(SIZE));
  const json: MapJson = {
    id: "t-kerb",
    size: SIZE,
    cellSize: 1,
    waterLevel: -10,
    heights: Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0)),
    water: none,
    wallsV: none,
    wallsH: none,
    spawns: [
      { x: 0.5, y: 0.5, yaw: 0 },
      { x: 2.5, y: 2.5, yaw: 0 },
    ],
    basePlots: [
      { x: 0.5, y: 0.5, radius: 0.5 },
      { x: 2.5, y: 2.5, radius: 0.5 },
    ],
    bases: [
      {
        gate: { x: 0.5, y: 1.5, radius: 0.5 },
        core: [0.5, 0.5],
        groundConsole: [0.5, 0.5],
        airConsole: [0.5, 0.5],
        turrets: [],
      },
      {
        gate: { x: 2.5, y: 1.5, radius: 0.5 },
        core: [2.5, 2.5],
        groundConsole: [2.5, 2.5],
        airConsole: [2.5, 2.5],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
  return loadMapFromJson(json);
}

/** Two triangles of a flat rectangle at height h (corners x0..x1, y0..y1). */
function floor(x0: number, x1: number, y0: number, y1: number, h: number): number[] {
  return [x0, h, y0, x1, h, y0, x1, h, y1, x0, h, y0, x1, h, y1, x0, h, y1];
}

/** Two triangles of a vertical face on the line x, from lo to hi, over y0..y1. */
function face(x: number, y0: number, y1: number, lo: number, hi: number): number[] {
  return [x, lo, y0, x, hi, y0, x, hi, y1, x, lo, y0, x, hi, y1, x, lo, y1];
}

function lattice(): Lattice[] {
  const rows = () => Array.from({ length: SIZE }, () => "0".repeat(SIZE).split(""));
  const v = rows();
  v[1][2] = "1";
  return [{ v, h: rows() }];
}

function opened(tris: number[]): boolean {
  const l = lattice();
  openKerbs(map(), Float64Array.from(tris), l);
  return l[0].v[1][2] === "0";
}

describe("kerbs (fcop-fidelity.md P15)", () => {
  it("opens a 0.3 m step with nothing above it", () => {
    expect(
      opened([...floor(0, 2, 0, 4, 0), ...floor(2, 4, 0, 4, 0.3), ...face(2, 0, 4, 0, 0.3)]),
    ).toBe(true);
  });

  it("keeps a step taller than the original's walker steps up", () => {
    expect(
      opened([...floor(0, 2, 0, 4, 0), ...floor(2, 4, 0, 4, 0.6), ...face(2, 0, 4, 0, 0.6)]),
    ).toBe(false);
  });

  it("keeps a wall that stands above the step", () => {
    expect(
      opened([...floor(0, 2, 0, 4, 0), ...floor(2, 4, 0, 4, 0.3), ...face(2, 0, 4, 0, 1.5)]),
    ).toBe(false);
  });

  it("keeps a fence between two floors of one height", () => {
    expect(
      opened([...floor(0, 2, 0, 4, 0), ...floor(2, 4, 0, 4, 0), ...face(2, 0, 4, 0, 1.0)]),
    ).toBe(false);
  });
});
