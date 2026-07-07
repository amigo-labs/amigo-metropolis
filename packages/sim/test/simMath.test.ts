// Pins EXACT output values (toBe, not toBeCloseTo). If any of these change,
// the sim is no longer producing the committed bit-exact results and every
// existing replay/golden is invalid — that is a SIM_VERSION bump, not a
// test update.
import { describe, expect, it } from "bun:test";
import { atan2Poly, cosLUT, HALF_PI, invLen, len, PI, rand01, sinLUT, TAU } from "../src/simMath";
import { SIN_TABLE, SIN_TABLE_SIZE } from "../src/sinTable";

describe("sin table", () => {
  it("has 4096 committed entries", () => {
    expect(SIN_TABLE_SIZE).toBe(4096);
    expect(SIN_TABLE.length).toBe(4096);
  });

  it("pins exact table entries", () => {
    expect(SIN_TABLE[0]).toBe(0);
    expect(SIN_TABLE[1]).toBe(0.0015339801862847655);
    expect(SIN_TABLE[1024]).toBe(1);
    expect(SIN_TABLE[3000]).toBe(-0.9939069700023561);
  });
});

describe("sinLUT / cosLUT", () => {
  it("pins exact values, including negative and large angles", () => {
    expect(sinLUT(0)).toBe(0);
    expect(sinLUT(TAU / 4)).toBe(1);
    expect(sinLUT(1)).toBe(0.8407253749704581);
    expect(sinLUT(-1)).toBe(-0.8415549774368988);
    expect(sinLUT(100)).toBe(-0.5075089910529711);
    expect(sinLUT(-100)).toBe(0.5061866453451552);
    expect(cosLUT(0)).toBe(1);
    expect(cosLUT(1)).toBe(0.5414617658531233);
    expect(cosLUT(-3)).toBe(-0.9900582102622971);
  });

  it("stays within quantization error of true sine", () => {
    for (let i = 0; i < 1000; i++) {
      const a = (i / 1000) * TAU;
      expect(Math.abs(sinLUT(a) - Math.sin(a))).toBeLessThan(0.0016);
    }
  });
});

describe("atan2Poly", () => {
  it("pins exact values on axes and diagonals", () => {
    expect(atan2Poly(0, 0)).toBe(0);
    expect(atan2Poly(0, 1)).toBe(0);
    expect(atan2Poly(1, 1)).toBe(0.7854095999999999);
    expect(atan2Poly(1, 0)).toBe(HALF_PI);
    expect(atan2Poly(1, -1)).toBe(2.356183053589793);
    expect(atan2Poly(0, -1)).toBe(PI);
    expect(atan2Poly(-1, -1)).toBe(-2.356183053589793);
    expect(atan2Poly(-1, 0)).toBe(-HALF_PI);
    expect(atan2Poly(-1, 1)).toBe(-0.7854095999999999);
    expect(atan2Poly(0.3, 0.7)).toBe(0.40490235696692);
  });

  it("stays within 2e-5 rad of Math.atan2 across all octants", () => {
    for (let i = 0; i < 360; i++) {
      const a = (i / 360) * TAU - PI;
      const y = Math.sin(a) * 3.7;
      const x = Math.cos(a) * 3.7;
      expect(Math.abs(atan2Poly(y, x) - Math.atan2(y, x))).toBeLessThan(2e-5);
    }
  });
});

describe("vec2 helpers", () => {
  it("len and invLen are exact", () => {
    expect(len(3, 4)).toBe(5);
    expect(invLen(3, 4)).toBe(0.2);
    expect(invLen(0, 0)).toBe(0);
  });
});

describe("mulberry32", () => {
  it("pins the exact sequence for seed 1234", () => {
    const s = { prng: 1234 | 0 };
    const got = Array.from({ length: 8 }, () => rand01(s));
    expect(got).toEqual([
      0.07329497812315822, 0.7034119898453355, 0.9028560190927237, 0.9705493662040681,
      0.04096397617831826, 0.11776310740970075, 0.1617849813774228, 0.8027570187114179,
    ]);
    expect(s.prng).toBe(1767625850);
  });

  it("is reproducible from the same seed", () => {
    const a = { prng: 42 };
    const b = { prng: 42 };
    for (let i = 0; i < 100; i++) {
      expect(rand01(a)).toBe(rand01(b));
    }
  });
});
