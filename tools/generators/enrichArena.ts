// STAGE 2 of the arena pipeline: rewrites a committed map JSON's gameplay
// features from the original Precinct Assault logic, leaving its terrain alone.
//
//   bun run gen:arena [all | <mapId> | <Mission>] [--check] [--probe]
//
// --check rebuilds in memory and diffs against the committed map, writing
// nothing; --probe scores candidate frame offsets against the pristine wall
// lattice instead of authoring anything. Arena names come from
// tools/generators/fcopArenas.ts.
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
// exactly one Til on X and nothing on Z, on EVERY arena. The offset is a property
// of the private extractor's grid padding, not of any one mission. Three
// independent measurements agree, and none of them is taken on trust here:
//   - the terrain .glb's min corner lands on sim x 16 for all six arenas
//     (render/mapAlign.generated.ts, measured by vertex correlation) — checked at
//     authoring time by assertFrameOffset() below;
//   - mirror symmetry: on Mp the 106 gameplay actors are symmetric about actor
//     x 96.0 (score 1.00) and the heightfield about col 112.0 (0.992) -> +16;
//   - the original road network fits the wall lattice at +16 and nowhere else —
//     `--probe` re-measures this per arena, which is the check to run when an
//     arena blows its wall budget.
// The previously authored features carried no offset, which is why they needed
// hand-snapping onto walkable ground (git 7966c99) and why lanes had to detour
// around a "fragmented west maze" that was really the edge-repeat apron.
//
// Authoring-time only, like convert.ts: any Math.* is fine, the committed JSON
// is the artifact.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  crossesWallX,
  crossesWallY,
  GROUND_STEPS,
  JUMPABLE_RISE,
  loadMapFromJson,
  type MapData,
  type MapJson,
  openLine,
  roadProbes,
  sampleHeight,
  segmentWalkable,
  type WallHit,
  walkRoad,
  worstHoverRise,
  worstUphillRise,
} from "@metropolis/sim";
import { MAP_ALIGN } from "../../packages/client/src/render/mapAlign.generated";
import { type FcopArena, logicFile, selectArenas, wallsFile } from "./fcopArenas";
import { fovToCos, rangeToCells, rotToYaw, toSimTicks, turnSpeedToRadPerTick } from "./fcopLogic";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TICK_HZ = 30; // packages/sim/src/balance.ts

/**
 * Grid offset from the original actor frame to the sim heightfield frame.
 *
 * Exported so tools/generators/test/mapAlign.test.ts can assert it IS the shift
 * that test measures from the committed terrain. Two constants that have to agree
 * and previously agreed only by coincidence — them disagreeing was issue #30.
 */
export const LOGIC_OFFSET_X = 16;
export const LOGIC_OFFSET_Z = 0;

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
 * Health for a base's built-in defence weapons (fcop-logic.md §8.1).
 *
 * Also NOT in the extracted data: `BaseShooter` carries reach, cadence and FOV but
 * no health, and the base structure's own `health` is the core's 3000. Reusing it
 * put a 3000 HP gun on the core on all four arenas, and it is what held an
 * escorted push on the doorstep — a Runner stops at its own 14 m reach and chips
 * 3000 HP at 8 dps, which is 375 s per gun against four of them.
 *
 * The originals' Turret actors all carry 500, and a built-in gun is the same kind
 * of thing — a structure you can shoot off a base that comes back on the ring
 * timer (see spawnBaseDefence in sim.ts). So it takes the same number, and the
 * core keeps the 3000 that IS extracted.
 */
const BASE_DEFENCE_HP = 500;

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

/**
 * The offset is a measurement, so check it against the measurement rather than
 * trusting a constant six arenas deep.
 *
 * `MAP_ALIGN` records the translation that lands each arena's terrain .glb on the
 * sim grid, correlated vertex-by-vertex against the heightfield and re-derived by
 * tools/generators/test/mapAlign.test.ts. `x + minX` is therefore the cell shift
 * between the mesh's own frame — which is the actor frame — and the sim's. If a
 * regenerated asset ever moves that, this throws instead of quietly authoring an
 * arena 16 cells from its art.
 */
function assertFrameOffset(mapId: string): void {
  const align = MAP_ALIGN[mapId];
  if (!align) throw new Error(`no measured alignment for ${mapId} in mapAlign.generated.ts`);
  const shiftX = align.x + align.minX;
  const shiftZ = align.z + align.minZ;
  if (shiftX !== LOGIC_OFFSET_X || shiftZ !== LOGIC_OFFSET_Z) {
    throw new Error(
      `${mapId}: measured frame shift [${shiftX}, ${shiftZ}] but stage 2 applies ` +
        `[${LOGIC_OFFSET_X}, ${LOGIC_OFFSET_Z}] — re-run gen:mapalign and reconcile before authoring`,
    );
  }
}

/**
 * Which grid axis the two bases face each other across, and where the halfway
 * line sits on it.
 *
 * Mp, Conft, Slim, Joke and Ovmp are all north-south arenas, which is why this
 * used to be the literal `z` and the literal mid-line 112. Hk is not: its bases
 * sit at x 71 and x 201.4 with only 5.9 cells of z between them, so sorting the
 * teams by z there pairs each base with the ENEMY's X1Alpha. Derive it.
 */
