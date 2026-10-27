// Map data: heightfield grid + water mask + authored features (bases, lanes,
// turret/outpost spots) per architecture.md §2. The same heights drive sim
// ground-snap/slope checks AND the render mesh — single source of truth.
// Real maps ship as JSON in packages/sim/maps/ (validated by loadMapFromJson
// and a schema test); the Phase 0 test map stays procedurally generated.

import bugHuntJson from "../maps/bug-hunt.json";
import hollywoodKeysJson from "../maps/hollywood-keys.json";
import laCantinaJson from "../maps/la-cantina.json";
import layeredTestJson from "../maps/layered-test.json";
import provingGroundJson from "../maps/proving-ground.json";
import urbanJungleJson from "../maps/urban-jungle.json";
import veniceBeachJson from "../maps/venice-beach.json";
import { ARCHETYPE } from "./archetypes";
import {
  type AircraftFlight,
  ARCHETYPE_RADIUS,
  AVATAR_HOVER_RADIUS,
  DREADNOUGHT_GUN_TURN,
  DREADNOUGHT_GUNS,
  DREADNOUGHT_MOUNTS,
  MUZZLE_HEIGHT,
  MUZZLE_OFFSET,
  NEUTRAL_TURRET_RADIUS,
  ORIGINAL_BUY_HALF_L,
  ORIGINAL_BUY_HALF_W,
  ORIGINAL_CAPTURE_RANGE,
  ORIGINAL_FORTRESS_FLIGHT,
  ORIGINAL_JET_FLIGHT,
  ORIGINAL_JET_QUEUE_PERIOD,
  ORIGINAL_PICKUP_HALF_H,
  ORIGINAL_PICKUP_HALF_L,
  ORIGINAL_PICKUP_HALF_W,
  ORIGINAL_PICKUP_LIFT,
  ORIGINAL_SKY_FLIGHT,
  ORIGINAL_TANK_QUEUE_PERIOD,
  ORIGINAL_TURRET_HP,
  ORIGINAL_UNIT_PROFILES,
  ORIGINAL_WEAPON_PROFILES,
  PROFILE_NEUTRAL_TURRET,
  PROFILE_TEAM_TURRET,
  SKY_RADIUS,
} from "./balance";
import { clamp, cosLUT, lerp, sinLUT } from "./simMath";

/**
 * A 2D map point. `layer` is the stacked surface the feature sits on
 * (0 = ground / `heights`, 1+ = `layerHeights[layer-1]`). Absent in JSON → 0,
 * which is every pre-#33 arena and keeps their spawn heights bit-identical.
 */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
  /** 0-based surface index; see resolveHeight. */
  readonly layer: number;
}

export interface MapSpawn {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly layer: number;
  /**
   * Spawn (and respawn) in hover form. The original encodes it as a negative
   * X1Alpha facing (`player_respawn`, fcop-re/player-and-weapons.md §1): both
   * hollywood-keys (Hk) spawns, nothing else in PA. False when the JSON omits it.
   */
  readonly hover: boolean;
}

export interface MapPlot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly layer: number;
}

/**
 * A purchase spot's type-95 trigger box about its console point: half extents
 * along x and y in metres, before the intruder's own radius widens it.
 */
export interface MapBuyBox {
  readonly halfW: number;
  readonly halfL: number;
}

/**
 * One weapon profile, seeded from an original BaseShooter/BaseTurret block
 * (docs/specs/fcop-logic.md §3.2). Referenced by index from turrets and base
 * defences so identical originals share one entry.
 *
 * A map that imports no profiles gets the original's own (balance.ts
 * ORIGINAL_WEAPON_PROFILES, loadMapFromJson), since SIM_VERSION 52; until then it
 * left every shooter on Metropolis' instant-hit TURRET_* / UNIT_* constants.
 */
export interface MapWeapon {
  /** Engage range in meters. */
  readonly range: number;
  /** Fire cooldown / detection delay in ticks; >= 1. */
  readonly delay: number;
  /** Damage per shot. */
  readonly damage: number;
  /** Gun slew in radians per tick; 0 = instant (the pre-PA behavior). */
  readonly turnSpeed: number;
  /**
   * cos(fov/2), PRECOMPUTED at authoring time so the sim never calls trig
   * (CLAUDE.md determinism rule 1). -1 = omnidirectional, i.e. no restriction —
   * which is what every original Mp shooter carries (fov 4096 = 360°).
   */
  readonly fovCos: number;
  // --- The original's weapon catalogue entry (fcop-fidelity.md W3). All of
  // these default to 0 / -1 when absent, which keeps the shooter on the old
  // instant-hit cooldown model (`delay`, `damage` at the target).
  /**
   * Refire period in engine units (1/300 s): the entry's burst gap. > 0 runs the
   * original's rate machine (sim.ts `shooterDue`) instead of the `delay` cooldown.
   */
  readonly refireUnits: number;
  /** Re-acquire period (the shooter's targeting_delay) in engine units; 0 = every tick. */
  readonly searchUnits: number;
  /** Round speed, m/s; 0 = an instant hit. */
  readonly speed: number;
  /** How far the round flies, m (the entry's range). */
  readonly flight: number;
  /** 1: the round homes on its target (catalogue kind 3). */
  readonly guided: number;
  /** 1: the round is aimed with an intercept lead (kind 2). */
  readonly lead: number;
  /** cos of the firing cone about the gun's facing (precomputed); -1 = none. */
  readonly arcCos: number;
  /** 1: HOLD_TARGET — keeps its target and re-scans every search period. */
  readonly hold: number;
  /** 1: prefers the higher target priority (Dreadnought > tank > X1 > other). */
  readonly priority: number;
  /**
   * Its round's 3DBB table in MapData.shapes (the catalogue entry's aRSL slot 0,
   * the model `cact_missile_spawn` binds), -1 for none: the round then meets a
   * body at Metropolis' 0.5 m (sim contact.ts).
   */
  readonly round: number;
}

/**
 * One side's purchasable unit as the original arena defines it (the tank, jet
 * and Flying Fortress spawner records): its health and its shooter's weapon
 * profile. Precinct Assault arenas only; absent, the unit keeps balance.ts's
 * own stats (fcop-fidelity.md W3).
 */
export interface MapUnitProfile {
  readonly hp: number;
  /** Index into MapData.weapons. */
  readonly weapon: number;
}

/**
 * The hit radius of each body on this arena, metres: the original's `radius_68`
 * of the model its own mission draws there, at the frame it holds (the 3DBB box's
 * halfword at +12 << 4 wu; fcop-fidelity.md G1). Mp, Conft, Slim and Ovmp share
 * most; Joke's units and Sky Captains, Hk's tank, second neutral set and Sky
 * Captains are their own (tools/generators/fcop/<mission>-models.json).
 */
export interface MapRadii {
  /** The mech's legs at the walker's pose (frame 0) and the hover's (359). */
  readonly walker: number;
  readonly hover: number;
  readonly tank: number;
  readonly jet: number;
  readonly fortress: number;
  /** The Dreadnought's hull, at frame 0. */
  readonly dreadnought: number;
  /**
   * A hull that walks (MapJuggernaut.walk, Joke's): its radius in each frame,
   * frame k at index k (frame 0 is `dreadnought`). The type-28 tick re-reads the
   * hull's box each frame its walk shows (`type5_model_select`, RE type5.c
   * 137-145, `cact_model_select` 0x004297e0), and every hit and zone test adds
   * the `radius_68` that leaves. Empty on a static hull.
   */
  readonly dreadnoughtByFrame: readonly number[];
  /** A ring or outpost plate (type 8) turret's gun. */
  readonly baseTurret: number;
  /** A neutral (type 36) turret's gun, per `turretSpots` entry. */
  readonly neutral: readonly number[];
  /** The Sky Captain's model by level 0..9 (balance.ts wardenLevel). */
  readonly skyCaptain: readonly number[];
}

/**
 * A turret's gun (fcop-fidelity.md G12). The gun is the turret actor: it stands
 * on its base's attach point 0 (`turret_construct`, RE turret.c 913-918), turns
 * and pitches there (`turret_tick` 0x0041c3e0: `math_matrix_from_angles(yaw,
 * pitch, 0)` at 0x0041c7a9), and its round leaves from its model's point 0
 * through that matrix (`cact_weapon_discharge` 0x0044d98d). Metres, from
 * gen:pamodels' `turrets` (RE pa_models.json).
 */
export interface MapTurretGun {
  /**
   * The base's point 0's height over the turret's spot: the gun's position. Its
   * horizontal offset (8 mm at most on the six arenas, in the base's own yaw)
   * is left out.
   */
  readonly stand: number;
  /** The muzzle in the gun's frame at zero yaw and pitch: right (glb x), up, forward. */
  readonly mx: number;
  readonly my: number;
  readonly mz: number;
}

/** The type-8 (ring and outpost plate) turret's gun, and a neutral's per turret spot. */
export interface MapTurretGuns {
  readonly baseTurret: MapTurretGun;
  readonly neutral: readonly MapTurretGun[];
}

/**
 * One model's 3DBB table (RE docs/formats/objects.md "3DBB"), metres: `perFrame`
 * boxes in each of `frames` frames, box-major -- box i of frame f is row
 * i * frames + f -- each row SHAPE_WORDS numbers: its centre x, y, z, its half
 * extents x, y, z, its 3D radius (`radius_68`) and its horizontal one
 * (`half_h`). The model's own axes: x NOT negated (a glb's is), y up, +z
 * forward. What `cact_pair_test` 0x00450190 and `cact_hit_boxes` 0x0044f640
 * read (sim contact.ts).
 */
export interface MapShapeTable {
  readonly perFrame: number;
  readonly frames: number;
  readonly boxes: Float64Array;
}

/** Numbers a MapShapeTable row holds. */
export const SHAPE_WORDS = 8;

/**
 * A turret's two colliders: its gun (the actor that aims) standing on its base
 * part's attach point 0 (turret.c 914-917) -- (px, py, pz) in the base's model
 * axes, metres -- and the base, which forwards a contact to the gun
 * (turret_part.c op 0x0b). Indices into MapShapes.tables.
 */
export interface MapTurretShape {
  readonly gun: number;
  readonly base: number;
  readonly px: number;
  readonly py: number;
  readonly pz: number;
}

/**
 * A unit (the tank, the jet, the Flying Fortress, the Sky Captain; gen:units'
 * `unit`, drawn at its model's own origin): its table and where its model's
 * origin stands from a body standing on the ground (lx, ly, lz, the model's
 * axes, metres) -- the raw's grounding, read only for a tank off the road graph
 * (contact.ts); a route follower's and an aircraft's position is its origin.
 */
export interface MapUnitShape {
  readonly table: number;
  readonly lx: number;
  readonly ly: number;
  readonly lz: number;
  /**
   * The model's point 0 at frame 0 in its glb frame (metres, +z forward, x the
   * model's negated): the muzzle `cact_weapon_discharge` (0x0044d98d) places
   * through the body's matrix for a shooter whose +0x23 is 0. null for none.
   */
  readonly muzzle: readonly [number, number, number] | null;
}

/**
 * Every body's and round's hit boxes on this arena (fcop-fidelity.md G1): its
 * own mission's models, indices into `tables`, -1 where the arena imports none
 * (the test maps, the sandbox): a body or round without one meets the other at
 * Metropolis' flat circle (contact.ts). The mech's legs and cockpit are the same
 * models everywhere (x1Shapes.generated.ts).
 */
export interface MapShapes {
  readonly tables: readonly MapShapeTable[];
  readonly tank: MapUnitShape | null;
  readonly jet: MapUnitShape | null;
  readonly fortress: MapUnitShape | null;
  /** The hull, every frame of its walk (its own origin, as drawn); -1 none. */
  readonly dreadnought: number;
  /** Gun i's model (mount.c: each forwards a contact to the hull); empty for none. */
  readonly dreadnoughtGuns: readonly number[];
  readonly baseTurret: MapTurretShape | null;
  /** Per turretSpots entry; empty for none. */
  readonly neutral: readonly MapTurretShape[];
  /** By level 0..9; empty for none. */
  readonly skyCaptain: readonly MapUnitShape[];
  /** A world weapon's round by its catalogue id (the Sky Captain's 8 and 9). */
  readonly worldRounds: Int16Array;
  /** A player weapon's round by its loadout code (0x00..0x3f). */
  readonly playerRounds: Int16Array;
}

/** Catalogue ids and loadout codes MapShapes' two round tables cover. */
export const SHAPE_ROUND_SLOTS = 64;

/**
 * One of the Dreadnought's gun mounts, in its models' glb frames (metres, +z
 * forward, y up; RE docs/formats/pa-models.md): the hull's attach point the gun
 * stands on (x, y, z) and the gun model's point 0, its muzzle (mx, my, mz). The
 * sim places a hull-frame point at hull + z * forward + x * (sin yaw, -cos yaw),
 * the frame the client draws the hull's glb in.
 */
