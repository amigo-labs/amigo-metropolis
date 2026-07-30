import { describe, expect, test } from "bun:test";
import { createTestMap, sampleHeight } from "@metropolis/sim";
import {
  buildPin,
  buildPinPrompt,
  findNearby,
  pinIdFromCreatedAt,
  rayHitHeightfield,
  worldToGrid,
} from "../src/debug/pinCapture";

describe("worldToGrid", () => {
  test("floors world xz into col/row within map bounds", () => {
    const map = createTestMap();
    const g = worldToGrid(map, map.cellSize * 3.7, map.cellSize * 5.1);
    expect(g.col).toBe(3);
    expect(g.row).toBe(5);
  });

  test("clamps out of bounds to edges", () => {
    const map = createTestMap();
    const lo = worldToGrid(map, -10, -10);
    expect(lo.col).toBe(0);
    expect(lo.row).toBe(0);
    const hi = worldToGrid(map, 1e6, 1e6);
    expect(hi.col).toBe(map.size - 1);
    expect(hi.row).toBe(map.size - 1);
  });
});

describe("rayHitHeightfield", () => {
  test("hits terrain when looking down from above center", () => {
    const map = createTestMap();
    const extent = (map.size - 1) * map.cellSize;
    const cx = extent / 2;
    const cz = extent / 2;
    const h = sampleHeight(map, cx, cz);
    const hit = rayHitHeightfield(map, cx, h + 40, cz, 0, -1, 0);
    expect(hit.source).toBe("heightfield");
    expect(hit.y).toBeCloseTo(h, 3);
    expect(hit.x).toBeCloseTo(cx, 3);
    expect(hit.z).toBeCloseTo(cz, 3);
  });
});

describe("findNearby", () => {
  test("returns sorted features within radius", () => {
    const map = createTestMap();
    if (map.spawns.length === 0) return;
    const s = map.spawns[0];
    const nearby = findNearby(map, s.x, s.y);
    expect(nearby.length).toBeGreaterThan(0);
    for (let i = 1; i < nearby.length; i++) {
      expect(nearby[i].dist).toBeGreaterThanOrEqual(nearby[i - 1].dist);
    }
  });
});

describe("buildPin + prompt", () => {
  test("embeds notes and grid in prompt", () => {
    const pin = buildPin({
      mapId: "test",
      url: "http://localhost/?cam=fly",
      render: "mesh",
      seed: 1,
      tick: 30,
      camera: { x: 1, y: 2, z: 3, yaw: 0.1, pitch: -0.4 },
      hit: { x: 10, y: 1, z: 12, col: 2, row: 3, source: "heightfield" },
      nearby: [{ kind: "turretSpot", id: 0, x: 11, z: 12, dist: 1.2 }],
      notes: "Turret sitzt 1 Zelle zu weit links",
      createdAt: "2026-07-30T12:34:56.789Z",
    });
    expect(pin.version).toBe(1);
    expect(pin.notes).toContain("Turret");
    const prompt = buildPinPrompt(pin);
    expect(prompt).toContain("Turret sitzt 1 Zelle zu weit links");
    expect(prompt).toContain("col=2");
    expect(prompt).toContain("row=3");
    expect(pinIdFromCreatedAt(pin.createdAt)).toBe("20260730-123456");
  });
});
