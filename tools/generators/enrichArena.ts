// STAGE 2 of the arena pipeline: rewrites a committed map JSON's gameplay
// features from the original Precinct Assault logic, leaving its terrain alone.
//
//   bun run gen:arena [la-cantina]
//
// WHY A SECOND STAGE
// Stage 1 (convert.ts) turns the private extracted terrain into
// packages/sim/maps/<id>.json. It needs a heightmap dump that is not part of
// this repo, and its feature lists were hand-authored per arena. This stage
// takes the COMMITTED map as its terrain input and the COMMITTED
// tools/generators/fcop/<mission>-logic.json as its feature input, so the whole
// step is reproducible in-tree and touches only `spawns` downwards.
//
// THE FRAME (the thing that was wrong before)
// Actor coordinates and the sim heightfield are the same 0-based grid, offset by
// exactly one Til on X and nothing on Z. Three independent measurements agree:
//   - the 106 gameplay actors are perfectly mirror-symmetric about actor x 96.0
//     (score 1.00) and the heightfield about col 112.0 (score 0.992) -> +16;
//   - the terrain .glb's min corner lands on sim x 16 (render/mapAlign.generated.ts);
//   - at +16 the X1Alpha spawns land on heights 32 (the two 1 m base platforms)
//     and the capturable turrets on three flat tiers, where at +0 they scatter
//     across pits and wall tops.
// The previously authored features carried no offset, which is why they needed
// hand-snapping onto walkable ground (git 7966c99) and why lanes had to detour
// around a "fragmented west maze" that was really the edge-repeat apron.
//
// Authoring-time only, like convert.ts: any Math.* is fine, the committed JSON
// is the artifact.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AVATAR_WALKER_MAX_SLOPE,
  crossesWallX,
  crossesWallY,
  loadMapFromJson,
  type MapData,
  type MapJson,
  sampleHeight,
} from "@metropolis/sim";
import { fovToCos, rangeToCells, rotToYaw, toSimTicks, turnSpeedToRadPerTick } from "./fcopLogic";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TICK_HZ = 30; // packages/sim/src/balance.ts

/** Grid offset from the original actor frame to the sim heightfield frame. */
const LOGIC_OFFSET_X = 16;
const LOGIC_OFFSET_Z = 0;

/**
 * Damage per shot for the imported weapon profiles.
 *
 * NOT in the extracted data: the original stores weapon_id 3, and the weapon
 * table it indexes was not decoded. Kept at the pre-PA global TURRET_DAMAGE so
 * importing the originals changes reach and cadence — which ARE data — without
 * silently inventing a damage curve. Tuning lives in balance.ts.
 */
const TURRET_DAMAGE = 15;

/**
 * Pickup kinds (must match balance.ts PICKUP_*).
 *
 * The original's 8 grant kinds do not map one-to-one, because Metropolis'
 * primary weapon has infinite ammo (rules.md §2) and has no damage-boost
 * concept of its own. The adaptation is deliberate and recorded here:
 *   reload_gun       -> HEAVY_AMMO   (nearest meaningful refill)
 *   reload_heavy     -> HEAVY_AMMO
 *   reload_special   -> SPECIAL_AMMO
 *   restore_health   -> HEALTH
 *   power_up_*       -> POWER        (temporary damage boost)
 *   invisibility     -> INVIS
 */
const PICKUP_KIND: Record<string, number> = {
  reload_gun: 0,
  reload_heavy: 0,
  reload_special: 1,
  restore_health: 2,
  invisibility: 4,
  power_up_gun: 5,
  power_up_heavy: 5,
  power_up_special: 5,
};

/** balance.ts TRIGGER_WATCH_* bits. */
const WATCH_ENEMY_AVATAR = 1 << 0;
const WATCH_ENEMY_UNITS = 1 << 1;

interface Logic {
  mission: string;
  mapId: string;
  spawns: { id: number; x: number; z: number }[];
  bases: {
    id: number;
    x: number;
    z: number;
    team: number;
    health: number;
    netId: number;
    spawnTicks: number;
    spawnLimit: number;
    defenceWeaponCount: number;
    defenceWeapon: { engageRangeRaw: number; targetingDelayRaw: number; fovRaw: number };
  }[];
  turrets: Turret[];
  neutrals: Turret[];
  pickups: { id: number; x: number; z: number; grants: string[]; spawnTicks: number }[];
  triggers: {
    id: number;
    x: number;
    z: number;
    widthRaw: number;
    lengthRaw: number;
    flags: string[];
    watchesActor: number;
  }[];
  props: { id: number; x: number; z: number; height: number; objId: number }[];
  nets: { netId: number; nodes: { x: number; z: number; neighbours: number[] }[] }[];
}