export interface MapGunMount {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly mx: number;
  readonly my: number;
  readonly mz: number;
  /**
   * On a hull that walks (MapJuggernaut.walk): the attach point in each of its
   * frames, frame k at index k, the hull's glb frame as x, y, z are (frame 0 is
   * x, y, z). The gun stands on, and fires from, the point of the frame the hull
   * shows (RE mount.c 1019-1030, `cact_model_point` on the hull's +0x70).
   * Absent on a static hull.
   */
  readonly frames?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

/**
 * The Dreadnought hull's walk where its model animates (Joke's Cobj 35, 20
 * frames): the model's one AnmD track (block.c `anmd_track`), stepped as
 * `cact_handler_type5` op 6 steps it, by `velocity_84 * dt` -- a frame per
 * `period` world units travelled (type5.c 469-472) -- its links the track
 * itself. The event is packed `code << 10 | frame`, 0 for none.
 */
export interface MapHullWalk {
  readonly from: number;
  readonly to: number;
  readonly mode: number;
  readonly end: number;
  readonly link: number;
  readonly linkB: number;
  readonly linkC: number;
  readonly flags: number;
  readonly period: number;
  readonly event: number;
}

/**
 * A side's Juggernaut as the original arena defines it: the Dreadnought record
 * (act_type 28, extracted as "TeamBase?" — fcop-re/ranges-turrets-capture.md top
 * + Q4). Precinct Assault arenas only; absent on the §1 arenas, whose Juggernaut
 * keeps balance.ts's own stats and spawns at the ground console.
 *
 * Its `guns` are the original's mounts (SIM_VERSION 77, fcop-fidelity.md I6):
 * gun i on `mounts[i]`, each with its own yaw relative to the hull, turning
 * `gunTurn` angle units per 1/300 s toward its own target, firing from its muzzle
 * inside its front sector, all on one weapon profile.
 */
export interface MapJuggernaut {
  /** Spawn point: the type-28 record's position, node 0 of its Cnet by the HQ. */
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  /** Max HP (the original's 3000). */
  readonly hp: number;
  /** Hull guns (4): the length of `mounts`. */
  readonly guns: number;
  /** Index into MapData.weapons: one gun's profile. */
  readonly weapon: number;
  /** Gun i's mount (balance.ts DREADNOUGHT_MOUNTS where the arena imports none). */
  readonly mounts: readonly MapGunMount[];
  /** The guns' turn, angle units (4096 a turn) per 1/300 s (DREADNOUGHT_GUN_TURN). */
  readonly gunTurn: number;
  /** The hull's walk where its model animates (Joke's), else undefined: a static hull. */
  readonly walk: MapHullWalk | undefined;
}

/**
 * The win trigger volume. `halfW`/`halfL` > 0 make it the original's axis-aligned
 * gate box (x/y half-extents in metres, grown by the intruder's own radius —
 * fcop-re/ranges-turrets-capture.md Q1); 0 keeps the §1 circle of `radius`. The
 * radius stays meaningful on a box gate too: it is what the renderer and the AI
 * read as the gate's size.
 */
export interface MapGate extends MapPlot {
  readonly halfW: number;
  readonly halfL: number;
}

/**
 * Is a body of hit radius `r` centred at (x, y) inside `gate`? The single win
 * test (sim.ts systemWinCheck) and the road walker (roads.ts) share it.
 */
export function insideGate(gate: MapGate, x: number, y: number, r: number): boolean {
  const dx = x - gate.x;
  const dy = y - gate.y;
  if (gate.halfW > 0) {
    const hw = gate.halfW + r;
    const hl = gate.halfL + r;
    return dx <= hw && dx >= -hw && dy <= hl && dy >= -hl;
  }
  return dx * dx + dy * dy <= gate.radius * gate.radius;
}

/**
 * One base ring turret. Carries the original Turret actor's own parameters
 * rather than only its position, because it is the same kind of shooter as a
 * capturable pad and the original gives it the same block: `engage_range`,
 * `targeting_delay`, `fov`, `turn_speed`, `gun_rotation` and `health`.
 *
 * The pre-PA authoring form, a bare position (district-01), loads as the
 * original team turret: PROFILE_TEAM_TURRET and ORIGINAL_TURRET_HP.
 */
export interface MapBaseTurret {
  readonly x: number;
  readonly y: number;
  /** Index into MapData.weapons. */
  readonly weapon: number;
  /** Max HP. */
  readonly hp: number;
  /** Rest yaw (original gun_rotation). */
  readonly yaw: number;
  readonly layer: number;
}

/** One team's base structures (rules.md §5). Index = team id. */
/**
 * A type-14 purchase zone (fcop-fidelity.md R10): touched by the own mech
 * within `radius` plus the mech's own radius (as an outpost pad is), and
 * answering the action key's press.
 */
export interface MapZone {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
  readonly radius: number;
}

/**
 * A base's Dreadnought and Flying Fortress zones and the polled check that opens
 * them for good the first time it sees the side hold HEAVY_UNLOCK_POINTS (the
 * original's fn30/fn31: every 5 s, 2.5 s on Joke and Slim, from a random phase),
 * and in the same run requests the base's two terminals.
 */
export interface MapHeavyZones {
  readonly juggernaut: MapZone;
  readonly fortress: MapZone;
  /**
   * The poll's period in the original's engine ticks (300 Hz): the function's
   * time units × 5, as `cfun_load` stores it (Mp 1500 / 1525, Joke and Slim
   * 750 / 765). Counted down by the frame delta, CFUN_DELTA_PER_TICK a tick.
   */
  readonly pollPeriod: number;
  /**
   * The Csac templates the opening run requests: the Dreadnought's and the
   * Flying Fortress's terminals (type-11 props; Mp 50 / 52 and 54 / 56). The
   * sim only reports whether they stand (MATCH_SLOT_TERMINALS); the client's
   * scenery table names them "Csac <template>".
   */
  readonly terminals: readonly number[];
}

export interface MapBase {
  /**
   * Win trigger volume: an enemy Runner or Juggernaut inside = breach (rules.md
   * §1; on the PA arenas the original's gate trigger box, §9).
   */
  readonly gate: MapGate;
  /**
   * The base's centrepiece and anchor point — render, the Guardians' patrol
   * orbit, the Warden's holding point. Indestructible everywhere: the original
   * has no destructible core (fcop-fidelity.md I6/R1).
   */
  readonly core: MapPoint;
  /** Build console for ground units (Runner/Juggernaut). */
  readonly groundConsole: MapPoint;
  /** The ground console's trigger box, half extents x / y in metres. */
  readonly groundBuy: MapBuyBox;
  /** Build console for air units (Guardian/Fortress). */
  readonly airConsole: MapPoint;
  /** The air console's trigger box, half extents x / y in metres. */
  readonly airBuy: MapBuyBox;
  /** Ring turrets; each respawns `turretRespawnTicks` after destruction. */
  readonly turrets: readonly MapBaseTurret[];
  /**
   * Ticks a ring turret stays down: the original ring spawner's period (tSAC
   * -2250 = 37.5 s = 1125 ticks on every PA map, fcop-re/outposts.md Q1), or 0
   * where the arena imports none and the sim uses BASE_TURRET_RESPAWN_TICKS,
   * the same 37.5 s (sim.ts `ringRespawnTicks`).
   */
  readonly turretRespawnTicks: number;
  /**
   * The original Dreadnought's spawn point and stats: the type-28 record on an
   * imported arena; elsewhere the ground console and ORIGINAL_UNIT_PROFILES.
   */
  readonly juggernaut: MapJuggernaut;
  /** The original tank (Runner), jet (Guardian) and Flying Fortress: records or defaults. */
  readonly runner: MapUnitProfile;
  readonly guardian: MapUnitProfile;
  readonly fortress: MapUnitProfile;
  /**
   * The heavy-unit zones; undefined where the arena imports none, and then no
   * player can buy a Dreadnought or a Fortress (the test maps).
   */
  readonly heavyZones: MapHeavyZones | undefined;
  /** Where a Fortress appears: its own spawner's (Csac) position; else the air console. */
  readonly fortressSpawn: MapPoint;
  /** Where the base's tanks and jets appear: their spawners; else the consoles. */
  readonly tankSpawn: MapPoint;
  readonly jetSpawn: MapPoint;
  /**
   * The base's tank queue's period, and the jet queue's (the Sky Captain's; a
   * human's jets come at once), in engine ticks (MapQueuePeriods).
   * ORIGINAL_*_QUEUE_PERIOD where the arena imports none.
   */
  readonly queuePeriod: MapQueuePeriods;
  /**
   * The base jet spawner's and the Fortress spawner's flight blocks (their
   * records' altitudes and spawn flags, their models' half-extents;
   * balance.ts AircraftFlight): Mp's (ORIGINAL_JET_FLIGHT / _FORTRESS_FLIGHT)
   * where the arena imports none.
   */
  readonly jetFlight: AircraftFlight;
  readonly fortressFlight: AircraftFlight;
}

/**
 * The original Cnet lane graph (fcop-logic.md §3.1) — a real graph with
 * junctions, unlike the flat `lanes` polylines.
 *
 * `nextHopA`/`nextHopB` are the reason this does NOT amount to runtime
 * pathfinding (rules.md §6): the routes are searched once at authoring time and
 * committed as a signpost per (team, node), so a unit reads at most one array
 * entry and makes at most one coin flip. It never searches.
 */
export interface MapLaneGraph {
  readonly nodes: readonly MapPoint[];
  /** 4 slots per node, -1 = no edge. length = nodes.length * 4. */
  readonly edges: Int16Array;
  /** Committed next hop toward the enemy base, [team * n + node]; -1 = arrived. */
  readonly nextHopA: Int16Array;
  /** Alternate next hop (a parallel road) or -1; picked by the seeded PRNG. */
  readonly nextHopB: Int16Array;
  /** Entry node per team (index = team id). */
  readonly entry: readonly number[];
  /**
   * Which team's net each node belongs to (0 / 1; 255 for a node on neither).
   * The original carries one Cnet per side and each side's units drive their
   * own (fcop-logic.md §8.1); the import merges them into one node list, so the
   * loader labels the two connected components by the entry each contains.
   */
  readonly net: Uint8Array;
  /**
   * Each node's height in node units (1/32 m): what `cnet_load` (0x00441900)
   * writes at node +8, `(terrain_height_at + 0x7f) >> 8` over the shipped
   * plates. The route cursor measures its legs and their pitch with it
   * (route.ts). 0 where the arena imports none.
   */
  readonly heights: Int16Array;
  /**
   * 1 for a node a mission script has closed: bit 1 of its state
   * (`CNET_NODE_STATE_SCRIPT`), refused by the step chooser. As shipped,
   * cleared and set at run time by Cfun opcode 0x3b (0x00440060) and the route
   * orders 0x14 / 0x15 (0x00440120); no Precinct Assault script uses either.
   */
  readonly closed: Uint8Array;
  /**
   * The merged index of each imported Cnet's node 0, ascending from 0: the
   * original compares node indices within one net (route.ts localNode).
   */
  readonly netStart: readonly number[];
  /** The tank's route block (MapRouteParams): its spawner records'. */
  readonly runnerRoute: MapRouteParams;
  /** The Dreadnought's (type 28's). */
  readonly juggernautRoute: MapRouteParams;
}

/**
 * A route follower's parameter block as `cnet_route_init` (0x004415f0) copies
 * it in from the record's payload +0x30 (fcop-fidelity.md U1, I6), raw: the
 * flag word's low halfword -- 0 the tank, 0x20 (`CNET_ROUTE_BANK`) Hk's, 0x8
 * the Dreadnought; neither 0x100 (`CNET_ROUTE_NO_PITCH`) nor 0x200
 * (`CNET_ROUTE_ON_GROUND`) on any Precinct Assault record -- and the height
 * bias, which the tick adds `<< 4` world units over the road (0x00440672):
 * 307 the tank (Hk 102, Joke 20), 204 the Dreadnought (Joke 20).
 */
export interface MapRouteParams {
  readonly flags: number;
  readonly bias: number;
}

/** A road graph without imported records: no flag, no bias (the Dreadnought's 0x8 kept). */
export const DEFAULT_RUNNER_ROUTE: MapRouteParams = { flags: 0, bias: 0 };
export const DEFAULT_JUGGERNAUT_ROUTE: MapRouteParams = { flags: 0x8, bias: 0 };

/** A power-up spot (original ItemPickup, act_type 16). */
export interface MapPickup {
  readonly x: number;
  readonly y: number;
  /** PICKUP_* kind (balance.ts). */
  readonly kind: number;
  /** Ticks before the spot re-arms after being taken. */
  readonly respawnTicks: number;
  readonly layer: number;
  /**
   * The collection box's half extents in metres (fcop-fidelity.md P9): x, y and
   * height about the pickup, which stands `lift` above the ground. A mech
   * collects strictly inside on every axis (`cact_pickup_box_touch`; no radius).
   */
  readonly halfW: number;
  readonly halfL: number;
  readonly halfH: number;
  readonly lift: number;
  /** Render-only: the original Cobj model and its spin rate (4096ths a 300 Hz tick). */
  readonly model: number;
  readonly spin: number;
}

/**
 * An axis-aligned base-intrusion volume (original Trigger, act_type 95;
 * fcop-logic.md §8.6). The sim detects and emits EV_ALARM; the client speaks the
 * original's intrusion line for the base's side (speech 2/3, fcop-fidelity.md
 * R15).
 */
export interface MapTriggerVolume {
  readonly x: number;
  readonly y: number;
  readonly halfW: number;
  readonly halfL: number;
  /** Team whose base this guards. */
  readonly team: number;
  /** TRIGGER_WATCH_* bitmask (balance.ts). */
  readonly watch: number;
  readonly layer: number;
}

/**
 * Hk's spawn guard (fcop-fidelity.md P11): a trigger box about a spawn that
 * watches the ENEMY mech. While that mech is inside it takes `damage`, then the
 * box waits for a latch reset the mission polls every `resetPeriod` engine
 * ticks from a random phase (fn45 / fn46's 60 time units × 5 = 300, as
 * `cfun_load` stores it; RE `pa_rules.json` damage_triggers; trigger.c's box
 * test, every axis widened by the mech's radius).
 */
export interface MapSpawnGuard {
  readonly x: number;
  readonly y: number;
  readonly halfW: number;
  readonly halfL: number;
  /** Half height about the terrain under the centre, sampled at load. */
  readonly halfH: number;
  /** Team whose mech the box hurts. */
  readonly hurtsTeam: number;
  readonly damage: number;
  readonly resetPeriod: number;
  readonly layer: number;
}

/**
 * The original's coarse ground-height field (RE prepare.c,
 * `cact_coarse_height_build` 0x00455e00): one signed byte (1/32 m) per two
 * terrain samples each way, the maximum over a 2x2 block of samples and their
 * three channels, blurred and maxed again — an upper envelope of the ground
 * and the decks. The K-9 Drone keeps its clearance over it (coarseHeightAt).
 * Field row R begins at the sim's y = originY + 2R, column C at x = originX + 2C.
 */
export interface MapCoarse {
  readonly originX: number;
  readonly originY: number;
  readonly rows: number;
  readonly stride: number;
  /** rows * stride bytes, row-major. */
  readonly data: Int8Array;
}

/**
 * One of the original's lifts (type-10 actor, `elevator.c`; fcop-fidelity.md
 * P12; RE `camera-and-movement.md` "Lifts"). It moves only its height, between
 * `stops` above the ground it was built on: from a stop whose `dwell` is 0 it
 * leaves when a mech standing on its top presses the Action Key, from any other
 * after `dwell` ticks; at either end of the table it turns round. Its top face
 * is ground to a mech standing on it, and a tagged lift's top is its base's
 * floor (`hurtsTeam`).
 */
export interface MapLift {
  /** Centre, sim frame. */
  readonly x: number;
  readonly y: number;
  /** The top face's rectangle, absolute sim coordinates (the record's box, turned by its yaw). */
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  /** The ground under the lift as it was built, m. */
  readonly ground: number;
  /** The top face above the lift's position, m. */
  readonly top: number;
  /** Stops in world units (1/8192 m) above `ground`, ascending (raw << 4). */
  readonly stops: readonly number[];
  /** World units a sim tick toward a higher stop (`up`) and a lower one (`down`). */
  readonly up: number;
  readonly down: number;
  /** Per stop: sim ticks it waits there; 0 parks it until a rider's press. */
  readonly dwell: readonly number[];
  /** The stop it starts at; it first moves toward the next one up. */
  readonly start: number;
  /** Team whose mech its top hurts as that team's enemy floor does (tag 14/15), -1 none. */
  readonly hurtsTeam: number;
  /** Per stop: the surface a rider counts as standing on (0 ground, L deck L), for its walls. */
  readonly layers: readonly number[];
  /** Render only: the original Cobj and the yaw, radians. */
  readonly model: number;
  readonly yaw: number;
}

/**
 * One of the original's outposts (fcop-re/outposts.md Q3), parallel to
 * `MapData.outpostSpots` (the claim zone's centre, where the console marker
 * stands). Precinct Assault arenas only.
 */
export interface MapOutpost {
  /**
   * The type-14 claim zone's and the pads' radius in metres (614 raw << 4 wu =
   * 1.2 m), before the toucher's own radius.
   */
  readonly zone: number;
  /** Where an owner buys a tank (Runner) and a jet (Guardian), at 2 points each. */
  readonly tankPad: MapPoint;
  readonly jetPad: MapPoint;
  /** Per team: where its tanks and jets from this outpost appear (their spawners). */
  readonly tankSpawn: readonly MapPoint[];
  readonly jetSpawn: readonly MapPoint[];
  /** Per team: this outpost's tank and jet queues' periods in engine ticks (MapQueuePeriods). */
  readonly queuePeriod: readonly MapQueuePeriods[];
  /** Per team: this outpost's jet spawner's flight block (ORIGINAL_JET_FLIGHT where none). */
  readonly jetFlight: readonly AircraftFlight[];
}

/**
 * A spawn queue pair's periods (fcop-fidelity.md R18): each queue is the
 * mission function that spawns one queued unit per poll while its count is
 * positive, polled by `cfun_tick` from a random phase drawn at load; its period
 * in the original's engine ticks (300 Hz), the function's time units × 5 as
 * `cfun_load` stores it, counted down by the frame delta, CFUN_DELTA_PER_TICK a
 * tick.
 */
export interface MapQueuePeriods {
  readonly tank: number;
  readonly jet: number;
}

/**
 * One outpost turret plate (fcop-re/outposts.md Q1): a NeutralTurret, live at
 * start, and each side's type-8 turret record, shut until that side claims the
 * outpost. The claim kills the neutral for good and opens the claimer's turret.
 */
export interface MapOutpostPlate {
  /** Index into MapData.outposts / outpostSpots. */
  readonly outpost: number;
  /** Index into MapData.turretSpots: the plate's NeutralTurret. */
  readonly spot: number;
  /** The plate's team turret per team (index = team): position, weapon, hp, yaw. */
  readonly turrets: readonly MapBaseTurret[];
}

export interface MapData {
  readonly id: string;
  /** Vertices per side (the grid is size × size, so (size-1)² cells). */
  readonly size: number;
  /** Meters per cell edge. */
  readonly cellSize: number;
  /** Row-major heights, index = row * size + col. */
  readonly heights: Float32Array;
  /**
   * 1 = water, per cell (`floor(y) * size + floor(x)`): the original's surface
   * code 1, whose sample tiles are the sim's cells (fcop-fidelity.md P13).
   */
  readonly waterMask: Uint8Array;
  /** Each water cell's own surface height in metres; meaningless off the mask. */
  readonly waterHeights: Float32Array;
  /**
   * The arena's water surface in metres, for everything that does not ask a cell:
   * a hover rides on max(terrain, this) off the mask too (its banks), and
   * aircraft cruise above it.
   */
  readonly waterLevel: number;
  /**
   * Vertical wall segments (edge blockers on grid lines): wallsV[j*size+i]=1
   * blocks ±x crossings of the line x = i*cellSize within cell row j. EMPTY
   * (length 0) when the map has no walls — collision helpers early-out on
   * that, which is what keeps wall-free maps provably hash-identical.
   */
  readonly wallsV: Uint8Array;
  /** Horizontal twin: wallsH[j*size+i]=1 blocks ±y crossings of the line
   *  y = j*cellSize within cell column i. Empty when the map has no walls. */
  readonly wallsH: Uint8Array;
  /**
   * Extra walkable surfaces stacked above layer 0 (= `heights`). Index 0 here
   * is layer 1. Each is a full size×size heightfield (edge-extended so bilinear
   * sampling within a present cell is well-defined). EMPTY (length 0) for
   * single-story maps → resolveHeight early-outs and hashes stay byte-identical.
   */
  readonly layerHeights: readonly Float32Array[];
  /** Presence mask per extra layer, same indexing: 1 = deck present at this vertex. */
  readonly layerMask: readonly Uint8Array[];
  /**
   * Wall lattice PER extra layer, same indexing as layerHeights (index 0 is
   * layer 1). `wallsV`/`wallsH` above are layer 0's. EMPTY (length 0) when no
   * deck carries its own walls — every layer then shares the layer-0 lattice,
   * which is exactly the pre-#29 behaviour and what keeps every other map's
   * hashes byte-identical.
   *
   * A bridge's parapet blocks on the bridge, not on the road underneath, so a
   * lattice per deck is what stops the two from being charged to each other.
   */
  readonly layerWallsV: readonly Uint8Array[];
  /** Horizontal twin, same indexing. */
  readonly layerWallsH: readonly Uint8Array[];
  /** Avatar spawn per team (index = team id). */
  readonly spawns: readonly MapSpawn[];
  /** Base plot per team (index = team id): the flat build area. */
  readonly basePlots: readonly MapPlot[];
  /** Base structures per team (index = team id). */
  readonly bases: readonly MapBase[];
  /** Ground-unit lane polylines, each ≥ 2 waypoints, base 0 → base 1. */
  readonly lanes: readonly (readonly MapPoint[])[];
  /** Neutral turret spots (Phase 2/3). */
  readonly turretSpots: readonly MapPoint[];
  /** Outpost spots: the console / claim zone of each outpost (rules.md §5). */
  readonly outpostSpots: readonly MapPoint[];
  /**
   * The original's outposts, parallel to `outpostSpots` (fcop-re/outposts.md).
   * EMPTY on Metropolis' own arenas, whose outposts are consoles with no pads
   * and no turret plates (district-01 keeps them as a purchase menu).
   */
  readonly outposts: readonly MapOutpost[];
  /** Every outpost's turret plates, flattened in outpost order. EMPTY with `outposts`. */
  readonly outpostPlates: readonly MapOutpostPlate[];
  /** Destructible test-dummy turret spots (Phase 1 sandbox targets). */
  readonly dummySpots: readonly MapPoint[];
  /**
   * The dummies' gun: an index into `weapons`, the original neutral turret's
   * profile (balance.ts PROFILE_NEUTRAL_TURRET); -1 on a map without dummies.
   */
  readonly dummyWeapon: number;
  /**
   * Weapon profiles referenced by index: the arena's imported ones, or
   * ORIGINAL_WEAPON_PROFILES (same order) where it imports none.
   */
  readonly weapons: readonly MapWeapon[];
  /**
   * Weapon index per `turretSpots` entry, same length and index space
   * (PROFILE_NEUTRAL_TURRET where the arena imports none) — the two lists are
   * kept parallel rather than fused so capture bookkeeping keeps indexing
   * turretSpots directly.
   */
  readonly turretParams: readonly number[];
  /** Rest yaw per `turretSpots` entry (original gun_rotation). EMPTY = 0. */
  readonly turretYaw: readonly number[];
  /**
   * Max HP per `turretSpots` entry (original Turret `health`; ORIGINAL_TURRET_HP
   * where the arena imports none).
   */
  readonly turretHp: readonly number[];
  /**
   * Capture range of the `turretSpots`, in metres, BEFORE the capturer's own
   * radius: the original's `(range + 1024) / 512` (fcop-re/ranges-turrets-capture.md
   * Q2) — 4.0 on Mp/Conft/Ovmp, 5.2 on Slim/Joke, 5.6 on Hk; an arena that
   * imports none gets ORIGINAL_CAPTURE_RANGE, the 4.0 m.
   */
  readonly captureRange: number;
  /**
   * The arena's hit radii, its own mission's models (MapRadii; balance.ts
   * ARCHETYPE_RADIUS's Mp values where it imports none).
   */
  readonly radii: MapRadii;
  /**
   * How far each role's reference point stands above its position, metres:
   * the box-0 centre of the same model and frame as its radius, placed as
   * the original places it (`math_matrix_place_point` 0x00458850: `(M * src)
   * >> 12` with M in 16.16, so the box's 1/512 m units as metres; a turret's
   * gun from its base's attach point 0). It is what the original aims at and
   * measures to (fcop-fidelity.md W5). MUZZLE_HEIGHT on every role where the
   * arena imports none.
   */
  readonly refHeights: MapRadii;
  /**
   * Each turret's gun as it aims and fires (fcop-fidelity.md G12): where it
   * stands on its base and its muzzle, the type-8 gun's and a neutral's per
   * `turretSpots` entry (MapTurretGun). Metropolis' stand-in muzzle on the
   * ground (MUZZLE_OFFSET ahead, MUZZLE_HEIGHT up) where the arena imports none.
   */
  readonly turretGuns: MapTurretGuns;
  /**
   * The Sky Captain's flight block by level 0..9 (its record per level band;
   * ORIGINAL_SKY_FLIGHT where the arena imports none).
   */
  readonly skyFlight: readonly AircraftFlight[];
  /**
   * The Sky Captain's missile's acceleration, the catalogue's weapon 8 +0x14
   * raw: 0 on Mp, Conft, Hk and Ovmp (it leaves at its top speed), 0x7a on Slim
   * and Joke (`cact_missile_spawn` 0x0044d103). 0 where the arena imports none.
   */
  readonly skyMissileAccel: number;
  /** Every body's and round's hit boxes (MapShapes; none where the arena imports none). */
  readonly shapes: MapShapes;
  /** The original Cnet graph. `undefined` → follow the `lanes` polylines. */
  readonly laneGraph: MapLaneGraph | undefined;
  /** Power-up spots. EMPTY → no pickups on this arena. */
  readonly pickups: readonly MapPickup[];
  /** Base-intrusion volumes. EMPTY → no intrusion alerts. */
  readonly triggerVolumes: readonly MapTriggerVolume[];
  /**
   * The ground's codes a mech feels, one mask per surface (index 0 the ground,
   * L deck L), cell-indexed (`floor(y) * size + floor(x)`): 0 = none; 1 + team
   * = the bases' floors (fcop-fidelity.md P11), this cell hurts that team's
   * mech; 3, 4, 5 = the ground codes 3, 4, 5 that set the walker's movement
   * mode (P11; Ovmp's slippery code 4). EMPTY on an arena whose ground carries
   * none.
   */
  readonly floorMasks: readonly Uint8Array[];
  /** Any cell of floorMasks carries a mode code (3..5): the walker's mode is live. */
  readonly modeFloors: boolean;
  /** Hk's spawn guards. EMPTY elsewhere. */
  readonly spawnGuards: readonly MapSpawnGuard[];
  /** The lifts (Conft, Slim, Joke). EMPTY elsewhere. */
  readonly lifts: readonly MapLift[];
  /** The original's coarse ground-height field; null off the FCOP arenas. */
  readonly coarse: MapCoarse | null;
}

/**
 * Labels each node with the team whose entry shares its connected component
 * (edges taken as undirected), 255 where neither does. Union-find in index
 * order: deterministic, and only run at load.
 */
function labelNets(edges: Int16Array, n: number, entry: readonly number[]): Uint8Array {
  const parent = new Int32Array(n);
  for (let k = 0; k < n; k++) parent[k] = k;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  for (let k = 0; k < n; k++) {
    for (let s = 0; s < 4; s++) {
      const v = edges[k * 4 + s];
      if (v >= 0) parent[find(k)] = find(v);
    }
  }
  const out = new Uint8Array(n).fill(255);
  for (let team = 1; team >= 0; team--) {
    const root = find(entry[team]);
    for (let k = 0; k < n; k++) if (find(k) === root) out[k] = team;
  }
  return out;
}

/** Playable extent in meters along one axis: [0, extent] on both axes. */
export function worldExtent(map: MapData): number {
  return (map.size - 1) * map.cellSize;
}

/**
 * Bilinear height sample at world position (x, y). Coordinates are clamped
 * to the map, so out-of-bounds queries return edge heights. Uses only
 * + - * /, floor, min, max — bit-exact on every engine.
 */
export function sampleHeight(map: MapData, x: number, y: number): number {
  const max = map.size - 1;
  const gx = clamp(x / map.cellSize, 0, max);
  const gy = clamp(y / map.cellSize, 0, max);
  let i0 = Math.floor(gx);
  let j0 = Math.floor(gy);
  if (i0 > max - 1) i0 = max - 1;
  if (j0 > max - 1) j0 = max - 1;
  const fx = gx - i0;
  const fy = gy - j0;
  const s = map.size;
  const row0 = j0 * s + i0;
  const row1 = row0 + s;
  const h0 = lerp(map.heights[row0], map.heights[row0 + 1], fx);
  const h1 = lerp(map.heights[row1], map.heights[row1 + 1], fx);
  return lerp(h0, h1, fy);
}

/**
 * Bilinear height sample on an EXTRA layer (layerIdx 0-based into layerHeights,
 * i.e. layerIdx 0 == layer 1). Same math as sampleHeight — bit-exact on every
 * engine. Out-of-range layerIdx degrades to the base surface.
 */
export function sampleLayerHeight(map: MapData, layerIdx: number, x: number, y: number): number {
  if (layerIdx < 0 || layerIdx >= map.layerHeights.length) return sampleHeight(map, x, y);
  const heights = map.layerHeights[layerIdx];
  const max = map.size - 1;
  const gx = clamp(x / map.cellSize, 0, max);
  const gy = clamp(y / map.cellSize, 0, max);
  let i0 = Math.floor(gx);
  let j0 = Math.floor(gy);
  if (i0 > max - 1) i0 = max - 1;
  if (j0 > max - 1) j0 = max - 1;
  const fx = gx - i0;
  const fy = gy - j0;
  const s = map.size;
  const row0 = j0 * s + i0;
  const row1 = row0 + s;
  const h0 = lerp(heights[row0], heights[row0 + 1], fx);
  const h1 = lerp(heights[row1], heights[row1 + 1], fx);
  return lerp(h0, h1, fy);
}

/**
 * Height of the walkable surface at (x, y) on `layer` (0 = base heights). The
 * layer===0 / no-extra-layers early-out makes single-story maps bit-identical
 * to a plain sampleHeight (No-op invariant).
 */
export function resolveHeight(map: MapData, x: number, y: number, layer: number): number {
  if (layer === 0 || map.layerHeights.length === 0) return sampleHeight(map, x, y);
  return sampleLayerHeight(map, layer - 1, x, y);
}

/** Water test at world position (x, y): the cell it stands in, clamped. */
export function isWater(map: MapData, x: number, y: number): boolean {
  const max = map.size - 1;
  const i = clamp(Math.floor(x / map.cellSize), 0, max);
  const j = clamp(Math.floor(y / map.cellSize), 0, max);
  return map.waterMask[j * map.size + i] === 1;
}

/**
 * The water surface a hover rides at (x, y): the cell's own where it is water,
 * else the arena's `waterLevel` (so a bank whose terrain dips below the water
 * floats a hover before the mask begins).
 */
export function waterHeightAt(map: MapData, x: number, y: number): number {
  const max = map.size - 1;
  const i = clamp(Math.floor(x / map.cellSize), 0, max);
  const j = clamp(Math.floor(y / map.cellSize), 0, max);
  const k = j * map.size + i;
  return map.waterMask[k] === 1 ? map.waterHeights[k] : map.waterLevel;
}

/** Map registry: resolves the mapId stored in replays/net handshakes. */
export function getMapById(id: string): MapData {
  if (id === TEST_MAP_ID) return createTestMap();
  if (id === LAYERED_TEST_ID) return loadMapFromJson(layeredTestJson as MapJson);
  for (const entry of REGISTRY) {
    if (entry.info.id === id) return loadMapFromJson(entry.json);
  }
  throw new Error(`unknown map id: ${id}`);
}

/** FCOP "Urban Jungle" arena (mission Conft), heightfield extracted 1:1. */
export const URBAN_JUNGLE_ID = "urban-jungle";

/** FCOP "Proving Ground" arena (mission Slim), heightfield extracted 1:1. */
export const PROVING_GROUND_ID = "proving-ground";

/** FCOP "La Cantina" arena (mission Mp), heightfield extracted 1:1. */
export const LA_CANTINA_ID = "la-cantina";

/** FCOP "Bug Hunt" arena (mission Joke), heightfield extracted 1:1. */
export const BUG_HUNT_ID = "bug-hunt";

/** FCOP "Hollywood Keys" arena (mission Hk) — layered (multi-deck, Stage 5). */
export const HOLLYWOOD_KEYS_ID = "hollywood-keys";

/** FCOP "Venice Beach" PA arena (mission Ovmp) — layered (multi-deck, Stage 5). */
export const VENICE_BEACH_ID = "venice-beach";

/** Synthetic multi-deck sandbox for layered-movement tests (debug-only, NOT in MAP_REGISTRY). */
export const LAYERED_TEST_ID = "layered-test";

/** Metadata for one selectable arena — what a map picker needs to offer it. */
export interface MapInfo {
  /** Registry id — the exact string stored in replays and the net handshake. */
  readonly id: string;
  /** Human-readable arena name. */
  readonly displayName: string;
}

// Adding an arena = one entry here + its JSON in packages/sim/maps/.
// (District 01 is intentionally absent — retired from the picker but kept
// resolvable by id in getMapById above for goldens/tools.)
const REGISTRY: readonly { readonly info: MapInfo; readonly json: MapJson }[] = [
  { info: { id: URBAN_JUNGLE_ID, displayName: "Urban Jungle" }, json: urbanJungleJson },
  { info: { id: PROVING_GROUND_ID, displayName: "Proving Ground" }, json: provingGroundJson },
  { info: { id: LA_CANTINA_ID, displayName: "La Cantina" }, json: laCantinaJson },
  { info: { id: BUG_HUNT_ID, displayName: "Bug Hunt" }, json: bugHuntJson },
  { info: { id: HOLLYWOOD_KEYS_ID, displayName: "Hollywood Keys" }, json: hollywoodKeysJson },
  { info: { id: VENICE_BEACH_ID, displayName: "Venice Beach" }, json: veniceBeachJson },
];

/** Selectable arenas in display order. test-128 stays a debug-only deep link. */
export const MAP_REGISTRY: readonly MapInfo[] = REGISTRY.map((e) => e.info);

/**
 * Fixed-point scale for JSON heights: 1/32 m steps are exact binary
 * fractions, so `int * HEIGHT_SCALE` reconstructs bit-identical floats on
 * every engine.
 */
export const HEIGHT_SCALE = 0.03125;

/** Shape of a map JSON file (packages/sim/maps/*.json). */
export interface MapJson {
  id: string;
  size: number;
  cellSize: number;
  /** Rows of heights in 1/32 m integer units. */
  heights: number[][];
  /**
   * Rows of digit characters: '0' dry; with `waterLevels`, '1'..'9' a water cell
   * at `waterLevels[digit - 1]`; without, '1' a water cell at `waterLevel`.
   */
  water: string[];
  /** Water surface height in meters. */
  waterLevel: number;
  /** OPTIONAL: the arena's distinct water surfaces in metres (`water` digits). */
  waterLevels?: number[];
  /**
   * OPTIONAL wall data (both present or both absent): size rows of size
   * '0'/'1' chars each. wallsV[j][i] blocks ±x over line x = i*cellSize in
   * cell row j; wallsH[j][i] blocks ±y over line y = j*cellSize in cell
   * column i. Absent → the loaded map has EMPTY wall arrays (no-op movement).
   */
  wallsV?: string[];
  wallsH?: string[];
  /**
   * OPTIONAL extra walkable decks above layer 0. Each: `heights` in 1/32 m
   * ints (size rows × size), `mask` size rows of size '0'/'1' chars, plus that
   * deck's OWN optional wall lattice (both present or both absent, same shape as
   * the top-level pair). Absent → single-story (empty layer arrays); layer walls
   * absent → every deck shares the layer-0 lattice.
   */
  layers?: { heights: number[][]; mask: string[]; wallsV?: string[]; wallsH?: string[] }[];
  /** Optional `layer` (default 0) — surface the spawn sits on (issue #33). */
  spawns: { x: number; y: number; yaw: number; layer?: number; hover?: boolean }[];
  basePlots: { x: number; y: number; radius: number; layer?: number }[];
  bases: MapBaseJson[];
  /**
   * Point lists are `[x, y]` pairs (layer 0) or `{x, y, layer?}` objects.
   * Length is validated at load time.
   */
  lanes: (number[] | { x: number; y: number; layer?: number })[][];
  turretSpots: (number[] | { x: number; y: number; layer?: number })[];
  outpostSpots: (number[] | { x: number; y: number; layer?: number })[];
  dummySpots: (number[] | { x: number; y: number; layer?: number })[];
  /**
   * OPTIONAL: the original's outposts (MapOutpost), one per `outpostSpots` entry.
   * Each plate names its NeutralTurret by `turretSpots` index and carries both
   * teams' turrets in the ring turrets' object form.
   */
  outposts?: {
    zone: number;
    tankPad: number[] | { x: number; y: number; layer?: number };
    jetPad: number[] | { x: number; y: number; layer?: number };
    /** OPTIONAL, per team: the spawners' positions (absent -> the pads) and queue periods. */
    tankSpawn?: (number[] | { x: number; y: number; layer?: number })[];
    jetSpawn?: (number[] | { x: number; y: number; layer?: number })[];
    queuePeriod?: { tank: number; jet: number }[];
    /** OPTIONAL, per team: the jet spawner's flight block (MapOutpost.jetFlight). */
    jetFlight?: FlightJson[];
    plates: {
      spot: number;
      turrets: { x: number; y: number; weapon: number; hp: number; yaw: number; layer?: number }[];
    }[];
  }[];
  /**
   * OPTIONAL Precinct Assault data (rules.md §9). Absent on district-01 and on
   * the inline MapJson literals the tests build: those load with the original's
   * own profiles, health and capture range (balance.ts ORIGINAL_*), so every
   * arena plays the original's rules on its own geometry (SIM_VERSION 52).
   */
  weapons?: {
    range: number;
    delay: number;
    damage: number;
    turnSpeed: number;
    fovCos: number;
    refireUnits?: number;
    searchUnits?: number;
    speed?: number;
    flight?: number;
    guided?: number;
    lead?: number;
    arcCos?: number;
    hold?: number;
    priority?: number;
    /** OPTIONAL: its round's table in `shapes.tables` (MapWeapon.round), -1 none. */
    round?: number;
  }[];
  /** Weapon index per turretSpots entry; length must equal turretSpots.length. */
  turretParams?: number[];
  /** Rest yaw per turretSpots entry; length must equal turretSpots.length. */
  turretYaw?: number[];
  /** Max HP per turretSpots entry; length must equal turretSpots.length. */
  turretHp?: number[];
  /** Capture range of the turret spots in metres, before the capturer's radius. */
  captureRange?: number;
  /** OPTIONAL: the arena's hit radii (MapRadii); `neutral` parallel to turretSpots. */
  radii?: {
    walker: number;
    hover: number;
    tank: number;
    jet: number;
    fortress: number;
    dreadnought: number;
    /** OPTIONAL: a walking hull's radius per frame (MapRadii.dreadnoughtByFrame). */
    dreadnoughtByFrame?: number[];
    baseTurret: number;
    neutral: number[];
    skyCaptain: number[];
  };
  /** OPTIONAL: the Sky Captain's flight block per level 0..9 (MapData.skyFlight). */
  skyFlight?: FlightJson[];
  /** OPTIONAL: the Sky Captain's missile's raw acceleration (MapData.skyMissileAccel). */
  skyMissileAccel?: number;
  /** OPTIONAL: each role's reference height (MapData.refHeights), the radii's shape. */
  refHeights?: {
    walker: number;
    hover: number;
    tank: number;
    jet: number;
    fortress: number;
    dreadnought: number;
    dreadnoughtByFrame?: number[];
    baseTurret: number;
    neutral: number[];
    skyCaptain: number[];
  };
  /**
   * OPTIONAL: each turret's gun (MapData.turretGuns): `stand` metres, `muzzle`
   * [x, y, z] metres in the gun's glb frame; `neutral` parallel to turretSpots.
   */
  turretGuns?: {
    baseTurret: { stand: number; muzzle: number[] };
    neutral: { stand: number; muzzle: number[] }[];
  };
  /**
   * OPTIONAL: every body's and round's 3DBB tables (MapShapes), raw halfwords
   * (1/512 m) as the models hold them; `neutral` parallel to turretSpots, its
   * `point` in glb metres (x negated).
   */
  shapes?: {
    tables: { cobj?: number; perFrame: number; frames: number; boxes: number[][] }[];
    tank: { table: number; lift: number[]; muzzle?: number[] };
    jet: { table: number; lift: number[]; muzzle?: number[] };
    fortress: { table: number; lift: number[]; muzzle?: number[] };
    dreadnought: number;
    dreadnoughtGuns: number[];
    baseTurret: { gun: number; base: number; point: number[] };
    neutral: { gun: number; base: number; point: number[] }[];
    skyCaptain: { table: number; lift: number[]; muzzle?: number[] }[];
    worldRounds: Record<string, number>;
    playerRounds: Record<string, number>;
  };
  /** Original Cnet graph. `edges` is one 4-tuple per node, -1 = no edge. */
  laneGraph?: {
    nodes: (number[] | { x: number; y: number; layer?: number })[];
    edges: number[][];
    nextHopA: number[][];
    nextHopB: number[][];
    entry: number[];
    /** OPTIONAL node heights, node units (MapLaneGraph.heights); absent -> 0. */
    heights?: number[];
    /** OPTIONAL script-closed nodes, by index (MapLaneGraph.closed); absent -> none. */
    closed?: number[];
    /** OPTIONAL first node of each imported net (MapLaneGraph.netStart); absent -> [0]. */
    netStart?: number[];
    /**
     * OPTIONAL route blocks (MapLaneGraph.runnerRoute / juggernautRoute), each
     * `[flags, bias]` raw; absent -> DEFAULT_RUNNER_ROUTE / DEFAULT_JUGGERNAUT_ROUTE.
     */
    routes?: { runner: number[]; juggernaut: number[] };
  };
  /** OPTIONAL box, lift, model and spin per pickup (MapPickup); absent -> Mp's box, no model. */
  pickups?: {
    x: number;
    y: number;
    kind: number;
    respawnTicks: number;
    layer?: number;
    halfW?: number;
    halfL?: number;
    halfH?: number;
    lift?: number;
    model?: number;
    spin?: number;
  }[];
  triggerVolumes?: {
    x: number;
    y: number;
    halfW: number;
    halfL: number;
    team: number;
    watch: number;
    layer?: number;
  }[];
  /**
   * OPTIONAL: the ground's codes a mech feels, one mask per surface (ground,
   * then each deck): size rows of size chars, '0' none, '1' hurts team 0's
   * mech, '2' team 1's, '3' '4' '5' the movement-mode codes 3, 4, 5.
   */
  floors?: string[][];
  /** OPTIONAL: Hk's spawn guards (MapSpawnGuard). */
  spawnGuards?: {
    x: number;
    y: number;
    halfW: number;
    halfL: number;
    halfH: number;
    hurtsTeam: number;
    damage: number;
    resetPeriod: number;
    layer?: number;
  }[];
  /** OPTIONAL: the lifts (MapLift). */
  lifts?: {
    x: number;
    y: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    ground: number;
    top: number;
    stops: number[];
    up: number;
    down: number;
    dwell: number[];
    start: number;
    hurtsTeam: number;
    layers: number[];
    model: number;
    yaw: number;
  }[];
  /** OPTIONAL: the coarse ground-height field (MapCoarse), its rows as hex bytes. */
  coarse?: {
    originX: number;
    originY: number;
    rows: number;
    stride: number;
    field: string[];
  };
}

/** JSON shape of one base; point lists are [x, y] pairs or {x,y,layer?} objects. */
export interface MapBaseJson {
  /** halfW/halfL: the original's gate box; absent -> the §1 circle. */
  gate: { x: number; y: number; radius: number; halfW?: number; halfL?: number; layer?: number };
  core: number[] | { x: number; y: number; layer?: number };
  groundConsole: number[] | { x: number; y: number; layer?: number };
  airConsole: number[] | { x: number; y: number; layer?: number };
  /**
   * OPTIONAL: each console's type-95 trigger box (half extents x / y, metres);
   * absent -> the original's Mp box (balance.ts ORIGINAL_BUY_HALF_W/L).
   */
  groundBuy?: { halfW: number; halfL: number };
  airBuy?: { halfW: number; halfL: number };
  /**
   * Retired: Metropolis' ammo/repair pad, which the original does not have
   * (fcop-fidelity.md P1). Ignored where a stage-1 authoring file still carries it.
   */
  pad?: { x: number; y: number; radius: number; layer?: number };
  /**
   * Ring turrets. Either a bare `[x, y]` pair (district-01: the original team
   * turret's defaults) or an object carrying the original Turret actor's own
   * parameters (the imported arenas).
   */
  turrets: (
    | number[]
    | { x: number; y: number; weapon: number; hp: number; yaw: number; layer?: number }
  )[];
  /** OPTIONAL: the ring spawner's period in sim ticks (MapBase.turretRespawnTicks). */
  turretRespawnTicks?: number;
  /** OPTIONAL PA extra: the original Dreadnought (MapJuggernaut). */
  juggernaut?: {
    x: number;
    y: number;
    hp: number;
    guns: number;
    weapon: number;
    layer?: number;
    /** OPTIONAL: the gun mounts (MapGunMount); balance.ts DREADNOUGHT_MOUNTS when absent. */
    mounts?: {
      x: number;
      y: number;
      z: number;
      mx: number;
      my: number;
      mz: number;
      frames?: number[][];
    }[];
    /** OPTIONAL: the hull's walk (MapHullWalk); absent for a static hull. */
    walk?: {
      from: number;
      to: number;
      mode: number;
      end: number;
      link: number;
      linkB: number;
      linkC: number;
      flags: number;
      period: number;
      event: number;
    };
    /** OPTIONAL: the guns' turn (MapJuggernaut.gunTurn); DREADNOUGHT_GUN_TURN when absent. */
    gunTurn?: number;
  };
  /** OPTIONAL PA extras: the original tank, jet and Flying Fortress (MapUnitProfile). */
  runner?: { hp: number; weapon: number };
  guardian?: { hp: number; weapon: number };
  fortress?: { hp: number; weapon: number };
  /** OPTIONAL: the Dreadnought and Fortress zones (MapHeavyZones). */
  heavyZones?: {
    juggernaut: { x: number; y: number; radius: number; layer?: number };
    fortress: { x: number; y: number; radius: number; layer?: number };
    pollPeriod: number;
    terminals?: number[];
  };
  /** OPTIONAL: the Fortress spawner's position; absent -> the air console. */
  fortressSpawn?: number[] | { x: number; y: number; layer?: number };
  /** OPTIONAL: the tank and jet spawners' positions; absent -> the consoles. */
  tankSpawn?: number[] | { x: number; y: number; layer?: number };
  jetSpawn?: number[] | { x: number; y: number; layer?: number };
  /** OPTIONAL: the base's queue periods in engine ticks (MapQueuePeriods). */
  queuePeriod?: { tank: number; jet: number };
  /** OPTIONAL: the jet and Fortress spawners' flight blocks (MapBase.jetFlight). */
  jetFlight?: FlightJson;
  fortressFlight?: FlightJson;
}

/** An aircraft record's flight block in a map JSON (balance.ts AircraftFlight). */
interface FlightJson {
  altMin: number;
  altCruise: number;
  altMax: number;
  halfY: number;
  spawn: number;
}

function fail(id: string, reason: string): never {
  throw new Error(`invalid map "${id}": ${reason}`);
}

/** Parses + validates a map JSON. Throws with a precise reason if malformed. */
/** Mp's radii, for an arena that imports none (balance.ts ARCHETYPE_RADIUS). */
function defaultRadii(spots: number): MapRadii {
  return {
    walker: ARCHETYPE_RADIUS[ARCHETYPE.AVATAR],
    hover: AVATAR_HOVER_RADIUS,
    tank: ARCHETYPE_RADIUS[ARCHETYPE.RUNNER],
    jet: ARCHETYPE_RADIUS[ARCHETYPE.GUARDIAN],
    fortress: ARCHETYPE_RADIUS[ARCHETYPE.FORTRESS],
    dreadnought: ARCHETYPE_RADIUS[ARCHETYPE.JUGGERNAUT],
    dreadnoughtByFrame: [],
    baseTurret: ARCHETYPE_RADIUS[ARCHETYPE.TURRET],
    neutral: new Array<number>(spots).fill(NEUTRAL_TURRET_RADIUS),
    skyCaptain: SKY_RADIUS,
  };
}

/** The arena's radii, strictly: every one a positive finite number, the lists their lengths. */
function parseRadii(raw: MapJson["radii"], spots: number, id: string): MapRadii {
  if (raw === undefined) return defaultRadii(spots);
  const r = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      fail(id, `radii ${what} is not a positive number (got ${String(v)})`);
    }
    return v;
  };
  const list = (v: unknown, n: number, what: string): number[] => {
    if (!Array.isArray(v) || v.length !== n) fail(id, `radii ${what} needs ${n} entries`);
    return v.map((x, i) => r(x, `${what}[${i}]`));
  };
  return {
    walker: r(raw.walker, "walker"),
    hover: r(raw.hover, "hover"),
    tank: r(raw.tank, "tank"),
    jet: r(raw.jet, "jet"),
    fortress: r(raw.fortress, "fortress"),
    dreadnought: r(raw.dreadnought, "dreadnought"),
    dreadnoughtByFrame:
      raw.dreadnoughtByFrame === undefined
        ? []
        : list(raw.dreadnoughtByFrame, raw.dreadnoughtByFrame.length, "dreadnoughtByFrame"),
    baseTurret: r(raw.baseTurret, "baseTurret"),
    neutral: list(raw.neutral, spots, "neutral"),
    skyCaptain: list(raw.skyCaptain, 10, "skyCaptain"),
  };
}

