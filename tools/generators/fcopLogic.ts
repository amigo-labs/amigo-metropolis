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
// UNIT SCALES — read from the retail executable
// Positions and rotations are documented in docs/specs/fcop-logic.md §3
// (POS_FACTOR 1/8192, NET_FACTOR 1/32, ROT_FACTOR -pi/2048, 4096 = 360°). The
// extractor leaves the remaining parameter fields as raw u16; what the engine
// does with each of them was read from the decompiled C against the retail
// disassembly (docs/specs/fcop-re/ranges-turrets-capture.md Q1, Q3, Q5) and is
// implemented below. Every raw value is preserved in the artifact next to its
// derived value, so a later correction only changes this file, not the data.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FcopArena, logicFile, selectArenas } from "./fcopArenas";
import { containerIndex, containerResource } from "./fcopCoarse";
import { plateStackOf, selectedHeight, surfaceHeight } from "./fcopTerrain";

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/**
 * Unit of the authored spawner (tSAC) and script periods: 1/60 s. The engine
 * clock is 300 Hz and `csac_load` multiplies the raw word by 5
 * (fcop-re/ranges-turrets-capture.md Q5), so raw/60 is seconds. Metropolis runs at
 * balance.ts TICK_HZ (30).
 */
export const ORIGINAL_TICK_HZ = 60;
/** The original engine clock: every actor tick advances in 1/300 s steps. */
export const ENGINE_TICK_HZ = 300;
/** docs/specs/fcop-logic.md §3.2 — 4096 raw = 360°. */
export const ROTATION_TURN = 4096;

/**
 * Raw-to-metres divisor for distance parameters (engage_range,
 * target_detection_range / search_range, standoff).
 *
 * Read from the retail code (fcop-re/ranges-turrets-capture.md Q1):
 * `cact_shooter_acquire` loads engage_range with `shl 4` (0x0044e96b) and
 * `cact_target_score` compares it against raw position deltas in world units,
 * where 8192 wu = 1 m. So metres = raw * 16 / 8192 = raw / 512: engage_range 6144
 * is 12 m, and weapon 3's own range field (also 6144, `<< 4` in
 * `cact_missile_spawn`) makes its rounds fly exactly those 12 m. The aircraft
 * search range takes the same `shl 4` (0x00420796): 28672 is 56 m, 32358 63.2 m.
 *
 * This was 1024, inferred from turret placement before the code was read — half
 * the real reach.
 */
export const RANGE_SCALE = 512;
/**
 * Raw-to-metres divisor for a trigger volume's HALF-extent.
 *
 * The loader halves the raw width/length (`sar 1`, 0x0041fde2..0x0041fdff) and the
 * containment test shifts the half back up by 4 against world units
 * (0x00420150..0x0042017f): half-extent = raw * 8 wu = raw / 1024 m, grown by the
 * intruder's own radius (fcop-re/ranges-turrets-capture.md Q1). Mp's base zone
 * 20480 x 12288 is therefore 40 x 24 m and a gate 2457 x 1843 is 4.8 x 3.6 m. It
 * was 8192 on the full extent, i.e. 16x too small.
 */
export const TRIGGER_SCALE = 1024;
/**
 * Raw-to-metres divisor for an aircraft orbit_area field as the LEASH half-extent:
 * stored `raw >> 5`, tripped at `|d| >> 8 > stored`, i.e. raw * 8 wu = raw / 1024 m
 * (`aircraft.c:1014`, 0x00420904..0x00420924).
 */
export const ORBIT_LEASH_SCALE = 1024;
/** New patrol destinations are drawn within half the leash: +-raw / 2048 m. */
export const ORBIT_PATROL_SCALE = 2048;

/** Distance parameter (raw u16) to metres (= cells). */
export function rangeToCells(raw: number): number {
  return raw / RANGE_SCALE;
}

/**
 * NeutralTurret capture range (raw) to metres, before the capturer's own radius.
 *
 * `turret_op10` (0x0041c920) captures when the distance between reference points
 * is under `(range + 0x400) << 4` world units plus the candidate's radius_68
 * (0x0041ca04..0x0041ca20; fcop-re/ranges-turrets-capture.md Q2). At 8192 wu/m
 * that is (raw + 1024) / 512 m: 1024 -> 4.0, 1638 -> 5.2, 1843 -> 5.6.
 */
