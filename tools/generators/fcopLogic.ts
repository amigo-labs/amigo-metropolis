// Reads the reverse-engineered Precinct Assault mission logic out of the private
// RE repo and writes it into this repo as a committed, deterministic artifact
// (tools/generators/fcop/<mission>-logic.json).
//
// WHY A COMMITTED COPY
// The decode lives in amigo-labs/fcop-reverse-engineering
// (tools/gfx/extract_logic.py → extracted/logic/<Mission>/{actors,nets}.json).
// That repo is private and not a build dependency, so without a copy in-tree the
// arena data would only be regenerable by whoever has it checked out. Committing
// FCOP-derived map data is explicitly allowed (docs/specs/assets.md §2), so the
// copy is the source of truth for the arena generator, and this file is the only
// place raw original units are interpreted.
//
//   bun run gen:palogic [all | <mapId> | <Mission>] [--re-repo <path>]
//
// Any spelling names the arena and tools/generators/fcopArenas.ts supplies the
// rest; --map/--mission are accepted too. Default RE repo path: $FCOP_RE_REPO,
// else /workspace/fcop-reverse-engineering.
//
// Authoring-time only, like convert.ts — the committed JSON is the artifact, so
// any Math.* is fine here. The determinism guard only scans packages/sim/src.
//
// UNIT SCALES — what is documented and what is inferred
// Positions and rotations are documented in docs/specs/fcop-logic.md §3
// (POS_FACTOR 1/8192, NET_FACTOR 1/32, ROT_FACTOR -pi/2048, 4096 = 360°). The
// extractor leaves the remaining parameter fields as raw u16 and says the scale
// is unconfirmed, so RANGE_SCALE below is derived here from the geometry; see
// its comment. Every raw value is preserved in the artifact next to its derived
// value, so a later correction only changes this file, not the data.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FcopArena, logicFile, selectArenas } from "./fcopArenas";

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/** Original simulation rate; Metropolis runs at balance.ts TICK_HZ (30). */
export const ORIGINAL_TICK_HZ = 60;
/** docs/specs/fcop-logic.md §3.2 — 4096 raw = 360°. */
export const ROTATION_TURN = 4096;
/** Turret rotations are stored offset by a quarter turn (fcop-logic.md §3.2). */
export const TURRET_ROTATION_BIAS = 1024;

/**
 * Raw-to-cells divisor for distance parameters (engage_range, orbit_area,
 * target_detection_range).
 *
 * NOT documented — extract_logic.py reads these as bare u16. Derived here from
 * the Mp geometry, and 1024 (2^10, u16 max 64 cells) is the only scale all the
 * evidence agrees on:
 *
 *   - Every one of the 64 turrets on Mp sits 1.9-8.4 cells from a lane node
 *     (median 2.7 for base turrets, 3.5 for the capturable ones). Designers only
 *     hug the road they are guarding that tightly when the weapon's reach is
 *     short: at /1024 engage_range 6144 = 6 cells, which covers the adjacent
 *     road and little else. At /256 it would be 24 cells and the precise
 *     placement would be pointless, since one turret would cover half the
 *     compound and several unrelated lanes.
 *   - Aircraft target_detection_range 28672 -> 28 cells and orbit_area
 *     24576x20480 -> 24x20 cells, both sane patrol figures on a ~96-cell
 *     playfield (and the two heavy gunships get a bigger 30x28 orbit, matching
 *     the Guardian/Fortress split in rules.md §4). At /256 those become 112
 *     cells and 96x80 — larger than the arena.
 *   - fcop-logic.md §5 reports engage_range ∈ {4096, 5120, 6144} across
 *     campaign missions, i.e. a clean {4, 5, 6}-cell ladder at this scale.
 *
 * Trigger volumes are the exception and use the POSITION scale (1/8192): their
 * raw 20480x12288 becomes a 2.5x1.5-cell box, which matches the small
 * base-mouth footprints in docs/renders/fcop-viz/la-cantina/.
 */
export const RANGE_SCALE = 1024;
/** Trigger volume extents use the position fixed point, not RANGE_SCALE. */
export const TRIGGER_SCALE = 8192;

/** Distance parameter (raw u16) to cells. */
export function rangeToCells(raw: number): number {
  return raw / RANGE_SCALE;
}