interface Turret {
  id: number;
  x: number;
  z: number;
  team: number;
  health: number;
  gunRotationRaw: number;
  turnSpeedRaw: number;
  shooter: { engageRangeRaw: number; targetingDelayRaw: number; fovRaw: number };
  spawnTicks: number;
}

interface Weapon {
  range: number;
  delay: number;
  damage: number;
  turnSpeed: number;
  fovCos: number;
}

const sx = (x: number): number => x + LOGIC_OFFSET_X;
const sz = (z: number): number => z + LOGIC_OFFSET_Z;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Spawn list in sim coordinates, north first — the reachability flood's origin. */
function out0Spawns(
  spawnsByZ: { x: number; z: number }[],
): { x: number; y: number; yaw: number }[] {
  return spawnsByZ.map((s, team) => ({
    x: round4(sx(s.x)),
    y: round4(sz(s.z)),
    yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
  }));
}

/** Interns weapon profiles so identical originals share one index. */
class WeaponTable {
  readonly list: Weapon[] = [];
  intern(w: Weapon): number {
    const key = (x: Weapon) => `${x.range}|${x.delay}|${x.damage}|${x.turnSpeed}|${x.fovCos}`;
    const k = key(w);
    for (let i = 0; i < this.list.length; i++) if (key(this.list[i]) === k) return i;
    this.list.push(w);
    return this.list.length - 1;
  }
}

function turretWeapon(t: Turret, table: WeaponTable): number {
  return table.intern({
    range: rangeToCells(t.shooter.engageRangeRaw),
    delay: toSimTicks(t.shooter.targetingDelayRaw, TICK_HZ),
    damage: TURRET_DAMAGE,
    turnSpeed: round4(turnSpeedToRadPerTick(t.turnSpeedRaw, TICK_HZ)),
    fovCos: fovToCos(t.shooter.fovRaw),
  });
}

// ---------------------------------------------------------------------------
// Lane graph
// ---------------------------------------------------------------------------

interface Graph {
  nodes: { x: number; z: number }[];
  edges: number[][];
  nextHopA: number[][];
  nextHopB: number[][];
  entry: number[];
}

/**
 * Merges both original Cnet graphs into one node list and precomputes, per team,
 * a next-hop signpost toward the enemy base.
 *
 * The search happens HERE, once, at authoring time. That is what keeps
 * rules.md §6's "no runtime pathfinding" true in substance: the sim reads one
 * array entry per waypoint and, at a fork, flips one seeded coin.
 */