/** Every role's reference height where the arena imports none: Metropolis' muzzle height. */
function defaultRefHeights(spots: number): MapRadii {
  return {
    walker: MUZZLE_HEIGHT,
    hover: MUZZLE_HEIGHT,
    tank: MUZZLE_HEIGHT,
    jet: MUZZLE_HEIGHT,
    fortress: MUZZLE_HEIGHT,
    dreadnought: MUZZLE_HEIGHT,
    dreadnoughtByFrame: [],
    baseTurret: MUZZLE_HEIGHT,
    neutral: new Array<number>(spots).fill(MUZZLE_HEIGHT),
    skyCaptain: new Array<number>(10).fill(MUZZLE_HEIGHT),
  };
}

/** The arena's reference heights: finite numbers (a box can sit below its origin), the radii's lengths. */
function parseRefHeights(raw: MapJson["refHeights"], radii: MapRadii, id: string): MapRadii {
  if (raw === undefined) return defaultRefHeights(radii.neutral.length);
  const r = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(id, `refHeights ${what} is not a number (got ${String(v)})`);
    }
    return v;
  };
  const list = (v: unknown, n: number, what: string): number[] => {
    if (!Array.isArray(v) || v.length !== n) fail(id, `refHeights ${what} needs ${n} entries`);
    return v.map((x, i) => r(x, `${what}[${i}]`));
  };
  return {
    walker: r(raw.walker, "walker"),
    hover: r(raw.hover, "hover"),
    tank: r(raw.tank, "tank"),
    jet: r(raw.jet, "jet"),
    fortress: r(raw.fortress, "fortress"),
    dreadnought: r(raw.dreadnought, "dreadnought"),
    dreadnoughtByFrame: list(
      raw.dreadnoughtByFrame ?? [],
      radii.dreadnoughtByFrame.length,
      "dreadnoughtByFrame",
    ),
    baseTurret: r(raw.baseTurret, "baseTurret"),
    neutral: list(raw.neutral, radii.neutral.length, "neutral"),
    skyCaptain: list(raw.skyCaptain, 10, "skyCaptain"),
  };
}

