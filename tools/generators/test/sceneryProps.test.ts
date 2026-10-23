// The type-96 Props and type-97 DCSQuads as gen:scenery builds them
// (tools/generators/sceneryProps.ts; fcop-fidelity.md G13): the generator the
// original draws its random angles from, each record field as the RE's build
// and spawn read it, and the table every arena's mission gives.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SCENERY_PLACEMENTS } from "../../../packages/client/src/render/arenaScenery.generated";
import {
  type DecalRect,
  emitterAnchor,
  GameRand,
  type PropRecord,
  type QuadRecord,
  RETAIL_SEED,
  resolveProp,
  resolveQuad,
  worldCellQuadMask,
} from "../sceneryProps";

const PUBLIC = join(import.meta.dir, "..", "..", "..", "packages", "client", "public");

describe("game_rand", () => {
  test("its seed stream is MINSTD, the published sequence from seed 1", () => {
    const r = new GameRand(0);
    // A fresh generator's own stream, re-seeded by hand to 1.
    (r as unknown as { seedState: number }).seedState = 1;
    expect([r.seedStep(), r.seedStep(), r.seedStep(), r.seedStep(), r.seedStep()]).toEqual([
      16807, 282475249, 1622650073, 984943658, 1144108930,
    ]);
  });

  test("draws the lagged Fibonacci sum, t[i-1] + t[i+2], walking down", () => {
    const a = new GameRand(RETAIL_SEED);
    const seeds = new GameRand(0);
    (seeds as unknown as { seedState: number }).seedState = RETAIL_SEED;
    const table = Array.from({ length: 20 }, () => seeds.seedStep());
    // First draw: index 20 -> 19, ahead 22 folds to 2.
    expect(a.next()).toBe((table[19] + table[2]) | 0);
    // Second: 19 -> 18, ahead 21 folds to 1.
    expect(a.next()).toBe((table[18] + table[1]) | 0);
  });
});

function prop(over: Partial<PropRecord>): PropRecord {
  return {
    seq: 0,
    res: "Cact",
    id: 1,
    cobjs: [61],
    pos: [8192, 4096, 16384],
    angleY: 0,
    angleZ: 0,
    angleX: 0,
    height: 0,
    layer: 0,
    flags: 0,
    rate: 0,
    scale: [64, 64, 64],
    spin: 0,
    heading: 0,
    ground: 1000,
    ...over,
  };
}

describe("a Prop as snd_emit_build stands it", () => {
  const frames = () => 9;

  test("on its layer's ground plus height << 4, or its own y on layer -99", () => {
    const rand = new GameRand(RETAIL_SEED);
    expect(resolveProp(prop({ height: 100 }), rand, frames).pos[1]).toBe(1000 + 1600);
    expect(resolveProp(prop({ layer: -99, ground: null }), rand, frames).pos[1]).toBe(4096);
  });

  test("a negative angle is a random 12-bit one, drawn y, x, z", () => {
    const rand = new GameRand(RETAIL_SEED);
    const draws = new GameRand(RETAIL_SEED);
    const p = resolveProp(prop({ angleY: -1, angleX: -1, angleZ: -1 }), rand, frames);
    expect([p.yaw, p.pitch, p.roll]).toEqual([
      draws.next() & 0xfff,
      draws.next() & 0xfff,
      draws.next() & 0xfff,
    ]);
    // A positive one is kept and draws nothing.
    const q = resolveProp(prop({ angleY: 220 }), rand, frames);
    expect(q.yaw).toBe(220);
  });

  test("an attached sound takes angle z's low byte and leaves the angle 0", () => {
    const p = resolveProp(prop({ flags: 0x40, angleZ: 90 }), new GameRand(1), frames);
    expect([p.sound, p.roll]).toEqual([90, 0]);
  });

  test("a negative scale lands within its own spread of unity", () => {
    for (let k = 0; k < 50; k++) {
      const p = resolveProp(prop({ scale: [-8, 64, 64] }), new GameRand(k), frames);
      expect(p.scale[0]).toBeGreaterThanOrEqual(64 - 8);
      expect(p.scale[0]).toBeLessThanOrEqual(64 + 8 - 1);
    }
  });

  test("the rate is a period of 300 / rate engine ticks, and the frames step by the flags", () => {
    const rand = new GameRand(1);
    expect(resolveProp(prop({ rate: 8 }), rand, frames)).toMatchObject({
      period: 37,
      anim: "loop",
    });
    expect(resolveProp(prop({ rate: 1 }), rand, frames).period).toBe(255);
    expect(resolveProp(prop({ rate: 0 }), rand, frames).anim).toBe("none");
    expect(resolveProp(prop({ rate: 8, flags: 4 }), rand, frames).anim).toBe("boomerang");
    expect(resolveProp(prop({ rate: 8, flags: 8 }), rand, frames).anim).toBe("none");
    expect(resolveProp(prop({ rate: 8 }), rand, () => 1).anim).toBe("none");
    expect(() => resolveProp(prop({ rate: 8, flags: 0x20 }), rand, frames)).toThrow();
  });

  test("the swing is +0x23's degrees as a 12-bit angle", () => {
    const p = resolveProp(prop({ heading: 60, spin: 8, angleY: 1024 }), new GameRand(1), frames);
    expect([p.swing, p.park]).toEqual([682, 1024]);
  });
});

