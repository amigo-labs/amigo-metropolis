// The running radar's rules (render/hud/radar.ts) against hud_radar.c as the RE
// states them (hud.json radar): the octagonal range, the heading-up rotation and
// scale, the markers by unit kind and side.

import { describe, expect, test } from "bun:test";
import { ARCHETYPE, SNAPSHOT_STRIDE, TURRET_CAPTURABLE, TURRET_DEFENSE } from "@metropolis/sim";
import { SCENERY_PLACEMENTS } from "../src/render/arenaScenery.generated";
import {
  ARENA_PRESENTATION,
  HUD,
  RADAR_PALETTE,
  UNIT_MARKERS,
} from "../src/render/fcopPresentation.generated";
import {
  entityCandidates,
  LiveOrder,
  markerOf,
  REGISTRY_LIMIT_TEAM_GAME,
  radarInRange,
  radarPlace,
  radarRegistry,
  registryDistance,
} from "../src/render/hud/radar";
import { SIDE_BLUE, SIDE_RED } from "../src/render/sides";

const R = 0x25555;

describe("range (hud_radar_place_contact 0x0044a950)", () => {
  test("0x25555 world units, about 18.7 m", () => {
    expect(HUD.radar.rangeWu).toBe(R);
    expect(R / 8192).toBeCloseTo(18.67, 2);
  });

  test("along an axis the edge is the range itself", () => {
    expect(radarInRange(R, 0)).toBe(true);
    expect(radarInRange(R + 1, 0)).toBe(false);
    expect(radarInRange(0, -R)).toBe(true);
    expect(radarInRange(0, -R - 1)).toBe(false);
  });

  test("the octagon cuts the square's corners, close to the circle", () => {
    // Inside the square on both axes, outside the octagon.
    expect(radarInRange(R * 0.9, R * 0.9)).toBe(false);
    // On the diagonal the octagon reaches ~0.707 x the range, like a circle.
    const d = Math.trunc(R * 0.69);
    expect(radarInRange(d, d)).toBe(true);
    expect(radarInRange(Math.trunc(R * 0.73), Math.trunc(R * 0.73))).toBe(false);
  });
});

describe("rotation (heading-up, 1.5 / 4096 px a world unit)", () => {
  const out = new Float64Array(2);

  test("3 px a metre: the range sits 55 px out (hud.json range.radius_px640)", () => {
    expect(HUD.radar.pxPerWu * 8192).toBeCloseTo(3, 9);
    radarPlace(R / 8192, 0, 0, out);
    expect(out[1]).toBe(-55); // facing +x: a point 18.7 m ahead is 56 px up
  });

  test("ahead is up and the facing's right is right, whatever the facing", () => {
    for (const facing of [0, 0.7, Math.PI / 2, 2.5, -1.2]) {
      const fx = Math.cos(facing);
      const fy = Math.sin(facing);
      radarPlace(10 * fx, 10 * fy, facing, out);
      expect(out[0]).toBe(0);
      expect(out[1]).toBe(-30);
      // Right of the facing in the sim's (x, y): (-sin, cos), the camera's right.
      radarPlace(-10 * fy, 10 * fx, facing, out);
      expect(out[0]).toBe(30);
      expect(Math.abs(out[1])).toBe(0);
    }
  });
});