interface Field {
  readonly axis: "x" | "z";
  readonly mid: number;
  readonly separation: number;
}

function fieldOf(bases: readonly { x: number; z: number }[]): Field {
  const dx = Math.abs(bases[0].x - bases[1].x);
  const dz = Math.abs(bases[0].z - bases[1].z);
  // Tie goes to z: the five north-south arenas keep their historical ordering
  // even if a future mission happens to be exactly diagonal.
  const axis = dx > dz ? "x" : "z";
  const a = bases[0][axis];
  const b = bases[1][axis];
  return { axis, mid: (a + b) / 2, separation: Math.abs(a - b) };
}

/**
 * Pairs each base with its OWN X1Alpha — the nearest one — then orders the pairs
 * along the field axis so team 0 is the low end.
 *
 * The two lists used to be sorted independently and paired by index, which is
 * only correct while both happen to order the same way.
 */
function teamsOf<
  B extends { x: number; z: number },
  S extends { id: number; x: number; z: number },
>(bases: readonly B[], spawns: readonly S[], field: Field): { base: B; spawn: S }[] {
  const d = (p: { x: number; z: number }, q: { x: number; z: number }): number =>
    Math.hypot(p.x - q.x, p.z - q.z);
  const pairs = bases.map((base) => {
    const spawn = [...spawns].sort((p, q) => d(base, p) - d(base, q) || p.id - q.id)[0];
    return { base, spawn };
  });
  if (new Set(pairs.map((p) => p.spawn.id)).size !== pairs.length) {
    throw new Error("two bases claim the same X1Alpha — the spawn/base pairing is ambiguous");
  }
  return pairs.sort((p, q) => p.base[field.axis] - q.base[field.axis]);
}

/**
 * Spawn list in sim coordinates, team 0 first — the reachability flood's origin.
 *
 * Facing is the cardinal direction of the field axis toward the enemy base rather
 * than the true bearing: "look down your own lane" is the symmetric answer, and
 * the original's stored X1Alpha rotation is not it.
 */