function buildGraph(logic: Logic, teamNet: number[], enemyBase: { x: number; z: number }[]): Graph {
  const nodes: { x: number; z: number }[] = [];
  const edges: number[][] = [];
  const offsetOf = new Map<number, number>();

  for (const net of logic.nets) {
    offsetOf.set(net.netId, nodes.length);
    const base = nodes.length;
    for (const n of net.nodes) nodes.push({ x: round4(sx(n.x)), z: round4(sz(n.z)) });
    for (const n of net.nodes) {
      edges.push(n.neighbours.map((nb) => (nb < 0 ? -1 : base + nb)));
    }
  }

  const n = nodes.length;
  const nextHopA: number[][] = [new Array(n).fill(-1), new Array(n).fill(-1)];
  const nextHopB: number[][] = [new Array(n).fill(-1), new Array(n).fill(-1)];
  const entry: number[] = [];

  for (let team = 0; team < 2; team++) {
    const net = logic.nets.find((x) => x.netId === teamNet[team]);
    if (!net) throw new Error(`no net ${teamNet[team]} for team ${team}`);
    const base = offsetOf.get(net.netId) as number;
    const ids: number[] = [];
    for (let k = 0; k < net.nodes.length; k++) ids.push(base + k);

    // Goal = the node of this team's own net closest to the ENEMY base, i.e.
    // the far end of its road.
    const goalTarget = enemyBase[team];
    let goal = ids[0];
    let bestD = Infinity;
    for (const id of ids) {
      const d = Math.hypot(nodes[id].x - goalTarget.x, nodes[id].z - goalTarget.z);
      if (d < bestD) {
        bestD = d;
        goal = id;
      }
    }

    // The Cnet is DIRECTED (fcop-logic.md §3.1), so "hops to the goal" has to be
    // measured by walking edges BACKWARDS from the goal. Searching forwards from
    // it would map the roads leading away from the enemy base instead.
    const predecessors = new Map<number, number[]>();
    for (const id of ids) {
      for (const nb of edges[id]) {
        if (nb < 0) continue;
        const list = predecessors.get(nb);
        if (list) list.push(id);
        else predecessors.set(nb, [id]);
      }
    }
    const dist = new Map<number, number>();
    dist.set(goal, 0);
    const queue = [goal];
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head];
      for (const from of predecessors.get(at) ?? []) {
        if (dist.has(from)) continue;
        dist.set(from, (dist.get(at) as number) + 1);
        queue.push(from);
      }
    }

    for (const id of ids) {
      if (id === goal) continue;
      const here = dist.get(id);
      if (here === undefined) continue; // unreachable from the goal: no signpost
      const downhill: number[] = [];
      for (const nb of edges[id]) {
        if (nb < 0) continue;
        const there = dist.get(nb);
        if (there !== undefined && there < here) downhill.push(nb);
      }
      // Deterministic order so the artifact never depends on iteration luck.
      downhill.sort((a, b) => a - b);
      nextHopA[team][id] = downhill[0] ?? -1;
      nextHopB[team][id] = downhill[1] ?? -1;
    }

    // The team's road starts at its own base — node 0 of its net by construction
    // (fcop-logic.md §8.1, asserted in tools/generators/test/fcopLogic.test.ts).
    entry.push(base);
    if (!dist.has(base)) {
      throw new Error(`team ${team} entry node is not connected to its goal node`);
    }
  }

  return { nodes, edges, nextHopA, nextHopB, entry };
}

/** Walks the committed signposts into a plain polyline, for `lanes`. */
function graphRoute(graph: Graph, team: number): number[][] {
  const out: number[][] = [];
  let at = graph.entry[team];
  const seen = new Set<number>();
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    out.push([graph.nodes[at].x, graph.nodes[at].z]);
    at = graph.nextHopA[team][at];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wall reconciliation
// ---------------------------------------------------------------------------

/**
 * Clears the wall bits that block the original roads, and reports how many.
 *
 * The offset was checked first (the owner's call): at +16 exactly 22 of 246 lane
 * edges are blocked, and every other shift is at least twice as bad, so the wall
 * lattice is NOT misaligned — these are residual conflicts, not a mapping bug.
 * Five of them are the ring's 36-38 cell straightaways, where 6 of 8 blocking
 * cells sit on an upper deck in the source terrain: the original road runs UNDER
 * a bridge, and flattening Mp to one storey turned that bridge into a wall. The
 * rest are short diagonals clipping a wall corner.
 *
 * Clearing them is therefore restoring roads the original drives, not deleting
 * original walls — but it is still a change to extracted data, so it is counted
 * and thresholded rather than done silently.
 */
function carveLaneWalls(
  map: MapData,
  wallsV: string[],
  wallsH: string[],
  graph: Graph,
  limit: number,
): number {
  const size = map.size;
  const v = wallsV.map((row) => row.split(""));
  const h = wallsH.map((row) => row.split(""));
  let cleared = 0;

  // The sim's own movement semantics, so what we clear is exactly what would
  // have stopped a unit (collision.ts crossesWallX/Y).
  const clearAlong = (ax: number, az: number, bx: number, bz: number): void => {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) * 4);
    let px = ax;
    let py = az;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const cx = ax + (bx - ax) * t;
      const cy = az + (bz - az) * t;
      if (crossesWallX(map, px, cx, py)) {
        const row = Math.floor(py / map.cellSize);
        const lo = Math.min(px, cx) / map.cellSize;
        const hi = Math.max(px, cx) / map.cellSize;
        for (let i = Math.ceil(lo); i <= Math.floor(hi); i++) {
          if (row >= 0 && row < size && i >= 0 && i < size && v[row][i] === "1") {
            v[row][i] = "0";
            cleared++;
          }
        }
      }
      if (crossesWallY(map, cx, py, cy)) {
        const col = Math.floor(cx / map.cellSize);
        const lo = Math.min(py, cy) / map.cellSize;
        const hi = Math.max(py, cy) / map.cellSize;
        for (let j = Math.ceil(lo); j <= Math.floor(hi); j++) {
          if (col >= 0 && col < size && j >= 0 && j < size && h[j][col] === "1") {
            h[j][col] = "0";
            cleared++;
          }
        }
      }
      px = cx;
      py = cy;
    }
  };

  for (let k = 0; k < graph.nodes.length; k++) {
    for (const nb of graph.edges[k]) {
      if (nb < 0 || nb <= k) continue;
      const a = graph.nodes[k];
      const b = graph.nodes[nb];
      clearAlong(a.x, a.z, b.x, b.z);
    }
  }

  if (cleared > limit) {
    throw new Error(
      `carved ${cleared} wall bits to open the original roads, over the ${limit} limit — ` +
        "that many means the frame offset is wrong again, not that the arena needs it",
    );
  }
  for (let j = 0; j < size; j++) {
    wallsV[j] = v[j].join("");
    wallsH[j] = h[j].join("");
  }
  return cleared;
}