export function captureRangeToCells(raw: number): number {
  return (raw + 1024) / RANGE_SCALE;
}

/** Trigger width/length (raw) to the volume's half-extent in metres. */
export function triggerHalfExtent(raw: number): number {
  return raw / TRIGGER_SCALE;
}

/** Aircraft orbit_area (raw) to the leash half-extent in metres. */
export function orbitLeashToCells(raw: number): number {
  return raw / ORBIT_LEASH_SCALE;
}

/** Aircraft orbit_area (raw) to the patrol-destination half-extent in metres. */
export function orbitPatrolToCells(raw: number): number {
  return raw / ORBIT_PATROL_SCALE;
}

/** Original 1/60 s spawner/script period to sim ticks, floored at one tick. */
export function toSimTicks(raw: number, tickHz: number): number {
  const seconds = Math.abs(raw) / ORIGINAL_TICK_HZ;
  return Math.max(1, Math.round(seconds * tickHz));
}

/**
 * BaseShooter targeting_delay (raw) to sim ticks.
 *
 * NOT the spawner unit. `cact_shooter_init` stores `trunc(raw * 4096 / 218)`
 * 300 Hz ticks (0x0044ea83..0x0044eaa6), and 218 = 4096 * 16 / 300, so the raw
 * value is in 1/16 s: 32 -> 601 ticks = 2.0 s (turrets, tanks, jets), 16 -> 300
 * ticks = 1.0 s (Dreadnought guns, Fortress, captain)
 * (fcop-re/ranges-turrets-capture.md Q3). Reading it as 1/60 s made 32 a 0.53 s
 * cooldown.
 */
export function targetingDelayToSimTicks(raw: number, tickHz: number): number {
  const engineTicks = Math.trunc((Math.abs(raw) * 4096) / 218);
  return Math.max(1, Math.round((engineTicks * tickHz) / ENGINE_TICK_HZ));
}

/**
 * Turret turn_speed (raw) to angle units (4096 = 360°) per 300 Hz engine tick.
 *
 * `turret_construct` on the /218 rate block (flag 0x04, set on all 196 PA turrets):
 * `turn_rate = (raw * 16 / 218) >> 4`, truncating division then an arithmetic
 * shift (`turret.c:711-735`, retail 0x0041c255..0x0041c272), and `turret_turn`
 * caps each step at `turn_rate * dt`. 2457 -> 11 units per tick = 3300 units/s =
 * 290°/s (fcop-re/ranges-turrets-capture.md Q3).
 */
export function turnSpeedToUnitsPerEngineTick(raw: number): number {
  return Math.trunc((raw * 16) / 218) >> 4;
}

/**
 * A record angle (4096 a turn) to the sim's yaw: the angle itself
 * (fcop-fidelity.md G12; client render/recordYaw.ts). The construct builds
 * `My(a)` from the halfword and the engine is row-vector, so a carries the
 * model's +z to the game's (sin a, cos a), which the actors frame's x/z swap
 * makes the sim's (cos a, sin a). A turret gun's halfword at +0x34 is no
 * exception: `turret_construct` (0x0041c222) builds its matrix and stores its
 * `rest_yaw` and `yaw` from it as it stands (RE turret.c 879-883). Until
 * SIM_VERSION 86 this read pi/2 - a for the turrets (FC:MIT's -1024 bias, the
 * fcop-logic.md §3.2 reading) and -a otherwise. In (-PI, PI], as the X1's
 * spawn facing is (enrichArena.ts out0Spawns).
 */