/** Metropolis' stand-in gun where the arena imports none: on the ground, the muzzle ahead and up. */
const DEFAULT_TURRET_GUN: MapTurretGun = { stand: 0, mx: 0, my: MUZZLE_HEIGHT, mz: MUZZLE_OFFSET };

function defaultTurretGuns(spots: number): MapTurretGuns {
  return {
    baseTurret: DEFAULT_TURRET_GUN,
    neutral: new Array<MapTurretGun>(spots).fill(DEFAULT_TURRET_GUN),
  };
}

/** The arena's turret guns: finite numbers, a neutral per turret spot. */
function parseTurretGuns(raw: MapJson["turretGuns"], spots: number, id: string): MapTurretGuns {
  if (raw === undefined) return defaultTurretGuns(spots);
  const gun = (v: { stand: number; muzzle: number[] } | undefined, what: string): MapTurretGun => {
    const m = v?.muzzle;
    if (
      v === undefined ||
      typeof v.stand !== "number" ||
      !Number.isFinite(v.stand) ||
      !Array.isArray(m) ||
      m.length !== 3 ||
      !m.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      fail(id, `turretGuns ${what} needs a finite stand and a 3-number muzzle`);
    }
    return { stand: v.stand, mx: m[0], my: m[1], mz: m[2] };
  };
  if (!Array.isArray(raw.neutral) || raw.neutral.length !== spots) {
    fail(id, `turretGuns neutral needs ${spots} entries`);
  }
  return {
    baseTurret: gun(raw.baseTurret, "baseTurret"),
    neutral: raw.neutral.map((v, i) => gun(v, `neutral[${i}]`)),
  };
}

