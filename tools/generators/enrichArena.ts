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
  FLOOR_DAMAGE_PER_STEP,
  GROUND_STEPS,
  gapUnits,
  JUMPABLE_RISE,
  loadMapFromJson,
  type MapData,
  type MapJson,
  ORIGINAL_CAPTURE_RANGE,
  openLine,
  reachableFrom,
  resolveHeight,
  resolveWalker,
  roadProbes,
  roundSpeed,
  SHOOTER_FRONT_ARC_COS,
  STEP_SNAP,
  sampleHeight,
  segmentWalkable,
  type WallHit,
  WORLD_KIND_GUIDED,
  WORLD_KIND_LEAD,
  WORLD_WEAPONS,
  walkRoad,
  worstHoverRise,
  worstUphillRise,
} from "@metropolis/sim";
import { MAP_ALIGN } from "../../packages/client/src/render/mapAlign.generated";
import { type FcopArena, logicFile, rulesFile, selectArenas, wallsFile } from "./fcopArenas";
import {
  captureRangeToCells,
  fovToCos,
  ROTATION_TURN,
  rangeToCells,
  rotToYaw,
  toSimTicks,
  triggerHalfExtent,
  turnSpeedToRadPerTick,
} from "./fcopLogic";
import type { FcopRules } from "./fcopRules";
import { type Lattice, openKerbs, readGlbTriangles, TerrainMesh } from "./kerbs";

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
 * Pickup kinds (must match balance.ts PICKUP_*).
 *
 * The original's 8 grant kinds (fcop-re/player-and-weapons.md §6):
 *   reload_gun       -> GUN_AMMO     (the guns' magazines are finite since
 *                                     SIM_VERSION 41; it was a heavy refill)
 *   reload_heavy     -> HEAVY_AMMO
 *   reload_special   -> SPECIAL_AMMO
 *   restore_health   -> HEALTH
 *   power_up_gun     -> POWER (_GUN)  the slot's block-B weapon (fcop-fidelity.md
 *   power_up_heavy   -> POWER_HEAVY   P8); all three were one x2-damage kind
 *   power_up_special -> POWER_SPECIAL until SIM_VERSION 43
 *   invisibility     -> INVIS
 *   invincibility    -> INVULN       (flag 0x80000, 20 s in the original; no PA
 *                                     pickup carries it — fcop-re/player-and-
 *                                     weapons.md §6 — but a campaign-style
 *                                     arena that did would import, not throw)
 */
const PICKUP_KIND: Record<string, number> = {
  reload_gun: 6,
  reload_heavy: 0,
  reload_special: 1,
  restore_health: 2,
  invisibility: 4,
  invincibility: 3,
  power_up_gun: 5,
  power_up_heavy: 7,
  power_up_special: 8,
};

/** balance.ts TRIGGER_WATCH_* bits. */
const WATCH_ENEMY_AVATAR = 1 << 0;
const WATCH_ENEMY_UNITS = 1 << 1;

interface Logic {
  mission: string;
  mapId: string;
  spawns: { id: number; x: number; z: number }[];
  /** The type-28 records: the two Dreadnoughts (fcopLogic.ts PaDreadnought). */
  dreadnoughts: {
    id: number;
    x: number;
    z: number;
    team: number;
    health: number;
    netId: number;
    gunCount: number;
    gun: Shooter;
  }[];
  /** Tank (Runner) spawner records; spawnLimit 20 marks the purchasable ones. */
  units: { id: number; team: number; health: number; spawnLimit?: number; shooter: Shooter }[];
  /** Jet (Guardian) and Flying Fortress records. */
  aircraft: { id: number; team: number; health: number; shooter: Shooter }[];
  turrets: Turret[];
  neutrals: Turret[];
  pickups: {
    id: number;
    x: number;
    z: number;
    grants: string[];
    spawnTicks: number;
    rotationalSpeed: number;
  }[];
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
  nets: {
    netId: number;
    nodes: { x: number; z: number; neighbours: number[]; groundCast?: number }[];
  }[];
}

interface Turret {
  id: number;
  x: number;
  z: number;
  team: number;
  health: number;
  gunRotationRaw: number;
  turnSpeedRaw: number;
  shooter: Shooter;
  spawnTicks: number;
}

/** A BaseShooter block as fcopLogic.ts carries it. */
interface Shooter {
  weaponId: number;
  engageRangeRaw: number;
  targetingDelayRaw: number;
  fovRaw: number;
}

interface Weapon {
  range: number;
  delay: number;
  damage: number;
  turnSpeed: number;
  fovCos: number;
  refireUnits: number;
  searchUnits: number;
  speed: number;
  flight: number;
  guided: number;
  lead: number;
  arcCos: number;
  hold: number;
  priority: number;
}

const sx = (x: number): number => x + LOGIC_OFFSET_X;
const sz = (z: number): number => z + LOGIC_OFFSET_Z;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------------------
// Feature layer (issue #33)
// ---------------------------------------------------------------------------
//
// ACT pos_h is 0 on every PC mission, so deck membership cannot come from the
// container. Surfaces at a cell are the ground + any present deck masks; the
// original Cnet's ground_cast picks among them for lane nodes (HIGH / LOW /
// MIDDLE). Gameplay actors without a cast sit on the topmost surface — the same
// reading as RE's actors.layered.json `layer_top`. Layer 0 is omitted from JSON
// so existing single-storey maps stay byte-identical when re-emitted.

/** Cnet ground_cast enums, as carried in the committed logic JSON. */
const CAST_HIGH = 0;
const CAST_LOW = 1;
// const CAST_NONE = 2; // engine default = topmost
const CAST_MIDDLE = 3;

/** Every present surface at a cell, ascending by height, as sim layer indices. */
function surfacesAt(map: MapData, x: number, y: number): { layer: number; h: number }[] {
  const s = map.size;
  const i = Math.min(s - 1, Math.max(0, Math.floor(x / map.cellSize)));
  const j = Math.min(s - 1, Math.max(0, Math.floor(y / map.cellSize)));
  const out: { layer: number; h: number }[] = [{ layer: 0, h: resolveHeight(map, x, y, 0) }];
  for (let L = 0; L < map.layerHeights.length; L++) {
    if (map.layerMask[L][j * s + i] !== 1) continue;
    out.push({ layer: L + 1, h: resolveHeight(map, x, y, L + 1) });
  }
  out.sort((a, b) => a.h - b.h || a.layer - b.layer);
  return out;
}

/**
 * Surface selected by a Cnet node's ground_cast (fcop-logic.md §3.1).
 * LOW = bottom of the stack, HIGH = top, MIDDLE = the one between when present.
 *
 * Non-Cnet features (bases, turrets, pickups, props) stay on layer 0 for now.
 * RE's actors.layered.json `layer_top` would place some of them on decks, but
 * sampling the topmost surface at every cell is the wrong default — la-cantina's
 * cores sit under bridges and must stay on the ground. Until that side-file is
 * committed in-tree, only nodes with an authored cast leave layer 0.
 */
function layerFromCast(map: MapData, x: number, y: number, cast: number | undefined): number {
  const stack = surfacesAt(map, x, y);
  if (stack.length === 1 || cast === undefined) return stack[0].layer;
  if (cast === CAST_LOW) return stack[0].layer;
  if (cast === CAST_MIDDLE) return stack[Math.floor((stack.length - 1) / 2)].layer;
  if (cast === CAST_HIGH) return stack[stack.length - 1].layer;
  return stack[0].layer; // NONE → ground (safe for flattened import)
}

/** Point as [x,y] or {x,y,layer} when the feature is off the ground. */
function emitPoint(
  x: number,
  y: number,
  layer: number,
): number[] | { x: number; y: number; layer: number } {
  if (layer <= 0) return [x, y];
  return { x, y, layer };
}

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
 * Facing and form are the X1Alpha record's (the rules artifact, read by
 * pa_rules_data.py): raw 4096 = one turn, forward = (cos f, sin f) in the actors
 * frame, so +x is 0 and +z is +pi/2 — the sim's own yaw convention, the frame
 * offset being a translation. A negative facing is the hover flag; the record
 * stores the direction as its magnitude (view_place.c, player_respawn). Until
 * SIM_VERSION 57 the facing was "the field axis toward the enemy base", which the
 * record agrees with on Mp only.
 */
function out0Spawns(
  spawns: readonly { id: number; x: number; z: number }[],
  rules: FcopRules,
): { x: number; y: number; yaw: number; layer?: number; hover?: boolean }[] {
  return spawns.map((s) => {
    const rec = rules.x1alpha.find((r) => r.id === s.id);
    if (!rec) throw new Error(`${rules.mapId}: no X1Alpha ${s.id} in the rules artifact`);
    // In raw units first, so a quarter turn lands on an exact multiple of pi.
    let raw = Math.abs(rec.facingRaw) % ROTATION_TURN;
    if (raw > ROTATION_TURN / 2) raw -= ROTATION_TURN;
    // The form is written only where it is hover, so a walker arena's JSON
    // carries no field it does not need.
    return {
      x: round4(sx(s.x)),
      y: round4(sz(s.z)),
      yaw: (raw * Math.PI) / (ROTATION_TURN / 2),
      ...(rec.hover ? { hover: true } : {}),
    };
  });
}

/** One sim tick is this many of the original's 300 Hz engine ticks. */
const ENGINE_TICKS_PER_TICK = 300 / TICK_HZ;

type LiftJson = NonNullable<MapJson["lifts"]>[number];