export function rotToYaw(raw: number): number {
  let v = raw % ROTATION_TURN;
  if (v > ROTATION_TURN / 2) v -= ROTATION_TURN;
  else if (v <= -ROTATION_TURN / 2) v += ROTATION_TURN;
  return (Math.PI / (ROTATION_TURN / 2)) * v;
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
 * Gun slew (raw) to radians per sim tick, through the retail integer rate
 * (turnSpeedToUnitsPerEngineTick): 2457 -> 11 units per 1/300 s -> 290°/s. It
 * used to read raw/4096 turns per second (216°/s), which was a guess.
 */
export function turnSpeedToRadPerTick(raw: number, tickHz: number): number {
  const unitsPerSecond = turnSpeedToUnitsPerEngineTick(raw) * ENGINE_TICK_HZ;
  return ((unitsPerSecond / ROTATION_TURN) * (2 * Math.PI)) / tickHz;
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
  /** Resource id and container family ("Cact" / "Csac"), as extract_logic writes them. */
  res_id?: number;
  container?: string;
  /** The record's height selector (HEIGHT_SELECTOR), read from the container here. */
  ground_cast?: number;
  /** The height the original stands it at, metres (fcopTerrain.ts); null where no plate is. */
  ground_y?: number | null;
  /** An aircraft's or Sky Captain's flight block, raw (readGroundCasts). */
  flight?: PaFlight;
  /** A type-98 catalogue entry's key byte and its raw acceleration (+0x14). */
  weapon_key?: number;
  weapon_accel?: number;
  /** A pathed actor's route block (types 5 and 28), raw (readGroundCasts). */
  route?: PaRoute;
  /** A tank's or an aircraft's shooter bitfield, raw (readGroundCasts). */
  shooter_bits?: number;
}

interface RawNetNode {
  i: number;
  x: number;
  z: number;
  raw_x: number;
  raw_z: number;
  height_offset: number;
  state: number;
  ground_cast: number;
  neighbours: number[];
  /** Filled in by readGroundCasts. */
  ground_y?: number | null;
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
  /**
   * Extracted as "TeamBase?". It is the Dreadnought (fcop-re/ranges-turrets-
   * capture.md, top + Q4): record class byte 3 ("Dreadnoughts" on the results
   * screen), it drives its Cnet like a tank, and its four guns sit on its hull.
   */
  DREADNOUGHT: 28,
  /** The Sky Captain (dispatch.c), one record per level band. */
  SKY_CAPTAIN: 37,
  /** A type-98 weapon catalogue entry (prepare.c 0x0044eb80). */
  WEAPON: 98,
  NEUTRAL_TURRET: 36,
  TRIGGER: 95,
  MARKER_14: 14,
  MARKER_89: 89,
} as const;

/**
 * Where each record type keeps its HEIGHT SELECTOR, by tACT payload offset (the
 * construct's record pointer is payload - 4, so `[reg + off + 4]` in the
 * listing), and the instruction that reads it.
 *
 * ACT `pos_h` is 0 on every PC record: no actor's Y is stored. Every construct
 * asks the terrain instead, `terrain_height_at(position, layer)` (0x004545d0),
 * with a layer remapped from this byte as `cnet_load` remaps a Cnet node's
 * mode (0x00441981): 0 -> -1 the topmost plate, 1 -> -2 the lowest, n -> n - 2
 * the n-2-th from the bottom (0 when the stack is shallower). So it is the same
 * field as a node's `groundCast`, and carried under that name.
 *
 *   type 1  X1Alpha      0x22 i8   player_view_construct  movsx [edx+0x26] 0x00446b66
 *   type 8  Turret       0x30 i8   turret_part (base)     movsx [edi+0x34] 0x0041cff1
 *   type 36 NeutralTurret 0x30 i8  the same construct, the same branch (0x0041cfc5)
 *   type 16 ItemPickup   0x20 i8   pickup construct       movsx [edi+0x24] 0x0041e7db
 *   type 14 zone         0x22 i16  type-14 construct      movsx [edi+0x26] 0x0041f719 (word)
 *   type 95 Trigger      0x16 i8   cact_load_type95       movsx [edi+0x1a] 0x0041fdb1
 *
 * A turret stands on attachment point 0 of its base part, whose own Y is this
 * query plus the record's height offset (turret.c, turret_part.c).
 */
const HEIGHT_SELECTOR: Readonly<Record<number, { offset: number; word: boolean }>> = {
  1: { offset: 0x22, word: false },
  8: { offset: 0x30, word: false },
  36: { offset: 0x30, word: false },
  16: { offset: 0x20, word: false },
  14: { offset: 0x22, word: true },
  95: { offset: 0x16, word: false },
};

/** The tACT chunk header ahead of the payload (tag, size, matching id). */
const TACT_PAYLOAD = 12;

/**
 * Annotates every record of a HEIGHT_SELECTOR type with its selector, read from
 * the shipped container's bytes (the RE extract does not decode it).
 */
export function readGroundCasts(
  container: Uint8Array,
  actors: RawActor[],
  nets: RawNet[] = [],
): void {
  const res = containerIndex(container);
  const stack = plateStackOf(container);
  const i32 = (b: Uint8Array, o: number): number =>
    b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  const recordOf = (a: RawActor): Uint8Array => {
    if (a.res_id === undefined || (a.container !== "Cact" && a.container !== "Csac")) {
      throw new Error(`type-${a.act_type} record ${a.matching} has no resource id`);
    }
    const tag = a.container.split("").reverse().join("");
    const at = res.get(`${tag}:${a.res_id}`);
    if (!at) throw new Error(`${a.container} ${a.res_id} is not in the container`);
    const blob = containerResource(container, at);
    if (String.fromCharCode(blob[3], blob[2], blob[1], blob[0]) !== "tACT") {
      throw new Error(`${a.container} ${a.res_id} does not start with a tACT chunk`);
    }
    if (blob[TACT_PAYLOAD] !== a.act_type) {
      throw new Error(
        `${a.container} ${a.res_id} is type ${blob[TACT_PAYLOAD]}, not ${a.act_type}`,
      );
    }
    return blob;
  };
  // The query's point is the record's position triple (payload +4): its first
  // word is the engine's x, which the extract calls z, and its third the
  // extract's x.
  const platesOf = (blob: Uint8Array): number[] =>
    stack(i32(blob, TACT_PAYLOAD + 4), i32(blob, TACT_PAYLOAD + 12));
  const metres = (y: number | null): number | null =>
    y === null ? null : Math.round(y * 10000) / 10000;
  const i16 = (b: Uint8Array, o: number): number => ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
  for (const a of actors) {
    if (a.act_type === ACT.AIRCRAFT || a.act_type === ACT.SKY_CAPTAIN) {
      // The flight block `aircraft_construct` reads (0x00420380): the three
      // altitudes at payload +0x3a / +0x3c / +0x3e and the spawn flags at +0x35
      // (RE fcop/actor_aircraft.h AREC_*), raw.
      const blob = recordOf(a);
      a.flight = {
        altMin: i16(blob, TACT_PAYLOAD + 0x3a),
        altCruise: i16(blob, TACT_PAYLOAD + 0x3c),
        altMax: i16(blob, TACT_PAYLOAD + 0x3e),
        spawn: blob[TACT_PAYLOAD + 0x35],
      };
      if (a.act_type === ACT.SKY_CAPTAIN) continue;
    }
    if (a.act_type === ACT.PATHED_ACTOR || a.act_type === ACT.AIRCRAFT) {
      // The BaseShooter block at payload +0x20 (type 5's CACT_TYPE5_REC_SHOOTER,
      // type 9's AREC_SHOOTER): its bitfield, the halfword after the weapon id.
      a.shooter_bits = i16(recordOf(a), TACT_PAYLOAD + 0x22) & 0xffff;
    }
    if (a.act_type === ACT.PATHED_ACTOR || a.act_type === ACT.DREADNOUGHT) {
      // The route block `cnet_route_init` reads (0x004415f0, handed payload
      // +0x30 by the type-5 construct at 0x00425257): its flag word's low
      // halfword (+0) and its height bias (+4), raw (RE fcop/net_route.h
      // CNET_ROUTE_PARAM_FLAGS, _HEIGHT_BIAS).
      const blob = recordOf(a);
      a.route = {
        flags: blob[TACT_PAYLOAD + 0x30] | (blob[TACT_PAYLOAD + 0x31] << 8),
        heightBias: i16(blob, TACT_PAYLOAD + 0x34),
      };
    }
    if (a.act_type === ACT.WEAPON) {
      // A catalogue entry is the payload from +0x10 (`cact_weapon_catalogue_load`
      // 0x0044eb80): its key byte, and +0x14 the acceleration before the
      // loader's `* 256 / 300` (0x0044eb10).
      const blob = recordOf(a);
      a.weapon_key = blob[TACT_PAYLOAD + 0x10];
      a.weapon_accel = i16(blob, TACT_PAYLOAD + 0x10 + 0x14);
      continue;
    }
    if (a.act_type === ACT.AIRCRAFT) {
      // No selector: `aircraft_construct` places it by the surface query from
      // its record's own point (0x00420501), whose y is 0 on every record.
      a.ground_y = metres(surfaceHeight(platesOf(recordOf(a)), 0));
      continue;
    }
    const sel = HEIGHT_SELECTOR[a.act_type];
    if (!sel) continue;
    const blob = recordOf(a);
    const o = TACT_PAYLOAD + sel.offset;
    const lo = blob[o];
    a.ground_cast = sel.word ? ((lo | (blob[o + 1] << 8)) << 16) >> 16 : (lo << 24) >> 24;
    a.ground_y = metres(selectedHeight(platesOf(blob), a.ground_cast));
  }
  // A Cnet node's point is (node +8, 0, node +6) << 8 — the extract's z, then
  // its x (0x00441957..0x00441968) — and its mode is the same selector.
  for (const net of nets) {
    for (const n of net.nodes) {
      const y = selectedHeight(stack(n.raw_z * 256, n.raw_x * 256), n.ground_cast);
      n.ground_y = y === null ? null : Math.round(y * 10000) / 10000;
    }
  }
}

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
  /**
   * The BaseShooter block's bitfield (`cact_shooter_init` 0x0044ea00, record
   * +2), raw, where readGroundCasts reads it (a tank's and an aircraft's, at
   * payload +0x22): 0x20 is ALTERNATE, which flips the muzzle index +0x23
   * every round (`cact_shooter_step` 0x0044e673). Absent elsewhere.
   */
  readonly bitfield?: number;
}