/** No hit boxes at all: every body and round meets at Metropolis' flat circle. */
export function noShapes(): MapShapes {
  return {
    tables: [],
    tank: null,
    jet: null,
    fortress: null,
    dreadnought: -1,
    dreadnoughtGuns: [],
    baseTurret: null,
    neutral: [],
    skyCaptain: [],
    worldRounds: new Int16Array(SHAPE_ROUND_SLOTS).fill(-1),
    playerRounds: new Int16Array(SHAPE_ROUND_SLOTS).fill(-1),
  };
}

/** Raw halfwords (1/512 m) a metre: the models' unit. */
const SHAPE_RAW_PER_METRE = 512;

/** The arena's hit boxes, strictly (MapShapes): every index in range, every table whole. */
function parseShapes(raw: MapJson["shapes"], id: string): MapShapes {
  if (raw === undefined) return noShapes();
  if (!Array.isArray(raw.tables)) fail(id, "shapes.tables is not an array");
  const tables = raw.tables.map((t, k): MapShapeTable => {
    const what = `shapes table ${k}`;
    if (!Number.isInteger(t?.perFrame) || t.perFrame < 1) fail(id, `${what} bad perFrame`);
    if (!Number.isInteger(t.frames) || t.frames < 1) fail(id, `${what} bad frames`);
    if (!Array.isArray(t.boxes) || t.boxes.length !== t.perFrame * t.frames) {
      fail(id, `${what} needs ${t.perFrame * t.frames} boxes`);
    }
    const boxes = new Float64Array(t.boxes.length * SHAPE_WORDS);
    t.boxes.forEach((b, i) => {
      if (!Array.isArray(b) || b.length !== SHAPE_WORDS) fail(id, `${what} box ${i} not 8 words`);
      for (let w = 0; w < SHAPE_WORDS; w++) {
        if (!Number.isInteger(b[w])) fail(id, `${what} box ${i} word ${w} not an integer`);
        boxes[i * SHAPE_WORDS + w] = b[w] / SHAPE_RAW_PER_METRE;
      }
    });
    return { perFrame: t.perFrame, frames: t.frames, boxes };
  });
  const at = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= tables.length) {
      fail(id, `shapes ${what}: ${String(v)} out of range`);
    }
    return v;
  };
  const turret = (t: { gun: number; base: number; point: number[] }, what: string) => {
    if (!t || !Array.isArray(t.point) || t.point.length !== 3) fail(id, `shapes ${what} bad`);
    for (const v of t.point) {
      if (typeof v !== "number" || !Number.isFinite(v)) fail(id, `shapes ${what} bad point`);
    }
    // The point is a glb's (x negated); the tables are the model's own axes.
    return {
      gun: at(t.gun, `${what} gun`),
      base: at(t.base, `${what} base`),
      px: -t.point[0],
      py: t.point[1],
      pz: t.point[2],
    };
  };
  const unit = (
    u: { table: number; lift: number[]; muzzle?: number[] },
    what: string,
  ): MapUnitShape => {
    if (!u || !Array.isArray(u.lift) || u.lift.length !== 3) fail(id, `shapes ${what} bad`);
    for (const v of u.lift) {
      if (typeof v !== "number" || !Number.isFinite(v)) fail(id, `shapes ${what} bad lift`);
    }
    const m = u.muzzle;
    if (m !== undefined) {
      if (!Array.isArray(m) || m.length !== 3) fail(id, `shapes ${what} bad muzzle`);
      for (const v of m) {
        if (typeof v !== "number" || !Number.isFinite(v)) fail(id, `shapes ${what} bad muzzle`);
      }
    }
    return {
      table: at(u.table, what),
      lx: u.lift[0],
      ly: u.lift[1],
      lz: u.lift[2],
      muzzle: m === undefined ? null : [m[0], m[1], m[2]],
    };
  };
  const rounds = (r: Record<string, number>, what: string): Int16Array => {
    const out = new Int16Array(SHAPE_ROUND_SLOTS).fill(-1);
    if (!r || typeof r !== "object") fail(id, `shapes ${what} is not an object`);
    // Read in key order 0..63, never the object's insertion order.
    for (let k = 0; k < SHAPE_ROUND_SLOTS; k++) {
      const v = r[String(k)];
      if (v !== undefined) out[k] = at(v, `${what} ${k}`);
    }
    for (const key of Object.keys(r)) {
      const k = Number(key);
      if (!Number.isInteger(k) || k < 0 || k >= SHAPE_ROUND_SLOTS)
        fail(id, `shapes ${what} key ${key}`);
    }
    return out;
  };
  if (!Array.isArray(raw.dreadnoughtGuns) || !Array.isArray(raw.neutral)) {
    fail(id, "shapes lists are not arrays");
  }
  if (!Array.isArray(raw.skyCaptain) || raw.skyCaptain.length !== 10) {
    fail(id, "shapes.skyCaptain needs 10 levels");
  }
  return {
    tables,
    tank: unit(raw.tank, "tank"),
    jet: unit(raw.jet, "jet"),
    fortress: unit(raw.fortress, "fortress"),
    dreadnought: at(raw.dreadnought, "dreadnought"),
    dreadnoughtGuns: raw.dreadnoughtGuns.map((v, i) => at(v, `dreadnoughtGuns ${i}`)),
    baseTurret: turret(raw.baseTurret, "baseTurret"),
    neutral: raw.neutral.map((t, i) => turret(t, `neutral ${i}`)),
    skyCaptain: raw.skyCaptain.map((v, i) => unit(v, `skyCaptain ${i}`)),
    worldRounds: rounds(raw.worldRounds, "worldRounds"),
    playerRounds: rounds(raw.playerRounds, "playerRounds"),
  };
}