/** The cells whose centres lie on a lift's face: the shaft it moves in. */
function liftCells(l: { x0: number; x1: number; y0: number; y1: number }): [number, number][] {
  const out: [number, number][] = [];
  for (let i = Math.ceil(l.x0 - 0.5); i + 0.5 <= l.x1; i++) {
    for (let j = Math.ceil(l.y0 - 0.5); j + 0.5 <= l.y1; j++) out.push([i, j]);
  }
  return out;
}

/** How far a lift's face must reach into a cell for its rider to stand there. */
const FACE_OVERLAP = 0.1;

/**
 * Every cell the lift's face reaches into by more than FACE_OVERLAP on both
 * axes: where its rider can stand. A shaft cell, and the cell a face's edge
 * crosses into (Conft's 1.1 m lifts reach 0.22 m past a cell line).
 */
function faceCells(l: { x0: number; x1: number; y0: number; y1: number }): [number, number][] {
  const out: [number, number][] = [];
  for (let i = Math.floor(l.x0); i < l.x1; i++) {
    if (Math.min(i + 1, l.x1) - Math.max(i, l.x0) <= FACE_OVERLAP) continue;
    for (let j = Math.floor(l.y0); j < l.y1; j++) {
      if (Math.min(j + 1, l.y1) - Math.max(j, l.y0) <= FACE_OVERLAP) continue;
      out.push([i, j]);
    }
  }
  return out;
}

/** The four neighbours of a cell, with the lattice bit between them. */
function edgesOf(
  i: number,
  j: number,
): { ni: number; nj: number; axis: "V" | "H"; r: number; c: number }[] {
  return [
    { ni: i + 1, nj: j, axis: "V", r: j, c: i + 1 },
    { ni: i - 1, nj: j, axis: "V", r: j, c: i },
    { ni: i, nj: j + 1, axis: "H", r: j + 1, c: i },
    { ni: i, nj: j - 1, axis: "H", r: j, c: i },
  ];
}

/**
 * The lifts (fcop-fidelity.md P12) in the sim's frame, from the rules artifact:
 * the face's rectangle (already turned by the record's yaw), the stops in world
 * units (raw << 4), the speeds per sim tick, the dwell per stop in sim ticks.
 * The surface a rider counts as standing on at a stop is the one most of the
 * floors around the shaft at that stop's height belong to (their walls are the
 * ones it then reads); the ground's where none meets it.
 */
function liftsOf(
  rules: FcopRules,
  terrain: MapData,
  teamOfSlot: (slot: number) => number,
): LiftJson[] {
  return rules.lifts.map((l) => {
    const x = sx(l.x);
    const y = sz(l.z);
    const face = {
      x0: round4(x + l.footprint.x0),
      x1: round4(x + l.footprint.x1),
      y0: round4(y + l.footprint.z0),
      y1: round4(y + l.footprint.z1),
    };
    const stops = l.stopsRaw.map((r) => r << 4);
    const cells = liftCells(face);
    const inShaft = new Set(cells.map(([i, j]) => i * terrain.size + j));
    const layers = stops.map((wu) => {
      const top = l.groundM + wu / 8192 + l.footprint.topM;
      const count = new Map<number, number>();
      for (const [i, j] of cells) {
        for (const e of edgesOf(i, j)) {
          if (inShaft.has(e.ni * terrain.size + e.nj)) continue;
          const wr = resolveWalker(terrain, e.ni + 0.5, e.nj + 0.5, top);
          if (Math.abs(wr.height - top) > STEP_SNAP) continue;
          count.set(wr.layer, (count.get(wr.layer) ?? 0) + 1);
        }
      }
      let best = 0;
      let bestN = 0;
      for (const [layer, n] of [...count].sort((a, b) => a[0] - b[0])) {
        if (n > bestN) {
          best = layer;
          bestN = n;
        }
      }
      return best;
    });
    return {
      x: round4(x),
      y: round4(y),
      ...face,
      ground: l.groundM,
      top: l.footprint.topM,
      stops,
      up: l.speedWuPerTick.forward * ENGINE_TICKS_PER_TICK,
      down: l.speedWuPerTick.backward * ENGINE_TICKS_PER_TICK,
      dwell: l.dwellTicks.map((t) => Math.floor(t / ENGINE_TICKS_PER_TICK)),
      start: l.startsAt,
      hurtsTeam: l.hurtsSlot === null ? -1 : teamOfSlot(l.hurtsSlot),
      layers,
      model: l.cobj,
      yaw: round4((l.yawRaw * Math.PI) / (ROTATION_TURN / 2)),
    };
  });
}

/**
 * Opens the shaft a lift moves in (fcop-fidelity.md P12), in place.
 *
 * The extractor turns every near-vertical polygon into the edge of the tile it
 * lies in, so a shaft arrives walled on every side and through its middle, on
 * every surface's lattice: the shaft's own faces, from its floor up to the
 * floors it serves. The original's mech stands on the lift's top above them.
 * So:
 * - the edges between the cells its face reaches into open on every lattice
 *   (the lift is one platform at every height);
 * - at every stop above the lowest, an edge from the shaft to a floor at that
 *   stop's height (within STEP_SNAP of its top) opens on the rider's lattice
 *   there and on that floor's own — the rider steps off over the shaft's wall;
 * - at the lowest stop the shaft's walls stand: they are walls at that height;
 * - no deck lies inside the shaft: the extractor's plates on its cells (a
 *   sample on the shaft's rim) would catch the lift's rider mid-travel.
 * Returns the bits opened.
 */
function openLiftShafts(
  lifts: readonly LiftJson[],
  terrain: MapData,
  lattices: { v: string[][]; h: string[][] }[],
  masks: string[][][],
): number {
  let opened = 0;
  const open = (layer: number, axis: "V" | "H", r: number, c: number): void => {
    const lat = lattices[layer] ?? lattices[0];
    const grid = axis === "V" ? lat.v : lat.h;
    if (grid[r]?.[c] !== "1") return;
    grid[r][c] = "0";
    opened++;
  };
  for (const l of lifts) {
    const cells = liftCells(l);
    const inShaft = new Set(cells.map(([i, j]) => i * terrain.size + j));
    // The lift is one platform wherever its face reaches.
    const face = faceCells(l);
    const onFace = new Set(face.map(([i, j]) => i * terrain.size + j));
    for (const [i, j] of face) {
      for (const e of edgesOf(i, j)) {
        if (!onFace.has(e.ni * terrain.size + e.nj)) continue;
        for (let layer = 0; layer < lattices.length; layer++) open(layer, e.axis, e.r, e.c);
      }
    }
    for (const [i, j] of cells) {
      for (const m of masks) if (m[j]?.[i] === "1") m[j][i] = "0";
      for (const e of edgesOf(i, j)) {
        if (inShaft.has(e.ni * terrain.size + e.nj)) continue;
        for (let s = 1; s < l.stops.length; s++) {
          const top = l.ground + l.stops[s] / 8192 + l.top;
          const wr = resolveWalker(terrain, e.ni + 0.5, e.nj + 0.5, top);
          if (Math.abs(wr.height - top) > STEP_SNAP) continue;
          open(l.layers[s], e.axis, e.r, e.c);
          open(wr.layer, e.axis, e.r, e.c);
        }
      }
    }
  }
  return opened;
}

/**
 * Lays the original's floor where a lift lands and the heightfield cannot carry
 * it (fcop-fidelity.md P12), in place; returns the cells patched.
 *
 * The sim's heights sit on the grid's points and a deck's presence on its cells,
 * so the last cell of a platform beside a shaft shares its far corners with the
 * shaft's floor and slopes down into it: Conft's central platform is flat to
 * its edge in the original's mesh, and on its south and east sides the cell
 * between it and the lift's top stop reads as a 2 m slope. Where the mesh has a
 * floor beside a shaft within STEP_SNAP of a stop above the lowest and the sim's
 * surface there is not, the cell gets a deck patch at the mesh's height — on a
 * deck that is absent there and whose corners no present cell of it holds at
 * another height.
 */