const RECT: DecalRect = { res: 11, u: 163, v: 84, w: 63, h: 64, page: 9, id: 1 };

function quad(over: Partial<QuadRecord>): QuadRecord {
  return {
    seq: 0,
    res: "Cact",
    id: 2,
    pos: [0, 0, 0],
    flags: 0x10,
    kind: 1,
    lift: 614,
    spanZ: 1638,
    spanX: 1638,
    angleY: 0,
    angleX: 0,
    angleZ: 0,
    layer: 0,
    colour: [16, 16, 16],
    ground: -100,
    ...over,
  };
}

describe("a DCSQuad as pyro_spawn spawns it", () => {
  test("at its ground plus lift << 4, its spans halved into sixteenths", () => {
    const q = resolveQuad(quad({}), new GameRand(1), [RECT]);
    expect(q?.pos[1]).toBe(614 * 16 - 100);
    // 1638 << 4 = 26208, halved 13104, >> 4 = 819 sixteenths.
    expect([q?.halfX, q?.halfZ]).toEqual([819 * 16, 819 * 16]);
  });

  test("bit 0x10 is the additive blend, its colour doubled", () => {
    const q = resolveQuad(quad({ colour: [20, 28, 200] }), new GameRand(1), [RECT]);
    expect(q?.blend).toBe(2);
    expect(q?.tint).toEqual([40, 56, 255]);
    const plain = resolveQuad(quad({ flags: 0 }), new GameRand(1), [RECT]);
    expect([plain?.blend, plain?.tint]).toEqual([1, [255, 255, 255]]);
  });

  test("spawns nothing for spans both under 0x40 or an id no rect carries", () => {
    expect(resolveQuad(quad({ spanX: 0x3f, spanZ: 0x3f }), new GameRand(1), [RECT])).toBeNull();
    expect(resolveQuad(quad({ kind: 5 }), new GameRand(1), [RECT])).toBeNull();
  });
});

describe("every arena's Props and DCSQuads", () => {
  test("are the records its mission carries", () => {
    const count = (id: string) => [
      SCENERY_PLACEMENTS[id].props.length,
      SCENERY_PLACEMENTS[id].quads.length,
    ];
    expect(count("urban-jungle")).toEqual([89, 0]);
    expect(count("proving-ground")).toEqual([75, 56]);
    expect(count("bug-hunt")).toEqual([75, 51]);
    expect(count("hollywood-keys")).toEqual([151, 134]);
    expect(count("la-cantina")).toEqual([0, 0]);
    expect(count("venice-beach")).toEqual([0, 0]);
  });

  test("draw from committed files: a model each, an image each", () => {
    for (const [mapId, s] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const [cobj, m] of Object.entries(s.propModels)) {
        const file = join(PUBLIC, "models", "props", mapId, `prop-${cobj.padStart(3, "0")}.glb`);
        expect({ mapId, cobj, file: existsSync(file) }).toEqual({ mapId, cobj, file: m.drawn });
      }
      for (const d of Object.values(s.decals)) {
        expect(existsSync(join(PUBLIC, "models", "decals", mapId, d.file))).toBe(true);
      }
      for (const q of s.quads) expect(s.decals[q.decal]).toBeDefined();
    }
  });

  // The five of camera-facing facers only draw too: their records are the
  // glbs' (render/facers.ts), no longer the RE's static white stand-ins.
  test("draw every Prop model, the facer-only ones included", () => {
    const undrawn = Object.entries(SCENERY_PLACEMENTS).flatMap(([mapId, s]) =>
      Object.entries(s.propModels)
        .filter(([, m]) => !m.drawn)
        .map(([cobj]) => `${mapId}/${cobj}`),
    );
    expect(undrawn).toEqual([]);
  });

  test("draw Hk's 44 random yaws from the one stream, every one in 12 bits", () => {
    const hk = SCENERY_PLACEMENTS["hollywood-keys"].props.filter((p) => p.park === -1);
    expect(hk.length).toBe(44);
    expect(new Set(hk.map((p) => p.yaw)).size).toBeGreaterThan(40);
    for (const p of hk) expect(p.yaw >= 0 && p.yaw < 4096).toBe(true);
  });
});

