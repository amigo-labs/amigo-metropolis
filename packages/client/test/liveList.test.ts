// The live list the radar's registry walks (render/hud/liveList.ts) against the
// original's: creation order, oldest first (`cact_link` 0x0043ad70 appends at the
// tail), the mission's actors before anything made since, the actors Metropolis
// has no entity for counted, and flag 8 never culled (fcop-fidelity.md V3).

import { describe, expect, test } from "bun:test";
import {
  ARCHETYPE,
  MATCH_PICKUPS,
  MATCH_WARDEN_DIFFICULTY,
  SNAPSHOT_STRIDE,
  TURRET_CAPTURABLE,
} from "@metropolis/sim";
import { SCENERY_PLACEMENTS } from "../src/render/arenaScenery.generated";
import {
  ARENA_PRESENTATION,
  type ArenaPresentation,
  type LoadActor,
} from "../src/render/fcopPresentation.generated";
import {
  createLiveList,
  LIVE_ENTITY,
  LIVE_OTHER,
  LIVE_PICKUP,
  LIVE_PLACED,
  NO_SPAWNED,
} from "../src/render/hud/liveList";
import { REGISTRY_LIMIT_TEAM_GAME, radarRegistry } from "../src/render/hud/radar";

const UNITS = {
  noCull: {
    tank: true,
    jet: true,
    fortress: true,
    dreadnought: true,
    turret: true,
    neutralTurret: true,
    pickup: false,
  },
  turretParts: 1,
  dreadnoughtMounts: 4,
};

function arenaOf(loadActors: LoadActor[], spawned = UNITS): ArenaPresentation {
  return {
    mission: "",
    team0Side: 1,
    reticle: 0,
    contacts: [],
    staticMarkers: [],
    claimMarkers: [],
    boxes: {},
    loadActors,
    spawned,
  };
}

/** A snapshot of [id, archetype, team, x, y, aux] rows. */
function snap(rows: [number, number, number, number, number, number?][]): Float32Array {
  const out = new Float32Array(rows.length * SNAPSHOT_STRIDE);
  rows.forEach((r, i) => {
    const o = i * SNAPSHOT_STRIDE;
    out[o] = r[0];
    out[o + 1] = r[1];
    out[o + 2] = r[2];
    out[o + 3] = r[3];
    out[o + 4] = r[4];
    out[o + 9] = r[5] ?? 0;
  });
  return out;
}

const match = new Float32Array(64);
const NONE = new Uint8Array(0);

/** The entity ids of the live list's entity candidates, in order. */
function entityIds(list: ReturnType<typeof createLiveList>, s: Float32Array): number[] {
  const ids: number[] = [];
  for (let k = 0; k < list.out.n; k++) {
    if (list.out.kind[k] === LIVE_ENTITY) ids.push(s[list.out.ref[k] * SNAPSHOT_STRIDE]);
  }
  return ids;
}