/** Original 60 Hz tick count to sim ticks, floored at one tick. */
export function toSimTicks(raw: number, tickHz: number): number {
  const seconds = Math.abs(raw) / ORIGINAL_TICK_HZ;
  return Math.max(1, Math.round(seconds * tickHz));
}

/** Actor rotation (raw) to a yaw in radians, matching the original's sign. */
export function rotToYaw(raw: number, turretBias = false): number {
  const v = turretBias ? raw - TURRET_ROTATION_BIAS : raw;
  return (-Math.PI / (ROTATION_TURN / 2)) * v;
}

/**
 * Field of view (raw) to cos(fov/2), precomputed so the sim never calls trig.
 * Returns -1 for a full circle, which the sim reads as "no FOV restriction" —
 * every Mp shooter carries fov 4096 (= 360°), so all of them are omnidirectional.
 */
export function fovToCos(raw: number): number {
  const turns = raw / ROTATION_TURN;
  if (turns >= 1) return -1;
  return Math.cos(Math.PI * turns);
}

/**
 * Gun slew (raw) to radians per sim tick.
 *
 * Inferred: read as rotation units per second, so raw/4096 turns per second.
 * Every Mp turret shares turn_speed 2457 (~216°/s), so on this arena the scale
 * only sets one global slew rate — a later correction cannot reshuffle relative
 * turret behaviour.
 */
export function turnSpeedToRadPerTick(raw: number, tickHz: number): number {
  return ((raw / ROTATION_TURN) * (2 * Math.PI)) / tickHz;
}

// ---------------------------------------------------------------------------
// Shape of the RE repo's extraction (input)
// ---------------------------------------------------------------------------

interface RawParams {
  team?: number;
  health?: number;
  collision_damage?: number;
  group_id?: number;
  target_priority?: number;
  weapon_id?: number;
  target_type?: number;
  targeting?: number;
  fov?: number;
  engage_range?: number;
  targeting_delay?: number;
  gun_rotation?: number;
  turn_speed?: number;
  move_speed?: number;
  acceleration?: number;
  height_offset?: number;
  grants?: string[];
  bitfield?: string;
  rotational_speed?: number;
  width_raw?: number;
  length_raw?: number;
  height_raw?: number;
  flags?: string[] | number;
  triggering_actor_id?: number;
  defense_weapon_count?: number;
  defense_weapon?: {
    weapon_id: number;
    target_type: number;
    targeting: number;
    fov: number;
    engage_range: number;
    targeting_delay: number;
  };
  unit_template?: { move_speed: number; acceleration: number };
  orbit_area_x?: number;
  orbit_area_y?: number;
  turn_rate?: number;
  target_detection_range?: number;
  time_to_descend?: number;
  spawn_type?: number;
  spawn_pos_x?: number;
  spawn_pos_y?: number;
}

interface RawActor {
  matching: number;
  act_type: number;
  type_name: string;
  x: number;
  z: number;
  height: number;
  params?: RawParams;
  refs?: { slot: number; type: string; id: number }[];
  net_id?: number;
  spawn_ticks?: number;
  spawn_limit?: number;
}

interface RawNetNode {
  i: number;
  x: number;
  z: number;
  height_offset: number;
  state: number;
  ground_cast: number;
  neighbours: number[];
}

interface RawNet {
  res_id: number;
  node_count: number;
  nodes: RawNetNode[];
}

/** ACT type codes used here (docs/specs/fcop-logic.md §3.2 registry). */
export const ACT = {
  X1ALPHA: 1,
  PATHED_ACTOR: 5,
  TURRET: 8,
  AIRCRAFT: 9,
  DYNAMIC_PROP: 11,
  ITEM_PICKUP: 16,
  TEAM_BASE: 28,
  NEUTRAL_TURRET: 36,
  TRIGGER: 95,
  MARKER_14: 14,
  MARKER_89: 89,
} as const;

// ---------------------------------------------------------------------------
// Shape of the committed artifact (output)
// ---------------------------------------------------------------------------

export interface PaShooter {
  readonly weaponId: number;
  readonly targetType: number;
  readonly targeting: number;
  readonly fovRaw: number;
  readonly engageRangeRaw: number;
  readonly targetingDelayRaw: number;
}

export interface PaSpawn {
  readonly id: number;
  readonly x: number;
  readonly z: number;
}

