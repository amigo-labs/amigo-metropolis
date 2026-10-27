// The route cursor (route.ts) against the RE's transcription of the original's
// (fcop-fidelity.md U1): `cnet_route_init` 0x004415f0, `cnet_route_tick`
// 0x004402a0, `cnet_route_plan_leg` 0x00440920 and `cnet_route_corner_blend`
// 0x00441260 in fcop-reverse-engineering's src/game/net, at f3d4200f.
//
// The traces were taken by driving those C functions (libfcop_core) over a
// loop of single-link nodes — so the step chooser has one answer and neither
// side's random draws matter — with the PA tank's route block (speed 1024,
// acceleration 1228, deceleration 614, speed scale 4096, flags 0) and a frame
// delta of 10, printing each frame:
//   frame  engine-x  engine-z  yaw  pitch  node  next  phase  travelled  speed-word
// with the actor placed on node 0 and `cnet_route_init` called first. The whole
// 3000-frame trace is pinned by its FNV-1a digest over the text, one line a
// frame joined by newlines; every 150th line is spelled out to say where a
// mismatch starts. g1 has a pitch-only corner (a straight on with a rise), a
// 5 m leg and turns either way; g2 thirty nodes of random turns and heights.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { angleOf, fixedMul, reciprocalSpan } from "../src/route";
import { createSim, spawnUnit, step } from "../src/sim";

/** Nodes as (engine x, height, engine z), node units: the sim's y, h, x times 32. */
const G1 = [
  [2000, 0, 2000],
  [2000, 0, 2960],
  [2320, 0, 3600],
  [2320, 64, 4400],
  [2320, 64, 4560],
  [1800, 30, 4500],
  [1360, 0, 3200],
  [1700, -20, 2400],
];
const G2 = [
  [2000, 1, 2000],
  [1854, 43, 2104],
  [1603, 65, 1878],
  [1851, 6, 1674],
  [2147, 76, 1433],
  [2366, -36, 1352],
  [2154, 13, 1496],
  [1925, -29, 1442],
  [2189, -33, 1576],
  [2468, -12, 1402],
  [2764, 33, 1165],
  [3063, -34, 1271],
  [2989, 31, 1018],
  [2825, 13, 1014],
  [2672, -25, 1267],
  [2956, 31, 1282],
  [2841, 34, 1087],
  [3125, 7, 979],
  [2924, 51, 1239],
  [2688, -33, 1516],
  [2598, 47, 1724],
  [2842, 59, 1861],
  [2863, 34, 2037],
  [3027, -2, 2107],
  [2981, 49, 1991],
  [2930, 33, 1774],
  [2937, 23, 2011],
  [2988, -4, 2170],
  [2762, 25, 1990],
  [2890, 56, 1858],
];