function landLifts(
  lifts: readonly LiftJson[],
  terrain: MapData,
  mesh: TerrainMesh,
  heights: number[][][],
  masks: string[][][],
): number {
  let patched = 0;
  const size = terrain.size;
  const present = (L: number, i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < size && j < size && masks[L][j][i] === "1";
  for (const l of lifts) {
    const cells = liftCells(l);
    const inShaft = new Set(cells.map(([i, j]) => i * size + j));
    for (let s = 1; s < l.stops.length; s++) {
      const top = l.ground + l.stops[s] / 8192 + l.top;
      for (const [i, j] of cells) {
        for (const e of edgesOf(i, j)) {
          if (inShaft.has(e.ni * size + e.nj)) continue;
          const art = mesh.floorNear(e.ni + 0.5, e.nj + 0.5, top);
          if (art === undefined || Math.abs(art - top) > STEP_SNAP) continue;
          const sim = resolveWalker(terrain, e.ni + 0.5, e.nj + 0.5, top).height;
          if (Math.abs(sim - top) <= STEP_SNAP) continue;
          const q = Math.round(art * 32);
          for (let L = 0; L < masks.length; L++) {
            if (present(L, e.ni, e.nj)) continue;
            let clash = false;
            for (let vj = e.nj; vj <= e.nj + 1; vj++) {
              for (let vi = e.ni; vi <= e.ni + 1; vi++) {
                for (let cj = vj - 1; cj <= vj; cj++) {
                  for (let ci = vi - 1; ci <= vi; ci++) {
                    if (present(L, ci, cj) && heights[L][vj][vi] !== q) clash = true;
                  }
                }
              }
            }
            if (clash) continue;
            for (let vj = e.nj; vj <= e.nj + 1; vj++) {
              for (let vi = e.ni; vi <= e.ni + 1; vi++) heights[L][vj][vi] = q;
            }
            masks[L][e.nj][e.ni] = "1";
            patched++;
            break;
          }
        }
      }
    }
  }
  return patched;
}

/**
 * The bases' floors (fcop-fidelity.md P11) as the sim's per-surface cell masks:
 * '1' where the floor hurts team 0's mech, '2' team 1's, '0' elsewhere.
 *
 * The rules artifact gives each terrain sample's highest plate's code, and every
 * plate of the samples whose plates disagree (a base floor under a roof, a deck
 * over a plain road). A sample tile [x, x+1) maps onto sim cell x + LOGIC_OFFSET
 * exactly, the offset being whole cells. On a stacked sample each sim surface
 * takes the plate nearest its own height at the cell's centre, so a mech on the
 * roof is not on the floor beneath it. undefined when no floor exists (Hk).
 */
function floorMasks(
  terrain: MapData,
  rules: FcopRules,
  teamOfSlot: (slot: number) => number,
): string[][] | undefined {
  const surf = rules.surface;
  const decode = (ch: string): number => (ch === "." ? -1 : surf.alphabet.indexOf(ch));
  const hurts = new Map<number, number>();
  for (const f of rules.damageFloors) {
    if (f.damagePerStep !== FLOOR_DAMAGE_PER_STEP) {
      throw new Error(`${rules.mapId}: floor ${f.code} deals ${f.damagePerStep} a step`);
    }
    hurts.set(f.code, teamOfSlot(f.hurtsSlot));
  }
  if (hurts.size === 0) return undefined;
  const stacked = new Map<string, FcopRules["surface"]["stacked"][number]["plates"]>();
  for (const st of surf.stacked) stacked.set(`${st.x},${st.z}`, st.plates);
  const size = terrain.size;
  const cs = terrain.cellSize;
  const masks: string[][] = [];
  for (let L = 0; L <= terrain.layerHeights.length; L++) {
    const rows: string[] = [];
    for (let j = 0; j < size; j++) {
      let row = "";
      for (let i = 0; i < size; i++) {
        const x = i - LOGIC_OFFSET_X;
        const z = j - LOGIC_OFFSET_Z;
        let code = -1;
        if (x >= 0 && z >= 0 && x < surf.answeredCols && z < surf.answeredRows) {
          const plates = stacked.get(`${x},${z}`);
          if (plates) {
            const h = resolveHeight(terrain, (i + 0.5) * cs, (j + 0.5) * cs, L);
            let best = plates[0];
            for (const pl of plates) {
              if (Math.abs(pl.heightM - h) < Math.abs(best.heightM - h)) best = pl;
            }
            code = best.code;
          } else {
            code = decode(surf.codes[z][x]);
          }
        }
        const team = hurts.get(code);
        row += team === undefined ? "0" : String(1 + team);
      }
      rows.push(row);
    }
    masks.push(rows);
  }
  return masks;
}

/**
 * The arena's water (fcop-fidelity.md P13): the original's surface code 1, as
 * the sim's per-cell mask with each cell's own surface. The rules artifact
 * indexes every sample that carries a code-1 plate into its distinct levels (a
 * level is that plate's corner height range); a sloped plate's level is taken
 * at its top, so a hover never rides below it. The arena-wide `waterLevel` is
 * the level most samples carry (its banks and its aircraft read that one).
 * undefined on a dry arena, whose stage-1 `water` / `waterLevel` stay as they are.
 */
function waterOf(
  size: number,
  rules: FcopRules,
): { water: string[]; waterLevel: number; waterLevels: number[] } | undefined {
  const surf = rules.surface;
  if (surf.waterLevels.length === 0) return undefined;
  if (surf.waterLevels.length > 9) throw new Error(`${rules.mapId}: more than 9 water levels`);
  const count = new Array<number>(surf.waterLevels.length).fill(0);
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    let row = "";
    for (let i = 0; i < size; i++) {
      const x = i - LOGIC_OFFSET_X;
      const z = j - LOGIC_OFFSET_Z;
      const ch =
        x >= 0 && z >= 0 && x < surf.answeredCols && z < surf.answeredRows
          ? (surf.waterRows[z]?.[x] ?? ".")
          : ".";
      if (ch === ".") {
        row += "0";
        continue;
      }
      const k = Number.parseInt(ch, 10);
      if (!(k >= 0 && k < surf.waterLevels.length)) {
        throw new Error(`${rules.mapId}: water sample (${x}, ${z}) names level "${ch}"`);
      }
      count[k] += 1;
      row += String(k + 1);
    }
    water.push(row);
  }
  let main = 0;
  for (let k = 1; k < count.length; k++) if (count[k] > count[main]) main = k;
  return {
    water,
    waterLevel: surf.waterLevels[main].maxM,
    waterLevels: surf.waterLevels.map((l) => l.maxM),
  };
}

/**
 * A base's Dreadnought and Fortress zones (fcop-fidelity.md R10) and the
 * Fortress spawner, from the rules artifact: each type-14 zone's radius is the
 * record's r << 4 world units (r / 512 m; the mech's own radius comes on top in
 * the sim), the opening poll the slot's fn30/fn31 period. The Dreadnought's
 * spawner is the Dreadnought record the base already carries; asserted.
 */
function heavyOf(
  rules: FcopRules,
  team: number,
  teamOfSlot: (slot: number) => number,
  dreadX: number,
  dreadY: number,
): {
  heavyZones: {
    juggernaut: { x: number; y: number; radius: number };
    fortress: { x: number; y: number; radius: number };
    pollTicks: number;
  };
  fortressSpawn: number[];
} {
  const zones = rules.heavyZones.filter((z) => teamOfSlot(z.slot) === team);
  const enable = rules.heavyEnable.filter((e) => teamOfSlot(e.slot) === team);
  const dread = zones.find((z) => z.unit === "dreadnought");
  const fort = zones.find((z) => z.unit === "flying_fortress");
  if (zones.length !== 2 || !dread || !fort || enable.length !== 1) {
    throw new Error(`${rules.mapId}: team ${team} lacks its two heavy zones or their poll`);
  }
  const spawner = (template: number) => {
    const s = rules.spawners.find((q) => q.template === template);
    if (!s) throw new Error(`${rules.mapId}: no spawner for template ${template}`);
    return s;
  };
  const d = spawner(dread.template);
  if (Math.abs(round4(sx(d.x)) - dreadX) > 0.01 || Math.abs(round4(sz(d.z)) - dreadY) > 0.01) {
    throw new Error(`${rules.mapId}: team ${team}'s Dreadnought spawner is not its record`);
  }
  const f = spawner(fort.template);
  const zone = (z: (typeof zones)[number]) => ({
    x: round4(sx(z.x)),
    y: round4(sz(z.z)),
    radius: round4(rangeToCells(z.radiusRaw)),
  });
  return {
    heavyZones: {
      juggernaut: zone(dread),
      fortress: zone(fort),
      pollTicks: toSimTicks(enable[0].pollUnits, TICK_HZ),
    },
    fortressSpawn: [round4(sx(f.x)), round4(sz(f.z))],
  };
}

/** A rules-artifact pickup's kind as the sim's PICKUP_* (the grant's reading). */
function RULES_PICKUP_KIND(p: FcopRules["pickups"][number]): number {
  if (p.kind === "health") return PICKUP_KIND.restore_health;
  if (p.kind === "cloak") return PICKUP_KIND.invisibility;
  const slot = p.kind === "ammo" ? p.ammoSlots[0] : p.powerUpSlots[0];
  const names =
    p.kind === "ammo"
      ? ["reload_gun", "reload_heavy", "reload_special"]
      : ["power_up_gun", "power_up_heavy", "power_up_special"];
  const kind = PICKUP_KIND[names[slot] ?? ""];
  if (kind === undefined) throw new Error(`${p.template}: no kind for ${p.kind} slot ${slot}`);
  return kind;
}

/** A spawner's position in sim coordinates, by its Csac template. */
function spawnerAt(rules: FcopRules, template: number): number[] {
  const s = rules.spawners.find((q) => q.template === template);
  if (!s) throw new Error(`${rules.mapId}: no spawner for template ${template}`);
  return [round4(sx(s.x)), round4(sz(s.z))];
}

/** A queue's period in sim ticks, by its rows in the rules artifact. */
function queueTicksOf(rules: FcopRules, pick: (q: FcopRules["queues"][number]) => boolean): number {
  const rows = rules.queues.filter(pick);
  if (rows.length !== 1) throw new Error(`${rules.mapId}: ${rows.length} queues match, want 1`);
  return toSimTicks(rows[0].periodUnits, TICK_HZ);
}

/**
 * A base's spawn queues and spawners (fcop-fidelity.md R18): its tanks queue on
 * the slot's base tank function (fn18/fn19) and leave the tank spawner, its jets
 * leave the jet spawner at once; the base jet queue is the Sky Captain's (fn17),
 * which only the second slot carries — the first slot's captain, which the
 * original never fields, takes the same period.
 */
function baseQueuesOf(
  rules: FcopRules,
  slot: number,
): { tankSpawn: number[]; jetSpawn: number[]; queueTicks: { tank: number; jet: number } } {
  const shop = (kind: string) => {
    const b = rules.buyTriggers.find((t) => t.slot === slot && t.kind === kind);
    if (!b) throw new Error(`${rules.mapId}: slot ${slot} has no ${kind} shop`);
    return b;
  };
  const tank = shop("tank");
  const base = (q: FcopRules["queues"][number]) => q.outpost === null;
  const ownJet = rules.queues.some((q) => base(q) && q.kind === "jet" && q.slot === slot);
  return {
    tankSpawn: spawnerAt(rules, tank.template),
    jetSpawn: spawnerAt(rules, shop("jet").template),
    queueTicks: {
      tank: queueTicksOf(rules, (q) => q.fn === tank.queueFn),
      jet: queueTicksOf(rules, (q) => base(q) && q.kind === "jet" && (!ownJet || q.slot === slot)),
    },
  };
}