export interface PaSpawn {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /**
   * The record's height selector (HEIGHT_SELECTOR): which of the stacked
   * surfaces the construct stands the actor on. Absent on a type that reads none
   * (type 89).
   */
  readonly groundCast?: number;
  /**
   * The height the original stands the record at, metres: `terrain_height_at`
   * over the shipped plates with that selector (fcopTerrain.ts). null where it
   * answers 0 for want of a plate.
   */
  readonly groundY?: number | null;
}

/**
 * One side's Dreadnought record (act_type 28). Its position is the Dreadnought's
 * spawn point — node 0 of its Cnet, next to the HQ — not a base structure: the
 * original has no destructible core (fcop-re/ranges-turrets-capture.md, top).
 */
/**
 * A pathed actor's route block, raw (`cnet_route_init` 0x004415f0): the flag
 * word's low halfword -- 0 the tank, 0x20 (CNET_ROUTE_BANK) Hk's, 0x8 the
 * Dreadnought -- and the height bias, `<< 4` world units over the road the
 * cursor walks (the tick's 0x00440672).
 */
export interface PaRoute {
  readonly flags: number;
  readonly heightBias: number;
}

export interface PaDreadnought {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Original team byte: 1 or 2. */
  readonly team: number;
  /** 3000 on every PA record: the Dreadnought's own HP. */
  readonly health: number;
  /** Cnet the Dreadnought drives; it spawns at node 0 (fcop-logic.md §8.1). */
  readonly netId: number;
  /**
   * Its Csac spawner period in 1/60 s (300 = 5 s) and limit (1). The spawner is
   * SHUT in PA: the Dreadnought appears only when bought (ai-and-rules.md §0).
   */
  readonly spawnTicks: number;
  readonly spawnLimit: number;
  /** Hull guns (4): mounts at the hull model's points 0..3 (Q4). */
  readonly gunCount: number;
  /** Gun 0's BaseShooter block (guns 1..3 carry the same values). */
  readonly gun: PaShooter;
  /** Its own route block at payload 0x30: move_speed 1024, accel 1228. */
  readonly moveSpeed: number;
  readonly acceleration: number;
  /** The same block's flags and height bias (PaRoute). */
  readonly route: PaRoute;
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
  /** Height selector (HEIGHT_SELECTOR): the surface its base part stands on. */
  readonly groundCast: number;
  /** The height that selector answers there, metres (PaSpawn.groundY). */
  readonly groundY: number | null;
}