const G1_DIGEST = 0xb85479e5;
const G2_DIGEST = 0x615f3fcb;
const G1_EVERY_150 = [
  "149 512000 592999 0 4095 1 2 1 81000 54",
  "299 512066 673981 12 4095 1 2 1 162000 54",
  "449 521026 752684 143 4095 1 2 1 243000 54",
  "599 547263 827840 274 4095 2 -1 2 78240 54",
  "749 577826 901465 190 4077 2 3 1 159240 54",
  "899 592523 978060 55 4054 3 -1 2 57200 54",
  "1049 593920 1057423 0 4045 3 4 1 138200 54",
  "1199 593920 1136959 0 4083 4 -1 2 10560 54",
  "1349 545373 1161758 2997 42 5 6 1 50600 54",
  "1499 476381 1141433 2668 29 5 6 1 131600 54",
  "1649 437656 1083622 2260 14 6 7 1 73848 54",
  "1799 412272 1008622 2260 14 6 7 1 154848 54",
  "1949 386887 933622 2260 14 6 7 1 235848 54",
  "2099 368933 858719 2112 14 6 7 1 316848 54",
  "2249 371343 784378 1941 14 7 -1 2 38424 54",
  "2399 394301 710632 1786 15 7 0 1 119424 54",
  "2549 426750 637669 1737 2 7 0 1 200424 54",
  "2699 468411 570224 1639 4074 0 -1 2 56144 54",
  "2849 504229 541741 727 4084 1 -1 2 6840 54",
  "2999 512000 599839 0 0 1 2 1 87840 54",
];
const G2_EVERY_150 = [
  "149 450825 517196 2594 4054 2 3 1 32616 54",
  "299 431861 465243 1697 85 3 -1 2 25552 54",
  "449 489319 415953 1469 4040 4 -1 2 20792 54",
  "599 550060 369157 1362 83 4 5 1 101792 54",
  "749 590432 355607 4041 4 6 -1 2 12808 54",
  "899 528293 377255 2978 88 7 -1 2 25200 54",
  "1049 530200 388035 752 6 8 9 1 41944 54",
  "1199 599540 379019 1390 4053 9 10 1 47168 54",
  "1349 663636 333426 1462 4020 10 -1 2 42152 54",
  "1499 728033 307524 961 82 11 -1 2 22800 54",
  "1649 776847 306856 1855 4018 12 -1 2 17016 54",
  "1799 738609 260209 3138 72 13 14 1 27360 54",
  "1949 696495 310631 97 12 14 15 1 65096 54",
  "2099 743439 324394 1489 4012 15 16 1 68528 54",
  "2249 742706 274201 1543 40 17 -1 2 14360 54",
  "2399 785221 266338 109 4056 18 -1 2 14720 54",
  "2549 742493 323607 3647 54 19 -1 2 9192 54",
  "2699 693315 383740 3710 5 19 20 1 90192 54",
  "2849 678886 446291 406 4012 21 -1 2 12216 54",
  "2999 729893 496529 109 83 22 -1 2 20768 54",
];

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** A 198 m flat arena whose graph is the loop `pts`, node k linked to k + 1. */
function loop(pts: number[][]): MapJson {
  const n = pts.length;
  const size = 100;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  return {
    id: "route-cursor-test",
    size,
    cellSize: 2,
    waterLevel: -10,
    heights,
    water,
    spawns: [
      { x: 1, y: 1, yaw: 0 },
      { x: 197, y: 197, yaw: 0 },
    ],
    basePlots: [
      { x: 5, y: 5, radius: 3 },
      { x: 190, y: 190, radius: 3 },
    ],
    bases: [
      {
        gate: { x: 2, y: 2, radius: 1 },
        core: [5, 5],
        groundConsole: [3, 3],
        airConsole: [5, 8],
        turrets: [],
      },
      {
        gate: { x: 196, y: 196, radius: 1 },
        core: [190, 190],
        groundConsole: [193, 193],
        airConsole: [190, 185],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
    laneGraph: {
      nodes: pts.map(([x, , z]) => [z / 32, x / 32]),
      edges: pts.map((_, i) => [(i + 1) % n, -1, -1, -1]),
      nextHopA: [pts.map((_, i) => (i + 1 < n ? i + 1 : -1)), pts.map(() => -1)],
      nextHopB: [pts.map(() => -1), pts.map(() => -1)],
      entry: [0, 0],
      heights: pts.map(([, h]) => h),
    },
  } as unknown as MapJson;
}

/** The sim's trace over `pts`, in the oracle's line format. */
function trace(pts: number[][]): string[] {
  const state = createSim(loadMapFromJson(loop(pts)), 1);
  // The Dreadnought: no traffic reaction, and alone on the road.
  const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, pts[0][2] / 32, pts[0][0] / 32);
  const idle = createTickInputs();
  const c = state.route;
  const out: string[] = [];
  for (let t = 0; t < 3000; t++) {
    step(state, idle);
    out.push(
      [
        t,
        Math.round(state.ent.posY[id] * 8192),
        Math.round(state.ent.posX[id] * 8192),
        c.yaw[id],
        c.pitch[id],
        state.ent.timerA[id],
        c.next[id],
        c.phase[id] & 3,
        c.travelled[id],
        c.velocity[id],
      ].join(" "),
    );
  }
  return out;
}

describe("the route cursor walks what the original's walks", () => {
  it("g1: a pitch-only corner, a short leg, turns either way", () => {
    const got = trace(G1);
    expect(got.filter((_, i) => i % 150 === 149)).toEqual(G1_EVERY_150);
    expect(fnv(got.join("\n"))).toBe(G1_DIGEST);
  });

  it("g2: thirty nodes of random turns and heights", () => {
    const got = trace(G2);
    expect(got.filter((_, i) => i % 150 === 149)).toEqual(G2_EVERY_150);
    expect(fnv(got.join("\n"))).toBe(G2_DIGEST);
  });
});

describe("the engine's fixed-point arithmetic", () => {
  it("math_fixed_mul keeps the low 32 bits of the 64-bit product >> 16", () => {
    expect(fixedMul(0x10000, 0x10000)).toBe(0x10000);
    expect(fixedMul(-0x18000, 0x20000)).toBe(-0x30000);
    // Values from the RE's math_fixed_mul (fcop/math.h).
    expect(fixedMul(0x7fffffff, 0x7fffffff)).toBe(-65536);
    expect(fixedMul(3, -1)).toBe(-1); // a floor, as `sar` of the product
  });

  it("math_reciprocal_span is 0x80000000 / (span >> 1), 0 for an empty half", () => {
    expect(reciprocalSpan(0)).toBe(0);
    expect(reciprocalSpan(1)).toBe(0);
    expect(reciprocalSpan(2)).toBe(0x80000000);
    expect(reciprocalSpan(512)).toBe(0x800000);
  });

  it("math_angle_of is atan2(b, a) in 24 bits, the RE's answers", () => {
    // Values from the RE's math_angle_of (game/math/angle.c, retail 0x00439170):
    // the diagonal reads a little short, by the reciprocal of half the larger.
    const cases = [
      [1000, 0, 0],
      [1000, 1000, 2097131],
      [0, 1000, 4194304],
      [-1000, 0, 8388608],
      [0, -1000, -4194304],
      [-1000, -1000, -6291477],
      [30000, 10000, 858717],
      [-7, 3, 7150188],
    ];
    for (const [a, b, want] of cases) expect(angleOf(a, b)).toBe(want);
    expect(angleOf(0, 0)).toBe(0);
  });
});