/** 4-connected cell flood over the wall graph, matching mapConnectivity.test.ts. */
function floodFrom(map: MapData, ax: number, ay: number): Set<number> {
  const cell = map.cellSize;
  const half = cell * 0.5;
  const ext = (map.size - 1) * cell;
  const ci = (v: number): number => Math.min(map.size - 1, Math.max(0, Math.floor(v / cell)));
  const cc = (v: number): number => (Math.floor(v / cell) + 0.5) * cell;
  const key = (i: number, j: number): number => i * map.size + j;
  const q: number[][] = [[cc(ax), cc(ay)]];
  const seen = new Set<number>([key(ci(cc(ax)), ci(cc(ay)))]);
  const dirs = [
    [cell, 0],
    [-cell, 0],
    [0, cell],
    [0, -cell],
  ] as const;
  for (let qi = 0; qi < q.length; qi++) {
    const [x, y] = q[qi];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < half || ny < half || nx > ext - half || ny > ext - half) continue;
      const k = key(ci(nx), ci(ny));
      if (seen.has(k)) continue;
      if (dx !== 0 && crossesWallX(map, x, nx, y)) continue;
      if (dy !== 0 && crossesWallY(map, x, y, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return seen;
}

/**
 * Opens the minimum number of extra wall bits needed to make every lane node and
 * capture spot reachable from a spawn.
 *
 * Same root cause as the lane carve: Mp is a bridged, multi-storey arena in the
 * source terrain (uses_bridges, 2 layer masks, 1566 multi-level points), and
 * flattening it to one storey walls off the outer ring corridor that the original
 * reaches over and under bridges. Without this, 8 of the 32 capturable pads and
 * 8 lane nodes are permanently unreachable — dead content, and unwinnable lanes.
 *
 * Modelling the decks properly is the deeper fix and stays on the list; this is
 * the honest single-storey approximation, and it is counted so the size of the
 * approximation is visible rather than buried.
 */
function repairReachability(
  raw: MapJson,
  wallsV: string[],
  wallsH: string[],
  targets: { x: number; y: number }[],
  limit: number,
): number {
  const size = raw.size;
  const v = wallsV.map((row) => row.split(""));
  const h = wallsH.map((row) => row.split(""));
  let opened = 0;

  const rebuild = (): MapData =>
    loadMapFromJson({
      ...raw,
      wallsV: v.map((r) => r.join("")),
      wallsH: h.map((r) => r.join("")),
    });

  const writeBack = (): void => {
    for (let j = 0; j < size; j++) {
      wallsV[j] = v[j].join("");
      wallsH[j] = h[j].join("");
    }
  };

  // One breach per pass, because each breach can pull a whole region into the
  // flood and make most of the remaining targets reachable for free.
  for (let pass = 0; pass < 200; pass++) {
    const map = rebuild();
    const reached = floodFrom(map, raw.spawns[0].x, raw.spawns[0].y);
    const ci = (val: number): number => Math.min(size - 1, Math.max(0, Math.floor(val)));
    const missing = targets.filter((t) => !reached.has(ci(t.x) * size + ci(t.y)));
    if (missing.length === 0) {
      writeBack();
      return opened;
    }

    // Cell BFS that ignores walls, from the whole reached set outward, so each
    // unreachable target gets the SHORTEST breach path rather than an arbitrary
    // one. Recomputed per pass because each breach grows the reached set.
    const from = new Int32Array(size * size).fill(-1);
    const queue: number[] = [];
    for (const k of reached) {
      from[k] = k;
      queue.push(k);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const at = queue[qi];
      const i = Math.floor(at / size);
      const j = at % size;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
        const nk = ni * size + nj;
        if (from[nk] !== -1) continue;
        from[nk] = at;
        queue.push(nk);
      }
    }

    // Walk one target back to the reached set and clear the bits in the way.
    const target = missing[0];
    let at = ci(target.x) * size + ci(target.y);
    let guard = 0;
    while (!reached.has(at) && guard++ < size * 4) {
      const prev = from[at];
      if (prev < 0 || prev === at) break;
      const i = Math.floor(at / size);
      const j = at % size;
      const pi = Math.floor(prev / size);
      const pj = prev % size;
      if (i !== pi) {
        // Step across the vertical line between columns min(i,pi)+1 in row j.
        const line = Math.max(i, pi);
        if (v[j][line] === "1") {
          v[j][line] = "0";
          opened++;
        }
      } else {
        const line = Math.max(j, pj);
        if (h[line][i] === "1") {
          h[line][i] = "0";
          opened++;
        }
      }
      at = prev;
    }
    if (opened > limit) {
      throw new Error(
        `opened ${opened} wall bits repairing reachability, over the ${limit} limit — ` +
          "check the frame offset before widening this",
      );
    }
  }
  throw new Error("reachability repair did not converge in 200 passes");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function enrich(mapId: string, mission: string): void {
  const mapPath = join(REPO_ROOT, "packages", "sim", "maps", `${mapId}.json`);
  const raw = JSON.parse(readFileSync(mapPath, "utf8")) as MapJson;
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", `${mission}-logic.json`), "utf8"),
  ) as Logic;

  // Metropolis team 0 is the north spawn; the original's north base carries team
  // byte 2, and each base drives its own Cnet (fcop-logic.md §8.1).
  const spawnsByZ = [...logic.spawns].sort((a, b) => a.z - b.z);
  const basesByZ = [...logic.bases].sort((a, b) => a.z - b.z);
  const teamNet = [basesByZ[0].netId, basesByZ[1].netId];
  const enemyBase = [
    { x: sx(basesByZ[1].x), z: sz(basesByZ[1].z) },
    { x: sx(basesByZ[0].x), z: sz(basesByZ[0].z) },
  ];

  const table = new WeaponTable();

  // --- bases -------------------------------------------------------------
  // The two `action_button` triggers per base are the base's own interaction
  // points (fcop-logic.md §8.6: they watch that base's own X1Alpha), so they are
  // the build consoles. The original does not label which is which; their
  // footprints differ consistently across both bases, so the wider one is the
  // ground console. Deterministic, symmetric, and derived rather than invented.
  const bases = basesByZ.map((base, team) => {
    const own = spawnsByZ[team];
    const buttons = logic.triggers
      .filter((t) => t.flags.includes("action_button") && t.watchesActor === own.id)
      .sort((a, b) => b.widthRaw - a.widthRaw || a.id - b.id);
    if (buttons.length < 2) {
      throw new Error(`base ${team} has ${buttons.length} action-button triggers, need 2`);
    }
    const core = [round4(sx(base.x)), round4(sz(base.z))];
    const ring = logic.turrets
      .filter((t) => t.team === base.team)
      .sort((a, b) => a.id - b.id)
      // MapBase.turrets caps at 16 and the original places exactly 16 per base.
      .slice(0, 16);

    return {
      // The base structure IS the objective under the original rules, so the
      // gate volume sits on it. With coreHp set, systemWinCheck uses the core;
      // the gate still anchors lane termination and produced-unit heading.
      gate: { x: core[0], y: core[1], radius: 4 },
      core,
      groundConsole: [round4(sx(buttons[0].x)), round4(sz(buttons[0].z))],
      airConsole: [round4(sx(buttons[1].x)), round4(sz(buttons[1].z))],
      pad: { x: core[0], y: core[1], radius: 3 },
      turrets: ring.map((t) => [round4(sx(t.x)), round4(sz(t.z))]),
      defence: new Array(base.defenceWeaponCount).fill(0).map(() => ({
        x: core[0],
        y: core[1],
        weapon: table.intern({
          range: rangeToCells(base.defenceWeapon.engageRangeRaw),
          delay: toSimTicks(base.defenceWeapon.targetingDelayRaw, TICK_HZ),
          damage: TURRET_DAMAGE,
          // BaseShooter carries no turn_speed: the base's built-in guns do not
          // slew, they just fire (fcop-logic.md §8.1).
          turnSpeed: 0,
          fovCos: fovToCos(base.defenceWeapon.fovRaw),
        }),
        hp: base.health,
      })),
      coreHp: base.health,
      productionTicks: toSimTicks(base.spawnTicks, TICK_HZ),
      // The original's spawn_limit is 1 per cycle, not a population cap. The cap
      // is ours: without one, 2 bases at 12 units/min fill the entity store.
      productionLimit: 8,
    };
  });

  // --- base plots --------------------------------------------------------
  // The build area only: gate/core/consoles/pad/spawn. Ring turrets spread up to
  // ~20 cells along the base approach in the original, so a plot containing them
  // would cover a quarter of the arena.
  const basePlots = bases.map((b, team) => {
    const pts = [
      [b.gate.x, b.gate.y],
      b.core,
      b.groundConsole,
      b.airConsole,
      [round4(sx(spawnsByZ[team].x)), round4(sz(spawnsByZ[team].z))],
    ];
    const cx = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
    const cy = (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cy));
    return { x: round4(cx), y: round4(cy), radius: Math.ceil(r) + 1 };
  });

  // --- capturable turrets ------------------------------------------------
  const neutrals = [...logic.neutrals].sort((a, b) => a.id - b.id);
  const turretSpots = neutrals.map((t) => [round4(sx(t.x)), round4(sz(t.z))]);
  const turretParams = neutrals.map((t) => turretWeapon(t, table));
  const turretYaw = neutrals.map((t) => round4(rotToYaw(t.gunRotationRaw, true)));

  // --- outposts ----------------------------------------------------------
  // Metropolis-only concept (rules.md §5): the original has no outposts. Placed
  // on the two mid-field capturable pads furthest out on either flank — the
  // arena's natural forward strongpoints, and real turret pads, so they sit on
  // authored geometry rather than invented ground.
  const midfield = neutrals
    .map((t, k) => ({ k, x: sx(t.x), z: sz(t.z) }))
    .filter((p) => Math.abs(p.z - 112) < 12)
    .sort((a, b) => a.x - b.x);
  if (midfield.length < 2) throw new Error("no mid-field pads to host the outposts");
  const outpostSpots = [midfield[0], midfield[midfield.length - 1]].map((p) => [
    round4(p.x),
    round4(p.z),
  ]);

  // --- lane graph + polyline ---------------------------------------------
  const graph = buildGraph(logic, teamNet, enemyBase);
  const lanes = [graphRoute(graph, 0)];
  if (lanes[0].length < 2) throw new Error("team 0's committed route is shorter than 2 waypoints");

  // --- pickups / triggers / props ----------------------------------------
  const pickups = [...logic.pickups]
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const grant = p.grants.find((g) => g !== "is_set" && g !== "pickup_consume") ?? "";
      const kind = PICKUP_KIND[grant];
      if (kind === undefined) throw new Error(`pickup ${p.id} has unmapped grant "${grant}"`);
      return {
        x: round4(sx(p.x)),
        y: round4(sz(p.z)),
        kind,
        respawnTicks: toSimTicks(p.spawnTicks, TICK_HZ),
      };
    });

  // Intrusion volumes: the original wraps each base in a cluster that watches
  // the enemy X1Alpha and the enemy units separately, so many volumes repeat the
  // same box. Dedupe by footprint and assign each to the base it guards — the
  // nearer of the two.
  const seenVolume = new Set<string>();
  const triggerVolumes: {
    x: number;
    y: number;
    halfW: number;
    halfL: number;
    team: number;
    watch: number;
  }[] = [];
  for (const t of [...logic.triggers].sort((a, b) => a.id - b.id)) {
    if (t.flags.includes("action_button")) continue; // those are the consoles
    const x = round4(sx(t.x));
    const y = round4(sz(t.z));
    const halfW = Math.max(0.5, round4(t.widthRaw / 8192 / 2));
    const halfL = Math.max(0.5, round4(t.lengthRaw / 8192 / 2));
    const team =
      Math.hypot(x - bases[0].core[0], y - bases[0].core[1]) <
      Math.hypot(x - bases[1].core[0], y - bases[1].core[1])
        ? 0
        : 1;
    const key = `${x}|${y}|${halfW}|${halfL}|${team}`;
    if (seenVolume.has(key)) continue;
    seenVolume.add(key);
    triggerVolumes.push({
      x,
      y,
      halfW,
      halfL,
      team,
      watch: WATCH_ENEMY_AVATAR | WATCH_ENEMY_UNITS,
    });
  }

  const props = [...logic.props]
    .sort((a, b) => a.id - b.id)
    .map((p) => ({
      x: round4(sx(p.x)),
      y: round4(sz(p.z)),
      height: round4(p.height),
      yaw: 0,
      model: p.objId,
    }));

  // --- walls -------------------------------------------------------------
  // Start from the PRISTINE stage-1 lattice, never from the map on disk. This
  // stage both reads and writes packages/sim/maps/<id>.json, so reading walls
  // back out of it would make the wall edits depend on how many times the
  // generator has been run — the output has to be a function of committed
  // inputs alone.
  const pristine = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", `${mission}-walls.json`), "utf8"),
  ) as { size: number; wallsV: string[]; wallsH: string[] };
  if (pristine.size !== raw.size) {
    throw new Error(`${mission}-walls.json is size ${pristine.size}, map is ${raw.size}`);
  }
  const wallsV = [...pristine.wallsV];
  const wallsH = [...pristine.wallsH];
  let carved = 0;
  let repaired = 0;
  if (wallsV.length > 0) {
    // Wall queries must see the PRISTINE lattice, not whatever is on disk.
    const pristineMap = loadMapFromJson({
      ...raw,
      wallsV: pristine.wallsV,
      wallsH: pristine.wallsH,
    });
    carved = carveLaneWalls(pristineMap, wallsV, wallsH, graph, 400);
    // Opening the lane edges is not enough on its own: a corridor can be
    // drivable end to end and still be sealed off from the rest of the arena,
    // which is what leaves the outer ring's capture pads unreachable.
    repaired = repairReachability(
      { ...raw, spawns: out0Spawns(spawnsByZ), wallsV, wallsH },
      wallsV,
      wallsH,
      [
        ...graph.nodes.map((n) => ({ x: n.x, y: n.z })),
        ...turretSpots.map(([x, y]) => ({ x, y })),
        ...outpostSpots.map(([x, y]) => ({ x, y })),
        ...pickups.map((p) => ({ x: p.x, y: p.y })),
      ],
      400,
    );
  }

  // --- emit --------------------------------------------------------------
  const out: MapJson = {
    ...raw,
    wallsV,
    wallsH,
    // Face the enemy base: the original stores an X1Alpha rotation, but the
    // useful, symmetric answer is "look down your own lane".
    spawns: out0Spawns(spawnsByZ),
    basePlots,
    bases,
    lanes,
    turretSpots,
    outpostSpots,
    // No original counterpart: dummy turrets are a Phase-1 sandbox concept.
    dummySpots: [],
    weapons: table.list,
    turretParams,
    turretYaw,
    laneGraph: {
      nodes: graph.nodes.map((n) => [n.x, n.z]),
      edges: graph.edges,
      nextHopA: graph.nextHopA,
      nextHopB: graph.nextHopB,
      entry: graph.entry,
    },
    pickups,
    triggerVolumes,
    props,
  };

  // Load it back through the real validator before writing: an arena that only
  // the generator can read is worse than no arena.
  const loaded = loadMapFromJson(out);
  writeFileSync(mapPath, `${JSON.stringify(out)}\n`);

  report(mapId, loaded, carved, repaired, graph);
}