describe("creation order (cact_link appends at the tail)", () => {
  test("oldest first, not by id; a frame's newcomers by id", () => {
    const list = createLiveList("test", arenaOf([]), [], []);
    let s = snap([
      [2, ARCHETYPE.RUNNER, 0, 10, 10],
      [5, ARCHETYPE.RUNNER, 1, 20, 10],
    ]);
    list.build(match, s, 2, NONE);
    expect(entityIds(list, s)).toEqual([2, 5]);
    // Id 1 is made later: it joins at the tail, behind 5.
    s = snap([
      [1, ARCHETYPE.GUARDIAN, 0, 30, 10],
      [2, ARCHETYPE.RUNNER, 0, 10, 10],
      [5, ARCHETYPE.RUNNER, 1, 20, 10],
    ]);
    list.build(match, s, 3, NONE);
    expect(entityIds(list, s)).toEqual([2, 5, 1]);
    // Id 2 dies; id 2 comes back as a round: a new actor, at the tail.
    s = snap([
      [1, ARCHETYPE.GUARDIAN, 0, 30, 10],
      [2, ARCHETYPE.PROJECTILE, 0, 10, 10],
      [5, ARCHETYPE.RUNNER, 1, 20, 10],
    ]);
    list.build(match, s, 3, NONE);
    expect(entityIds(list, s)).toEqual([5, 1, 2]);
  });

  test("the mission's actors first; an X1 behind its partner, kept while down", () => {
    const load: LoadActor[] = [
      { kind: "partner", type: 0x12, x: 5, y: 5, noCull: true, side: 1 },
      { kind: "x1", type: 1, x: 5, y: 5, noCull: true, side: 1 },
      { kind: "fixed", type: 14, x: 50, y: 50, noCull: false },
    ];
    const list = createLiveList("test", arenaOf(load), [], []);
    let s = snap([
      [0, ARCHETYPE.RUNNER, 0, 10, 10],
      [3, ARCHETYPE.AVATAR, 0, 7, 8],
    ]);
    list.build(match, s, 2, NONE);
    const o = list.out;
    expect(o.n).toBe(4);
    expect([o.kind[0], o.kind[1], o.kind[2], o.kind[3]]).toEqual([
      LIVE_OTHER, // the partner
      LIVE_ENTITY, // the X1
      LIVE_OTHER, // the type-14 actor
      LIVE_ENTITY, // the tank
    ]);
    expect([o.x[0], o.y[0], o.x[1], o.noCull[0], o.noCull[1]]).toEqual([7, 8, 7, 1, 1]);
    expect([o.x[2], o.noCull[2]]).toEqual([50, 0]);
    // The X1 is down: the original's mech is still the same actor, where it was.
    s = snap([[0, ARCHETYPE.RUNNER, 0, 10, 10]]);
    list.build(match, s, 1, NONE);
    expect(o.n).toBe(4);
    expect([o.kind[1], o.x[1], o.y[1]]).toEqual([LIVE_OTHER, 7, 8]);
  });

  test("an X1 that never plays is no actor (the second X1's load gate)", () => {
    const load: LoadActor[] = [
      { kind: "partner", type: 0x12, x: 5, y: 5, noCull: true, side: 2 },
      { kind: "x1", type: 1, x: 5, y: 5, noCull: true, side: 2 },
    ];
    const list = createLiveList("test", arenaOf(load), [], []);
    const s = snap([[3, ARCHETYPE.AVATAR, 0, 7, 8]]);
    list.build(match, s, 1, NONE);
    expect(list.out.n).toBe(0);
  });

  test("the Sky Captain of the level's band", () => {
    const load: LoadActor[] = [
      { kind: "captain", type: 37, x: 1, y: 1, noCull: true, levels: [0, 1, 2] },
      { kind: "fixed", type: 14, x: 2, y: 2, noCull: false },
      { kind: "captain", type: 37, x: 3, y: 3, noCull: true, levels: [3, 4, 5, 6, 7, 8, 9] },
    ];
    const list = createLiveList("test", arenaOf(load), [], []);
    const s = snap([[9, ARCHETYPE.WARDEN, 1, 40, 40]]);
    const m = new Float32Array(64);
    m[MATCH_WARDEN_DIFFICULTY] = 0; // level 0
    list.build(m, s, 1, NONE);
    expect([list.out.n, list.out.kind[0], list.out.x[0]]).toEqual([2, LIVE_ENTITY, 40]);
    m[MATCH_WARDEN_DIFFICULTY] = 10; // the top of the ladder
    const high = createLiveList("test", arenaOf(load), [], []);
    high.build(m, s, 1, NONE);
    expect([high.out.n, high.out.kind[1], high.out.x[1]]).toEqual([2, LIVE_ENTITY, 40]);
  });

  test("a turret's part and a Dreadnought's mounts stand in front of them", () => {
    const list = createLiveList("test", arenaOf([]), [], []);
    const s = snap([
      [0, ARCHETYPE.TURRET, 0, 10, 10, TURRET_CAPTURABLE],
      [1, ARCHETYPE.JUGGERNAUT, 1, 20, 20],
      [2, ARCHETYPE.PROJECTILE, 1, 30, 30],
    ]);
    list.build(match, s, 3, NONE);
    const o = list.out;
    expect(o.n).toBe(2 + 5 + 1);
    // The part: culled (its construct clears flag 8); the turret: never.
    expect([o.kind[0], o.noCull[0], o.kind[1], o.noCull[1]]).toEqual([
      LIVE_OTHER,
      0,
      LIVE_ENTITY,
      1,
    ]);
    // The mounts keep their Dreadnought's flag 8.
    for (let k = 2; k < 6; k++)
      expect([o.kind[k], o.noCull[k], o.x[k]]).toEqual([LIVE_OTHER, 1, 20]);
    expect([o.kind[6], o.noCull[6]]).toEqual([LIVE_ENTITY, 1]);
    // A round: the spawner's `or al, 8`.
    expect([o.kind[7], o.noCull[7]]).toEqual([LIVE_ENTITY, 1]);
  });

  test("pickups and spawned placements join when they stand, and leave when they go", () => {
    const placements = [
      { record: "Cact 1", x: 1, y: 1 },
      { record: "Csac 2", x: 2, y: 2 },
    ];
    const load: LoadActor[] = [
      { kind: "placed", type: 11, x: 1, y: 1, noCull: false, record: "Cact 1" },
    ];
    const pickups = [
      { x: 10, y: 10 },
      { x: 11, y: 11 },
    ];
    const list = createLiveList("test", arenaOf(load), placements, pickups);
    const m = new Float32Array(64);
    m[MATCH_PICKUPS] = 0b10;
    const stands = new Uint8Array([0, 0]);
    list.build(m, new Float32Array(0), 0, stands);
    const o = list.out;
    // The console, not standing, still holds its place; then pickup 1.
    expect(o.n).toBe(2);
    expect([o.kind[0], Number.isNaN(o.x[0]), o.kind[1], o.ref[1]]).toEqual([
      LIVE_PLACED,
      true,
      LIVE_PICKUP,
      1,
    ]);
    // The terminal is spawned, then pickup 0 respawns: both behind pickup 1.
    stands[1] = 1;
    list.build(m, new Float32Array(0), 0, stands);
    m[MATCH_PICKUPS] = 0b11;
    list.build(m, new Float32Array(0), 0, stands);
    expect(o.n).toBe(4);
    expect([o.kind[2], o.ref[2], o.kind[3], o.ref[3]]).toEqual([LIVE_PLACED, 1, LIVE_PICKUP, 0]);
    expect([o.ref[1], o.noCull[3]]).toEqual([1, 0]);
  });
});