export interface PaBase {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Original team byte: 1 or 2. */
  readonly team: number;
  readonly health: number;
  /** Cnet this base's produced units traverse (fcop-logic.md §8.1). */
  readonly netId: number;
  /** Production cadence in original 60 Hz ticks (300 = 5 s). */
  readonly spawnTicks: number;
  readonly spawnLimit: number;
  readonly defenceWeaponCount: number;
  readonly defenceWeapon: PaShooter;
  readonly unitMoveSpeed: number;
  readonly unitAcceleration: number;
}

export interface PaTurret {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** 0 for capturable NeutralTurrets, 1/2 for base-defence Turrets. */
  readonly team: number;
  readonly health: number;
  readonly gunRotationRaw: number;
  readonly turnSpeedRaw: number;
  readonly shooter: PaShooter;
  /** Respawn delay in original ticks (negative in the source = after death). */
  readonly spawnTicks: number;
  readonly spawnLimit: number;
}

export interface PaPickup {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Raw grant flag names, e.g. ["reload_gun", "is_set", "pickup_consume"]. */
  readonly grants: readonly string[];
  readonly spawnTicks: number;
  readonly rotationalSpeed: number;
}

export interface PaTrigger {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly widthRaw: number;
  readonly lengthRaw: number;
  readonly heightRaw: number;
  readonly flags: readonly string[];
  /** Actor whose entry fires this volume (fcop-logic.md §8.6). */
  readonly watchesActor: number;
}

export interface PaUnit {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly team: number;
  readonly health: number;
  readonly netId: number;
  readonly moveSpeed: number;
  readonly acceleration: number;
  readonly shooter: PaShooter;
  readonly spawnTicks: number;
  readonly spawnLimit: number;
}

export interface PaAircraft {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly team: number;
  readonly health: number;
  readonly moveSpeed: number;
  readonly turnRate: number;
  readonly orbitAreaX: number;
  readonly orbitAreaY: number;
  readonly targetDetectionRange: number;
  readonly timeToDescend: number;
  readonly shooter: PaShooter;
  readonly spawnTicks: number;
}

export interface PaProp {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** act_type, so the render side can tell scenery classes apart. */
  readonly actType: number;
  /** Cobj resource id of the alive model. */
  readonly objId: number;
}

export interface PaNetNode {
  readonly x: number;
  readonly z: number;
  /** Up to 4 neighbour node indices; -1 = no edge (0x3FF sentinel resolved). */
  readonly neighbours: readonly number[];
  readonly state: number;
}

export interface PaNet {
  readonly netId: number;
  readonly nodes: readonly PaNetNode[];
}