describe("the emitter's anchor (snd_emit_build 0x0042f942..0x0042fa88)", () => {
  const rand = () => new GameRand(RETAIL_SEED);
  const frames = () => 1;

  test("box 0's centre through the orientation onto the position; the cell is >> 17", () => {
    // Unturned, unit scale: the centre (2, 3, -1) halfwords is 32, 48, -16 wu off.
    const p = resolveProp(prop({ pos: [0x20000 + 100, 0, 0x40000 + 200] }), rand(), frames);
    const a = emitterAnchor(p, [2, 3, -1, 4, 4, 4]);
    expect(a.at).toEqual([p.pos[0] + 32, p.pos[1] + 48, p.pos[2] - 16]);
    expect([a.cellX, a.cellZ]).toEqual([1, 2]);
  });

  test("a quarter turn carries the centre across; a scale byte scales it", () => {
    // My(0x400): the model's z goes to the game's -x... row 2 of My is (sin, 0, cos).
    const turned = resolveProp(prop({ angleY: 0x400 }), rand(), frames);
    const a = emitterAnchor(turned, [0, 0, 64, 1, 1, 1]);
    expect(a.at[0] - turned.pos[0]).toBe(1024);
    expect(a.at[2] - turned.pos[2]).toBe(0);
    const big = resolveProp(prop({ scale: [64, 64, 128] }), rand(), frames);
    const b = emitterAnchor(big, [0, 0, 64, 1, 1, 1]);
    expect(b.at[2] - big.pos[2]).toBe(2048);
  });

  test("a spinning emitter's y row and column are flattened first", () => {
    // Tilted about x, a spinner still lifts its centre straight up.
    const p = resolveProp(prop({ angleX: 0x200, spin: 4 }), rand(), frames);
    const a = emitterAnchor(p, [0, 64, 0, 1, 1, 1]);
    expect(a.at[0] - p.pos[0]).toBe(0);
    expect(a.at[1] - p.pos[1]).toBe(1024);
    expect(a.at[2] - p.pos[2]).toBe(0);
  });
});

describe("world_cell_quad_mask (RE world/grid.c 0x0042f600)", () => {
  const cell = 0x20000 * 3;
  test("element a + 4 b at bit 0x8000 >> it, a box's quarter-cells", () => {
    // A point in the first quarter of both axes: element 0.
    expect(worldCellQuadMask(cell + 10, cell + 10, cell + 5, cell + 15, cell + 5, cell + 15)).toBe(
      0x8000,
    );
    // a (z) in quarter 2, b (x) in quarter 1: element 6.
    const z = cell + 0x10000 + 10;
    const x = cell + 0x8000 + 10;
    expect(worldCellQuadMask(z, x, z, z, x, x)).toBe(0x8000 >> 6);
    // Spanning a quarters 0..2 and b quarter 0: elements 0, 1 and 2.
    expect(worldCellQuadMask(cell + 0x8000, cell, cell + 0x7000, cell + 0x11000, cell, cell)).toBe(
      0x8000 | (0x8000 >> 1) | (0x8000 >> 2),
    );
  });

  test("a bound off the cell takes its side's end, whichever way it fell", () => {
    expect(
      worldCellQuadMask(cell + 10, cell + 10, cell - 50, cell + 10, cell + 10, cell + 10),
    ).toBe(0x8000);
    expect(
      worldCellQuadMask(cell + 10, cell + 10, cell + 10, cell + 0x30000, cell + 10, cell + 10),
    ).toBe(0x8000 | 0x4000 | 0x2000 | 0x1000);
  });

  test("every Prop's footprint lies in its cell and its cell has a quadtree", () => {
    for (const [mapId, s] of Object.entries(SCENERY_PLACEMENTS)) {
      for (const p of s.props) {
        expect(p.quad, `${mapId} ${p.record}`).toBeGreaterThan(0);
        expect(p.leaf, `${mapId} ${p.record}`).toBeGreaterThanOrEqual(0);
        const tree = s.leafTrees[p.leaf];
        expect([tree.cz, tree.cx]).toEqual([Math.floor((p.ax - 16) / 16), Math.floor(p.ay / 16)]);
        // The anchor is the model's box centre: within a few metres of its origin.
        expect(Math.hypot(p.ax - p.x, p.ay - p.y), `${mapId} ${p.record}`).toBeLessThan(6);
      }
      for (const t of s.leafTrees) expect(t.spheres.length).toBe(42);
    }
  });
});