function out0Spawns(
  spawns: readonly { x: number; z: number }[],
  field: Field,
): { x: number; y: number; yaw: number }[] {
  // yaw is atan2(dy, dx) in sim convention, so +z is +pi/2 and +x is 0.
  const toward = field.axis === "z" ? [Math.PI / 2, -Math.PI / 2] : [0, Math.PI];
  return spawns.map((s, team) => ({
    x: round4(sx(s.x)),
    y: round4(sz(s.z)),
    yaw: toward[team],
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

/**
 * Half-cell pad key in sim frame. Dual-team mid turrets and NeutralTurret pads
 * that share a plate land on the same key after LOGIC_OFFSET, even when the
 * raw actor coords differ by a few centimetres.
 */
function padKey(x: number, z: number): string {
  return `${Math.round(x * 2) / 2},${Math.round(z * 2) / 2}`;
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
/** Half-width of the band around the mid-line that counts as mid-field. */
const MIDFIELD_BAND_CELLS = 12;

/**
 * The two capturable pads furthest out on either flank of the mid-line.
 *
 * Metropolis-only concept (rules.md §5): the original has no outposts. Putting
 * them on real turret pads means they sit on authored geometry rather than
 * invented ground. The band used to be `|z - 112| < 12`, which is Mp's mid-line
 * on Mp's axis; both come from `field` now. Widen rather than fail if a mission
 * puts nothing within the band, and say so — an arena with no mid-field pads at
 * all is a data problem worth reading, not a silent zero.
 */
function midfieldOutposts(neutrals: readonly Turret[], field: Field): number[][] {
  const cross = field.axis === "x" ? "z" : "x";
  const pads = neutrals.map((t) => ({ x: sx(t.x), z: sz(t.z) }));
  const limit = Math.max(MIDFIELD_BAND_CELLS, field.separation / 2);
  for (let band = MIDFIELD_BAND_CELLS; band <= limit; band *= 1.5) {
    const inBand = pads
      .filter((p) => Math.abs(p[field.axis] - field.mid) < band)
      .sort((a, b) => a[cross] - b[cross]);
    if (inBand.length >= 2) {
      return [inBand[0], inBand[inBand.length - 1]].map((p) => [round4(p.x), round4(p.z)]);
    }
  }
  const spread = pads.map((p) => round4(p[field.axis])).sort((a, b) => a - b);
  throw new Error(
    `no mid-field pads to host the outposts: mid-line ${field.axis}=${field.mid}, ` +
      `widened to ${round4(limit)} cells, pads at ${field.axis} ${spread.join(",")}`,
  );
}

/**
 * The Cnets the two bases actually drive, in netId order.
 *
 * Mp, Conft, Slim, Joke and Ovmp carry exactly two nets and both are owned, so
 * this is the identity there. Hk carries a THIRD net of 41 nodes that no base
 * produces onto — a campaign leftover. Importing it would put nodes no unit ever
 * walks into the lane carve and into the reachability targets, so an arena would
 * fail its wall budget for a reason that has nothing to do with the frame.
 */
function ownedNets(logic: Logic, teamNet: readonly number[]): Logic["nets"] {
  return logic.nets.filter((n) => teamNet.includes(n.netId));
}

function buildGraph(logic: Logic, teamNet: number[], enemyBase: { x: number; z: number }[]): Graph {
  const nodes: { x: number; z: number }[] = [];
  const edges: number[][] = [];
  const offsetOf = new Map<number, number>();

  for (const net of ownedNets(logic, teamNet)) {
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
    const net = ownedNets(logic, teamNet).find((x) => x.netId === teamNet[team]);
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

/** The base fields the road carve needs, as `buildArena` shapes them. */
interface RoadBase {
  readonly gate: { readonly x: number; readonly y: number };
  readonly groundConsole: readonly number[];
}

/**
 * Clears the wall bits that block the original roads, picks where produced units
 * join them, and reports how many bits it took.
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
 *
 * WHAT CHANGED, AND WHY IT MATTERS (issue #30)
 * A produced unit travels three kinds of segment and this used to validate one:
 * the Cnet edges. The other two are generated by the SIM, not by the extracted
 * data — the beeline from the production console to the graph entry node, and the
 * beeline from the road's far end to the enemy gate — so nothing in the data says
 * they have to be clear, and on three of the four arenas they were not. On Slim
 * and Joke neither team's units could leave their own base at all.
 *
 * It also matters HOW a segment is walked. The old probe stepped the straight
 * line in fixed 0.25 m slices; a unit steps 0.1333 m (Runner) or 0.0833 m
 * (Juggernaut) per tick, and `crossesWallX/Y` judge a diagonal from the position
 * at the START of the axis move — so the step length decides which cell row the
 * test lands in. Edges this reported as clear were blocked for a Runner: 2 on Mp,
 * 3 on Conft, 1 each on Slim and Joke. The sharpest case is a road running
 * exactly along a lattice line, which the Cnet does constantly (Conft #385->#393
 * sits on x = 122.0): the walker's x lands on 121.9999…, so the bit consulted
 * belongs to column 121 and the street is walled. Hence `roads.ts`, which walks
 * every segment at both ground step lengths and 5 cm either side of the centre
 * line, and clears exactly the bit that stopped the walker.
 */
function carveRoads(
  map: MapData,
  wallsV: string[],
  wallsH: string[],
  graph: Graph,
  bases: readonly RoadBase[],
  limit: number,
): { cleared: number; entries: string[] } {
  const size = map.size;
  // The pristine lattice is mutated in place as bits open, so each walk carries
  // on down the road it just unblocked instead of re-jamming on the same bit.
  const v = map.wallsV as Uint8Array;
  const h = map.wallsH as Uint8Array;
  let cleared = 0;
  const open = (hit: WallHit): void => {
    const arr = hit.axis === 0 ? v : h;
    const idx = hit.axis === 0 ? hit.cross * size + hit.line : hit.line * size + hit.cross;
    if (arr[idx] === 0) return;
    arr[idx] = 0;
    cleared += 1;
  };
  const carve = (ax: number, ay: number, bx: number, by: number): void => {
    for (const p of roadProbes(ax, ay, bx, by)) {
      openLine(map, ax + p.ox, ay + p.oy, bx + p.ox, by + p.oy, p.step, open);
    }
  };

  // EVERY directed edge, with no `nb <= k` dedup. The Cnet is one-way
  // (fcop-logic.md §3.1) and measurably so: not one of Mp's 315 edges, or
  // Conft's 518, has a reverse twin. Deduping as if it were undirected skipped
  // every edge pointing at a lower node index — 69 of Mp's, 186 of Conft's — and
  // left the roads they run down half-walled, which is how team 0's committed
  // route on Conft ended up crossing a wall a produced unit cannot pass.
  for (let k = 0; k < graph.nodes.length; k++) {
    for (const nb of graph.edges[k]) {
      if (nb < 0) continue;
      const a = graph.nodes[k];
      const b = graph.nodes[nb];
      carve(a.x, a.z, b.x, b.z);
    }
  }

  // Where the team's signpost chain ends, and whether a node is on it.
  const goalOf = (team: number): number => {
    let at = graph.entry[team];
    for (let guard = 0; guard <= graph.nodes.length; guard++) {
      const next = graph.nextHopA[team][at];
      if (next < 0) return at;
      at = next;
    }
    return at;
  };
  const leadsTo = (team: number, node: number, goal: number): boolean => {
    let at = node;
    for (let guard = 0; guard <= graph.nodes.length; guard++) {
      if (at === goal) return true;
      const next = graph.nextHopA[team][at];
      if (next < 0) return false;
      at = next;
    }
    return false;
  };

  const entries: string[] = [];
  for (let team = 0; team < 2; team++) {
    const console0 = bases[team].groundConsole;
    const goal = goalOf(team);
    const first = graph.entry[team];
    const e = graph.nodes[first];
    // Leg 1 — production console to the road. Which node produced units join at
    // is OUR choice, not extracted data, so a blocked leg is answered by joining
    // somewhere the sim can actually walk to rather than by deleting a wall. The
    // Cnet's own node 0 is kept wherever it works (Mp keeps it).
    if (segmentWalkable(map, console0[0], console0[1], e.x, e.z)) {
      entries.push(`team ${team} joins the road at #${first} (the Cnet's own base node)`);
    } else {
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < graph.nodes.length; k++) {
        if (k !== goal && !leadsTo(team, k, goal)) continue;
        const nd = graph.nodes[k];
        const d = Math.hypot(nd.x - console0[0], nd.z - console0[1]);
        if (d >= bestD) continue; // ties keep the lower node index
        if (!segmentWalkable(map, console0[0], console0[1], nd.x, nd.z)) continue;
        best = k;
        bestD = d;
      }
      if (best < 0) {
        carve(console0[0], console0[1], e.x, e.z);
        entries.push(`team ${team} joins at #${first}, its console leg CARVED (no walkable node)`);
      } else {
        graph.entry[team] = best;
        entries.push(
          `team ${team} joins at #${best}, ${round4(bestD)} m out — #${first} is walled off ` +
            "from the console",
        );
      }
    }
    // Leg 3 — the road's far end into the enemy base. This one has no
    // alternative to pick: `moveGroundUnit` beelines the gate once the signposts
    // run out, so the last few metres either open or the objective is
    // unreachable by anything the arena produces.
    const gate = bases[team ^ 1].gate;
    const end = graph.nodes[goalOf(team)];
    if (!segmentWalkable(map, end.x, end.z, gate.x, gate.y)) {
      carve(end.x, end.z, gate.x, gate.y);
    }
  }

  if (cleared > limit) {
    throw new Error(
      `carved ${cleared} wall bits to open the original roads, over the ${limit} limit — ` +
        "that many means the frame offset is wrong again, not that the arena needs it",
    );
  }
  for (let j = 0; j < size; j++) {
    let rowV = "";
    let rowH = "";
    for (let i = 0; i < size; i++) {
      rowV += v[j * size + i] ? "1" : "0";
      rowH += h[j * size + i] ? "1" : "0";
    }
    wallsV[j] = rowV;
    wallsH[j] = rowH;
  }
  return { cleared, entries };
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

function buildArena(arena: FcopArena): { json: MapJson; stats: EnrichStats; graph: Graph } {
  const { mapId } = arena;
  assertFrameOffset(mapId);
  const mapPath = join(REPO_ROOT, "packages", "sim", "maps", `${mapId}.json`);
  const raw = JSON.parse(readFileSync(mapPath, "utf8")) as MapJson;
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as Logic;

  // Team 0 is the low end of the field axis; each base drives its own Cnet
  // (fcop-logic.md §8.1) and owns the nearer X1Alpha.
  const field = fieldOf(logic.bases);
  const teams = teamsOf(logic.bases, logic.spawns, field);
  const teamBases = teams.map((t) => t.base);
  const teamSpawns = teams.map((t) => t.spawn);
  const teamNet = [teamBases[0].netId, teamBases[1].netId];
  const enemyBase = [
    { x: sx(teamBases[1].x), z: sz(teamBases[1].z) },
    { x: sx(teamBases[0].x), z: sz(teamBases[0].z) },
  ];

  const table = new WeaponTable();

  // --- bases -------------------------------------------------------------
  // The two `action_button` triggers per base are the base's own interaction
  // points (fcop-logic.md §8.6: they watch that base's own X1Alpha), so they are
  // the build consoles. The original does not label which is which; their
  // footprints differ consistently across both bases, so the wider one is the
  // ground console. Deterministic, symmetric, and derived rather than invented.
  let ringDropped = 0;
  const bases = teamBases.map((base, team) => {
    const own = teamSpawns[team];
    const buttons = logic.triggers
      .filter((t) => t.flags.includes("action_button") && t.watchesActor === own.id)
      .sort((a, b) => b.widthRaw - a.widthRaw || a.id - b.id);
    if (buttons.length < 2) {
      throw new Error(`base ${team} has ${buttons.length} action-button triggers, need 2`);
    }
    const core = [round4(sx(base.x)), round4(sz(base.z))];
    // Permanent base ring = team-unique type-8 pads only. The original also
    // lists dual-team type-8 actors on mid plates that are NeutralTurrets —
    // those pads are capturable, not permanent guns for both teams. Putting
    // them in both rings AND turretSpots stacked three meshes (and three
    // shooters) on one plate: team0 ring + team1 ring + capturable.
    // importLaCantinaFromFcopViz.ts uses the same teamOnlyTurrets rule.
    //
    // The two filters below are near-identical on Mp by construction, not by
    // accident: every plate a team shares with a NeutralTurret is also one the
    // other team lists (the mid-field row at x 94.5 and x 129.5). So 8 of each
    // team's 16 Turret actors drop out and 8+8 is the ring the original's data
    // supports. Re-measured; the filters are not over-eager. PLAN.md phase 12
    // claimed 16+16 and has been corrected.
    const otherTeam = teamBases[1 - team].team;
    const otherPadKeys = new Set(
      logic.turrets.filter((t) => t.team === otherTeam).map((t) => padKey(sx(t.x), sz(t.z))),
    );
    const neutralPadKeys = new Set(logic.neutrals.map((t) => padKey(sx(t.x), sz(t.z))));
    const ownTurrets = logic.turrets
      .filter((t) => t.team === base.team)
      .filter((t) => {
        const k = padKey(sx(t.x), sz(t.z));
        return !otherPadKeys.has(k) && !neutralPadKeys.has(k);
      })
      .sort((a, b) => a.id - b.id);
    // MapBase.turrets caps at 16. After dual/neutral filtering Mp/Ovmp keep 8
    // unique per base; Slim/Joke keep 6–7. Count anything the cap would drop.
    const ring = ownTurrets.slice(0, 16);
    ringDropped += ownTurrets.length - ring.length;

    return {
      // The base structure IS the objective under the original rules, so the
      // gate volume sits on it. With coreHp set, systemWinCheck uses the core;
      // the gate still anchors lane termination and produced-unit heading.
      gate: { x: core[0], y: core[1], radius: 4 },
      core,
      groundConsole: [round4(sx(buttons[0].x)), round4(sz(buttons[0].z))],
      airConsole: [round4(sx(buttons[1].x)), round4(sz(buttons[1].z))],
      pad: { x: core[0], y: core[1], radius: 3 },
      // The ring carries each Turret actor's OWN shooter block, not just its
      // position. Dropping it left the ring on the global 28 m TURRET_RANGE
      // against an imported engage_range of 6 m — see spawnBaseTurret in sim.ts.
      // Every mission's ring shares the neutrals' parameters exactly, so these
      // intern to the same profile the capturable pads already use.
      turrets: ring.map((t) => ({
        x: round4(sx(t.x)),
        y: round4(sz(t.z)),
        weapon: turretWeapon(t, table),
        hp: t.health,
        yaw: round4(rotToYaw(t.gunRotationRaw, true)),
      })),
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
        hp: BASE_DEFENCE_HP,
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
      [round4(sx(teamSpawns[team].x)), round4(sz(teamSpawns[team].z))],
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
  // The original's Turret health, rather than the Phase-1 ARCHETYPE_MAX_HP
  // placeholder. Same value the ring turrets carry — they are the same actor kind.
  const turretHp = neutrals.map((t) => t.health);

  // --- outposts ----------------------------------------------------------
  const outpostSpots = midfieldOutposts(neutrals, field);

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

  // Icon consoles and outpost kiosks: face the nearer base core so their
  // unit-type screens read toward the pad (player stands on the apron and
  // looks at the console). Hazard barriers (Cobj 28) share the same rule —
  // striping still reads; yaw 0 left every kiosk facing world +X.
  const props = [...logic.props]
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const x = round4(sx(p.x));
      const y = round4(sz(p.z));
      const c0 = bases[0].core;
      const c1 = bases[1].core;
      const d0 = (x - c0[0]) * (x - c0[0]) + (y - c0[1]) * (y - c0[1]);
      const d1 = (x - c1[0]) * (x - c1[0]) + (y - c1[1]) * (y - c1[1]);
      const cx = d0 <= d1 ? c0[0] : c1[0];
      const cy = d0 <= d1 ? c0[1] : c1[1];
      return {
        x,
        y,
        height: round4(p.height),
        yaw: round4(Math.atan2(cy - y, cx - x)),
        model: p.objId,
      };
    });

  // --- walls -------------------------------------------------------------
  // Start from the PRISTINE stage-1 lattice, never from the map on disk. This
  // stage both reads and writes packages/sim/maps/<id>.json, so reading walls
  // back out of it would make the wall edits depend on how many times the
  // generator has been run — the output has to be a function of committed
  // inputs alone.
  const pristine = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", wallsFile(arena)), "utf8"),
  ) as { size: number; wallsV: string[]; wallsH: string[] };
  if (pristine.size !== raw.size) {
    throw new Error(`${wallsFile(arena)} is size ${pristine.size}, map is ${raw.size}`);
  }
  const wallsV = [...pristine.wallsV];
  const wallsH = [...pristine.wallsH];
  let carved = 0;
  let repaired = 0;
  let entries: string[] = [];
  if (wallsV.length > 0) {
    // Wall queries must see the PRISTINE lattice, not whatever is on disk.
    const pristineMap = loadMapFromJson({
      ...raw,
      wallsV: pristine.wallsV,
      wallsH: pristine.wallsH,
    });
    const roads = carveRoads(pristineMap, wallsV, wallsH, graph, bases, arena.carveLimit);
    carved = roads.cleared;
    entries = roads.entries;
    // Opening the lane edges is not enough on its own: a corridor can be
    // drivable end to end and still be sealed off from the rest of the arena,
    // which is what leaves the outer ring's capture pads unreachable.
    repaired = repairReachability(
      { ...raw, spawns: out0Spawns(teamSpawns, field), wallsV, wallsH },
      wallsV,
      wallsH,
      [
        ...graph.nodes.map((n) => ({ x: n.x, y: n.z })),
        ...turretSpots.map(([x, y]) => ({ x, y })),
        ...outpostSpots.map(([x, y]) => ({ x, y })),
        ...pickups.map((p) => ({ x: p.x, y: p.y })),
        // The base's own structures, or the player cannot walk from their spawn
        // to a buy console and back out onto the road. Mp's happened to land in
        // the spawn component already; Conft's, Slim's and Joke's do not, and
        // without these the arena generates clean and plays unbuyable.
        ...bases.flatMap((b) => [
          { x: b.core[0], y: b.core[1] },
          { x: b.groundConsole[0], y: b.groundConsole[1] },
          { x: b.airConsole[0], y: b.airConsole[1] },
          // Ring turrets too: one the player can neither reach nor shoot past is
          // dead content, and mapConnectivity.test.ts treats it as an error.
          ...b.turrets.map((t) => ({ x: t.x, y: t.y })),
        ]),
        ...out0Spawns(teamSpawns, field).map((s) => ({ x: s.x, y: s.y })),
      ],
      arena.repairLimit,
    );
  }

  // --- emit --------------------------------------------------------------
  const out: MapJson = {
    ...raw,
    wallsV,
    wallsH,
    // Face the enemy base: the original stores an X1Alpha rotation, but the
    // useful, symmetric answer is "look down your own lane".
    spawns: out0Spawns(teamSpawns, field),
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
    turretHp,
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

  // Load it back through the real validator before returning: an arena that only
  // the generator can read is worse than no arena.
  const loaded = loadMapFromJson(out);

  return {
    json: out,
    graph,
    stats: {
      carved,
      repaired,
      entries,
      ringDropped,
      unownedNets: logic.nets.length - ownedNets(logic, teamNet).length,
      field,
      map: loaded,
    },
  };
}

/** Where a built arena belongs on disk. */
function mapPathOf(arena: FcopArena): string {
  return join(REPO_ROOT, "packages", "sim", "maps", `${arena.mapId}.json`);
}

function serialize(json: MapJson): string {
  return `${JSON.stringify(json)}\n`;
}

/**
 * Has stage 2 ever been run on this arena's committed map?
 *
 * `laneGraph` is the marker: it is the one field only this stage writes, and an
 * arena without it is still carrying stage 1's hand-authored layout.
 */
function isImported(arena: FcopArena): boolean {
  const onDisk = JSON.parse(readFileSync(mapPathOf(arena), "utf8")) as MapJson;
  return onDisk.laneGraph !== undefined;
}

function writeArena(arena: FcopArena): number {
  const { json, stats, graph } = buildArena(arena);
  writeFileSync(mapPathOf(arena), serialize(json));
  return report(arena, stats, graph);
}

/**
 * Rebuilds the arena in memory and diffs it against the committed map.
 *
 * This is the claim every refactor of this file has to make — "the committed maps
 * are still exactly what the committed inputs produce" — and `--check` makes it
 * assertable without touching the tree.
 */
function checkArena(arena: FcopArena): boolean {
  // An arena stage 2 has never run on has nothing to compare against: its map is
  // still stage 1's hand-authored layout. Say so rather than calling it drift.
  const onDisk = JSON.parse(readFileSync(mapPathOf(arena), "utf8")) as MapJson;
  if (onDisk.laneGraph === undefined) {
    console.log(`${arena.mapId}: not imported yet — no committed stage-2 output to check`);
    return true;
  }
  const { json } = buildArena(arena);
  const want = readFileSync(mapPathOf(arena), "utf8");
  const got = serialize(json);
  if (want === got) {
    console.log(`${arena.mapId}: reproduces the committed map byte-for-byte`);
    return true;
  }
  console.log(`${arena.mapId}: DRIFT — the committed map is not what the inputs produce now`);
  return false;
}

/**
 * Scores candidate frame offsets by how much of the original road network the
 * PRISTINE wall lattice blocks, and reports whether the offset in use wins.
 *
 * The +16 offset was originally established for Mp by measuring exactly this —
 * 22 of 246 lane edges blocked at +16, every other shift at least twice as bad.
 * `--probe` makes that repeatable per arena, which matters because it is the
 * right instrument when an arena blows its wall budget: if +16 is not clearly the
 * best shift, the frame is wrong and no budget increase will fix it.
 */
function probeOffsets(arena: FcopArena): boolean {
  const raw = JSON.parse(readFileSync(mapPathOf(arena), "utf8")) as MapJson;
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as Logic;
  const pristine = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", wallsFile(arena)), "utf8"),
  ) as { wallsV: string[]; wallsH: string[] };
  const map = loadMapFromJson({ ...raw, wallsV: pristine.wallsV, wallsH: pristine.wallsH });

  const field = fieldOf(logic.bases);
  const teamNet = teamsOf(logic.bases, logic.spawns, field).map((t) => t.base.netId);
  const nets = ownedNets(logic, teamNet);

  // Every directed Cnet edge, in the raw actor frame.
  const edges: number[][] = [];
  for (const net of nets) {
    for (const n of net.nodes) {
      for (const nb of n.neighbours) {
        if (nb < 0) continue;
        edges.push([n.x, n.z, net.nodes[nb].x, net.nodes[nb].z]);
      }
    }
  }

  const blockedAt = (dx: number): number => {
    let blocked = 0;
    for (const [ax, az, bx, bz] of edges) {
      const x0 = ax + dx;
      const x1 = bx + dx;
      const steps = Math.ceil(Math.hypot(x1 - x0, bz - az) * 4);
      let px = x0;
      let py = az;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cx = x0 + (x1 - x0) * t;
        const cy = az + (bz - az) * t;
        if (crossesWallX(map, px, cx, py) || crossesWallY(map, cx, py, cy)) {
          blocked++;
          break;
        }
        px = cx;
        py = cy;
      }
    }
    return blocked;
  };

  const scores: { dx: number; blocked: number }[] = [];
  for (let dx = -16; dx <= 32; dx += 4) scores.push({ dx, blocked: blockedAt(dx) });
  const best = scores.reduce((a, b) => (b.blocked < a.blocked ? b : a));
  const here = scores.find((s) => s.dx === LOGIC_OFFSET_X) as { dx: number; blocked: number };
  const runnerUp = scores
    .filter((s) => s.dx !== LOGIC_OFFSET_X)
    .reduce((a, b) => (b.blocked < a.blocked ? b : a));

  console.log(`\n${arena.mapId} (${arena.mission}): ${edges.length} original lane edges`);
  for (const s of scores) {
    const mark = s.dx === LOGIC_OFFSET_X ? " <- in use" : s.dx === best.dx ? " <- best" : "";
    console.log(`  x+${String(s.dx).padStart(3)}: ${String(s.blocked).padStart(4)} blocked${mark}`);
  }
  // The offset in use has to be the UNIQUE minimum. A tie is not a pass: it means
  // the lattice cannot tell +16 from some other shift, so the probe is not
  // measuring anything and would print OK straight through a real regression.
  // Ties are the realistic failure here, not last place — Hk blocks 0 of its 160
  // edges because its road network lies on an empty canal floor, so on an arena
  // like that a second shift scoring 0 too is exactly what "uninformative" looks
  // like.
  const tied = scores.filter((s) => s.blocked === best.blocked);
  const unique = tied.length === 1 && tied[0].dx === LOGIC_OFFSET_X;
  if (unique) {
    console.log(
      `  OK — +${LOGIC_OFFSET_X} is the unique best shift; next best (+${runnerUp.dx}) blocks ` +
        `${runnerUp.blocked}, ${round4(runnerUp.blocked / Math.max(1, here.blocked))}x as many`,
    );
  } else if (here.blocked === best.blocked) {
    console.log(
      `  PROBLEM +${LOGIC_OFFSET_X} blocks ${here.blocked} but so does ` +
        `${tied
          .filter((s) => s.dx !== LOGIC_OFFSET_X)
          .map((s) => `+${s.dx}`)
          .join(", ")} — the lattice does not discriminate, so this proves nothing`,
    );
  } else {
    console.log(
      `  PROBLEM +${LOGIC_OFFSET_X} blocks ${here.blocked} but +${best.dx} blocks only ${best.blocked}`,
    );
  }
  return unique;
}

/** Everything the report prints, so buildArena stays free of console output. */
interface EnrichStats {
  carved: number;
  repaired: number;
  /** Where each team's produced units join the road, and why (carveRoads). */
  entries: string[];
  /** Ring turrets the MapBase cap of 16 dropped, across both bases. */
  ringDropped: number;
  /** Cnets in the extraction that no base drives, and were therefore not imported. */
  unownedNets: number;
  field: Field;
  map: MapData;
}

/** Authoring sanity report — the same checks the arena tests will assert. */
function report(arena: FcopArena, stats: EnrichStats, graph: Graph): number {
  const { map, carved, repaired } = stats;
  console.log(`\n${arena.mapId}: rewritten from the original ${arena.mission} logic`);
  console.log(
    `  field axis ${stats.field.axis}, mid-line ${round4(stats.field.mid)},` +
      ` bases ${round4(stats.field.separation)} cells apart`,
  );
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
  console.log(
    `  wall bits carved to open the original roads: ${carved}/${arena.carveLimit} allowed`,
  );
  console.log(
    `  wall bits opened to reconnect the outer ring: ${repaired}/${arena.repairLimit} allowed`,
  );
  if (stats.unownedNets > 0) {
    console.log(
      `  ${arena.mission} carries ${stats.unownedNets} Cnet(s) no base drives; not imported`,
    );
  }
  if (stats.ringDropped > 0) {
    console.log(`  PROBLEM ${stats.ringDropped} ring turret(s) dropped by the MapBase cap of 16`);
  }

  let problems = stats.ringDropped > 0 ? 1 : 0;
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

  // Lane edges must be walkable after the carve — this is the whole point — and
  // "walkable" means what the sim means: `segmentWalkable` walks each edge at both
  // ground step lengths and either side of the centre line, because a fixed-slice
  // line probe answers a different question (see carveRoads).
  let blocked = 0;
  for (let k = 0; k < graph.nodes.length; k++) {
    for (const nb of graph.edges[k]) {
      if (nb < 0) continue;
      const a = graph.nodes[k];
      const b = graph.nodes[nb];
      if (!segmentWalkable(map, a.x, a.z, b.x, b.z)) blocked++;
    }
  }
  if (blocked > 0) flag(`${blocked} lane edges a produced unit cannot walk`);

  // ...and the whole journey, which is the check that was missing: console to
  // graph, graph to the enemy gate, at every ground unit's own step. A road that
  // is edge-perfect and unreachable from the factory produces nothing.
  for (const note of stats.entries) console.log(`  ${note}`);
  for (let team = 0; team < 2; team++) {
    for (const step of GROUND_STEPS) {
      const w = walkRoad(map, team, step);
      const per = `${round4(step)} m/tick`;
      if (w.reached) {
        console.log(
          `  team ${team} road at ${per}: console -> core in ${(w.ticks / TICK_HZ).toFixed(1)} s`,
        );
      } else {
        flag(
          `team ${team} cannot drive its road at ${per}: stopped on leg ${w.leg}` +
            ` at (${round4(w.x)}, ${round4(w.y)}), ${round4(w.distanceToCore)} m from the core` +
            `, aiming at node ${w.node}`,
        );
      }
    }
  }

  // How much of the graph exceeds the walker slope limit: units ignore slope
  // (units.ts stepAndSnap checks walls only), but the player escorting them does
  // not, so this is reported rather than enforced.
  //
  // `worstUphillRise` is the sim's own rule, imported rather than reimplemented —
  // uphill only, heights from `resolveWalker`. That second part is why it is
  // shared: an open-coded `sampleHeight` version agrees with the sim on today's
  // single-storey arenas and would quietly stop agreeing the moment stage 2 is
  // pointed at hollywood-keys or venice-beach (issue #33), which is exactly when
  // a generator report needs to be trustworthy. The second figure is the subset
  // the jump cannot clear, i.e. the count that means "impassable".
  //
  // Both forms are reported, because they own different ground (issue #34): the
  // hover has no jump, so a rise `worstHoverRise` returns is impassable outright,
  // and it reads a climb over its own footprint rather than over one tick, so it
  // rides over steps the walker has to jump.
  let steep = 0;
  let hardWall = 0;
  let hoverBlocked = 0;
  let walkerOnly = 0;
  let hoverOnly = 0;
  let total = 0;
  for (let k = 0; k < graph.nodes.length; k++) {
    for (const nb of graph.edges[k]) {
      if (nb < 0) continue;
      total++;
      const a = graph.nodes[k];
      const b = graph.nodes[nb];
      const worst = worstUphillRise(map, a.x, a.z, b.x, b.z);
      if (worst > 0) steep++;
      if (worst > JUMPABLE_RISE) hardWall++;
      const hover = worstHoverRise(map, a.x, a.z, b.x, b.z);
      if (hover > 0) {
        hoverBlocked++;
        if (worst === 0) walkerOnly++;
      } else if (worst > JUMPABLE_RISE) hoverOnly++;
    }
  }
  console.log(
    `  lane edges the walker cannot climb: ${steep}/${total}` +
      ` (${hardWall} of them beyond jump range; units ignore slope)`,
  );
  console.log(
    `  lane edges the hover cannot climb: ${hoverBlocked}/${total}` +
      ` (${walkerOnly} walker-only, ${hoverOnly} hover-only ground)`,
  );

  for (const p of map.pickups) {
    if (Math.abs(sampleHeight(map, p.x, p.y)) > 100)
      flag(`pickup at (${p.x}, ${p.y}) has no ground`);
  }

  console.log(problems === 0 ? "  OK — no problems\n" : `  ${problems} PROBLEM(S)\n`);
  return problems;
}

function main(): void {
  const which =
    process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "la-cantina";
  const check = process.argv.includes("--check");
  const probe = process.argv.includes("--probe");
  const arenas = selectArenas(which);

  let bad = 0;
  for (const arena of arenas) {
    if (probe) bad += probeOffsets(arena) ? 0 : 1;
    else if (check) bad += checkArena(arena) ? 0 : 1;
    else if (which === "all" && !isImported(arena)) {
      // `all` re-runs what is already adopted; it does not adopt anything new.
      // hollywood-keys and venice-beach are blocked on issue #33 (their decks are
      // unreachable, so an import puts the whole road network under the city) and
      // `all` used to import them anyway, silently. Naming one still works, which
      // is how they get adopted the day #33 lands.
      console.log(`${arena.mapId}: not imported — name it explicitly to adopt it (issue #33)`);
    } else bad += writeArena(arena);
  }
  if (bad > 0) process.exit(1);
}

if (import.meta.main) main();