export interface PaLogic {
  readonly mission: string;
  readonly mapId: string;
  readonly source: {
    readonly repo: string;
    readonly commit: string;
    readonly extractor: string;
  };
  readonly frame: {
    readonly actorScale: number;
    readonly netScale: number;
    readonly note: string;
  };
  readonly scales: {
    readonly range: number;
    readonly trigger: number;
    readonly rotationTurn: number;
    readonly originalTickHz: number;
    readonly note: string;
  };
  readonly spawns: readonly PaSpawn[];
  readonly bases: readonly PaBase[];
  readonly turrets: readonly PaTurret[];
  readonly neutrals: readonly PaTurret[];
  readonly pickups: readonly PaPickup[];
  readonly triggers: readonly PaTrigger[];
  readonly units: readonly PaUnit[];
  readonly aircraft: readonly PaAircraft[];
  readonly props: readonly PaProp[];
  readonly nets: readonly PaNet[];
  /** Types 14/89: extracted for provenance only (fcop-logic.md §8.5). */
  readonly markers: Readonly<Record<string, readonly PaSpawn[]>>;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function shooter(p: RawParams): PaShooter {
  return {
    weaponId: p.weapon_id ?? 0,
    targetType: p.target_type ?? 0,
    targeting: p.targeting ?? 0,
    fovRaw: p.fov ?? 0,
    engageRangeRaw: p.engage_range ?? 0,
    targetingDelayRaw: p.targeting_delay ?? 0,
  };
}

/** Cobj id of the alive model, i.e. resource slot 0. */
function aliveObj(a: RawActor): number {
  const ref = (a.refs ?? []).find((r) => r.slot === 0 && r.type === "Cobj");
  return ref?.id ?? -1;
}

function turret(a: RawActor): PaTurret {
  const p = a.params ?? {};
  return {
    id: a.matching,
    x: a.x,
    z: a.z,
    team: p.team ?? 0,
    health: p.health ?? 0,
    gunRotationRaw: p.gun_rotation ?? 0,
    turnSpeedRaw: p.turn_speed ?? 0,
    shooter: shooter(p),
    spawnTicks: a.spawn_ticks ?? 0,
    spawnLimit: a.spawn_limit ?? 0,
  };
}

export function buildPaLogic(
  mission: string,
  mapId: string,
  actors: RawActor[],
  nets: RawNet[],
  source: PaLogic["source"],
): PaLogic {
  // Deterministic ordering: the artifact feeds a committed map JSON, so the
  // iteration order has to be a property of the data, not of the extraction.
  const byId = [...actors].sort((a, b) => a.matching - b.matching);
  const of = (t: number): RawActor[] => byId.filter((a) => a.act_type === t);

  const marker = (a: RawActor): PaSpawn => ({ id: a.matching, x: a.x, z: a.z });

  return {
    mission,
    mapId,
    source,
    frame: {
      actorScale: 8192,
      netScale: 32,
      note:
        "x/z are 0-based grid cells (raw/8192 for actors, raw/32 for Cnet nodes). " +
        "The sim heightfield frame is this frame shifted by LOGIC_OFFSET_X/Z in " +
        "tools/generators/enrichArena.ts — see docs/specs/fcop-viz-handoff.md.",
    },
    scales: {
      range: RANGE_SCALE,
      trigger: TRIGGER_SCALE,
      rotationTurn: ROTATION_TURN,
      originalTickHz: ORIGINAL_TICK_HZ,
      note:
        "Positions/rotations are documented (fcop-logic.md §3). Distance and " +
        "timing scales are inferred in tools/generators/fcopLogic.ts; raw values " +
        "are preserved here so a correction touches only the converter.",
    },
    spawns: of(ACT.X1ALPHA).map(marker),
    bases: of(ACT.TEAM_BASE).map((a) => {
      const p = a.params ?? {};
      const dw = p.defense_weapon;
      if (!dw) throw new Error(`base ${a.matching} has no defense_weapon block`);
      return {
        id: a.matching,
        x: a.x,
        z: a.z,
        team: p.team ?? 0,
        health: p.health ?? 0,
        netId: a.net_id ?? -1,
        spawnTicks: a.spawn_ticks ?? 0,
        spawnLimit: a.spawn_limit ?? 0,
        defenceWeaponCount: p.defense_weapon_count ?? 0,
        defenceWeapon: {
          weaponId: dw.weapon_id,
          targetType: dw.target_type,
          targeting: dw.targeting,
          fovRaw: dw.fov,
          engageRangeRaw: dw.engage_range,
          targetingDelayRaw: dw.targeting_delay,
        },
        unitMoveSpeed: p.unit_template?.move_speed ?? 0,
        unitAcceleration: p.unit_template?.acceleration ?? 0,
      };
    }),
    turrets: of(ACT.TURRET).map(turret),
    neutrals: of(ACT.NEUTRAL_TURRET).map(turret),
    pickups: of(ACT.ITEM_PICKUP).map((a) => {
      const p = a.params ?? {};
      return {
        id: a.matching,
        x: a.x,
        z: a.z,
        grants: p.grants ?? [],
        spawnTicks: a.spawn_ticks ?? 0,
        rotationalSpeed: p.rotational_speed ?? 0,
      };
    }),
    triggers: of(ACT.TRIGGER).map((a) => {
      const p = a.params ?? {};
      return {
        id: a.matching,
        x: a.x,
        z: a.z,
        widthRaw: p.width_raw ?? 0,
        lengthRaw: p.length_raw ?? 0,
        heightRaw: p.height_raw ?? 0,
        flags: Array.isArray(p.flags) ? p.flags : [],
        watchesActor: p.triggering_actor_id ?? -1,
      };
    }),
    units: of(ACT.PATHED_ACTOR).map((a) => {
      const p = a.params ?? {};
      return {
        id: a.matching,
        x: a.x,
        z: a.z,
        team: p.team ?? 0,
        health: p.health ?? 0,
        netId: a.net_id ?? -1,
        moveSpeed: p.move_speed ?? 0,
        acceleration: p.acceleration ?? 0,
        shooter: shooter(p),
        spawnTicks: a.spawn_ticks ?? 0,
        spawnLimit: a.spawn_limit ?? 0,
      };
    }),
    aircraft: of(ACT.AIRCRAFT).map((a) => {
      const p = a.params ?? {};
      return {
        id: a.matching,
        x: a.x,
        z: a.z,
        team: p.team ?? 0,
        health: p.health ?? 0,
        moveSpeed: p.move_speed ?? 0,
        turnRate: p.turn_rate ?? 0,
        orbitAreaX: p.orbit_area_x ?? 0,
        orbitAreaY: p.orbit_area_y ?? 0,
        targetDetectionRange: p.target_detection_range ?? 0,
        timeToDescend: p.time_to_descend ?? 0,
        shooter: shooter(p),
        spawnTicks: a.spawn_ticks ?? 0,
      };
    }),
    props: of(ACT.DYNAMIC_PROP).map((a) => ({
      id: a.matching,
      x: a.x,
      z: a.z,
      height: a.height,
      actType: a.act_type,
      objId: aliveObj(a),
    })),
    nets: [...nets]
      .sort((a, b) => a.res_id - b.res_id)
      .map((net) => ({
        netId: net.res_id,
        nodes: net.nodes.map((n) => ({
          x: n.x,
          z: n.z,
          // The extractor already drops the 0x3FF sentinel, so a short list just
          // means fewer edges; pad to 4 with -1 so the sim can index a fixed
          // stride without a length lookup.
          neighbours: [0, 1, 2, 3].map((k) => n.neighbours[k] ?? -1),
          state: n.state,
        })),
      })),
    markers: {
      type14: of(ACT.MARKER_14).map(marker),
      type89: of(ACT.MARKER_89).map(marker),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Shared by every generator CLI in this directory. */
export function argOf(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function main(): void {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  // Any spelling identifies the arena and the table supplies the rest: a bare
  // positional (matching gen:walls and gen:arena), --map, or --mission. `all`
  // extracts every mission.
  //
  // This used to be `--map`/`--mission` only, fed to selectArenas(...)[0]. Both
  // halves of that were traps: a bare `gen:palogic all` silently extracted
  // la-cantina because it fell through to the default, and `--map all` silently
  // extracted urban-jungle because it took the first of six.
  const positional = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "";
  const named = positional || argOf("map", argOf("mission", "la-cantina"));

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", reRepo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    console.warn(`[genPaLogic] could not read the RE repo commit at ${reRepo}`);
  }

  for (const arena of selectArenas(named)) extract(arena, reRepo, commit);
}

function extract(arena: FcopArena, reRepo: string, commit: string): void {
  const { mission, mapId } = arena;
  const src = join(reRepo, "extracted", "logic", mission);

  const actors = JSON.parse(readFileSync(join(src, "actors.json"), "utf8")) as RawActor[];
  const nets = JSON.parse(readFileSync(join(src, "nets.json"), "utf8")) as RawNet[];

  const logic = buildPaLogic(mission, mapId, actors, nets, {
    repo: "amigo-labs/fcop-reverse-engineering",
    commit,
    extractor: "tools/gfx/extract_logic.py",
  });

  const out = join(REPO_ROOT, "tools", "generators", "fcop", logicFile(arena));
  mkdirSync(dirname(out), { recursive: true });
  // Two-space indent so the artifact satisfies the repo formatter as-is and
  // needs no biome.json override (unlike the minified map JSONs).
  writeFileSync(out, `${JSON.stringify(logic, null, 2)}\n`);

  console.log(`wrote ${out}`);
  console.log(
    `  spawns ${logic.spawns.length}  bases ${logic.bases.length}` +
      `  turrets ${logic.turrets.length}  neutrals ${logic.neutrals.length}` +
      `  pickups ${logic.pickups.length}  triggers ${logic.triggers.length}` +
      `  units ${logic.units.length}  aircraft ${logic.aircraft.length}` +
      `  props ${logic.props.length}  nets ${logic.nets.map((n) => n.nodes.length).join("+")}`,
  );
  console.log(
    `  derived: engage_range 6144 -> ${rangeToCells(6144)} cells,` +
      ` targeting_delay 32 -> ${toSimTicks(32, 30)} sim ticks,` +
      ` production 300 -> ${toSimTicks(300, 30)} sim ticks`,
  );
}

if (import.meta.main) main();