/**
 * An outpost's spawners and queues per team (fcop-fidelity.md R18): a tank
 * bought at its activation zone queues on the slot's outpost tank function, a
 * jet bought at its claim zone leaves the jet spawner at once; the outpost's jet
 * queue is the captain's, carried by one slot and shared as the base's is.
 * Asserted to be the evidence's outpost by distance.
 */
function outpostQueuesOf(
  rules: FcopRules,
  k: number,
  slots: number[],
  tankPad: number[],
): {
  tankSpawn: number[][];
  jetSpawn: number[][];
  queueTicks: { tank: number; jet: number }[];
} {
  const out = slots.map((slot) => {
    const shop = rules.outpostShop.find((o) => o.outpost === k && o.slot === slot);
    if (!shop) throw new Error(`${rules.mapId}: outpost ${k} has no shop for slot ${slot}`);
    const tankSpawn = spawnerAt(rules, shop.tankTemplate);
    if (Math.hypot(tankSpawn[0] - tankPad[0], tankSpawn[1] - tankPad[1]) > 12) {
      throw new Error(`${rules.mapId}: outpost ${k}'s tank spawner is not by its tank pad`);
    }
    const jets = (q: FcopRules["queues"][number]) => q.outpost === k && q.kind === "jet";
    const ownJet = rules.queues.some((q) => jets(q) && q.slot === slot);
    return {
      tankSpawn,
      jetSpawn: spawnerAt(rules, shop.jetTemplate),
      queueTicks: {
        tank: queueTicksOf(rules, (q) => q.fn === shop.tankQueueFn),
        jet: queueTicksOf(rules, (q) => jets(q) && (!ownJet || q.slot === slot)),
      },
    };
  });
  return {
    tankSpawn: out.map((o) => o.tankSpawn),
    jetSpawn: out.map((o) => o.jetSpawn),
    queueTicks: out.map((o) => o.queueTicks),
  };
}

/** Interns weapon profiles so identical originals share one index. */
class WeaponTable {
  readonly list: Weapon[] = [];
  intern(w: Weapon): number {
    const key = (x: Weapon) => JSON.stringify(x);
    const k = key(w);
    for (let i = 0; i < this.list.length; i++) if (key(this.list[i]) === k) return i;
    this.list.push(w);
    return this.list.length - 1;
  }
}

/**
 * Which unit a build console sells, read off the Cobj parked on it.
 *
 * The original labels its consoles with an icon rather than a field, and the
 * icon is a UV window into the shared 256x256 base atlas. Measured on the raw
 * assemblies in tools/generators/units/raw/fcop/, the icon face of each
 * console model samples one of two windows:
 *
 *   y 0..28  -> a yellow jet silhouette   -> AIR   (obj 33, obj 39)
 *   y 28..56 -> a yellow tank silhouette  -> GROUND (obj 27, obj 40)
 *
 * Conft and Slim mark the air console with obj 41 — the flyer model itself —
 * instead of an icon pillar. Same meaning.
 *
 * This replaces a footprint-width heuristic. On Mp the wider trigger (819) is
 * the one wearing the JET, so calling the wider one "ground" sold Runners at
 * the aircraft console and Guardians at the tank console. Joke, Hk and Ovmp
 * were wrong the same way; Conft and Slim happened to come out right.
 */
const CONSOLE_ICON_AIR = new Set([33, 39, 41]);
const CONSOLE_ICON_GROUND = new Set([27, 40]);

type ConsoleTrigger = Logic["triggers"][number];