export interface PaPickup {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Raw grant flag names, e.g. ["reload_gun", "is_set", "pickup_consume"]. */
  readonly grants: readonly string[];
  readonly spawnTicks: number;
  readonly rotationalSpeed: number;
  /** Height selector (HEIGHT_SELECTOR). */
  readonly groundCast: number;
  /** The height that selector answers there, metres (PaSpawn.groundY). */
  readonly groundY: number | null;
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
  /** Height selector (HEIGHT_SELECTOR): the surface the box's centre stands on. */
  readonly groundCast: number;
  /** The height that selector answers there, metres (PaSpawn.groundY). */
  readonly groundY: number | null;
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
  /** Its route block's flags and height bias (PaRoute). */
  readonly route: PaRoute;
}

/** An aircraft record's flight block, raw (sim balance.ts AircraftFlight, less the model's half height). */
export interface PaFlight {
  readonly altMin: number;
  readonly altCruise: number;
  readonly altMax: number;
  readonly spawn: number;
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
  /**
   * The surface it is placed over, metres: `terrain_surface_at` from its
   * record's point at y 0 (fcopTerrain.ts surfaceHeight). null where no plate is.
   */
  readonly groundY: number | null;
  readonly flight: PaFlight;
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
  /**
   * Which surface this node's Y resolves to: 0=HIGH 1=LOW 2=NONE 3=MIDDLE.
   *
   * This is the node's elevation. `height_offset` is 0.0 on all 174 graphs and
   * actor `height` is 0.0 on all 7506 actors because Y is not stored as a number
   * at all — §3 has always said "node Y is not stored, the engine raycasts it
   * against terrain", and this field is that raycast's mode. On a cell carrying
   * stacked surfaces HIGH takes the topmost, LOW the bottommost (`walk_height`),
   * MIDDLE the one between. See §3.1 for the measurement.
   *
   * Carried because the sim frame flattens each arena to `walk_height`, which is
   * the BOTTOM surface on 100% of deck cells — so importing every node at the
   * heightfield puts the HIGH ones under the deck they belong on top of.
   */
  readonly groundCast: number;
  /**
   * The height `cnet_load` (0x00441900) gives the node: `terrain_height_at` at
   * its point with the layer its mode names (fcopTerrain.ts), metres; null where
   * the original answers 0 for want of a plate.
   */
  readonly groundY: number | null;
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
    readonly engineTickHz: number;
    readonly note: string;
  };
  readonly spawns: readonly PaSpawn[];
  readonly dreadnoughts: readonly PaDreadnought[];
  readonly turrets: readonly PaTurret[];
  readonly neutrals: readonly PaTurret[];
  readonly pickups: readonly PaPickup[];
  readonly triggers: readonly PaTrigger[];
  readonly units: readonly PaUnit[];
  readonly aircraft: readonly PaAircraft[];
  /** The Sky Captain records (type 37), their flight blocks. */
  readonly skyCaptains: readonly { readonly id: number; readonly flight: PaFlight }[];
  /** The type-98 catalogue: each entry's key and raw acceleration (+0x14). */
  readonly catalogue: readonly { readonly key: number; readonly accelRaw: number }[];
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