export function loadMapFromJson(raw: MapJson): MapData {
  const { id, size, cellSize } = raw;
  if (!id || typeof id !== "string") fail("?", "missing id");
  if (!Number.isInteger(size) || size < 2 || size > 1024) fail(id, `bad size ${size}`);
  if (!(cellSize > 0)) fail(id, `bad cellSize ${cellSize}`);
  if (typeof raw.waterLevel !== "number") fail(id, "missing waterLevel");
  if (raw.heights.length !== size) fail(id, `expected ${size} height rows`);
  if (raw.water.length !== size) fail(id, `expected ${size} water rows`);

  const heights = new Float32Array(size * size);
  const waterMask = new Uint8Array(size * size);
  const waterHeights = new Float32Array(size * size);
  const levels = raw.waterLevels ?? [raw.waterLevel];
  if (levels.length < 1 || levels.length > 9) fail(id, `waterLevels needs 1..9 entries`);
  for (const l of levels) if (typeof l !== "number") fail(id, `bad water level ${l}`);
  for (let j = 0; j < size; j++) {
    const hRow = raw.heights[j];
    const wRow = raw.water[j];
    if (hRow.length !== size) fail(id, `height row ${j} has ${hRow.length} entries`);
    if (wRow.length !== size) fail(id, `water row ${j} has ${wRow.length} chars`);
    for (let i = 0; i < size; i++) {
      const q = hRow[i];
      if (!Number.isInteger(q)) fail(id, `non-integer height at (${i}, ${j})`);
      heights[j * size + i] = q * HEIGHT_SCALE;
      const w = wRow.charCodeAt(i) - 0x30;
      if (w < 0 || w > levels.length) fail(id, `water row ${j} has a bad char at ${i}`);
      if (w > 0) {
        waterMask[j * size + i] = 1;
        waterHeights[j * size + i] = levels[w - 1];
      }
    }
  }

  // Walls are optional but must come as a pair; a lone array is authoring rot.
  if ((raw.wallsV === undefined) !== (raw.wallsH === undefined)) {
    fail(id, "wallsV and wallsH must both be present or both be absent");
  }
  const parseWalls = (rows: string[], what: string): Uint8Array => {
    if (rows.length !== size) fail(id, `expected ${size} ${what} rows`);
    const bits = new Uint8Array(size * size);
    for (let j = 0; j < size; j++) {
      const row = rows[j];
      if (row.length !== size) fail(id, `${what} row ${j} has ${row.length} chars`);
      for (let i = 0; i < size; i++) {
        const c = row.charCodeAt(i);
        if (c !== 0x30 && c !== 0x31) fail(id, `${what} row ${j} has non-0/1 char at ${i}`);
        bits[j * size + i] = c - 0x30;
      }
    }
    return bits;
  };
  const wallsV = raw.wallsV ? parseWalls(raw.wallsV, "wallsV") : new Uint8Array(0);
  const wallsH = raw.wallsH ? parseWalls(raw.wallsH, "wallsH") : new Uint8Array(0);

  // Optional extra decks: each a full size×size heightfield (1/32 m ints) +
  // a present mask. Absent → single-story (empty arrays → resolveHeight no-op).
  const layerHeights: Float32Array[] = [];
  const layerMask: Uint8Array[] = [];
  const layerWallsV: Uint8Array[] = [];
  const layerWallsH: Uint8Array[] = [];
  let anyLayerWalls = false;
  if (raw.layers) {
    for (let L = 0; L < raw.layers.length; L++) {
      const layer = raw.layers[L];
      if (!layer || !Array.isArray(layer.heights) || !Array.isArray(layer.mask)) {
        fail(id, `layer ${L} needs heights[] and mask[]`);
      }
      if (layer.heights.length !== size) fail(id, `layer ${L} expected ${size} height rows`);
      if (layer.mask.length !== size) fail(id, `layer ${L} expected ${size} mask rows`);
      const lh = new Float32Array(size * size);
      const lm = new Uint8Array(size * size);
      for (let j = 0; j < size; j++) {
        const hRow = layer.heights[j];
        const mRow = layer.mask[j];
        if (hRow.length !== size) fail(id, `layer ${L} height row ${j} has ${hRow.length} entries`);
        if (mRow.length !== size) fail(id, `layer ${L} mask row ${j} has ${mRow.length} chars`);
        for (let i = 0; i < size; i++) {
          const q = hRow[i];
          if (!Number.isInteger(q)) fail(id, `layer ${L} non-integer height at (${i}, ${j})`);
          lh[j * size + i] = q * HEIGHT_SCALE;
          const c = mRow.charCodeAt(i);
          if (c !== 0x30 && c !== 0x31)
            fail(id, `layer ${L} mask row ${j} has non-0/1 char at ${i}`);
          lm[j * size + i] = c - 0x30;
        }
      }
      layerHeights.push(lh);
      layerMask.push(lm);

      // Per-deck walls, on the same both-or-neither rule as the top-level pair.
      // A deck without its own lattice inherits layer 0's, so a partially
      // annotated map degrades to the old shared-lattice behaviour instead of
      // silently losing a deck's collision.
      if ((layer.wallsV === undefined) !== (layer.wallsH === undefined)) {
        fail(id, `layer ${L} wallsV and wallsH must both be present or both be absent`);
      }
      if (layer.wallsV && layer.wallsH) {
        layerWallsV.push(parseWalls(layer.wallsV, `layer ${L} wallsV`));
        layerWallsH.push(parseWalls(layer.wallsH, `layer ${L} wallsH`));
        anyLayerWalls = true;
      } else {
        layerWallsV.push(wallsV);
        layerWallsH.push(wallsH);
      }
    }
  }
  // No deck brought its own walls → drop the arrays entirely so the collision
  // helpers take their length-0 fast path and stay bit-identical.
  if (!anyLayerWalls) {
    layerWallsV.length = 0;
    layerWallsH.length = 0;
  }

  const extent = (size - 1) * cellSize;
  const inBounds = (x: number, y: number) => x >= 0 && x <= extent && y >= 0 && y <= extent;
  /** Highest legal layer index: 0 = ground, layerHeights.length = top deck. */
  const maxLayer = layerHeights.length;
  const layerOf = (v: unknown, what: string): number => {
    if (v === undefined || v === null) return 0;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > maxLayer) {
      fail(id, `${what} layer ${String(v)} out of range (0..${maxLayer})`);
    }
    return v as number;
  };
  if (raw.spawns.length !== 2) fail(id, "need exactly 2 spawns");
  if (raw.basePlots.length !== 2) fail(id, "need exactly 2 base plots");
  for (const s of raw.spawns) {
    if (!inBounds(s.x, s.y)) fail(id, `spawn out of bounds (${s.x}, ${s.y})`);
    if (s.hover !== undefined && typeof s.hover !== "boolean") {
      fail(id, `spawn hover must be a boolean, got ${String(s.hover)}`);
    }
  }
  /**
   * A map point: either the historic `[x, y]` pair (layer 0) or an object
   * `{x, y, layer?}`. Object form is what issue #33 needs for deck features.
   */
  const point = (p: unknown, what: string): MapPoint => {
    if (Array.isArray(p)) {
      if (p.length !== 2) fail(id, `${what} is not an [x, y] pair`);
      const [x, y] = p;
      if (typeof x !== "number" || typeof y !== "number") {
        fail(id, `${what} is not an [x, y] pair`);
      }
      if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
      return { x, y, layer: 0 };
    }
    if (!p || typeof p !== "object") fail(id, `${what} is not a point`);
    const o = p as { x?: unknown; y?: unknown; layer?: unknown };
    if (typeof o.x !== "number" || typeof o.y !== "number") {
      fail(id, `${what} is not an {x, y} point`);
    }
    if (!inBounds(o.x, o.y)) fail(id, `${what} out of bounds (${o.x}, ${o.y})`);
    return { x: o.x, y: o.y, layer: layerOf(o.layer, what) };
  };
  for (const lane of raw.lanes) {
    if (lane.length < 2) fail(id, "lane with fewer than 2 waypoints");
  }
  const points = (list: unknown[], what: string): MapPoint[] =>
    list.map((p, i) => point(p, `${what} ${i}`));
  const buyBox = (b: { halfW: number; halfL: number } | undefined, what: string): MapBuyBox => {
    if (b === undefined) return { halfW: ORIGINAL_BUY_HALF_W, halfL: ORIGINAL_BUY_HALF_L };
    if (!b || typeof b !== "object") fail(id, `${what} is not a {halfW, halfL} box`);
    const halfW = num(b.halfW, `${what} halfW`);
    const halfL = num(b.halfL, `${what} halfL`);
    if (!(halfW > 0) || !(halfL > 0)) fail(id, `${what} needs positive half extents`);
    return { halfW, halfL };
  };

  const plot = (
    p: { x: number; y: number; radius: number; layer?: number },
    what: string,
  ): MapPlot => {
    if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !(p.radius > 0)) {
      fail(id, `${what} is not an {x, y, radius} plot`);
    }
    if (!inBounds(p.x, p.y)) fail(id, `${what} out of bounds (${p.x}, ${p.y})`);
    return { x: p.x, y: p.y, radius: p.radius, layer: layerOf(p.layer, what) };
  };
  /**
   * Asserts a field really is a finite number before it reaches MapData.
   *
   * `point` and `plot` have always checked `typeof === "number"`, but the §9
   * parsers below grew up comparing raw fields directly — `inBounds(v.x, v.y)`,
   * `d.hp > 0`, `w.range > 0` — and JS coercion lets `{ x: "10", hp: "500" }`
   * through every one of those, storing strings in a struct the sim then does
   * arithmetic on. Routing the loose fields through here makes the whole loader
   * uniformly strict, which is the job it advertises in its own doc comment.
   */
  const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(id, `${what} is not a finite number (got ${typeof v} ${String(v)})`);
    }
    return v;
  };
  // --- Precinct Assault features (rules.md §9) ----------------------------
  // All optional. Absent → empty arrays / undefined / 0, which every consumer
  // treats as "feature not present on this arena".
  // An arena that imports no profiles (district-01, the test maps) gets the
  // original's own (balance.ts ORIGINAL_WEAPON_PROFILES, in the imported arenas'
  // order): every turret and unit on every arena is the original's
  // (fcop-fidelity.md W3, owner's call 2026-10-12).
  const shapes = parseShapes(raw.shapes, id);
  const shapeIndex = (v: number | undefined, what: string): number => {
    if (v === undefined) return -1;
    if (!Number.isInteger(v) || v < -1 || v >= shapes.tables.length) {
      fail(id, `${what}: shape ${v} out of range (${shapes.tables.length} tables)`);
    }
    return v;
  };
  const weapons: MapWeapon[] = (raw.weapons ?? []).map((w, k) => {
    if (!w || typeof w !== "object") fail(id, `weapon ${k} is not an object`);
    const range = num(w.range, `weapon ${k} range`);
    const damage = num(w.damage, `weapon ${k} damage`);
    const turnSpeed = num(w.turnSpeed, `weapon ${k} turnSpeed`);
    const fovCos = num(w.fovCos, `weapon ${k} fovCos`);
    if (!(range > 0)) fail(id, `weapon ${k} bad range ${range}`);
    if (!Number.isInteger(w.delay) || w.delay < 1) fail(id, `weapon ${k} bad delay ${w.delay}`);
    if (!(damage >= 0)) fail(id, `weapon ${k} bad damage ${damage}`);
    if (!(turnSpeed >= 0)) fail(id, `weapon ${k} bad turnSpeed ${turnSpeed}`);
    if (!(fovCos >= -1 && fovCos <= 1)) fail(id, `weapon ${k} bad fovCos ${fovCos}`);
    const opt = (v: number | undefined, what: string, dflt: number): number =>
      v === undefined ? dflt : num(v, `weapon ${k} ${what}`);
    const refireUnits = opt(w.refireUnits, "refireUnits", 0);
    const searchUnits = opt(w.searchUnits, "searchUnits", 0);
    const speed = opt(w.speed, "speed", 0);
    const flight = opt(w.flight, "flight", 0);
    const arcCos = opt(w.arcCos, "arcCos", -1);
    if (!(refireUnits >= 0) || !(searchUnits >= 0) || !(speed >= 0) || !(flight >= 0)) {
      fail(id, `weapon ${k} has a negative refire, search, speed or flight`);
    }
    if (!(arcCos >= -1 && arcCos <= 1)) fail(id, `weapon ${k} bad arcCos ${arcCos}`);
    if (speed > 0 && !(flight > 0)) fail(id, `weapon ${k} fires rounds with no flight range`);
    return {
      range,
      delay: w.delay,
      damage,
      turnSpeed,
      fovCos,
      refireUnits,
      searchUnits,
      speed,
      flight,
      guided: opt(w.guided, "guided", 0) ? 1 : 0,
      lead: opt(w.lead, "lead", 0) ? 1 : 0,
      arcCos,
      hold: opt(w.hold, "hold", 0) ? 1 : 0,
      priority: opt(w.priority, "priority", 0) ? 1 : 0,
      round: shapeIndex(w.round, `weapon ${k} round`),
    };
  });
  // An index the map names itself refers to its own profiles, never to the
  // defaults appended after them.
  const ownProfiles = weapons.length;
  const weaponIndex = (v: number, what: string): number => {
    if (!Number.isInteger(v) || v < 0 || v >= ownProfiles) {
      fail(id, `${what} weapon index ${v} out of range (${ownProfiles} profiles)`);
    }
    return v;
  };
  // The original's own profiles, appended the first time a feature without its
  // own record needs one (on a map with no weapons of its own they ARE the table,
  // in the imported arenas' order; balance.ts PROFILE_*).
  let defaultsAt = -1;
  const original = (k: number): number => {
    if (defaultsAt < 0) {
      defaultsAt = weapons.length;
      for (const w of ORIGINAL_WEAPON_PROFILES) weapons.push({ ...w });
    }
    return defaultsAt + k;
  };

  const unitProfile = (
    u: { hp: number; weapon: number } | undefined,
    what: string,
    dflt: { hp: number; weapon: number },
  ): MapUnitProfile => {
    if (u === undefined) return { hp: dflt.hp, weapon: original(dflt.weapon) };
    if (!u || typeof u !== "object") fail(id, `${what} is not an object`);
    if (!Number.isInteger(u.hp) || u.hp < 1) fail(id, `${what} bad hp ${u.hp}`);
    return { hp: u.hp, weapon: weaponIndex(u.weapon, what) };
  };

  /** A turret record in its object form: the ring's, and an outpost plate's. */
  const turretObject = (
    t: { x: number; y: number; weapon: number; hp: number; yaw: number; layer?: number },
    what: string,
  ): MapBaseTurret => {
    const x = num(t.x, `${what} x`);
    const y = num(t.y, `${what} y`);
    const hp = num(t.hp, `${what} hp`);
    const yaw = num(t.yaw, `${what} yaw`);
    if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
    if (!(hp > 0)) fail(id, `${what} bad hp ${hp}`);
    return {
      x,
      y,
      weapon: weaponIndex(t.weapon, what),
      hp,
      yaw,
      layer: layerOf(t.layer, what),
    };
  };

  if (!Array.isArray(raw.bases) || raw.bases.length !== 2) fail(id, "need exactly 2 bases");
  const queuePeriodOf = (q: { tank: number; jet: number } | undefined, what: string) => {
    if (q === undefined)
      return { tank: ORIGINAL_TANK_QUEUE_PERIOD, jet: ORIGINAL_JET_QUEUE_PERIOD };
    if (!Number.isInteger(q.tank) || q.tank < 1 || !Number.isInteger(q.jet) || q.jet < 1) {
      fail(id, `${what} need positive integer periods`);
    }
    return { tank: q.tank, jet: q.jet };
  };
  const bases: MapBase[] = raw.bases.map((b, team) => {
    if (!b || typeof b !== "object") fail(id, `base ${team} is not an object`);
    if (!Array.isArray(b.turrets)) fail(id, `base ${team} turrets is not a list`);
    // 16, not 8: the original Mp places 16 base-defence Turret actors per base
    // (fcop-logic.md §8.2). The cap still exists to catch authoring runaway.
    if (b.turrets.length > 16) {
      fail(id, `base ${team} has ${b.turrets.length} ring turrets (max 16)`);
    }
    // The core-HP / free-production / built-in-gun fields of the retired §9 model
    // (SIM_VERSION 32). A map still carrying them was authored for rules the sim
    // no longer has; refuse it rather than silently ignore what it asks for.
    const legacy = b as { coreHp?: unknown; productionTicks?: unknown; defence?: unknown };
    if (legacy.coreHp !== undefined || legacy.productionTicks !== undefined) {
      fail(
        id,
        `base ${team} carries coreHp/productionTicks: the original has no core (rules.md §9)`,
      );
    }
    if (legacy.defence !== undefined) {
      fail(id, `base ${team} carries built-in defence guns: they were the Dreadnought's hull guns`);
    }
    let juggernaut: MapJuggernaut;
    if (b.juggernaut === undefined) {
      // No Dreadnought record: the original's Dreadnought rolls out at the ground
      // console it is bought from (district-01, the test maps).
      const gc = point(b.groundConsole, `base ${team} ground console`);
      const d = ORIGINAL_UNIT_PROFILES.juggernaut;
      juggernaut = {
        x: gc.x,
        y: gc.y,
        layer: gc.layer,
        hp: d.hp,
        guns: d.guns,
        weapon: original(d.weapon),
        mounts: DREADNOUGHT_MOUNTS,
        gunTurn: DREADNOUGHT_GUN_TURN,
        walk: undefined,
      };
    } else {
      const j = b.juggernaut;
      const what = `base ${team} juggernaut`;
      if (!j || typeof j !== "object") fail(id, `${what} is not an object`);
      const x = num(j.x, `${what} x`);
      const y = num(j.y, `${what} y`);
      if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
      if (!Number.isInteger(j.hp) || j.hp < 1) fail(id, `${what} bad hp ${j.hp}`);
      if (!Number.isInteger(j.guns) || j.guns < 1 || j.guns > DREADNOUGHT_GUNS) {
        fail(id, `${what} bad guns ${j.guns}`);
      }
      let walk: MapHullWalk | undefined;
      if (j.walk !== undefined) {
        const w = j.walk;
        const int = (v: unknown, f: string) => {
          if (!Number.isInteger(v)) fail(id, `${what} walk ${f} is not an integer`);
          return v as number;
        };
        walk = {
          from: int(w.from, "from"),
          to: int(w.to, "to"),
          mode: int(w.mode, "mode"),
          end: int(w.end, "end"),
          link: int(w.link, "link"),
          linkB: int(w.linkB, "linkB"),
          linkC: int(w.linkC, "linkC"),
          flags: int(w.flags, "flags"),
          period: int(w.period, "period"),
          event: int(w.event, "event"),
        };
        // One closed track: its links are itself, and it steps.
        if (walk.link !== 0 || walk.linkB !== 0 || walk.linkC !== 0) {
          fail(id, `${what} walk links another track`);
        }
        if (walk.period < 1 || walk.from < 0 || walk.to < walk.from) {
          fail(id, `${what} walk bad frames or period`);
        }
      }
      const frameCount = walk ? walk.to + 1 : 0;
      let mounts: readonly MapGunMount[] = DREADNOUGHT_MOUNTS;
      if (j.mounts !== undefined) {
        if (!Array.isArray(j.mounts)) fail(id, `${what} mounts is not an array`);
        mounts = j.mounts.map((m, i) => {
          const at = `${what} mount ${i}`;
          const x = num(m?.x, `${at} x`);
          const y = num(m?.y, `${at} y`);
          const z = num(m?.z, `${at} z`);
          const mount = {
            x,
            y,
            z,
            mx: num(m?.mx, `${at} mx`),
            my: num(m?.my, `${at} my`),
            mz: num(m?.mz, `${at} mz`),
          };
          if (m.frames === undefined) {
            if (walk) fail(id, `${at}: a walking hull's mount needs its frames`);
            return mount;
          }
          if (!walk) fail(id, `${at}: frames on a hull that does not walk`);
          if (!Array.isArray(m.frames) || m.frames.length !== frameCount) {
            fail(id, `${at}: frames not ${frameCount} long`);
          }
          const frames = m.frames.map((f, k) => {
            if (!Array.isArray(f) || f.length !== 3) fail(id, `${at} frame ${k} is not [x, y, z]`);
            return {
              x: num(f[0], `${at} frame ${k} x`),
              y: num(f[1], `${at} frame ${k} y`),
              z: num(f[2], `${at} frame ${k} z`),
            };
          });
          if (frames[0].x !== x || frames[0].y !== y || frames[0].z !== z) {
            fail(id, `${at}: frame 0 is not the mount's point`);
          }
          return { ...mount, frames };
        });
      } else if (walk) {
        fail(id, `${what}: a walking hull needs its own mounts`);
      }
      if (mounts.length !== j.guns) fail(id, `${what}: ${j.guns} guns on ${mounts.length} mounts`);
      const gunTurn = j.gunTurn ?? DREADNOUGHT_GUN_TURN;
      if (!Number.isInteger(gunTurn) || gunTurn < 1) fail(id, `${what} bad gunTurn ${gunTurn}`);
      juggernaut = {
        x,
        y,
        layer: layerOf(j.layer, what),
        hp: j.hp,
        guns: j.guns,
        weapon: weaponIndex(j.weapon, what),
        mounts,
        gunTurn,
        walk,
      };
    }
    const zone = (
      z: { x: number; y: number; radius: number; layer?: number },
      what: string,
    ): MapZone => {
      if (!z || typeof z !== "object") fail(id, `${what} is not an object`);
      const x = num(z.x, `${what} x`);
      const y = num(z.y, `${what} y`);
      if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
      const radius = num(z.radius, `${what} radius`);
      if (!(radius > 0)) fail(id, `${what} needs a positive radius`);
      return { x, y, layer: layerOf(z.layer, what), radius };
    };
    let heavyZones: MapHeavyZones | undefined;
    if (b.heavyZones !== undefined) {
      const hz = b.heavyZones;
      if (!Number.isInteger(hz.pollPeriod) || hz.pollPeriod < 1) {
        fail(id, `base ${team} heavy zones bad pollPeriod ${String(hz.pollPeriod)}`);
      }
      const terminals = hz.terminals ?? [];
      for (const t of terminals) {
        if (!Number.isInteger(t) || t < 0) fail(id, `base ${team} bad heavy terminal ${String(t)}`);
      }
      heavyZones = {
        juggernaut: zone(hz.juggernaut, `base ${team} Dreadnought zone`),
        fortress: zone(hz.fortress, `base ${team} Fortress zone`),
        pollPeriod: hz.pollPeriod,
        terminals: [...terminals],
      };
    }
    const turretRespawnTicks = b.turretRespawnTicks ?? 0;
    if (!Number.isInteger(turretRespawnTicks) || turretRespawnTicks < 0) {
      fail(id, `base ${team} bad turretRespawnTicks ${String(b.turretRespawnTicks)}`);
    }
    const g = b.gate;
    const gatePlot = plot(g, `base ${team} gate`);
    const halfW = g.halfW === undefined ? 0 : num(g.halfW, `base ${team} gate halfW`);
    const halfL = g.halfL === undefined ? 0 : num(g.halfL, `base ${team} gate halfL`);
    if (halfW < 0 || halfL < 0 || halfW > 0 !== halfL > 0) {
      fail(id, `base ${team} gate needs both half extents positive, or neither`);
    }
    return {
      gate: { ...gatePlot, halfW, halfL },
      core: point(b.core, `base ${team} core`),
      groundConsole: point(b.groundConsole, `base ${team} ground console`),
      groundBuy: buyBox(b.groundBuy, `base ${team} ground console box`),
      airConsole: point(b.airConsole, `base ${team} air console`),
      airBuy: buyBox(b.airBuy, `base ${team} air console box`),
      turrets: b.turrets.map((t, k) => {
        const what = `base ${team} ring turret ${k}`;
        // Bare pair: the pre-PA authoring form (district-01). It is the
        // original's team turret on the original's profile.
        if (Array.isArray(t)) {
          const p = point(t, what);
          return {
            x: p.x,
            y: p.y,
            weapon: original(PROFILE_TEAM_TURRET),
            hp: ORIGINAL_TURRET_HP,
            yaw: 0,
            layer: p.layer,
          };
        }
        if (!t || typeof t !== "object") fail(id, `${what} is neither a pair nor an object`);
        return turretObject(t, what);
      }),
      turretRespawnTicks,
      juggernaut,
      runner: unitProfile(b.runner, `base ${team} runner`, ORIGINAL_UNIT_PROFILES.runner),
      guardian: unitProfile(b.guardian, `base ${team} guardian`, ORIGINAL_UNIT_PROFILES.guardian),
      fortress: unitProfile(b.fortress, `base ${team} fortress`, ORIGINAL_UNIT_PROFILES.fortress),
      heavyZones,
      fortressSpawn: point(b.fortressSpawn ?? b.airConsole, `base ${team} fortress spawn`),
      tankSpawn: point(b.tankSpawn ?? b.groundConsole, `base ${team} tank spawn`),
      jetSpawn: point(b.jetSpawn ?? b.airConsole, `base ${team} jet spawn`),
      queuePeriod: queuePeriodOf(b.queuePeriod, `base ${team} queues`),
      jetFlight: flightOf(id, b.jetFlight, `base ${team} jet flight`, ORIGINAL_JET_FLIGHT),
      fortressFlight: flightOf(
        id,
        b.fortressFlight,
        `base ${team} fortress flight`,
        ORIGINAL_FORTRESS_FLIGHT,
      ),
    };
  });

  const turretSpots = points(raw.turretSpots, "turret spot");
  const perSpot = (list: number[] | undefined, what: string): number[] => {
    if (list === undefined) return [];
    if (list.length !== turretSpots.length) {
      fail(id, `${what} has ${list.length} entries for ${turretSpots.length} turret spots`);
    }
    return list;
  };
  // Without per-spot data a capture spot is the original's neutral turret.
  const turretParams =
    raw.turretParams === undefined
      ? turretSpots.map(() => original(PROFILE_NEUTRAL_TURRET))
      : perSpot(raw.turretParams, "turretParams").map((v, k) => weaponIndex(v, `turret spot ${k}`));
  const turretYaw = perSpot(raw.turretYaw, "turretYaw").map((v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(id, `turret spot ${k} bad yaw ${v}`);
    return v;
  });
  const turretHp =
    raw.turretHp === undefined
      ? turretSpots.map(() => ORIGINAL_TURRET_HP)
      : perSpot(raw.turretHp, "turretHp").map((v, k) => {
          if (!Number.isInteger(v) || v < 1) fail(id, `turret spot ${k} bad hp ${v}`);
          return v;
        });

  const outpostSpots = points(raw.outpostSpots, "outpost spot");
  const outposts: MapOutpost[] = [];
  const outpostPlates: MapOutpostPlate[] = [];
  // Every outpost is the original's: a claim zone, a tank pad and a jet pad.
  // district-01's consoles-as-a-menu went with it (fcop-fidelity.md D2).
  if (outpostSpots.length > 0 && raw.outposts === undefined) {
    fail(id, `${outpostSpots.length} outpost spots without their outposts`);
  }
  if (raw.outposts !== undefined) {
    if (!Array.isArray(raw.outposts) || raw.outposts.length !== outpostSpots.length) {
      fail(id, `outposts has ${raw.outposts?.length} entries for ${outpostSpots.length} spots`);
    }
    const plated = new Set<number>();
    raw.outposts.forEach((o, k) => {
      const what = `outpost ${k}`;
      if (!o || typeof o !== "object") fail(id, `${what} is not an object`);
      const zone = num(o.zone, `${what} zone`);
      if (!(zone > 0)) fail(id, `${what} bad zone ${zone}`);
      const tankPad = point(o.tankPad, `${what} tank pad`);
      const jetPad = point(o.jetPad, `${what} jet pad`);
      const perTeam = <T>(list: T[] | undefined, what2: string): (T | undefined)[] => {
        if (list === undefined) return [undefined, undefined];
        if (!Array.isArray(list) || list.length !== 2)
          fail(id, `${what} ${what2} needs one per team`);
        return list;
      };
      outposts.push({
        zone,
        tankPad,
        jetPad,
        tankSpawn: perTeam(o.tankSpawn, "tankSpawn").map((p, t) =>
          p === undefined ? tankPad : point(p, `${what} team ${t} tank spawn`),
        ),
        jetSpawn: perTeam(o.jetSpawn, "jetSpawn").map((p, t) =>
          p === undefined ? jetPad : point(p, `${what} team ${t} jet spawn`),
        ),
        queuePeriod: perTeam(o.queuePeriod, "queuePeriod").map((q, t) =>
          queuePeriodOf(q, `${what} team ${t} queues`),
        ),
        jetFlight: perTeam(o.jetFlight, "jetFlight").map((f, t) =>
          flightOf(id, f, `${what} team ${t} jet flight`, ORIGINAL_JET_FLIGHT),
        ),
      });
      if (!Array.isArray(o.plates)) fail(id, `${what} plates is not a list`);
      o.plates.forEach((pl, j) => {
        const pw = `${what} plate ${j}`;
        if (!Number.isInteger(pl.spot) || pl.spot < 0 || pl.spot >= turretSpots.length) {
          fail(id, `${pw} names turret spot ${pl.spot} of ${turretSpots.length}`);
        }
        if (plated.has(pl.spot)) fail(id, `${pw}: turret spot ${pl.spot} is on two plates`);
        plated.add(pl.spot);
        if (!Array.isArray(pl.turrets) || pl.turrets.length !== 2) {
          fail(id, `${pw} needs one turret per team`);
        }
        outpostPlates.push({
          outpost: k,
          spot: pl.spot,
          turrets: pl.turrets.map((t, team) => turretObject(t, `${pw} team ${team} turret`)),
        });
      });
    });
  }

  // Without one, the original's 4.0 m (Mp/Conft/Ovmp; ORIGINAL_CAPTURE_RANGE).
  const radii = parseRadii(raw.radii, turretSpots.length, id);
  if (shapes.neutral.length > 0 && shapes.neutral.length !== turretSpots.length) {
    fail(id, `shapes: ${shapes.neutral.length} neutral turrets for ${turretSpots.length} spots`);
  }
  // A walking hull's radii, where the arena imports them, cover its walk's
  // frames, frame 0 its own radius (without them it keeps frame 0's); a static
  // hull has none.
  const byFrame = radii.dreadnoughtByFrame.length;
  for (const b of bases) {
    const walk = b.juggernaut.walk;
    if (byFrame === 0) continue;
    if (walk === undefined) fail(id, "radii dreadnoughtByFrame on a hull that does not walk");
    if (byFrame !== walk.to + 1) fail(id, `radii dreadnoughtByFrame not ${walk.to + 1} long`);
    if (radii.dreadnoughtByFrame[0] !== radii.dreadnought) {
      fail(id, "radii dreadnoughtByFrame[0] is not the hull's radius");
    }
  }
  const captureRange = raw.captureRange ?? ORIGINAL_CAPTURE_RANGE;
  if (!Number.isFinite(captureRange) || captureRange <= 0) {
    fail(id, `bad captureRange ${raw.captureRange}`);
  }

  let laneGraph: MapLaneGraph | undefined;
  if (raw.laneGraph) {
    const g = raw.laneGraph;
    if (!Array.isArray(g.nodes) || g.nodes.length < 2) fail(id, "laneGraph needs >= 2 nodes");
    const n = g.nodes.length;
    if (n > 0x7fff) fail(id, `laneGraph has ${n} nodes (max 32767)`);
    const nodes = g.nodes.map((p) => point(p, "laneGraph node"));
    if (!Array.isArray(g.edges) || g.edges.length !== n) {
      fail(id, `laneGraph edges has ${g.edges?.length} rows for ${n} nodes`);
    }
    const edges = new Int16Array(n * 4);
    for (let k = 0; k < n; k++) {
      const row = g.edges[k];
      if (!Array.isArray(row) || row.length !== 4) {
        fail(id, `laneGraph edges row ${k} is not a 4-tuple`);
      }
      for (let s = 0; s < 4; s++) {
        const v = row[s];
        if (!Number.isInteger(v) || v < -1 || v >= n) {
          fail(id, `laneGraph edge ${k}.${s} target ${v} out of range`);
        }
        if (v === k) fail(id, `laneGraph node ${k} links to itself`);
        edges[k * 4 + s] = v;
      }
    }
    if (!Array.isArray(g.entry) || g.entry.length !== 2) fail(id, "laneGraph needs 2 entry nodes");
    for (const e of g.entry) {
      if (!Number.isInteger(e) || e < 0 || e >= n) fail(id, `laneGraph entry ${e} out of range`);
    }
    const hops = (rows: number[][], what: string): Int16Array => {
      if (!Array.isArray(rows) || rows.length !== 2) fail(id, `laneGraph ${what} needs 2 rows`);
      const out = new Int16Array(2 * n);
      for (let team = 0; team < 2; team++) {
        const row = rows[team];
        if (!Array.isArray(row) || row.length !== n) {
          fail(id, `laneGraph ${what} row ${team} has ${row?.length} entries for ${n} nodes`);
        }
        for (let k = 0; k < n; k++) {
          const v = row[k];
          if (!Number.isInteger(v) || v < -1 || v >= n) {
            fail(id, `laneGraph ${what}[${team}][${k}] target ${v} out of range`);
          }
          // The invariant that makes runtime traversal safe: a signpost may only
          // ever point along an edge that actually exists.
          if (v >= 0) {
            let linked = false;
            for (let s = 0; s < 4; s++) if (edges[k * 4 + s] === v) linked = true;
            if (!linked) fail(id, `laneGraph ${what}[${team}][${k}] -> ${v} is not a neighbour`);
          }
          out[team * n + k] = v;
        }
      }
      return out;
    };
    const nextHopA = hops(g.nextHopA, "nextHopA");
    const nextHopB = hops(g.nextHopB, "nextHopB");
    // Following the primary signposts must terminate, or a unit would circle
    // forever. Checked at load so the sim can walk them without a step budget.
    for (let team = 0; team < 2; team++) {
      let at = g.entry[team];
      let steps = 0;
      while (at >= 0) {
        if (steps++ > n) fail(id, `laneGraph nextHopA loops for team ${team}`);
        at = nextHopA[team * n + at];
      }
    }
    const heights = new Int16Array(n);
    if (g.heights !== undefined) {
      if (!Array.isArray(g.heights) || g.heights.length !== n) {
        fail(id, `laneGraph heights has ${g.heights?.length} entries for ${n} nodes`);
      }
      for (let k = 0; k < n; k++) {
        const h = g.heights[k];
        if (!Number.isInteger(h) || h < -0x8000 || h > 0x7fff) {
          fail(id, `laneGraph height ${k} is not a 16-bit integer (${h})`);
        }
        heights[k] = h;
      }
    }
    const closed = new Uint8Array(n);
    for (const k of g.closed ?? []) {
      if (!Number.isInteger(k) || k < 0 || k >= n)
        fail(id, `laneGraph closed node ${k} out of range`);
      closed[k] = 1;
    }
    const netStart = g.netStart ?? [0];
    if (netStart.length === 0 || netStart[0] !== 0) fail(id, "laneGraph netStart must start at 0");
    for (let k = 1; k < netStart.length; k++) {
      if (!Number.isInteger(netStart[k]) || netStart[k] <= netStart[k - 1] || netStart[k] >= n) {
        fail(id, `laneGraph netStart ${netStart[k]} out of order`);
      }
    }
    const route = (v: number[] | undefined, fallback: MapRouteParams, what: string) => {
      if (v === undefined) return fallback;
      if (!Array.isArray(v) || v.length !== 2)
        fail(id, `laneGraph ${what} route is not [flags, bias]`);
      const [flags, bias] = v;
      if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff)
        fail(id, `laneGraph ${what} route flags ${flags} are not a halfword`);
      // The port (route.ts) reaches the arms 0x8 (no traffic, no contact
      // transfer: the Dreadnought's) and 0x20 (the bank) take, and no other:
      // a record with 0x100 or 0x200 would need `cnet_route_orient`'s other
      // arms, with 0x10 the rise, and so on. No Precinct Assault record has one.
      if ((flags & ~0x28) !== 0)
        fail(id, `laneGraph ${what} route flags 0x${flags.toString(16)} take arms not modelled`);
      if (!Number.isInteger(bias) || bias < -0x8000 || bias > 0x7fff)
        fail(id, `laneGraph ${what} route bias ${bias} is not a halfword`);
      return { flags, bias };
    };
    laneGraph = {
      nodes,
      edges,
      nextHopA,
      nextHopB,
      entry: [g.entry[0], g.entry[1]],
      net: labelNets(edges, n, g.entry),
      heights,
      closed,
      netStart: [...netStart],
      runnerRoute: route(g.routes?.runner, DEFAULT_RUNNER_ROUTE, "runner"),
      juggernautRoute: route(g.routes?.juggernaut, DEFAULT_JUGGERNAUT_ROUTE, "juggernaut"),
    };
  }

  const pickups: MapPickup[] = (raw.pickups ?? []).map((p, k) => {
    if (!p || typeof p !== "object") fail(id, `pickup ${k} is not an object`);
    const x = num(p.x, `pickup ${k} x`);
    const y = num(p.y, `pickup ${k} y`);
    if (!inBounds(x, y)) fail(id, `pickup ${k} out of bounds (${x}, ${y})`);
    if (!Number.isInteger(p.kind) || p.kind < 0) fail(id, `pickup ${k} bad kind ${p.kind}`);
    if (!Number.isInteger(p.respawnTicks) || p.respawnTicks < 0) {
      fail(id, `pickup ${k} bad respawnTicks ${p.respawnTicks}`);
    }
    const half = (v: number | undefined, fallback: number, what: string): number => {
      if (v === undefined) return fallback;
      const n = num(v, `pickup ${k} ${what}`);
      if (!(n > 0)) fail(id, `pickup ${k} needs a positive ${what}`);
      return n;
    };
    return {
      x,
      y,
      kind: p.kind,
      respawnTicks: p.respawnTicks,
      layer: layerOf(p.layer, `pickup ${k}`),
      halfW: half(p.halfW, ORIGINAL_PICKUP_HALF_W, "halfW"),
      halfL: half(p.halfL, ORIGINAL_PICKUP_HALF_L, "halfL"),
      halfH: half(p.halfH, ORIGINAL_PICKUP_HALF_H, "halfH"),
      lift: p.lift === undefined ? ORIGINAL_PICKUP_LIFT : num(p.lift, `pickup ${k} lift`),
      model: p.model ?? -1,
      spin: p.spin ?? 0,
    };
  });

  const triggerVolumes: MapTriggerVolume[] = (raw.triggerVolumes ?? []).map((v, k) => {
    if (!v || typeof v !== "object") fail(id, `trigger ${k} is not an object`);
    const x = num(v.x, `trigger ${k} x`);
    const y = num(v.y, `trigger ${k} y`);
    const halfW = num(v.halfW, `trigger ${k} halfW`);
    const halfL = num(v.halfL, `trigger ${k} halfL`);
    if (!inBounds(x, y)) fail(id, `trigger ${k} out of bounds (${x}, ${y})`);
    if (!(halfW > 0) || !(halfL > 0)) fail(id, `trigger ${k} needs positive half extents`);
    if (v.team !== 0 && v.team !== 1) fail(id, `trigger ${k} bad team ${v.team}`);
    if (!Number.isInteger(v.watch) || v.watch < 0) fail(id, `trigger ${k} bad watch ${v.watch}`);
    return {
      x,
      y,
      halfW,
      halfL,
      team: v.team,
      watch: v.watch,
      layer: layerOf(v.layer, `trigger ${k}`),
    };
  });

  const floorMasks: Uint8Array[] = [];
  let modeFloors = false;
  if (raw.floors !== undefined) {
    if (raw.floors.length !== maxLayer + 1) {
      fail(id, `floors needs one mask per surface (${maxLayer + 1}), got ${raw.floors.length}`);
    }
    for (let L = 0; L < raw.floors.length; L++) {
      const rows = raw.floors[L];
      if (rows.length !== size) fail(id, `floors ${L} expected ${size} rows`);
      const mask = new Uint8Array(size * size);
      for (let j = 0; j < size; j++) {
        const row = rows[j];
        if (row.length !== size) fail(id, `floors ${L} row ${j} has ${row.length} chars`);
        for (let i = 0; i < size; i++) {
          const c = row.charCodeAt(i) - 0x30;
          if (c < 0 || c > 5) fail(id, `floors ${L} row ${j} has a bad char at ${i}`);
          if (c >= 3) modeFloors = true;
          mask[j * size + i] = c;
        }
      }
      floorMasks.push(mask);
    }
  }

  const spawnGuards: MapSpawnGuard[] = (raw.spawnGuards ?? []).map((g, k) => {
    if (!g || typeof g !== "object") fail(id, `spawn guard ${k} is not an object`);
    const x = num(g.x, `spawn guard ${k} x`);
    const y = num(g.y, `spawn guard ${k} y`);
    if (!inBounds(x, y)) fail(id, `spawn guard ${k} out of bounds (${x}, ${y})`);
    const halfW = num(g.halfW, `spawn guard ${k} halfW`);
    const halfL = num(g.halfL, `spawn guard ${k} halfL`);
    const halfH = num(g.halfH, `spawn guard ${k} halfH`);
    if (!(halfW > 0) || !(halfL > 0) || !(halfH > 0)) {
      fail(id, `spawn guard ${k} needs positive half extents`);
    }
    if (g.hurtsTeam !== 0 && g.hurtsTeam !== 1) fail(id, `spawn guard ${k} bad team`);
    if (!Number.isInteger(g.damage) || g.damage <= 0) fail(id, `spawn guard ${k} bad damage`);
    if (!Number.isInteger(g.resetPeriod) || g.resetPeriod <= 0) {
      fail(id, `spawn guard ${k} bad resetPeriod`);
    }
    return {
      x,
      y,
      halfW,
      halfL,
      halfH,
      hurtsTeam: g.hurtsTeam,
      damage: g.damage,
      resetPeriod: g.resetPeriod,
      layer: layerOf(g.layer, `spawn guard ${k}`),
    };
  });

  const lifts: MapLift[] = (raw.lifts ?? []).map((l, k) => {
    if (!l || typeof l !== "object") fail(id, `lift ${k} is not an object`);
    const what = `lift ${k}`;
    const x = num(l.x, `${what} x`);
    const y = num(l.y, `${what} y`);
    if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
    const x0 = num(l.x0, `${what} x0`);
    const x1 = num(l.x1, `${what} x1`);
    const y0 = num(l.y0, `${what} y0`);
    const y1 = num(l.y1, `${what} y1`);
    if (!(x0 <= x && x <= x1 && y0 <= y && y <= y1))
      fail(id, `${what} footprint misses its centre`);
    const ints = (v: unknown, label: string): number[] => {
      if (!Array.isArray(v)) fail(id, `${what} ${label} is not an array`);
      for (const e of v as unknown[]) {
        if (!Number.isInteger(e) || (e as number) < 0) fail(id, `${what} ${label} has a bad entry`);
      }
      return v as number[];
    };
    const stops = ints(l.stops, "stops");
    if (stops.length < 2) fail(id, `${what} needs two stops`);
    for (let i = 1; i < stops.length; i++) {
      if (stops[i] <= stops[i - 1]) fail(id, `${what} stops are not ascending`);
    }
    const dwell = ints(l.dwell, "dwell");
    const layers = ints(l.layers, "layers");
    if (dwell.length !== stops.length || layers.length !== stops.length) {
      fail(id, `${what} needs a dwell and a layer per stop`);
    }
    for (let i = 0; i < layers.length; i++) layerOf(layers[i], `${what} stop ${i}`);
    if (!Number.isInteger(l.up) || l.up <= 0 || !Number.isInteger(l.down) || l.down <= 0) {
      fail(id, `${what} needs positive integer speeds`);
    }
    if (!Number.isInteger(l.start) || l.start < 0 || l.start >= stops.length) {
      fail(id, `${what} bad start stop`);
    }
    if (l.hurtsTeam !== -1 && l.hurtsTeam !== 0 && l.hurtsTeam !== 1) fail(id, `${what} bad team`);
    return {
      x,
      y,
      x0,
      x1,
      y0,
      y1,
      ground: num(l.ground, `${what} ground`),
      top: num(l.top, `${what} top`),
      stops,
      up: l.up,
      down: l.down,
      dwell,
      start: l.start,
      hurtsTeam: l.hurtsTeam,
      layers,
      model: num(l.model, `${what} model`),
      yaw: num(l.yaw, `${what} yaw`),
    };
  });

  const dummySpots = points(raw.dummySpots, "dummy spot");
  const dummyWeapon = dummySpots.length > 0 ? original(PROFILE_NEUTRAL_TURRET) : -1;
  return {
    id,
    size,
    cellSize,
    heights,
    waterMask,
    waterHeights,
    waterLevel: raw.waterLevel,
    wallsV,
    wallsH,
    layerHeights,
    layerMask,
    layerWallsV,
    layerWallsH,
    spawns: raw.spawns.map((s, i) => ({
      x: s.x,
      y: s.y,
      yaw: s.yaw,
      layer: layerOf(s.layer, `spawn ${i}`),
      hover: s.hover === true,
    })),
    basePlots: raw.basePlots.map((p, i) => plot(p, `base plot ${i}`)),
    bases,
    lanes: raw.lanes.map((lane) => lane.map((p) => point(p, "lane waypoint"))),
    turretSpots,
    outpostSpots,
    outposts,
    outpostPlates,
    dummySpots,
    dummyWeapon,
    weapons,
    turretParams,
    turretYaw,
    turretHp,
    captureRange,
    radii,
    refHeights: parseRefHeights(raw.refHeights, radii, id),
    turretGuns: parseTurretGuns(raw.turretGuns, radii.neutral.length, id),
    skyFlight: skyFlightOf(id, raw.skyFlight),
    skyMissileAccel: skyMissileAccelOf(id, raw.skyMissileAccel),
    shapes,
    laneGraph,
    pickups,
    triggerVolumes,
    floorMasks,
    modeFloors,
    spawnGuards,
    lifts,
    coarse: parseCoarse(id, raw.coarse),
  };
}

