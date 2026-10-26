// The original's coarse ground-height field query (map.ts coarseHeightAt; RE
// prepare.c `cact_coarse_height_at` 0x00456180).

import { describe, expect, it } from "bun:test";
import { COARSE_OFFMAP, coarseHeightAt, type MapCoarse } from "../src/map";

const field = (rows: number[][]): MapCoarse => ({
  originX: 10,
  originY: 20,
  rows: rows.length,
  stride: rows[0].length,
  data: Int8Array.from(rows.flat()),
});

describe("coarseHeightAt", () => {
  const f = field([
    [0, 32, 64],
    [32, 64, -32],
    [0, 0, 0],
  ]);

  it("answers a byte's 1/32 m at its cell's corner, rows down the sim's y", () => {
    expect(coarseHeightAt(f, 10, 20)).toBe(0);
    expect(coarseHeightAt(f, 12, 20)).toBe(1);
    expect(coarseHeightAt(f, 10, 22)).toBe(1);
    expect(coarseHeightAt(f, 12, 22)).toBe(2);
  });

  it("interpolates along the row on both rows first, then between them", () => {
    // Half a cell each way: near = 0.5, far = 1.5, the middle 1.
    expect(coarseHeightAt(f, 11, 21)).toBe(1);
    expect(coarseHeightAt(f, 13, 20)).toBe(1.5);
    expect(coarseHeightAt(f, 13, 22)).toBe(0.5);
  });

  it("answers 0x8000 world units off the field: before its origin or past its last cell pair", () => {
    expect(COARSE_OFFMAP).toBe(4);
    expect(coarseHeightAt(f, 9.99, 20)).toBe(COARSE_OFFMAP);
    expect(coarseHeightAt(f, 10, 19.99)).toBe(COARSE_OFFMAP);
    expect(coarseHeightAt(f, 14, 20)).toBe(COARSE_OFFMAP); // column 2 has no right neighbour
    expect(coarseHeightAt(f, 13.99, 23.99)).not.toBe(COARSE_OFFMAP);
    expect(coarseHeightAt(f, 10, 24)).toBe(COARSE_OFFMAP);
  });
});