function routeOf(a: RawActor): PaRoute {
  if (!a.route) throw new Error(`type-${a.act_type} record ${a.matching}: route block not read`);
  return a.route;
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
    groundCast: castOf(a),
    groundY: a.ground_y ?? null,
  };
}

/** An aircraft's or Sky Captain's flight block, which readGroundCasts reads for every one. */
function flightOf(a: RawActor): PaFlight {
  if (!a.flight) throw new Error(`type-${a.act_type} record ${a.matching} has no flight block`);
  return a.flight;
}

/** The record's height selector, which every type that reads one must carry. */
function castOf(a: RawActor): number {
  if (a.ground_cast === undefined) {
    throw new Error(`type-${a.act_type} record ${a.matching} carries no height selector`);
  }
  return a.ground_cast;
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

  const marker = (a: RawActor): PaSpawn =>
    a.ground_cast === undefined
      ? { id: a.matching, x: a.x, z: a.z }
      : { id: a.matching, x: a.x, z: a.z, groundCast: a.ground_cast, groundY: a.ground_y ?? null };

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
      engineTickHz: ENGINE_TICK_HZ,
      note:
        "Positions/rotations are documented (fcop-logic.md §3). Distances are raw/range m " +
        "(engage/search ranges), trigger half-extents raw/trigger m; spawner periods are " +
        "1/originalTickHz s, targeting_delay is 1/16 s, turn_speed is " +
        "((raw*16/218)>>4)/rotationTurn turns per 1/engineTickHz s — all read from the " +
        "retail code (docs/specs/fcop-re/ranges-turrets-capture.md) and applied in " +
        "tools/generators/fcopLogic.ts; raw values are preserved here.",
    },
    spawns: of(ACT.X1ALPHA).map((a) => ({
      id: a.matching,
      x: a.x,
      z: a.z,
      groundCast: castOf(a),
      groundY: a.ground_y ?? null,
    })),
    dreadnoughts: of(ACT.DREADNOUGHT).map((a) => {
      const p = a.params ?? {};
      // The extractor still calls the gun blocks "defense_weapon".
      const dw = p.defense_weapon;
      if (!dw) throw new Error(`Dreadnought ${a.matching} has no gun (defense_weapon) block`);
      return {
        id: a.matching,
        x: a.x,
        z: a.z,
        team: p.team ?? 0,
        health: p.health ?? 0,
        netId: a.net_id ?? -1,
        spawnTicks: a.spawn_ticks ?? 0,
        spawnLimit: a.spawn_limit ?? 0,
        gunCount: p.defense_weapon_count ?? 0,
        gun: {
          weaponId: dw.weapon_id,
          targetType: dw.target_type,
          targeting: dw.targeting,
          fovRaw: dw.fov,
          engageRangeRaw: dw.engage_range,
          targetingDelayRaw: dw.targeting_delay,
        },
        moveSpeed: p.unit_template?.move_speed ?? 0,
        acceleration: p.unit_template?.acceleration ?? 0,
        route: routeOf(a),
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
        groundCast: castOf(a),
        groundY: a.ground_y ?? null,
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
        groundCast: castOf(a),
        groundY: a.ground_y ?? null,
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
        shooter: { ...shooter(p), bitfield: a.shooter_bits ?? 0 },
        spawnTicks: a.spawn_ticks ?? 0,
        spawnLimit: a.spawn_limit ?? 0,
        route: routeOf(a),
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
        shooter: { ...shooter(p), bitfield: a.shooter_bits ?? 0 },
        spawnTicks: a.spawn_ticks ?? 0,
        groundY: a.ground_y ?? null,
        flight: flightOf(a),
      };
    }),
    skyCaptains: of(ACT.SKY_CAPTAIN).map((a) => ({ id: a.matching, flight: flightOf(a) })),
    catalogue: of(ACT.WEAPON).map((a) => {
      if (a.weapon_key === undefined || a.weapon_accel === undefined) {
        throw new Error(`type-98 record ${a.matching} was not read from the container`);
      }
      return { key: a.weapon_key, accelRaw: a.weapon_accel };
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
          groundCast: n.ground_cast,
          groundY: n.ground_y ?? null,
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
  readGroundCasts(
    new Uint8Array(readFileSync(join(reRepo, "fixtures", "missions", mission))),
    actors,
    nets,
  );

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
    `  spawns ${logic.spawns.length}  dreadnoughts ${logic.dreadnoughts.length}` +
      `  turrets ${logic.turrets.length}  neutrals ${logic.neutrals.length}` +
      `  pickups ${logic.pickups.length}  triggers ${logic.triggers.length}` +
      `  units ${logic.units.length}  aircraft ${logic.aircraft.length}` +
      `  props ${logic.props.length}  nets ${logic.nets.map((n) => n.nodes.length).join("+")}`,
  );
  console.log(
    `  derived: engage_range 6144 -> ${rangeToCells(6144)} m,` +
      ` targeting_delay 32 -> ${targetingDelayToSimTicks(32, 30)} sim ticks,` +
      ` spawner period 300 -> ${toSimTicks(300, 30)} sim ticks,` +
      ` turn_speed 2457 -> ${turnSpeedToUnitsPerEngineTick(2457)} units per 1/300 s`,
  );
}

if (import.meta.main) main();