function consoleRole(trigger: ConsoleTrigger, props: Logic["props"]): "ground" | "air" | "unknown" {
  let best: Logic["props"][number] | null = null;
  let bestD = Infinity;
  for (const p of props) {
    const d = Math.hypot(p.x - trigger.x, p.z - trigger.z);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  // The console Cobj sits ON the trigger: measured 0.07-0.42 cells on all six
  // missions. Anything further away is some other piece of scenery.
  if (!best || bestD > 1.5) return "unknown";
  if (CONSOLE_ICON_AIR.has(best.objId)) return "air";
  if (CONSOLE_ICON_GROUND.has(best.objId)) return "ground";
  return "unknown";
}

/** [ground, air] triggers for one base, keyed off their console icons. */
function assignConsoles(
  triggers: readonly ConsoleTrigger[],
  props: Logic["props"],
  team: number,
): [ConsoleTrigger, ConsoleTrigger] {
  if (triggers.length < 2) {
    throw new Error(`base ${team} has ${triggers.length} action-button triggers, need 2`);
  }
  const byId = [...triggers].sort((a, b) => a.id - b.id);
  const ground = byId.filter((t) => consoleRole(t, props) === "ground");
  const air = byId.filter((t) => consoleRole(t, props) === "air");
  if (ground.length !== 1 || air.length !== 1) {
    // Refuse to guess. A mission whose consoles carry an icon this table does
    // not know is a data question, and getting it backwards is invisible in
    // every screenshot — you only notice when the wrong unit rolls out.
    const seen = byId.map((t) => `${t.id}:${consoleRole(t, props)}`).join(" ");
    throw new Error(
      `base ${team}: cannot tell the build consoles apart from their icons (${seen}). ` +
        `Add the console Cobj id to CONSOLE_ICON_AIR / CONSOLE_ICON_GROUND.`,
    );
  }
  return [ground[0], air[0]];
}

// ---------------------------------------------------------------------------
// The original's outposts (docs/specs/fcop-re/outposts.md)
// ---------------------------------------------------------------------------

/** One record stacked on an outpost turret plate (outposts.json `plates[].records`). */
interface PlateRecord {
  id: number;
  type: number;
  team: number;
}

/** One outpost as outposts.json carries it, in the extract_logic frame. */
interface EvidenceOutpost {
  index: number;
  claim_zone: { x: number; z: number; radius_m: number };
  sides: Record<string, { pads: { unit: string; cost: number; x: number; z: number }[] }>;
  plates: { x: number; z: number; records: PlateRecord[] }[];
}

interface EvidenceMap {
  base_plates: { csac: number; team: number; respawn_s: number }[];
  outposts: EvidenceOutpost[];
}

/**
 * The outposts of `arena`'s mission, read from the committed evidence
 * (docs/specs/fcop-re/outposts.json, built from the shipped mission bytes and
 * scripts). Four per PA map, in owner-word order W40..W43, each with a type-14
 * claim zone, a tank and a jet pad per side, and two turret plates carrying a
 * type-36 neutral turret (live at start) and both teams' type-8 records (shut at
 * load, opened by that side's claim).
 */
function evidenceOf(arena: FcopArena): EvidenceMap {
  const all = JSON.parse(
    readFileSync(join(REPO_ROOT, "docs", "specs", "fcop-re", "outposts.json"), "utf8"),
  ) as { maps: Record<string, EvidenceMap> };
  const m = all.maps[arena.mission];
  if (!m) throw new Error(`outposts.json has no entry for mission ${arena.mission}`);
  if (m.outposts.length !== 4) {
    throw new Error(`${arena.mission}: outposts.json lists ${m.outposts.length} outposts, not 4`);
  }
  return m;
}

/** Every record id stacked on any outpost plate: the outposts' own turrets. */
function outpostMembers(ev: EvidenceMap): Set<number> {
  const ids = new Set<number>();
  for (const o of ev.outposts) for (const p of o.plates) for (const r of p.records) ids.add(r.id);
  return ids;
}

/**
 * A shooter's weapon profile: its record's reach, re-search period and fov, and
 * the catalogue entry its weapon id names (balance.ts WORLD_WEAPONS; the
 * mission's type-98 catalogue, fcop-re/ranges-turrets-capture.md Q3) — damage,
 * refire, round speed and flight, guided or lead-aimed (fcop-fidelity.md W3).
 * `arc`: the shooter blocks its side and rear sectors (bitfield 0x02|0x04, every
 * PA turret); `hold` + `priority`: HOLD_TARGET and the priority preference
 * (0x4000 and 0x40, the team turrets' bitfield 0x4246).
 */
function shooterWeapon(
  sh: Shooter,
  turnSpeed: number,
  opts: { arc: boolean; hold: boolean; priority: boolean },
): Weapon {
  const w = WORLD_WEAPONS[sh.weaponId];
  if (w === undefined) {
    throw new Error(`weapon_id ${sh.weaponId} is not in balance.ts WORLD_WEAPONS`);
  }
  if (w.rounds !== 1 || w.w0e !== 0 || w.accel !== 0) {
    throw new Error(`weapon_id ${sh.weaponId}: bursts, blasts and acceleration are not modelled`);
  }
  if (w.kind !== WORLD_KIND_LEAD && w.kind !== WORLD_KIND_GUIDED) {
    throw new Error(`weapon_id ${sh.weaponId}: catalogue kind ${w.kind} is not modelled`);
  }
  const refireUnits = gapUnits(w.burstGap);
  return {
    range: rangeToCells(sh.engageRangeRaw),
    delay: Math.max(1, Math.round((refireUnits * TICK_HZ) / 300)),
    damage: w.damage,
    turnSpeed,
    fovCos: fovToCos(sh.fovRaw),
    refireUnits,
    searchUnits: gapUnits(Math.abs(sh.targetingDelayRaw)),
    speed: roundSpeed(w.speed),
    flight: rangeToCells(w.range),
    guided: w.kind === WORLD_KIND_GUIDED ? 1 : 0,
    lead: w.kind === WORLD_KIND_LEAD ? 1 : 0,
    arcCos: opts.arc ? SHOOTER_FRONT_ARC_COS : -1,
    hold: opts.hold ? 1 : 0,
    priority: opts.priority ? 1 : 0,
  };
}

/** A team (type 8) turret holds its target and prefers priority; a neutral (36) does neither. */
function turretWeapon(t: Turret, table: WeaponTable, team: boolean): number {
  return table.intern(
    shooterWeapon(t.shooter, round4(turnSpeedToRadPerTick(t.turnSpeedRaw, TICK_HZ)), {
      arc: true,
      hold: team,
      priority: team,
    }),
  );
}

/**
 * A side's purchasable tank, jet and Flying Fortress: health and weapon from its
 * own spawner record. Every one of a kind on a side carries the same values
 * (asserted), which is what lets one profile stand for all of them.
 */
function unitProfiles(
  logic: Logic,
  team: number,
  table: WeaponTable,
): Record<"runner" | "guardian" | "fortress", { hp: number; weapon: number }> {
  const one = (list: { id: number; health: number; shooter: Shooter }[], what: string) => {
    if (list.length === 0) throw new Error(`team ${team} has no ${what} record`);
    const key = (u: { health: number; shooter: Shooter }) => JSON.stringify([u.health, u.shooter]);
    if (new Set(list.map(key)).size !== 1) {
      throw new Error(`team ${team}'s ${what} records disagree on health or weapon`);
    }
    const u = list[0];
    return {
      hp: u.health,
      weapon: table.intern(
        shooterWeapon(u.shooter, 0, { arc: false, hold: false, priority: false }),
      ),
    };
  };
  const tanks = logic.units.filter((u) => u.team === team && u.spawnLimit === 20);
  const air = logic.aircraft.filter((a) => a.team === team);
  // The jets and the Fortress share the type-9 record; the Fortress is the one
  // with the heavy hull (class 4, 2000 HP against the jets' 150).
  const top = Math.max(...air.map((a) => a.health));
  return {
    runner: one(tanks, "tank"),
    guardian: one(
      air.filter((a) => a.health !== top),
      "jet",
    ),
    fortress: one(
      air.filter((a) => a.health === top),
      "Flying Fortress",
    ),
  };
}

// ---------------------------------------------------------------------------
// Lane graph
// ---------------------------------------------------------------------------

interface Graph {
  nodes: { x: number; z: number; layer: number }[];
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

function buildGraph(
  logic: Logic,
  teamNet: number[],
  enemyBase: { x: number; z: number }[],
  terrain: MapData,
): Graph {
  const nodes: { x: number; z: number; layer: number }[] = [];
  const edges: number[][] = [];
  const offsetOf = new Map<number, number>();

  for (const net of ownedNets(logic, teamNet)) {
    offsetOf.set(net.netId, nodes.length);
    const base = nodes.length;
    for (const n of net.nodes) {
      const x = round4(sx(n.x));
      const z = round4(sz(n.z));
      nodes.push({
        x,
        z,
        layer: layerFromCast(terrain, x, z, n.groundCast),
      });
    }
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
function graphRoute(
  graph: Graph,
  team: number,
): (number[] | { x: number; y: number; layer: number })[] {
  const out: (number[] | { x: number; y: number; layer: number })[] = [];
  let at = graph.entry[team];
  const seen = new Set<number>();
  while (at >= 0 && !seen.has(at)) {
    seen.add(at);
    const n = graph.nodes[at];
    out.push(emitPoint(n.x, n.z, n.layer));
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
  /** Where the Juggernaut (the original Dreadnought) spawns: [x, y]. */
  readonly juggernaut: readonly number[];
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
    // Leg 1b — the Juggernaut's own spawn (the Dreadnought record, node 0 of
    // its Cnet by the HQ) to wherever the road was joined above. Usually a few
    // centimetres; when leg 1 re-picked the entry it is a real beeline, and a
    // Juggernaut that cannot reach the road never leaves its base.
    const jug = bases[team].juggernaut;
    const entry = graph.nodes[graph.entry[team]];
    if (!segmentWalkable(map, jug[0], jug[1], entry.x, entry.z)) {
      carve(jug[0], jug[1], entry.x, entry.z);
      entries.push(`team ${team} Juggernaut leg to #${graph.entry[team]} CARVED`);
    }
    // Leg 3 — the road's far end into the enemy gate. This one has no
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

/**
 * Opens the minimum number of extra wall bits needed to make every lane node and
 * capture spot reachable from a spawn.
 *
 * This used to carry a private layer-blind flood and 10 breaches on la-cantina,
 * because flattening a bridged arena to one storey walls off the outer ring
 * corridor the original reaches over and under bridges. Issue #29 removed the
 * cause: the arena carries its decks, walls are attributed per deck, and the
 * flood is `reachableFrom` — which enters a deck sideways where the ground rises
 * to its edge, the way the original's ramps do.
 *
 * The breach machinery stays, because "no breaches needed" is a measurement, not
 * an assumption: whatever it opens is counted and reported, so a future arena
 * that does need help says so out loud instead of shipping dead content.
 */

/**
 * A thing that has to be reachable, and how close is close enough.
 *
 * `reach` is in cells. 0 means the target's OWN cell must be in the flood, which
 * is right for anything walked on — a lane node, a buy console, a spawn.
 *
 * It is wrong for a capture pad. Capturing is proximity — an action-key press
 * within the arena's capture range plus the capturer's radius, at least 4.0 + 0.4 m
 * on every imported arena (sim.ts systemCapture) — and the original mounts these pads
 * on raised plinths with parapets around them, so demanding the pad cell itself
 * be walkable asks for something the game never asks for — and the only way to
 * grant it is to knock the parapets down. All 8 of la-cantina's outer-ring pads
 * have a walkable cell ONE cell away; they were never unreachable, the test for
 * "reachable" was.
 */
interface RepairTarget {
  x: number;
  y: number;
  /** Reachable cells within this many cells satisfy the target. Default 0. */
  reach?: number;
  /** What this is, for the report — so a residual breach says what it bought. */
  kind: string;
}
function repairReachability(
  raw: MapJson,
  wallsV: string[],
  wallsH: string[],
  targets: RepairTarget[],
  limit: number,
): { opened: number; forKind: Map<string, number> } {
  const size = raw.size;
  const v = wallsV.map((row) => row.split(""));
  const h = wallsH.map((row) => row.split(""));
  let opened = 0;
  /** Bits opened per target kind, so the residual is attributable. */
  const forKind = new Map<string, number>();

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
    const reached = reachableFrom(map, raw.spawns[0].x, raw.spawns[0].y).cellKeys;
    const ci = (val: number): number => Math.min(size - 1, Math.max(0, Math.floor(val)));
    // Euclidean, on cell centres, so `reach` means the same thing the sim's
    // radius checks mean rather than a Manhattan approximation of it.
    const satisfied = (t: RepairTarget): boolean => {
      const r = t.reach ?? 0;
      if (reached.has(ci(t.x) * size + ci(t.y))) return true;
      if (r <= 0) return false;
      const i0 = ci(t.x - r);
      const i1 = ci(t.x + r);
      const j0 = ci(t.y - r);
      const j1 = ci(t.y + r);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          if (!reached.has(i * size + j)) continue;
          const dx = i + 0.5 - t.x;
          const dy = j + 0.5 - t.y;
          if (dx * dx + dy * dy <= r * r) return true;
        }
      }
      return false;
    };
    const missing = targets.filter((t) => !satisfied(t));
    if (missing.length === 0) {
      writeBack();
      return { opened, forKind };
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
    const before = opened;
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
    if (opened > before) {
      forKind.set(target.kind, (forKind.get(target.kind) ?? 0) + (opened - before));
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

/**
 * The gate triggers: no `retrigger`, no `action_button`. Each base carries one
 * box, listed six times — once per watched enemy tank template and once for the
 * enemy Dreadnought — on all six missions (fcop-re/ai-and-rules.md §5).
 */
function isGateTrigger(t: Logic["triggers"][number]): boolean {
  return !t.flags.includes("retrigger") && !t.flags.includes("action_button");
}

/**
 * The gate of the base whose own Dreadnought is `ownId`, read from the gate
 * trigger that watches the enemy Dreadnought `enemyId` — entering it with an
 * enemy tank or Dreadnought is the original's win (fcop-re/ai-and-rules.md §5).
 *
 * Box half-extents are raw/1024 m (fcopLogic.ts TRIGGER_SCALE; the sim adds the
 * intruder's radius). `radius` is the larger half-extent: what the renderer and
 * the AI read as the gate's size.
 */
function gateOf(
  logic: Logic,
  enemyId: number,
  ownId: number,
): { x: number; y: number; radius: number; halfW: number; halfL: number } {
  const hits = logic.triggers.filter((t) => isGateTrigger(t) && t.watchesActor === enemyId);
  if (hits.length !== 1) {
    throw new Error(
      `Dreadnought ${ownId}: expected one gate trigger watching enemy Dreadnought ${enemyId}, ` +
        `found ${hits.length}`,
    );
  }
  const t = hits[0];
  const halfW = round4(triggerHalfExtent(t.widthRaw));
  const halfL = round4(triggerHalfExtent(t.lengthRaw));
  return {
    x: round4(sx(t.x)),
    y: round4(sz(t.z)),
    radius: Math.max(halfW, halfL),
    halfW,
    halfL,
  };
}

/**
 * The committed map with the retired §9 base fields (coreHp, production,
 * built-in guns — SIM_VERSION 32) dropped, so the strict loader accepts it as
 * the terrain input. Every base field is rebuilt below anyway.
 */
function terrainOnly(raw: MapJson): MapJson {
  const bases = raw.bases.map((b) => {
    const { coreHp, productionTicks, productionLimit, defence, ...rest } = b as typeof b & {
      coreHp?: unknown;
      productionTicks?: unknown;
      productionLimit?: unknown;
      defence?: unknown;
    };
    void coreHp;
    void productionTicks;
    void productionLimit;
    void defence;
    return rest;
  });
  // A fresh stage-1 terrain still carries convert.ts's hand outpost spots but no
  // outposts, which the loader refuses; every feature list is rebuilt below.
  return raw.outposts === undefined ? { ...raw, bases, outpostSpots: [] } : { ...raw, bases };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildArena(arena: FcopArena): { json: MapJson; stats: EnrichStats; graph: Graph } {
  const { mapId } = arena;
  assertFrameOffset(mapId);
  const mapPath = join(REPO_ROOT, "packages", "sim", "maps", `${mapId}.json`);
  const raw = terrainOnly(JSON.parse(readFileSync(mapPath, "utf8")) as MapJson);
  // Terrain for layer sampling only — features below overwrite spawns downwards.
  const terrain = loadMapFromJson(raw);
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as Logic;
  const rules = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", rulesFile(arena)), "utf8"),
  ) as FcopRules;

  // Team 0 is the low end of the field axis; each side's Dreadnought drives its
  // own Cnet (fcop-logic.md §8.1) and the side owns the nearer X1Alpha. The
  // Dreadnought records stand next to each HQ, so they are what locates a base.
  const field = fieldOf(logic.dreadnoughts);
  const teams = teamsOf(logic.dreadnoughts, logic.spawns, field);
  const teamBases = teams.map((t) => t.base);
  const teamSpawns = teams.map((t) => t.spawn);
  // The original's player slot 0 is X1Alpha 12, slot 1 X1Alpha 16 (the rules
  // artifact's x1alpha); which team that is falls out of the base pairing.
  const teamOfSlot = (slot: number): number => {
    const rec = rules.x1alpha.find((x) => x.slot === slot);
    const team = rec ? teamSpawns.findIndex((sp) => sp.id === rec.id) : -1;
    if (team < 0) throw new Error(`${mapId}: no team owns player slot ${slot}`);
    return team;
  };
  const slotOfTeam = (team: number): number => (teamOfSlot(0) === team ? 0 : 1);
  const teamNet = [teamBases[0].netId, teamBases[1].netId];
  // Each side's gate: the trigger that watches the ENEMY's Dreadnought.
  const gates = teamBases.map((own, team) => gateOf(logic, teamBases[1 - team].id, own.id));
  // A team's road leads to the enemy GATE — the objective since SIM_VERSION 32.
  const enemyBase = [
    { x: gates[1].x, z: gates[1].y },
    { x: gates[0].x, z: gates[0].y },
  ];

  const table = new WeaponTable();

  // --- bases -------------------------------------------------------------
  // The two `action_button` triggers per base are the base's own interaction
  // points (fcop-logic.md §8.6: they watch that base's own X1Alpha), so they are
  // the build consoles. Which is which comes from the Cobj standing on each one
  // — see consoleRole(). This used to be "the wider footprint is the ground
  // console", which was a guess, and on four of six missions it was the wrong
  // way round.
  const evidence = evidenceOf(arena);
  const members = outpostMembers(evidence);
  let ringDropped = 0;
  const bases = teamBases.map((base, team) => {
    const own = teamSpawns[team];
    const buttons = assignConsoles(
      logic.triggers.filter((t) => t.flags.includes("action_button") && t.watchesActor === own.id),
      logic.props,
      team,
    );
    const coreX = round4(sx(base.x));
    const coreY = round4(sz(base.z));
    const gcx = round4(sx(buttons[0].x));
    const gcy = round4(sz(buttons[0].z));
    const acx = round4(sx(buttons[1].x));
    const acy = round4(sz(buttons[1].z));
    // Each console's trigger box: a purchase answers inside it, widened by the
    // buyer's radius (fcop-fidelity.md R17), as the gates are measured.
    const buyBox = (t: (typeof buttons)[number]) => ({
      halfW: round4(triggerHalfExtent(t.widthRaw)),
      halfL: round4(triggerHalfExtent(t.lengthRaw)),
    });
    // Permanent base ring = the type-8 records that belong to no outpost. The
    // original lists 16 (or 14) type-8 records per side, but only 8 (6 on
    // Slim/Joke/Hk) are base guns, live from t = 0: the rest stand on the
    // outposts' turret plates with the other side's record and a NeutralTurret,
    // shut at load, and open only when that side claims the outpost
    // (fcop-re/outposts.md Q1). Those are imported with the outposts below.
    //
    // Membership comes from the evidence (outposts.json), not from a half-cell
    // pad key: the key leaked on Conft, where Csac217 (team 1) sits at x 147.75 ->
    // key 148.0 while its plate-mates key to 147.5, so team 1's ring got a 9th
    // turret that is outpost 3's (and Slim/Joke a 7th the same way). The count is
    // asserted against the evidence's base plates.
    const ownTurrets = logic.turrets
      .filter((t) => t.team === base.team && !members.has(t.id))
      .sort((a, b) => a.id - b.id);
    const basePlates = evidence.base_plates.filter((p) => p.team === base.team).length;
    if (ownTurrets.length !== basePlates) {
      throw new Error(
        `${mapId}: team ${base.team} keeps ${ownTurrets.length} non-outpost type-8 turrets, ` +
          `outposts.json lists ${basePlates} base plates`,
      );
    }
    // MapBase.turrets caps at 16. The ring is 8 on Mp/Conft/Ovmp and 6 on
    // Slim/Joke/Hk; count anything the cap would drop.
    const ring = ownTurrets.slice(0, 16);
    ringDropped += ownTurrets.length - ring.length;
    // The ring's spawner period: tSAC -2250 = 37.5 s after each death on every PA
    // map (fcop-re/outposts.md Q1; the plates' -1500 is the outposts'). One
    // value per base, asserted shared by its records and against the evidence.
    const periods = new Set(ring.map((t) => t.spawnTicks));
    if (periods.size !== 1) {
      throw new Error(
        `${mapId}: team ${base.team}'s ring turrets disagree on their respawn period`,
      );
    }
    const turretRespawnTicks = toSimTicks(ring[0].spawnTicks, TICK_HZ);
    for (const p of evidence.base_plates) {
      if (p.team === base.team && Math.round(p.respawn_s * TICK_HZ) !== turretRespawnTicks) {
        throw new Error(
          `${mapId}: ring respawn ${turretRespawnTicks} ticks, outposts.json says ${p.respawn_s} s`,
        );
      }
    }

    return {
      // The original's gate trigger box (gateOf). Features without a Cnet
      // ground_cast stay layer 0 (see layerFromCast).
      gate: gates[team],
      // The HQ anchor, at the Dreadnought record — which is where the original
      // stands its Dreadnought by node 0 of the Cnet, next to the HQ. No HP: the
      // original has no destructible core (fcop-fidelity.md I6/R1).
      core: [coreX, coreY],
      groundConsole: [gcx, gcy],
      groundBuy: buyBox(buttons[0]),
      airConsole: [acx, acy],
      airBuy: buyBox(buttons[1]),
      // The ring carries each Turret actor's OWN shooter block, not just its
      // position. Dropping it once left the ring on the then-global 28 m TURRET_RANGE
      // against an imported engage_range of 12 m — see spawnBaseTurret in sim.ts.
      // Every mission's ring shares the neutrals' parameters exactly, so these
      // intern to the same profile the capturable pads already use.
      turrets: ring.map((t) => ({
        x: round4(sx(t.x)),
        y: round4(sz(t.z)),
        weapon: turretWeapon(t, table, true),
        hp: t.health,
        yaw: round4(rotToYaw(t.gunRotationRaw, true)),
      })),
      turretRespawnTicks,
      // The type-28 record IS the Dreadnought (fcop-re/ranges-turrets-capture.md
      // top + Q4): the Juggernaut spawns where it stands, with its 3000 HP and its
      // four hull guns, each its record's shooter on catalogue weapon 3. The
      // mounts' own yaw (237°/s, relative to the hull) is not modelled — the guns
      // stand at the hull and aim at their target — so their ±22.5° arc is not
      // applied either.
      juggernaut: {
        x: coreX,
        y: coreY,
        hp: base.health,
        guns: base.gunCount,
        weapon: table.intern(
          shooterWeapon(base.gun, 0, { arc: false, hold: false, priority: false }),
        ),
      },
      // The tank, jet and Flying Fortress spawner records (fcop-fidelity.md W3).
      ...unitProfiles(logic, base.team, table),
      ...heavyOf(rules, team, teamOfSlot, coreX, coreY),
      ...baseQueuesOf(rules, slotOfTeam(team)),
    };
  });

  // --- base plots --------------------------------------------------------
  // The build area only: gate/core/consoles/pad/spawn. Ring turrets spread up to
  // ~20 cells along the base approach in the original, so a plot containing them
  // would cover a quarter of the arena.
  const pointXY = (p: number[] | { x: number; y: number }): [number, number] =>
    Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
  const basePlots = bases.map((b, team) => {
    const pts = [
      [b.gate.x, b.gate.y],
      b.core as number[],
      b.groundConsole as number[],
      b.airConsole as number[],
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
  const turretSpots = neutrals.map((t) => [round4(sx(t.x)), round4(sz(t.z))] as number[]);
  const turretParams = neutrals.map((t) => turretWeapon(t, table, false));
  const turretYaw = neutrals.map((t) => round4(rotToYaw(t.gunRotationRaw, true)));
  // The original's Turret health, rather than the Phase-1 ARCHETYPE_MAX_HP
  // placeholder. Same value the ring turrets carry — they are the same actor kind.
  const turretHp = neutrals.map((t) => t.health);

  // --- outposts ----------------------------------------------------------
  // The original's four (fcop-re/outposts.md Q3), in owner-word order W40..W43
  // so the Sky Captain's outpost indices are the original's. The spot is the
  // type-14 claim zone's centre, where the console marker stands; the pads are
  // the same two points for either side (both sides' pad records share them,
  // to a few centimetres; slot 0's are taken);
  // each plate names its NeutralTurret by turretSpots index and carries both
  // teams' type-8 records, the plate turret a claim opens.
  const neutralIndex = new Map(neutrals.map((t, k) => [t.id, k] as const));
  const turretById = new Map(logic.turrets.map((t) => [t.id, t] as const));
  const padOf = (o: EvidenceOutpost, unit: string): number[] => {
    const at = Object.values(o.sides).map((side) => {
      const pad = side.pads.find((p) => p.unit === unit);
      if (!pad) throw new Error(`${mapId}: outpost ${o.index} has a side with no ${unit} pad`);
      return pad;
    });
    for (const p of at) {
      // Within a few centimetres: Hk outpost 2's jet pads are 6 cm apart.
      if (Math.abs(p.x - at[0].x) > 0.1 || Math.abs(p.z - at[0].z) > 0.1) {
        throw new Error(`${mapId}: outpost ${o.index}'s two ${unit} pads stand apart`);
      }
    }
    return [round4(sx(at[0].x)), round4(sz(at[0].z))];
  };
  const evOutposts = [...evidence.outposts].sort((a, b) => a.index - b.index);
  const outpostSpots = evOutposts.map((o) => [
    round4(sx(o.claim_zone.x)),
    round4(sz(o.claim_zone.z)),
  ]);
  const outposts = evOutposts.map((o) => ({
    zone: round4(o.claim_zone.radius_m),
    tankPad: padOf(o, "tank"),
    jetPad: padOf(o, "jet"),
    ...outpostQueuesOf(rules, o.index, [slotOfTeam(0), slotOfTeam(1)], padOf(o, "tank")),
    plates: o.plates.map((plate) => {
      const neutral = plate.records.filter((r) => r.type === 36);
      if (neutral.length !== 1 || !neutralIndex.has(neutral[0].id)) {
        throw new Error(`${mapId}: outpost ${o.index} plate has no single imported NeutralTurret`);
      }
      return {
        spot: neutralIndex.get(neutral[0].id) as number,
        turrets: teamBases.map((b) => {
          const recs = plate.records.filter((r) => r.type === 8 && r.team === b.team);
          const t = recs.length === 1 ? turretById.get(recs[0].id) : undefined;
          if (!t) {
            throw new Error(
              `${mapId}: outpost ${o.index} plate has no team-${b.team} type-8 record`,
            );
          }
          return {
            x: round4(sx(t.x)),
            y: round4(sz(t.z)),
            weapon: turretWeapon(t, table, true),
            hp: t.health,
            yaw: round4(rotToYaw(t.gunRotationRaw, true)),
          };
        }),
      };
    }),
  }));

  // --- lane graph + polyline ---------------------------------------------
  const graph = buildGraph(logic, teamNet, enemyBase, terrain);
  const lanes = [graphRoute(graph, 0)];
  if (lanes[0].length < 2) throw new Error("team 0's committed route is shorter than 2 waypoints");

  // --- pickups / triggers / props ----------------------------------------
  const pickups = [...logic.pickups]
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const grant = p.grants.find((g) => g !== "is_set" && g !== "pickup_consume") ?? "";
      const kind = PICKUP_KIND[grant];
      if (kind === undefined) throw new Error(`pickup ${p.id} has unmapped grant "${grant}"`);
      // The rules artifact's reading of the same record (fcop-fidelity.md P9):
      // its kind must agree with the grant's, and it carries the box.
      const r = rules.pickups.find((q) => q.template === p.id);
      if (!r) throw new Error(`${mapId}: pickup ${p.id} is not in the rules artifact`);
      if (RULES_PICKUP_KIND(r) !== kind) {
        throw new Error(`${mapId}: pickup ${p.id} is kind ${kind} by its grant, not ${r.kind}`);
      }
      return {
        x: round4(sx(p.x)),
        y: round4(sz(p.z)),
        kind,
        respawnTicks: toSimTicks(p.spawnTicks, TICK_HZ),
        // Record halfwords << 4 wu: +0x2a bounds runtime axis 2 (actors x, the
        // sim's x), +0x26 axis 0 (actors z, the sim's y), +0x28 the height.
        halfW: round4(rangeToCells(r.halfRaw[2])),
        halfL: round4(rangeToCells(r.halfRaw[0])),
        halfH: round4(rangeToCells(r.halfRaw[1])),
        lift: round4(rangeToCells(r.heightOffsetRaw)),
        model: r.cobj,
        // `((spin << 4) / 218) >> 4` 4096ths a 300 Hz tick (pickup.c 0x0041e85a).
        spin: Math.trunc((p.rotationalSpeed * 16) / 218) >> 4,
      };
    });
  if (rules.pickups.length !== pickups.length) {
    throw new Error(`${mapId}: ${rules.pickups.length} rules pickups, ${pickups.length} records`);
  }

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
    if (isGateTrigger(t)) continue; // those are the gates (gateOf)
    // Hk's spawn guards hurt the mech; they do not raise the base's alert.
    if (rules.spawnGuards.some((g) => g.id === t.id)) continue;
    const x = round4(sx(t.x));
    const y = round4(sz(t.z));
    // Half-extent raw/1024 m (fcopLogic.ts TRIGGER_SCALE); the intruder's own
    // radius is added by the sim's containment test (sim.ts insideVolume), as the
    // original's test does.
    const halfW = round4(triggerHalfExtent(t.widthRaw));
    const halfL = round4(triggerHalfExtent(t.lengthRaw));
    const c0 = bases[0].core as number[];
    const c1 = bases[1].core as number[];
    const team = Math.hypot(x - c0[0], y - c0[1]) < Math.hypot(x - c1[0], y - c1[1]) ? 0 : 1;
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

  // Hk's spawn guards (fcop-fidelity.md P11): each trigger box watches the enemy
  // mech; the first box halfword bounds actors x (the sim's x), the second z.
  const spawnGuards = rules.spawnGuards.map((g) => ({
    x: round4(sx(g.x)),
    y: round4(sz(g.z)),
    halfW: round4(triggerHalfExtent(g.widthRaw)),
    halfL: round4(triggerHalfExtent(g.lengthRaw)),
    halfH: round4(triggerHalfExtent(g.heightRaw)),
    hurtsTeam: teamOfSlot(g.hurtsSlot),
    damage: g.damage,
    resetTicks: toSimTicks(g.resetUnits, TICK_HZ),
  }));

  // Icon consoles and outpost kiosks: face the nearer base core so their
  // unit-type screens read toward the pad (player stands on the apron and
  // looks at the console). Hazard barriers (Cobj 28) share the same rule —
  // striping still reads; yaw 0 left every kiosk facing world +X.
  const props = [...logic.props]
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const x = round4(sx(p.x));
      const y = round4(sz(p.z));
      const c0 = bases[0].core as number[];
      const c1 = bases[1].core as number[];
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
  ) as {
    size: number;
    wallsV: string[];
    wallsH: string[];
    layers?: { wallsV: string[]; wallsH: string[] }[];
  };
  if (pristine.size !== raw.size) {
    throw new Error(`${wallsFile(arena)} is size ${pristine.size}, map is ${raw.size}`);
  }
  const wallsV = [...pristine.wallsV];
  const wallsH = [...pristine.wallsH];
  // The lifts and the shafts they move in (fcop-fidelity.md P12), then the
  // kerbs (P15). Both edit the deck lattices too, from the snapshot's pristine
  // copies, so the output stays a function of committed inputs; an arena with
  // neither keeps its decks as stage 1 wrote them.
  // A lift comes with the decks it serves: an arena still imported as one storey
  // has no platform for it to reach.
  let lifts = arena.layered ? liftsOf(rules, terrain, teamOfSlot) : [];
  let layers = raw.layers;
  let shaftBits = 0;
  let kerbBits = 0;
  let landingCells = 0;
  if (lifts.length > 0 || arena.kerbs === true) {
    const align = MAP_ALIGN[mapId];
    const glb = join(REPO_ROOT, "packages", "client", "public", "models", mapId, `${mapId}.glb`);
    const mesh = new TerrainMesh(readGlbTriangles(glb, align.x, align.z), raw.size);
    const decks = pristine.layers ?? [];
    const lattices: Lattice[] = [
      { v: wallsV.map((r) => r.split("")), h: wallsH.map((r) => r.split("")) },
      ...decks.map((d) => ({
        v: d.wallsV.map((r) => r.split("")),
        h: d.wallsH.map((r) => r.split("")),
      })),
    ];
    const masks = (raw.layers ?? []).map((L) => L.mask.map((r) => r.split("")));
    const heights = (raw.layers ?? []).map((L) => L.heights.map((r) => [...r]));
    landingCells = landLifts(lifts, terrain, mesh, heights, masks);
    const patched = (raw.layers ?? []).map((L, k) => ({
      ...L,
      heights: heights[k],
      mask: masks[k].map((r) => r.join("")),
    }));
    // The lifts and the shafts read the terrain with their landings.
    const landed = landingCells > 0 ? loadMapFromJson({ ...raw, layers: patched }) : terrain;
    if (landingCells > 0) lifts = liftsOf(rules, landed, teamOfSlot);
    shaftBits = openLiftShafts(lifts, landed, lattices, masks);
    if (arena.kerbs === true) kerbBits = openKerbs(landed, mesh, lattices);
    for (let j = 0; j < wallsV.length; j++) {
      wallsV[j] = lattices[0].v[j].join("");
      wallsH[j] = lattices[0].h[j].join("");
    }
    layers = (raw.layers ?? []).map((L, k) => ({
      ...L,
      heights: heights[k],
      mask: masks[k].map((r) => r.join("")),
      ...(lattices[k + 1]
        ? {
            wallsV: lattices[k + 1].v.map((r) => r.join("")),
            wallsH: lattices[k + 1].h.map((r) => r.join("")),
          }
        : {}),
    }));
  }
  let carved = 0;
  let repaired = 0;
  let repairedFor = new Map<string, number>();
  let entries: string[] = [];
  if (wallsV.length > 0) {
    // Wall queries must see the PRISTINE lattice, not whatever is on disk.
    const pristineMap = loadMapFromJson({
      ...raw,
      wallsV: pristine.wallsV,
      wallsH: pristine.wallsH,
    });
    // RoadBase only needs gate + groundConsole x/y.
    const roadBases = bases.map((b) => ({
      gate: { x: b.gate.x, y: b.gate.y },
      groundConsole: pointXY(b.groundConsole as number[] | { x: number; y: number }),
      juggernaut: [b.juggernaut.x, b.juggernaut.y],
    }));
    const roads = carveRoads(pristineMap, wallsV, wallsH, graph, roadBases, arena.carveLimit);
    carved = roads.cleared;
    entries = roads.entries;
    // Opening the lane edges is not enough on its own: a corridor can be
    // drivable end to end and still be sealed off from the rest of the arena,
    // which is what leaves the outer ring's capture pads unreachable.
    const spawns = out0Spawns(teamSpawns, rules);
    const repair = repairReachability(
      { ...raw, layers, lifts: lifts.length > 0 ? lifts : undefined, spawns, wallsV, wallsH },
      wallsV,
      wallsH,
      [
        ...graph.nodes.map((n) => ({ x: n.x, y: n.z, kind: "lane node" })),
        // Capture pads and outposts are taken from NEAR them, not on them — see
        // RepairTarget. ORIGINAL_CAPTURE_RANGE, 4 m, is the smallest imported
        // capture range (the avatar's radius comes on top), so it is the bound to
        // hold the map to.
        ...turretSpots.map(([x, y]) => ({
          x,
          y,
          reach: ORIGINAL_CAPTURE_RANGE,
          kind: "capture pad",
        })),
        // An outpost's claim zone and pads are touched (1.2 m + the mech's
        // radius), so the bound is the ring turrets' 1 m.
        ...outpostSpots.map(([x, y]) => ({ x, y, reach: 1, kind: "outpost" })),
        ...outposts.flatMap((o) => [
          { x: o.tankPad[0], y: o.tankPad[1], reach: 1, kind: "outpost pad" },
          { x: o.jetPad[0], y: o.jetPad[1], reach: 1, kind: "outpost pad" },
        ]),
        ...pickups.map((p) => ({ x: p.x, y: p.y, kind: "pickup" })),
        // The base's own structures, or the player cannot walk from their spawn
        // to a buy console and back out onto the road. Mp's happened to land in
        // the spawn component already; Conft's, Slim's and Joke's do not, and
        // without these the arena generates clean and plays unbuyable.
        ...bases.flatMap((b) => [
          { x: (b.core as number[])[0], y: (b.core as number[])[1], kind: "core" },
          {
            x: (b.groundConsole as number[])[0],
            y: (b.groundConsole as number[])[1],
            kind: "console",
          },
          { x: (b.airConsole as number[])[0], y: (b.airConsole as number[])[1], kind: "console" },
          // Ring turrets too: one the player can neither reach nor shoot past is
          // dead content, and mapConnectivity.test.ts treats it as an error. Its
          // own cell need not be walkable — that test asks only that a
          // NEIGHBOURING cell is, for the same plinth reason capture pads have.
          ...b.turrets.map((t) => ({ x: t.x, y: t.y, reach: 1, kind: "ring turret" })),
        ]),
        ...spawns.map((s) => ({ x: s.x, y: s.y, kind: "spawn" })),
      ],
      arena.repairLimit,
    );
    repaired = repair.opened;
    repairedFor = repair.forKind;
  }

  // --- emit --------------------------------------------------------------
  const out: MapJson = {
    ...raw,
    ...waterOf(raw.size, rules),
    wallsV,
    wallsH,
    // Where and how each X1Alpha record stands, facing included.
    spawns: out0Spawns(teamSpawns, rules),
    basePlots,
    bases: bases as MapJson["bases"],
    lanes,
    turretSpots,
    outpostSpots,
    outposts,
    // No original counterpart: dummy turrets are a Phase-1 sandbox concept.
    dummySpots: [],
    weapons: table.list,
    turretParams,
    turretYaw,
    turretHp,
    // The NeutralTurrets' capture range (fcop-re/ranges-turrets-capture.md Q2),
    // uniform per arena; the sim adds the capturer's own radius.
    captureRange: round4(captureRangeToCells(arena.neutralCaptureRaw)),
    laneGraph: {
      nodes: graph.nodes.map((n) => emitPoint(n.x, n.z, n.layer)),
      edges: graph.edges,
      nextHopA: graph.nextHopA,
      nextHopB: graph.nextHopB,
      entry: graph.entry,
    },
    pickups,
    triggerVolumes,
    floors: floorMasks(terrain, rules, teamOfSlot),
    spawnGuards: spawnGuards.length > 0 ? spawnGuards : undefined,
    lifts: lifts.length > 0 ? lifts : undefined,
    layers,
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
      shaftBits,
      kerbBits,
      landingCells,
      repaired,
      repairedFor,
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
  const raw = terrainOnly(JSON.parse(readFileSync(mapPathOf(arena), "utf8")) as MapJson);
  const logic = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena)), "utf8"),
  ) as Logic;
  const pristine = JSON.parse(
    readFileSync(join(REPO_ROOT, "tools", "generators", "fcop", wallsFile(arena)), "utf8"),
  ) as { wallsV: string[]; wallsH: string[] };
  const map = loadMapFromJson({ ...raw, wallsV: pristine.wallsV, wallsH: pristine.wallsH });

  const field = fieldOf(logic.dreadnoughts);
  const teamNet = teamsOf(logic.dreadnoughts, logic.spawns, field).map((t) => t.base.netId);
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
  /** Wall bits opened in the lifts' shafts (openLiftShafts). */
  shaftBits: number;
  /** Wall bits opened as kerbs (kerbs.ts openKerbs). */
  kerbBits: number;
  /** Cells given a deck at a lift's landing (landLifts). */
  landingCells: number;
  repaired: number;
  /** Bits the repair opened, per target kind — so a residual says what it bought. */
  repairedFor: Map<string, number>;
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
    `  spawns 2  bases 2 (${map.bases[0].turrets.length}+${map.bases[1].turrets.length} ring)` +
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
    `  gates ${map.bases.map((b) => `${b.gate.halfW}x${b.gate.halfL}`).join(", ")} half-extents;` +
      ` Juggernaut ${map.bases[0].juggernaut?.hp} HP, ${map.bases[0].juggernaut?.guns} guns`,
  );
  console.log(
    `  wall bits carved to open the original roads: ${carved}/${arena.carveLimit} allowed`,
  );
  if (stats.kerbBits > 0) console.log(`  wall bits opened as kerbs: ${stats.kerbBits}`);
  if (map.lifts.length > 0) {
    console.log(
      `  lifts ${map.lifts.length}: ${stats.landingCells} landing cells laid, ` +
        `${stats.shaftBits} wall bits opened in their shafts; ` +
        map.lifts
          .map(
            (l) => `(${l.x}, ${l.y}) stops ${l.stops.join("/")} on surfaces ${l.layers.join("/")}`,
          )
          .join(", "),
    );
  }
  const repairDetail =
    repaired > 0
      ? ` (${[...stats.repairedFor].map(([k, n]) => `${n} for a ${k}`).join(", ")})`
      : "";
  console.log(
    `  wall bits opened to reconnect the outer ring: ${repaired}/${arena.repairLimit} ` +
      `allowed${repairDetail}`,
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
          `  team ${team} road at ${per}: console -> enemy gate in ${(w.ticks / TICK_HZ).toFixed(1)} s`,
        );
      } else {
        flag(
          `team ${team} cannot drive its road at ${per}: stopped on leg ${w.leg}` +
            ` at (${round4(w.x)}, ${round4(w.y)}), ${round4(w.distanceToGate)} m from the gate` +
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
      // Naming an arena still works, which is how a fresh stage-2 lands.
      console.log(`${arena.mapId}: not imported — name it explicitly to adopt it`);
    } else bad += writeArena(arena);
  }
  if (bad > 0) process.exit(1);
}

if (import.meta.main) main();