/** A flight block, strictly: integer halfwords, altMin < altCruise < altMax (the gains divide by both bands). */
function flightOf(
  id: string,
  raw: FlightJson | undefined,
  what: string,
  fallback: AircraftFlight,
): AircraftFlight {
  if (raw === undefined) return fallback;
  if (!raw || typeof raw !== "object") fail(id, `${what} is not an object`);
  const { altMin, altCruise, altMax, halfY, spawn } = raw;
  for (const [k, v] of [
    ["altMin", altMin],
    ["altCruise", altCruise],
    ["altMax", altMax],
    ["halfY", halfY],
    ["spawn", spawn],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 0x7fff)
      fail(id, `${what} ${k} is not a halfword (${v})`);
  }
  if (!(altMin < altCruise && altCruise < altMax)) fail(id, `${what} altitudes are not ordered`);
  return { altMin, altCruise, altMax, halfY, spawn };
}

function skyMissileAccelOf(id: string, raw: number | undefined): number {
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0 || raw > 0x7fff)
    fail(id, `skyMissileAccel ${raw} is not a halfword`);
  return raw;
}

function skyFlightOf(id: string, raw: FlightJson[] | undefined): readonly AircraftFlight[] {
  if (raw === undefined) return ORIGINAL_SKY_FLIGHT;
  if (!Array.isArray(raw) || raw.length !== 10)
    fail(id, "skyFlight needs one entry per level 0..9");
  return raw.map((f, l) =>
    flightOf(id, f, `sky captain level ${l} flight`, ORIGINAL_SKY_FLIGHT[l]),
  );
}

