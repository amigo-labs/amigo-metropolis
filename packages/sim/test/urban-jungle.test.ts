// Schema + playability validation for the committed urban-jungle map (the FCOP
// "Urban Jungle" arena, mission Conft), plus an exact hash pin. The heightfield
// is extracted 1:1 from the original mission (int8, 1/32 m units) by
// tools/fcop/convert.ts; regenerating it changes gameplay everywhere it is
// sampled, so a changed pin means a SIM_VERSION bump + golden regeneration for
// every golden recorded on this map.
//
// Unlike district-01, urban-jungle is NOT 180°-symmetric (FCOP terrain is
// asymmetric) and has no water this stage — the mirror + river assertions are
// deliberately absent.
import { describe, expect, it } from "bun:test";
import { AVATAR_WALKER_MAX_SLOPE } from "../src/balance";
import { crossesWallX, crossesWallY } from "../src/collision";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import { getMapById, isWater, sampleHeight, URBAN_JUNGLE_ID, worldExtent } from "../src/map";

const map = getMapById(URBAN_JUNGLE_ID);
const GROUND_HEIGHT = 0.594; // int 19 * 1/32 m — the flat perimeter ring

describe("urban-jungle schema", () => {
  it("loads with the authored dimensions and feature counts", () => {
    expect(map.size).toBe(257);
    expect(map.cellSize).toBe(1);
    expect(worldExtent(map)).toBe(256);
    expect(map.spawns.length).toBe(2);
    expect(map.basePlots.length).toBe(2);
    expect(map.bases.length).toBe(2);
    expect(map.lanes.length).toBe(3);
    expect(map.turretSpots.length).toBe(4);
    expect(map.outpostSpots.length).toBe(2);
    expect(map.dummySpots.length).toBe(4);
  });

  it("pins the exact FNV-1a hash of the loaded heights", () => {
    const bytes = new Uint8Array(map.heights.buffer);
    expect(fnv1aBytes(fnv1aInit(), bytes, 0, bytes.length)).toBe(HEIGHTS_HASH_PIN);
  });

  it("pins the exact FNV-1a hashes of the wall arrays", () => {
    expect(map.wallsV.length).toBe(257 * 257);
    expect(map.wallsH.length).toBe(257 * 257);
    expect(fnv1aBytes(fnv1aInit(), map.wallsV, 0, map.wallsV.length)).toBe(WALLS_V_PIN);
    expect(fnv1aBytes(fnv1aInit(), map.wallsH, 0, map.wallsH.length)).toBe(WALLS_H_PIN);
  });

  it("lanes never cross a wall (sub-cell sampling, sim semantics)", () => {
    for (const lane of map.lanes) {
      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4);
        let px = a.x;
        let py = a.y;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const cx = a.x + (b.x - a.x) * t;
          const cy = a.y + (b.y - a.y) * t;
          expect(crossesWallX(map, px, cx, py)).toBe(false);
          expect(crossesWallY(map, cx, py, cy)).toBe(false);
          px = cx;
          py = cy;
        }
      }
    }
  });

  it("has no water this stage and keeps all authored features dry", () => {
    let waterCells = 0;
    for (const w of map.waterMask) waterCells += w;
    expect(waterCells).toBe(0);
    for (const s of map.spawns) expect(isWater(map, s.x, s.y)).toBe(false);
    for (const p of [...map.turretSpots, ...map.outpostSpots, ...map.dummySpots]) {
      expect(isWater(map, p.x, p.y)).toBe(false);
    }
  });

  it("spawns sit on their own flat base plots", () => {
    for (let team = 0; team < 2; team++) {
      const s = map.spawns[team];
      const b = map.basePlots[team];
      const d = Math.hypot(s.x - b.x, s.y - b.y);
      expect(d).toBeLessThanOrEqual(b.radius);
      expect(sampleHeight(map, s.x, s.y)).toBeCloseTo(GROUND_HEIGHT, 1);
    }
  });

  it("base structures sit dry on their own flat plots", () => {
    for (let team = 0; team < 2; team++) {
      const base = map.bases[team];
      const plotC = map.basePlots[team];
      expect(base.turrets.length).toBe(4);
      const pts = [
        { x: base.gate.x, y: base.gate.y },
        base.core,
        base.groundConsole,
        base.airConsole,
        { x: base.pad.x, y: base.pad.y },
        ...base.turrets,
      ];
      for (const p of pts) {
        expect(Math.hypot(p.x - plotC.x, p.y - plotC.y)).toBeLessThanOrEqual(plotC.radius);
        expect(isWater(map, p.x, p.y)).toBe(false);
        expect(sampleHeight(map, p.x, p.y)).toBeCloseTo(GROUND_HEIGHT, 1);
      }
    }
  });

  it("every feature coordinate is within bounds", () => {
    const extent = worldExtent(map);
    const ok = (x: number, y: number) => x >= 0 && x <= extent && y >= 0 && y <= extent;
    for (const s of map.spawns) expect(ok(s.x, s.y)).toBe(true);
    for (const p of [...map.turretSpots, ...map.outpostSpots, ...map.dummySpots]) {
      expect(ok(p.x, p.y)).toBe(true);
    }
  });

  it("every lane starts near base 0 and ends near base 1", () => {
    for (const lane of map.lanes) {
      const first = lane[0];
      const last = lane[lane.length - 1];
      const b0 = map.basePlots[0];
      const b1 = map.basePlots[1];
      expect(Math.hypot(first.x - b0.x, first.y - b0.y)).toBeLessThan(b0.radius + 10);
      expect(Math.hypot(last.x - b1.x, last.y - b1.y)).toBeLessThan(b1.radius + 10);
    }
  });

  it("lanes are walker-traversable: dry and within the slope limit", () => {
    for (const lane of map.lanes) {
      for (let i = 0; i < lane.length - 1; i++) {
        const a = lane[i];
        const b = lane[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.ceil(segLen);
        let prevH = sampleHeight(map, a.x, a.y);
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          expect(isWater(map, x, y)).toBe(false);
          const h = sampleHeight(map, x, y);
          const slope = Math.abs(h - prevH) / (segLen / steps);
          expect(slope).toBeLessThan(AVATAR_WALKER_MAX_SLOPE);
          prevH = h;
        }
      }
    }
  });
});

// Pinned after generation (tools/fcop/convert.ts); see file header for the
// regeneration contract.
const HEIGHTS_HASH_PIN = 264067427;
const WALLS_V_PIN = 3595907883;
const WALLS_H_PIN = 3331597098;
