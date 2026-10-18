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
import {
  DREADNOUGHT_GUN_TURN,
  DREADNOUGHT_GUNS,
  DREADNOUGHT_MOUNTS,
  ORIGINAL_BUY_HALF_L,
  ORIGINAL_BUY_HALF_W,
  ORIGINAL_CAPTURE_RANGE,
  ORIGINAL_JET_QUEUE_TICKS,
  ORIGINAL_PICKUP_HALF_H,
  ORIGINAL_PICKUP_HALF_L,
  ORIGINAL_PICKUP_HALF_W,
  ORIGINAL_PICKUP_LIFT,
  ORIGINAL_TANK_QUEUE_TICKS,
  ORIGINAL_TURRET_HP,
  ORIGINAL_UNIT_PROFILES,
  ORIGINAL_WEAPON_PROFILES,
  PROFILE_NEUTRAL_TURRET,
  PROFILE_TEAM_TURRET,
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
 * original's fn30/fn31: every 5 s, 2.5 s on Joke and Slim, from a random phase).
 */
export interface MapHeavyZones {
  readonly juggernaut: MapZone;
  readonly fortress: MapZone;
  readonly pollTicks: number;
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
   * human's jets come at once). ORIGINAL_*_QUEUE_TICKS where the arena imports none.
   */
  readonly queueTicks: MapQueueTicks;
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
}

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
 * box waits for a latch reset the mission polls every `resetTicks` from a random
 * phase (RE `pa_rules.json` damage_triggers; trigger.c's box test, every axis
 * widened by the mech's radius).
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
  readonly resetTicks: number;
  readonly layer: number;
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
 * A render-only scenery placement (original DynamicProp and friends).
 *
 * The SIM MUST NOT READ THIS. It rides along in the map so the client can place
 * original props without a second data file; packages/sim/test/map.test.ts
 * asserts no sim source file references it.
 */
export interface MapProp {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly yaw: number;
  /**
   * Original Cobj resource id in this arena's own mission container, so the
   * renderer can pick the model. The missions number their Cobjs differently:
   * the same id is another model on another arena.
   */
  readonly model: number;
  readonly layer: number;
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
  /** Per team: this outpost's tank and jet queues' periods in ticks (MapQueueTicks). */
  readonly queueTicks: readonly MapQueueTicks[];
}

/**
 * A spawn queue's period in ticks (fcop-fidelity.md R18): the mission function
 * that spawns one queued unit per poll while its count is positive, polled from a
 * random phase drawn at load.
 */
export interface MapQueueTicks {
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
  /** Render-only scenery. The sim must not read this. */
  readonly props: readonly MapProp[];
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
    queueTicks?: { tank: number; jet: number }[];
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
  }[];
  /** Weapon index per turretSpots entry; length must equal turretSpots.length. */
  turretParams?: number[];
  /** Rest yaw per turretSpots entry; length must equal turretSpots.length. */
  turretYaw?: number[];
  /** Max HP per turretSpots entry; length must equal turretSpots.length. */
  turretHp?: number[];
  /** Capture range of the turret spots in metres, before the capturer's radius. */
  captureRange?: number;
  /** Original Cnet graph. `edges` is one 4-tuple per node, -1 = no edge. */
  laneGraph?: {
    nodes: (number[] | { x: number; y: number; layer?: number })[];
    edges: number[][];
    nextHopA: number[][];
    nextHopB: number[][];
    entry: number[];
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
    resetTicks: number;
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
  /** Render-only scenery; never read by the sim. */
  props?: { x: number; y: number; height: number; yaw: number; model: number; layer?: number }[];
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
    mounts?: { x: number; y: number; z: number; mx: number; my: number; mz: number }[];
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
    pollTicks: number;
  };
  /** OPTIONAL: the Fortress spawner's position; absent -> the air console. */
  fortressSpawn?: number[] | { x: number; y: number; layer?: number };
  /** OPTIONAL: the tank and jet spawners' positions; absent -> the consoles. */
  tankSpawn?: number[] | { x: number; y: number; layer?: number };
  jetSpawn?: number[] | { x: number; y: number; layer?: number };
  /** OPTIONAL: the base's queue periods in ticks (MapQueueTicks). */
  queueTicks?: { tank: number; jet: number };
}

function fail(id: string, reason: string): never {
  throw new Error(`invalid map "${id}": ${reason}`);
}

/** Parses + validates a map JSON. Throws with a precise reason if malformed. */
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
  const queueTicksOf = (q: { tank: number; jet: number } | undefined, what: string) => {
    if (q === undefined) return { tank: ORIGINAL_TANK_QUEUE_TICKS, jet: ORIGINAL_JET_QUEUE_TICKS };
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
      let mounts: readonly MapGunMount[] = DREADNOUGHT_MOUNTS;
      if (j.mounts !== undefined) {
        if (!Array.isArray(j.mounts)) fail(id, `${what} mounts is not an array`);
        mounts = j.mounts.map((m, i) => ({
          x: num(m?.x, `${what} mount ${i} x`),
          y: num(m?.y, `${what} mount ${i} y`),
          z: num(m?.z, `${what} mount ${i} z`),
          mx: num(m?.mx, `${what} mount ${i} mx`),
          my: num(m?.my, `${what} mount ${i} my`),
          mz: num(m?.mz, `${what} mount ${i} mz`),
        }));
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
      if (!Number.isInteger(hz.pollTicks) || hz.pollTicks < 1) {
        fail(id, `base ${team} heavy zones bad pollTicks ${String(hz.pollTicks)}`);
      }
      heavyZones = {
        juggernaut: zone(hz.juggernaut, `base ${team} Dreadnought zone`),
        fortress: zone(hz.fortress, `base ${team} Fortress zone`),
        pollTicks: hz.pollTicks,
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
      queueTicks: queueTicksOf(b.queueTicks, `base ${team} queues`),
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
        queueTicks: perTeam(o.queueTicks, "queueTicks").map((q, t) =>
          queueTicksOf(q, `${what} team ${t} queues`),
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
    laneGraph = {
      nodes,
      edges,
      nextHopA,
      nextHopB,
      entry: [g.entry[0], g.entry[1]],
      net: labelNets(edges, n, g.entry),
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
    if (!Number.isInteger(g.resetTicks) || g.resetTicks <= 0) {
      fail(id, `spawn guard ${k} bad resetTicks`);
    }
    return {
      x,
      y,
      halfW,
      halfL,
      halfH,
      hurtsTeam: g.hurtsTeam,
      damage: g.damage,
      resetTicks: g.resetTicks,
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
    laneGraph,
    pickups,
    triggerVolumes,
    floorMasks,
    modeFloors,
    spawnGuards,
    lifts,
    // Render-only, and deliberately not validated against bounds: props are
    // scenery, so an out-of-play prop is a cosmetic question, not a load error.
    props: (raw.props ?? []).map((p) => ({
      x: p.x,
      y: p.y,
      height: p.height,
      yaw: p.yaw,
      model: p.model,
      layer: typeof p.layer === "number" && Number.isInteger(p.layer) && p.layer >= 0 ? p.layer : 0,
    })),
  };
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
    },
    runner: { ...ORIGINAL_UNIT_PROFILES.runner },
    guardian: { ...ORIGINAL_UNIT_PROFILES.guardian },
    fortress: { ...ORIGINAL_UNIT_PROFILES.fortress },
    heavyZones: undefined,
    fortressSpawn: { x: center, y: center + (team === 0 ? -12 : 12), layer: 0 },
    tankSpawn: { x: center + (team === 0 ? -12 : 12), y: center, layer: 0 },
    jetSpawn: { x: center, y: center + (team === 0 ? -12 : 12), layer: 0 },
    queueTicks: { tank: ORIGINAL_TANK_QUEUE_TICKS, jet: ORIGINAL_JET_QUEUE_TICKS },
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
    laneGraph: undefined,
    pickups: [],
    triggerVolumes: [],
    floorMasks: [],
    modeFloors: false,
    spawnGuards: [],
    lifts: [],
    props: [],
  };
}