describe("markers (radar_markers.json)", () => {
  test("the X1-Alphas: red triangle on side 1, blue on side 2", () => {
    const red = markerOf(ARCHETYPE.AVATAR, SIDE_RED, 0);
    const blue = markerOf(ARCHETYPE.AVATAR, SIDE_BLUE, 0);
    expect(red).toBe(0x31);
    expect(blue).toBe(0x32);
    expect(red >> 5).toBe(1); // triangle
    expect(RADAR_PALETTE[red & 0x1f]).toEqual([255, 0, 0]);
    expect(RADAR_PALETTE[blue & 0x1f]).toEqual([0, 0, 255]);
    expect(markerOf(ARCHETYPE.WARDEN, SIDE_BLUE, 0)).toBe(UNIT_MARKERS.captain);
  });

  test("units: tanks and jets sprites, the Dreadnought and Flying Fortress diamonds", () => {
    expect(markerOf(ARCHETYPE.RUNNER, SIDE_RED, 0)).toBe(0x08);
    expect(markerOf(ARCHETYPE.RUNNER, SIDE_BLUE, 0)).toBe(0x04);
    expect(markerOf(ARCHETYPE.GUARDIAN, SIDE_RED, 0) >> 5).toBe(0);
    expect(markerOf(ARCHETYPE.JUGGERNAUT, SIDE_RED, 0)).toBe(0x48);
    expect(markerOf(ARCHETYPE.FORTRESS, SIDE_BLUE, 0)).toBe(0x44);
  });

  test("turrets: red / blue by side, green while neutral, the captor's once captured", () => {
    expect(markerOf(ARCHETYPE.TURRET, SIDE_RED, TURRET_DEFENSE)).toBe(0x01);
    expect(markerOf(ARCHETYPE.TURRET, SIDE_BLUE, TURRET_DEFENSE)).toBe(0x02);
    expect(markerOf(ARCHETYPE.TURRET, 0, TURRET_CAPTURABLE)).toBe(0x03);
    expect(markerOf(ARCHETYPE.TURRET, SIDE_BLUE, TURRET_CAPTURABLE)).toBe(0x02);
    expect(markerOf(ARCHETYPE.PROJECTILE, SIDE_RED, 0)).toBe(0);
  });

  test("every PA arena carries its outposts' diamonds and two base arrows", () => {
    for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
      expect(a.staticMarkers.filter((m) => m.marker === 0x53).length).toBe(4);
      const arrows = a.contacts.filter((c) => (c.shown & 1) !== 0);
      expect(arrows.map((c) => c.colour).sort()).toEqual([1, 2]);
      expect(a.contacts.filter((c) => (c.shown & 2) !== 0).length).toBe(4);
      expect(a.claimMarkers.length, id).toBe(16);
    }
  });

  test("palette entries from 23 blink (and 0 has no colour)", () => {
    expect(RADAR_PALETTE[0]).toBeNull();
    expect(RADAR_PALETTE.length).toBe(32);
  });
});

describe("the registry (cact_registry_build 0x0043b520, _mp 0x0043b7a0)", () => {
  const WU = 8192;
  const vx = new Float64Array([100, 0]);
  const vy = new Float64Array([100, 0]);

  test("the octagonal distance is |dx| + |dz| - min / 2", () => {
    expect(registryDistance(0x10000, 0)).toBe(0x10000);
    expect(registryDistance(-0x10000, 0x10000)).toBe(0x18000);
  });

  test("everything within 0x38000 while it fits, in live-list order", () => {
    const xs = new Float64Array([100, 100 + 0x37fff / WU, 100 + 0x38000 / WU, Number.NaN]);
    const ys = new Float64Array([100, 100, 100, 100]);
    const member = new Uint8Array(4);
    expect(radarRegistry(xs, ys, 4, vx, vy, 1, REGISTRY_LIMIT_TEAM_GAME, member)).toBe(2);
    expect([...member]).toEqual([1, 1, 0, 0]);
  });

  test("overflowing, it tightens by 0x4000 and gives up after 0x24000", () => {
    // 300 actors: 200 within 0x30000 and 100 more out at 0x33000.
    const n = 300;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n).fill(100);
    for (let k = 0; k < n; k++) xs[k] = 100 + (k < 100 ? 0x33000 : 0x10000) / WU;
    const member = new Uint8Array(n);
    expect(radarRegistry(xs, ys, n, vx, vy, 1, REGISTRY_LIMIT_TEAM_GAME, member)).toBe(200);
    expect(member[0]).toBe(0);
    expect(member[299]).toBe(1);
    // Everything in reach: the last pass (0x24000) keeps the first 0xfe.
    xs.fill(100);
    expect(radarRegistry(xs, ys, n, vx, vy, 1, REGISTRY_LIMIT_TEAM_GAME, member)).toBe(0xfe);
    expect(member[0xfd]).toBe(1);
    expect(member[0xfe]).toBe(0);
  });

  test("two viewpoints: the nearer X1 decides", () => {
    const two = { x: new Float64Array([100, 200]), y: new Float64Array([100, 100]) };
    const xs = new Float64Array([200 + 1, 150]);
    const ys = new Float64Array([100, 100]);
    const member = new Uint8Array(2);
    expect(radarRegistry(xs, ys, 2, two.x, two.y, 1, 0xfe, member)).toBe(0);
    expect(radarRegistry(xs, ys, 2, two.x, two.y, 2, 0xfe, member)).toBe(1);
    expect([...member]).toEqual([1, 0]);
  });
});