/** Authoring sanity report — the same checks the arena tests will assert. */
function report(mapId: string, map: MapData, carved: number, repaired: number, graph: Graph): void {
  console.log(`\n${mapId}: rewritten from the original Mp logic`);
  console.log(
    `  spawns 2  bases 2 (${map.bases[0].turrets.length}+${map.bases[1].turrets.length} ring,` +
      ` ${map.bases[0].defence.length}+${map.bases[1].defence.length} built-in defence)` +
      `  capturables ${map.turretSpots.length}  outposts ${map.outpostSpots.length}`,
  );
  console.log(
    `  weapons ${map.weapons.length}  pickups ${map.pickups.length}` +
      `  intrusion volumes ${map.triggerVolumes.length}  props ${map.props.length}`,
  );
  console.log(
    `  lane graph ${graph.nodes.length} nodes, polyline route ${map.lanes[0].length} waypoints`,
  );
  console.log(
    `  core HP ${map.bases[0].coreHp}  production every ${map.bases[0].productionTicks} ticks`,
  );
  console.log(`  wall bits carved to open the original roads: ${carved}`);
  console.log(`  wall bits opened to reconnect the outer ring: ${repaired}`);

  let problems = 0;
  const flag = (msg: string): void => {
    problems++;
    console.log(`  PROBLEM ${msg}`);
  };

  for (let team = 0; team < 2; team++) {
    const s = map.spawns[team];
    console.log(`  spawn ${team} (${s.x}, ${s.y}) h=${sampleHeight(map, s.x, s.y).toFixed(3)}`);
    const plot = map.basePlots[team];
    const b = map.bases[team];
    for (const [what, p] of [
      ["core", b.core],
      ["groundConsole", b.groundConsole],
      ["airConsole", b.airConsole],
      ["spawn", { x: s.x, y: s.y }],
    ] as const) {
      if (Math.hypot(p.x - plot.x, p.y - plot.y) > plot.radius) {
        flag(`base ${team} ${what} outside its plot`);
      }
    }
  }

  // Lane edges must be wall-free after the carve — this is the whole point.
  let blocked = 0;
  for (let k = 0; k < graph.nodes.length; k++) {
    for (const nb of graph.edges[k]) {
      if (nb < 0 || nb <= k) continue;
      const a = graph.nodes[k];
      const b = graph.nodes[nb];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 4);
      let px = a.x;
      let py = a.z;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cx = a.x + (b.x - a.x) * t;
        const cy = a.z + (b.z - a.z) * t;
        if (crossesWallX(map, px, cx, py) || crossesWallY(map, cx, py, cy)) {
          blocked++;
          break;
        }
        px = cx;
        py = cy;
      }
    }
  }
  if (blocked > 0) flag(`${blocked} lane edges still cross a wall`);

  // How much of the graph exceeds the walker slope limit: units ignore slope
  // (units.ts stepAndSnap checks walls only), but the player escorting them does
  // not, so this is reported rather than enforced.
  let steep = 0;
  let total = 0;
  for (let k = 0; k < graph.nodes.length; k++) {
    for (const nb of graph.edges[k]) {
      if (nb < 0 || nb <= k) continue;
      total++;
      const a = graph.nodes[k];
      const b = graph.nodes[nb];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(len));
      let prev = sampleHeight(map, a.x, a.z);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const h = sampleHeight(map, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
        if (Math.abs(h - prev) / (len / steps) >= AVATAR_WALKER_MAX_SLOPE) {
          steep++;
          break;
        }
        prev = h;
      }
    }
  }
  console.log(`  lane edges over the walker slope limit: ${steep}/${total} (units ignore slope)`);

  for (const p of map.pickups) {
    if (Math.abs(sampleHeight(map, p.x, p.y)) > 100)
      flag(`pickup at (${p.x}, ${p.y}) has no ground`);
  }

  console.log(problems === 0 ? "  OK — no problems\n" : `  ${problems} PROBLEM(S)\n`);
}

function main(): void {
  const mapId = process.argv[2] ?? "la-cantina";
  const mission = mapId === "la-cantina" ? "mp" : mapId;
  enrich(mapId, mission);
}

if (import.meta.main) main();