function parseCoarse(id: string, raw: MapJson["coarse"]): MapCoarse | null {
  if (raw === undefined) return null;
  const { originX, originY, rows, stride, field } = raw;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) fail(id, "coarse origin");
  if (!Number.isInteger(rows) || !Number.isInteger(stride) || rows < 2 || stride < 2) {
    fail(id, "coarse needs integer rows and stride of at least 2");
  }
  if (!Array.isArray(field) || field.length !== rows) fail(id, `coarse needs ${rows} rows`);
  const data = new Int8Array(rows * stride);
  for (let r = 0; r < rows; r++) {
    const row = field[r];
    if (typeof row !== "string" || row.length !== stride * 2 || !/^[0-9a-f]+$/.test(row)) {
      fail(id, `coarse row ${r} needs ${stride * 2} hex digits`);
    }
    for (let c = 0; c < stride; c++) data[r * stride + c] = parseInt(row.substr(c * 2, 2), 16);
  }
  return { originX, originY, rows, stride, data };
}

/** World units a metre, and the coarse field's cell (two terrain samples): `>> 14`. */
const COARSE_WU_PER_METRE = 8192;
const COARSE_SHIFT = 14;
const COARSE_FRAC = (1 << COARSE_SHIFT) - 1;
/** What the query answers off the field, metres: 0x8000 world units, a height to its callers. */
export const COARSE_OFFMAP = 0x8000 / COARSE_WU_PER_METRE;

/**
 * `cact_coarse_height_at` (0x00456180): the field at sim (x, y), metres — a
 * bilinear sample in the original's integer steps, along the row first on
 * both rows, then between them. COARSE_OFFMAP outside, where the original's
 * callers take the sentinel for a height.
 */
export function coarseHeightAt(f: MapCoarse, x: number, y: number): number {
  const dz = Math.floor((x - f.originX) * COARSE_WU_PER_METRE);
  const dx = Math.floor((y - f.originY) * COARSE_WU_PER_METRE);
  const fz = dz & COARSE_FRAC;
  const fx = dx & COARSE_FRAC;
  const iz = dz >> COARSE_SHIFT;
  const ix = dx >> COARSE_SHIFT;
  if (iz < 0 || iz > f.stride - 2 || ix < 0 || ix > f.rows - 2) return COARSE_OFFMAP;
  const p = ix * f.stride + iz;
  const n0 = f.data[p] << 8;
  const n1 = f.data[p + 1] << 8;
  const near = n0 + (((n1 - n0) * fz) >> COARSE_SHIFT);
  const q = p + f.stride;
  const f0 = f.data[q] << 8;
  const f1 = f.data[q + 1] << 8;
  const far = f0 + (((f1 - f0) * fz) >> COARSE_SHIFT);
  return (near + (((far - near) * fx) >> COARSE_SHIFT)) / COARSE_WU_PER_METRE;
}

export const TEST_MAP_ID = "test-128";
export const TEST_MAP_SIZE = 128;
export const TEST_MAP_CELL_SIZE = 2;

/**
 * Deterministic rolling-hills test map (Phase 0). Built exclusively from
 * simMath LUT trig, so every peer generates bit-identical heights — pinned
 * by a hash test. Feature lists are minimal: spawns/base plots sit at the
 * map center, no lanes or spots.
 */
export function createTestMap(): MapData {
  const size = TEST_MAP_SIZE;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h =
        4 * sinLUT(i * 0.1) * sinLUT(j * 0.13) +
        2 * sinLUT((i + j) * 0.045) +
        1.2 * sinLUT(i * 0.31) * cosLUT(j * 0.22);
      heights[j * size + i] = h;
    }
  }
  const center = ((size - 1) * TEST_MAP_CELL_SIZE) / 2;
  const extent = (size - 1) * TEST_MAP_CELL_SIZE;
  // Minimal sandbox bases: pads cover the shared center plot (Phase-1-style
  // ammo behavior), gates sit in opposite corners far from the action, no
  // ring turrets — the test map stays a combat-free driving range.
  const testBase = (team: number): MapBase => ({
    gate: {
      x: team === 0 ? 10 : extent - 10,
      y: team === 0 ? 10 : extent - 10,
      radius: 6,
      halfW: 0,
      halfL: 0,
      layer: 0,
    },
    core: { x: center + (team === 0 ? -6 : 6), y: center, layer: 0 },
    groundConsole: { x: center + (team === 0 ? -12 : 12), y: center, layer: 0 },
    groundBuy: { halfW: ORIGINAL_BUY_HALF_W, halfL: ORIGINAL_BUY_HALF_L },
    airConsole: { x: center, y: center + (team === 0 ? -12 : 12), layer: 0 },
    airBuy: { halfW: ORIGINAL_BUY_HALF_W, halfL: ORIGINAL_BUY_HALF_L },
    turrets: [],
    turretRespawnTicks: 0,
    // The original's units on their default profiles; the Dreadnought rolls
    // out at the ground console (as on district-01).
    juggernaut: {
      x: center + (team === 0 ? -12 : 12),
      y: center,
      layer: 0,
      hp: ORIGINAL_UNIT_PROFILES.juggernaut.hp,
      guns: ORIGINAL_UNIT_PROFILES.juggernaut.guns,
      weapon: ORIGINAL_UNIT_PROFILES.juggernaut.weapon,
      mounts: DREADNOUGHT_MOUNTS,
      gunTurn: DREADNOUGHT_GUN_TURN,
      walk: undefined,
    },
    runner: { ...ORIGINAL_UNIT_PROFILES.runner },
    guardian: { ...ORIGINAL_UNIT_PROFILES.guardian },
    fortress: { ...ORIGINAL_UNIT_PROFILES.fortress },
    heavyZones: undefined,
    fortressSpawn: { x: center, y: center + (team === 0 ? -12 : 12), layer: 0 },
    tankSpawn: { x: center + (team === 0 ? -12 : 12), y: center, layer: 0 },
    jetSpawn: { x: center, y: center + (team === 0 ? -12 : 12), layer: 0 },
    queuePeriod: { tank: ORIGINAL_TANK_QUEUE_PERIOD, jet: ORIGINAL_JET_QUEUE_PERIOD },
    jetFlight: ORIGINAL_JET_FLIGHT,
    fortressFlight: ORIGINAL_FORTRESS_FLIGHT,
  });
  return {
    id: TEST_MAP_ID,
    size,
    cellSize: TEST_MAP_CELL_SIZE,
    heights,
    waterMask: new Uint8Array(size * size),
    waterHeights: new Float32Array(size * size),
    waterLevel: -10, // below every valley: the test map has no water at all
    wallsV: new Uint8Array(0),
    wallsH: new Uint8Array(0),
    layerHeights: [],
    layerMask: [],
    layerWallsV: [],
    layerWallsH: [],
    spawns: [
      { x: center, y: center, yaw: 0, layer: 0, hover: false },
      { x: center, y: center, yaw: 0, layer: 0, hover: false },
    ],
    basePlots: [
      { x: center, y: center, radius: 20, layer: 0 },
      { x: center, y: center, radius: 20, layer: 0 },
    ],
    bases: [testBase(0), testBase(1)],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    outposts: [],
    outpostPlates: [],
    dummySpots: [],
    dummyWeapon: -1,
    weapons: ORIGINAL_WEAPON_PROFILES.map((w) => ({ ...w })),
    turretParams: [],
    turretYaw: [],
    turretHp: [],
    captureRange: ORIGINAL_CAPTURE_RANGE,
    radii: defaultRadii(0),
    refHeights: defaultRefHeights(0),
    turretGuns: defaultTurretGuns(0),
    skyFlight: ORIGINAL_SKY_FLIGHT,
    skyMissileAccel: 0,
    shapes: noShapes(),
    laneGraph: undefined,
    pickups: [],
    triggerVolumes: [],
    floorMasks: [],
    modeFloors: false,
    spawnGuards: [],
    lifts: [],
    coarse: null,
  };
}
