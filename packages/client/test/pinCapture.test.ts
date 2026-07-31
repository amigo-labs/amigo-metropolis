import { describe, expect, test } from "bun:test";
import {
  ANIM_AIRBORNE,
  ANIM_MOVING,
  ARCHETYPE,
  createTestMap,
  SNAPSHOT_STRIDE,
  sampleHeight,
} from "@metropolis/sim";
import {
  animNames,
  archetypeName,
  buildPin,
  buildPinPrompt,
  classifyReproduction,
  createConsoleRing,
  findEntities,
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
    expect(pin.version).toBe(2);
    expect(pin.notes).toContain("Turret");
    const prompt = buildPinPrompt(pin);
    expect(prompt).toContain("Turret sitzt 1 Zelle zu weit links");
    expect(prompt).toContain("col=2");
    expect(prompt).toContain("row=3");
    expect(pinIdFromCreatedAt(pin.createdAt)).toBe("20260730-123456");
  });

  test("defaults the v2 fields so a caller can omit them", () => {
    const pin = buildPin({
      mapId: "test",
      url: "http://localhost/",
      render: "mesh",
      seed: null,
      tick: null,
      camera: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
      hit: { x: 0, y: 0, z: 0, col: 0, row: 0, source: "miss" },
      nearby: [],
      notes: "",
    });
    expect(pin.entities).toEqual([]);
    expect(pin.shots).toEqual([]);
    expect(pin.simHash).toBeNull();
    expect(pin.parentId).toBeNull();
    expect(pin.origin).toBe("hotkey");
    // No entities in frame ⇒ a reshoot reproduces it exactly.
    expect(pin.reproduction).toBe("static");
    // An empty note has to say so: the agent must ask rather than guess.
    expect(buildPinPrompt(pin)).toContain("ask what the problem is");
  });
});

// --- v2 helpers ---------------------------------------------------------------

/** Builds a snapshot buffer the way writeSnapshot lays it out (stride 10). */
function snapshotOf(
  records: readonly {
    id: number;
    archetype: number;
    team: number;
    x: number;
    y: number;
    height?: number;
    yaw?: number;
    anim?: number;
    hpFrac?: number;
    aux?: number;
  }[],
): { snap: Float32Array; count: number } {
  const snap = new Float32Array(records.length * SNAPSHOT_STRIDE);
  records.forEach((r, i) => {
    const o = i * SNAPSHOT_STRIDE;
    snap[o] = r.id;
    snap[o + 1] = r.archetype;
    snap[o + 2] = r.team;
    snap[o + 3] = r.x;
    snap[o + 4] = r.y;
    snap[o + 5] = r.height ?? 0;
    snap[o + 6] = r.yaw ?? 0;
    snap[o + 7] = r.anim ?? 0;
    snap[o + 8] = r.hpFrac ?? 1;
    snap[o + 9] = r.aux ?? 0;
  });
  return { snap, count: records.length };
}

describe("archetypeName / animNames", () => {
  test("decodes the snapshot numbers the agent has to read", () => {
    expect(archetypeName(ARCHETYPE.TURRET)).toBe("TURRET");
    expect(archetypeName(ARCHETYPE.WARDEN)).toBe("WARDEN");
    // Unknown values stay legible rather than becoming undefined.
    expect(archetypeName(999)).toBe("ARCHETYPE_999");
  });

  test("expands the anim bitfield", () => {
    expect(animNames(0)).toEqual([]);
    expect(animNames(ANIM_MOVING | ANIM_AIRBORNE)).toEqual(["moving", "airborne"]);
  });
});

describe("findEntities", () => {
  test("keeps entities within radius, sorted by distance, sim y as world z", () => {
    const { snap, count } = snapshotOf([
      { id: 7, archetype: ARCHETYPE.RUNNER, team: 0, x: 100, y: 130, height: 2 },
      { id: 3, archetype: ARCHETYPE.TURRET, team: -1, x: 100, y: 105 },
      { id: 9, archetype: ARCHETYPE.GUARDIAN, team: 1, x: 100, y: 400 }, // far away
    ]);
    const found = findEntities(snap, count, 100, 100);
    expect(found.map((e) => e.id)).toEqual([3, 7]);
    expect(found[0].archetype).toBe("TURRET");
    expect(found[0].dist).toBeCloseTo(5, 6);
    // Slot 4 is the sim's y, which is world z; slot 5 is the height.
    expect(found[1].z).toBe(130);
    expect(found[1].height).toBe(2);
  });

  test("returns nothing for an empty snapshot", () => {
    expect(findEntities(new Float32Array(0), 0, 0, 0)).toEqual([]);
  });
});

describe("classifyReproduction", () => {
  test("static when only immobile things are in frame", () => {
    const { snap, count } = snapshotOf([
      { id: 1, archetype: ARCHETYPE.TURRET, team: -1, x: 10, y: 10 },
      { id: 2, archetype: ARCHETYPE.CONSOLE, team: -1, x: 12, y: 10 },
    ]);
    expect(classifyReproduction(findEntities(snap, count, 10, 10))).toBe("static");
  });

  test("approximate as soon as something movable is in frame", () => {
    const { snap, count } = snapshotOf([
      { id: 1, archetype: ARCHETYPE.TURRET, team: -1, x: 10, y: 10 },
      { id: 2, archetype: ARCHETYPE.RUNNER, team: 0, x: 12, y: 10 },
    ]);
    expect(classifyReproduction(findEntities(snap, count, 10, 10))).toBe("approximate");
  });

  test("a projectile alone is enough — the frame will not come back", () => {
    const { snap, count } = snapshotOf([
      { id: 5, archetype: ARCHETYPE.PROJECTILE, team: 0, x: 10, y: 10 },
    ]);
    expect(classifyReproduction(findEntities(snap, count, 10, 10))).toBe("approximate");
  });
});

describe("createConsoleRing", () => {
  test("keeps entries oldest-first until it is full", () => {
    const ring = createConsoleRing(3);
    ring.push("warn", "a", 1);
    ring.push("error", "b", 2);
    expect(ring.entries().map((e) => e.text)).toEqual(["a", "b"]);
    expect(ring.entries()[0].level).toBe("warn");
    expect(ring.entries()[1].tick).toBe(2);
  });

  test("drops the oldest once full and still reads oldest-first", () => {
    const ring = createConsoleRing(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.push("log", t, null);
    expect(ring.entries().map((e) => e.text)).toEqual(["c", "d", "e"]);
  });

  test("wraps repeatedly without losing order", () => {
    const ring = createConsoleRing(2);
    for (let i = 0; i < 7; i++) ring.push("log", String(i), i);
    expect(ring.entries().map((e) => e.text)).toEqual(["5", "6"]);
  });

  test("clear empties it", () => {
    const ring = createConsoleRing(2);
    ring.push("log", "a", null);
    ring.clear();
    expect(ring.entries()).toEqual([]);
  });
});