describe("the registry over the live list", () => {
  const WU = 8192;
  const vx = new Float64Array([100]);
  const vy = new Float64Array([100]);

  test("a flag-8 actor is inside at every radius and counts toward the 0xfe", () => {
    const xs = new Float64Array([100 + 0x40000 / WU, 100 + 0x40000 / WU, 100]);
    const ys = new Float64Array([100, 100, 100]);
    const noCull = new Uint8Array([1, 0, 0]);
    const member = new Uint8Array(3);
    expect(radarRegistry(xs, ys, 3, vx, vy, 1, 0xfe, member, noCull)).toBe(2);
    expect([...member]).toEqual([1, 0, 1]);
  });

  test("never-culled actors past the limit: the oldest 0xfe stay, the newest drop", () => {
    const n = 300;
    const xs = new Float64Array(n).fill(100 + 0x60000 / WU);
    const ys = new Float64Array(n).fill(100);
    const noCull = new Uint8Array(n).fill(1);
    const member = new Uint8Array(n);
    expect(radarRegistry(xs, ys, n, vx, vy, 1, REGISTRY_LIMIT_TEAM_GAME, member, noCull)).toBe(
      0xfe,
    );
    expect(member[0]).toBe(1);
    expect(member[0xfd]).toBe(1);
    expect(member[0xfe]).toBe(0);
  });
});

describe("the arenas' live lists (gen:presentation loadActors)", () => {
  for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
    test(id, () => {
      const kinds = a.loadActors.map((k) => k.kind);
      // Both X1s, each behind its partner, both never culled.
      for (const side of [1, 2]) {
        const x1 = a.loadActors.findIndex((k) => k.kind === "x1" && k.side === side);
        expect(x1, `${id} X1 ${side}`).toBeGreaterThan(0);
        expect(a.loadActors[x1 - 1].kind).toBe("partner");
        expect(a.loadActors[x1 - 1].side).toBe(side);
        expect(a.loadActors[x1].noCull && a.loadActors[x1 - 1].noCull).toBe(true);
      }
      // Every level 0..9 has exactly one Sky Captain record.
      const bands = a.loadActors.flatMap((k) => (k.kind === "captain" ? (k.levels ?? []) : []));
      expect([...bands].sort((p, q) => p - q)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // The 24 type-11 records are scenery placements.
      const placements = SCENERY_PLACEMENTS[id]?.placements ?? [];
      const placed = a.loadActors.filter((k) => k.kind === "placed");
      expect(placed.length).toBe(24);
      for (const p of placed) expect(placements.some((q) => q.record === p.record)).toBe(true);
      // The objective (type 35) carries flag 8; no type-96 Prop is an actor.
      expect(a.loadActors.find((k) => k.type === 35)?.noCull).toBe(true);
      expect(a.loadActors.some((k) => k.type >= 87)).toBe(false);
      expect(kinds.length).toBeGreaterThan(50);
      // Every unit and turret is never culled; a pickup is.
      expect(a.spawned.noCull).toEqual(UNITS.noCull);
      expect([a.spawned.turretParts, a.spawned.dreadnoughtMounts]).toEqual([1, 4]);
    });
  }

  test("a debug map's live list is its entities alone", () => {
    const list = createLiveList("test", arenaOf([], NO_SPAWNED), [], []);
    const s = snap([[0, ARCHETYPE.TURRET, 0, 1, 1]]);
    list.build(match, s, 1, NONE);
    expect([list.out.n, list.out.noCull[0]]).toEqual([1, 0]);
  });
});