describe("the live list's order (cact_link 0x0043ad70: creation order, oldest first)", () => {
  /** A snapshot of [id, archetype, x, y] rows. */
  const snap = (rows: [number, number, number, number][]) => {
    const s = new Float32Array(rows.length * SNAPSHOT_STRIDE);
    rows.forEach(([id, arch, x, y], i) => {
      s[i * SNAPSHOT_STRIDE] = id;
      s[i * SNAPSHOT_STRIDE + 1] = arch;
      s[i * SNAPSHOT_STRIDE + 3] = x;
      s[i * SNAPSHOT_STRIDE + 4] = y;
    });
    return s;
  };
  const ids = (live: LiveOrder, s: Float32Array, m: number) =>
    [...live.order.subarray(0, m)].map((i) => s[i * SNAPSHOT_STRIDE]);

  test("born together they stand in id order; a reused id is the newest", () => {
    const live = new LiveOrder();
    const T = ARCHETYPE.TURRET;
    const R = ARCHETYPE.RUNNER;
    let s = snap([
      [1, T, 0, 0],
      [2, R, 0, 0],
      [3, R, 0, 0],
    ]);
    expect(ids(live, s, live.update(s, 3))).toEqual([1, 2, 3]);
    // 2 dies; the next unit takes id 2 back, after 4 was made.
    s = snap([
      [1, T, 0, 0],
      [3, R, 0, 0],
      [4, R, 0, 0],
    ]);
    expect(ids(live, s, live.update(s, 3))).toEqual([1, 3, 4]);
    s = snap([
      [1, T, 0, 0],
      [2, R, 0, 0],
      [3, R, 0, 0],
      [4, R, 0, 0],
    ]);
    expect(ids(live, s, live.update(s, 4))).toEqual([1, 3, 4, 2]);
    // An id that turns into another archetype is a new actor too.
    s = snap([
      [1, ARCHETYPE.PROJECTILE, 0, 0],
      [2, R, 0, 0],
      [3, R, 0, 0],
      [4, R, 0, 0],
    ]);
    expect(ids(live, s, live.update(s, 4))).toEqual([3, 4, 2, 1]);
  });

  test("the actors with no entity count where they stand: base part, mounts, partner", () => {
    const s = snap([
      [1, ARCHETYPE.TURRET, 1, 2],
      [2, ARCHETYPE.JUGGERNAUT, 3, 4],
      [3, ARCHETYPE.AVATAR, 5, 6],
      [4, ARCHETYPE.RUNNER, 7, 8],
    ]);
    const live = new LiveOrder();
    const m = live.update(s, 4);
    const xs = new Float64Array(32);
    const ys = new Float64Array(32);
    const at = new Int32Array(4);
    // After two placed candidates.
    const n = entityCandidates(s, live.order, m, xs, ys, 2, at);
    expect(n).toBe(2 + 2 + 5 + 2 + 1);
    // The turret's part before it, the four mounts before the hull, the partner after the X1.
    expect([...at]).toEqual([3, 8, 9, 11]);
    expect([...xs.subarray(2, n)]).toEqual([1, 1, 3, 3, 3, 3, 3, 5, 5, 7]);
    expect([...ys.subarray(2, n)]).toEqual([2, 2, 4, 4, 4, 4, 4, 6, 6, 8]);
  });
});

describe("the placed actors' markers", () => {
  test("only live actors: no type-96 Prop (a sound emitter) carries one", () => {
    for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
      const placements = SCENERY_PLACEMENTS[id]?.placements ?? [];
      for (const m of [...a.staticMarkers, ...a.claimMarkers]) {
        const p = placements.find((q) => q.record === m.record);
        expect(p, `${id} ${m.record}`).toBeDefined();
        expect(a.boxes[p?.cobj ?? -1], `${id} ${m.record}`).toBeDefined();
      }
      // The consoles are killed at the claim: their placement stands until then.
      for (const m of a.staticMarkers) {
        expect(placements.find((q) => q.record === m.record)?.show).toBe("unclaimed");
      }
      expect(a.staticMarkers.length, id).toBe(4);
    }
  });
});
