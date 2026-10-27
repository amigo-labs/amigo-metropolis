// Unit movement (architecture.md §2 "unit lane-following" slot).
//
// On an arena that carries the original road graph (the imported Precinct
// Assault arenas, rules.md §9) Runners and Juggernauts are the original's route
// followers (fcop-fidelity.md U1/U2; fcop-re/ai-and-rules.md §4): at every node
// the step chooser picks one of up to four links — a Runner seeking the nearest
// enemy within 16 m on 60 % of steps, at random otherwise; a Juggernaut always
// at random — never stepping straight back; they walk the legs at 1.98 m/s,
// choosing a leg ahead and rounding the corners, slow for traffic in 1 s holds
// and never stop to fight (their guns fire on the move). The cursor is route.ts.
// Elsewhere they follow Metropolis' authored lane polylines toward the enemy
// gate and halt for anything hostile in attack range (rules.md §4). Guardians
// and Fortresses are the original's aircraft on the imported arenas (search,
// leash, standoff; moveAircraft) and fly patrol orbits or assault runs elsewhere.
//
// Per-archetype field reuse on unit entities (see entities.ts):
//   timerA    — ground: lane index, or on the graph the node it walks to (-1 halted)
//               · air: patrol orbit angle (radians)
//   timerB    — ground off the graph: current waypoint index (past either end =
//               seek gate)
//   cooldownB — ground on the graph: the node it came from (-1 none)
//   ammoB     — ground on the graph: the node before that, + 1 (0 = none)
//   (the rest of a route follower's state is its cursor, SimState.route: route.ts)
//   mode      — GUARDIAN: UNIT_MODE_PATROL | UNIT_MODE_ASSAULT (spawn-site switch);
//               on a PA arena the aircraft's anchor (0 base, 1 + k outpost k)
//   (a PA aircraft's own reuse is listed at moveAircraft)

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
import {
  AIRCRAFT_CRUISE_DWELL_MIN,
  AIRCRAFT_CRUISE_JITTER,
  AIRCRAFT_DELTA_UNITS,
  AIRCRAFT_DWELL_JITTER,
  AIRCRAFT_HEADING_ONE,
  AIRCRAFT_PITCH_LIMIT,
  AIRCRAFT_REVERSE_JITTER,
  AIRCRAFT_REVERSE_UNITS,
  AIRCRAFT_SEARCH_JITTER,
  AIRCRAFT_SEARCH_UNITS,
  AIRCRAFT_SPAWN_CLIMB,
  AIRCRAFT_SPAWN_HIGH,
  AIRCRAFT_SPAWN_HIGH_RISE,
  AIRCRAFT_STANDOFF,
  AIRCRAFT_STEP_BITS,
  AIRCRAFT_TUMBLE_SPAN,
  AIRCRAFT_TURN_RATE,
  AIRCRAFT_UP_BIAS,
  AIRCRAFT_VERT_DEADBAND,
  AIRCRAFT_VERT_MAX,
  type AircraftFlight,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_WALKER_MAX_SLOPE,
  FORTRESS_AIRCRAFT_SPEED_RAW,
  FORTRESS_DETECT_RANGE,
  FORTRESS_DWELL_CRUISE,
  FORTRESS_DWELL_ENGAGE,
  FORTRESS_LEASH_X,
  FORTRESS_LEASH_Y,
  FRAME_CLOCK_PER_TICK,
  GUARDIAN_AIRCRAFT_SPEED_RAW,
  GUARDIAN_DETECT_RANGE,
  GUARDIAN_DWELL_CRUISE,
  GUARDIAN_DWELL_ENGAGE,
  GUARDIAN_LEASH_X,
  GUARDIAN_LEASH_Y,
  HOVER_CUSHION_SPAN,
  MAX_ENTITIES,
  ROUTE_SPEED_UNIT,
  ROUTE_TOP_SPEED,
  TARGET_PRIORITY_AVATAR,
  TARGET_PRIORITY_JUGGERNAUT,
  TARGET_PRIORITY_RUNNER,
  TICK_DT,
  TICK_HZ,
  UNIT_SEPARATION_PUSH,
  UNIT_SEPARATION_RADIUS,
  WAYPOINT_RADIUS,
  WU_PER_METRE,
  wardenLevel,
} from "./balance";
import { crossesWallX, crossesWallY, segmentBlocked } from "./collision";
import { coarseHeightAt, type MapData, sampleHeight, sampleLayerHeight, worldExtent } from "./map";
import { followsRoutes, routeContacts, routeTick, routeTraffic } from "./route";
import { ANIM_MOVING, entityRadius, rideHeight, type SimState, STEP_SNAP } from "./sim";
import { atan2Poly, cosLUT, rand01, randInt, sinLUT, TAU } from "./simMath";
import { animStep, T_MODE } from "./walker";

export { followsRoutes };

/**
 * An aircraft's anchor, the spawner it was built at (moveAircraft): 0 the base
 * air console, UNIT_MODE_OUTPOST + k outpost k. (Until SIM_VERSION 52 mode 1
 * was Metropolis' ASSAULT run off the PA arenas.)
 */
export const UNIT_MODE_PATROL = 0;
export const UNIT_MODE_OUTPOST = 1;

/**
 * Nearest live enemy of `id` within `range` (dense id order; ties keep the
 * lowest id). Neutral entities are never engaged by units, and projectiles
 * are never targets. Shared by unit movement AND the targeting system so
 * "halts the unit" and "gets shot" agree exactly. Turrets, units and the
 * Dreadnought's guns all engage the other side's turrets (the original's
 * search by team has no type test, fcop-fidelity.md U4); `skipStructures`
 * leaves them out for a caller that wants mobile bodies only (none since
 * SIM_VERSION 107).
 */
export function nearestEnemyInRange(
  state: SimState,
  id: number,
  range: number,
  skipStructures = false,
  /**
   * Prefer the higher target priority, nearest within it (the PA team turrets'
   * bitfield 0x40; balance.ts TARGET_PRIORITY_*).
   */
  byPriority = false,
  /**
   * Only targets with a terrain line of sight (walls only). The Sky Captain
   * assigns its target by distance alone (`dispatch.c` 0x00421b70..), so it
   * passes false; its shots are still stopped by walls (warden.ts, sim.ts).
   */
  lineOfSight = true,
): number {
  const ent = state.ent;
  return nearestEnemyFrom(
    state,
    id,
    ent.posX[id],
    ent.posY[id],
    range,
    skipStructures,
    byPriority,
    lineOfSight,
  );
}

/**
 * nearestEnemyInRange measured from (x, y) for `id`'s team: the Dreadnought's
 * guns search from their own mounts (sim.ts shooterDreadnought).
 */
export function nearestEnemyFrom(
  state: SimState,
  id: number,
  x: number,
  y: number,
  range: number,
  skipStructures = false,
  byPriority = false,
  lineOfSight = true,
): number {
  const ent = state.ent;
  // Invisible avatars are unacquirable (rules.md §9). Resolved to entity ids up
  // front so the hot loop stays a plain comparison; -1 when the arena has no
  // pickups, which never matches a live id.
  let hidden0 = -1;
  let hidden1 = -1;
  if (state.buffInvis.length > 0) {
    if (state.buffInvis[0] > 0) hidden0 = state.avatarId[0];
    if (state.buffInvis[1] > 0) hidden1 = state.avatarId[1];
  }
  const team = ent.team[id];
  // Outpost consoles cannot be destroyed on any arena (fcop-fidelity.md R14,
  // sim.ts applyDamage), so nothing shoots at one.
  let bestD2 = range * range;
  let bestId = -1;
  let bestPrio = -1;
  const range2 = range * range;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    if (t === hidden0 || t === hidden1) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    const archetype = ent.archetype[t];
    if (archetype === ARCHETYPE.PROJECTILE) continue;
    if (skipStructures && archetype === ARCHETYPE.TURRET) continue;
    if (archetype === ARCHETYPE.CONSOLE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    const prio = byPriority ? targetPriority(archetype) : 0;
    const better = byPriority
      ? d2 < range2 && (prio > bestPrio || (prio === bestPrio && d2 < bestD2))
      : d2 < bestD2;
    if (better) {
      if (lineOfSight && segmentBlocked(state.map, x, y, ent.posX[t], ent.posY[t])) {
        continue; // wall between us — invisible, so neither halt nor shot
      }
      bestD2 = d2;
      bestId = t;
      bestPrio = prio;
    }
  }
  return bestId;
}

/** A target's priority for the PA team turrets (balance.ts TARGET_PRIORITY_*). */
function targetPriority(archetype: number): number {
  if (archetype === ARCHETYPE.JUGGERNAUT) return TARGET_PRIORITY_JUGGERNAUT;
  if (archetype === ARCHETYPE.RUNNER) return TARGET_PRIORITY_RUNNER;
  if (archetype === ARCHETYPE.AVATAR) return TARGET_PRIORITY_AVATAR;
  return 0;
}

/**
 * A unit's engage range: its weapon profile's (the tank's, jet's and Fortress'
 * records and the Dreadnought's guns, 12 m on every arena; sim.ts spawnUnit), 0
 * for an entity without one.
 */
export function unitRange(state: SimState, id: number): number {
  const profile = state.ent.weaponProfile[id];
  return profile >= 0 ? state.map.weapons[profile].range : 0;
}

/**
 * unit movement system: moves every unit, then separates ground units on the
 * polyline arenas (route followers are never pushed off their road). Ground
 * units drive the original's road graph where the arena carries one, else
 * Metropolis' lane polylines (district-01, the test maps) — both at the
 * original's ROUTE_TOP_SPEED; aircraft are the original's everywhere.
 */
export function systemUnitMovement(state: SimState): void {
  const ent = state.ent;
  const routes = followsRoutes(state);
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    switch (ent.archetype[id]) {
      case ARCHETYPE.RUNNER:
        if (routes) routeTick(state, id);
        else moveGroundUnit(state, id, ROUTE_TOP_SPEED);
        break;
      case ARCHETYPE.JUGGERNAUT:
        // The type-5 tick's order (type5.c 469-494): the hull's walk by the
        // speed the last move left, then the move.
        stepHullWalk(state, id);
        if (routes) routeTick(state, id);
        else moveGroundUnit(state, id, ROUTE_TOP_SPEED);
        break;
      case ARCHETYPE.GUARDIAN:
      case ARCHETYPE.FORTRESS:
        moveAircraft(state, id);
        break;
      default:
        break;
    }
  }
  if (!routes) {
    separateGroundUnits(state);
    return;
  }
  // The frame's end on the graph, in the original's order: the pair walk's
  // contacts (operation 0x0b, `objects_pick_targets` 0x0044fe40), then each
  // actor's answer to its nearest neighbour (operation 0x0d,
  // `cact_post_impulse` 0x0043bf00, the frame's last actor pass).
  routeContacts(state);
  for (let id = 0; id < ent.high; id++) {
    if (ent.alive[id] && ent.archetype[id] === ARCHETYPE.RUNNER) routeTraffic(state, id);
  }
}

/**
 * The Dreadnought hull's walk where its model animates (Joke's; sim.ts
 * hullWalk): `cact_anim_step` on its block by `dt` for a track in mode 1, else
 * by `velocity_84 * dt` (RE type5.c 469-472) -- the speed word the last move
 * left, world units per engine tick (ROUTE_SPEED_UNIT: 54 at the top speed),
 * times the frame delta -- so a frame passes each `period` world units the hull
 * has travelled (775 on Joke). A halted hull steps nothing.
 */
function stepHullWalk(state: SimState, id: number): void {
  const ent = state.ent;
  const walk = state.hullWalk[ent.team[id]];
  if (!walk) return;
  // The speed word itself on the graph (route.ts); off it, read back from the velocity.
  const v = Math.sqrt(ent.velX[id] * ent.velX[id] + ent.velY[id] * ent.velY[id]);
  const speed = followsRoutes(state)
    ? state.route.velocity[id]
    : Math.floor(v / ROUTE_SPEED_UNIT + 0.5);
  const track = walk.tracks[walk.index[id]];
  const step = track[T_MODE] === 1 ? FRAME_CLOCK_PER_TICK : speed * FRAME_CLOCK_PER_TICK;
  animStep(walk, id, step, 0);
}

/**
 * An aircraft's `mode` holds its anchor (below) and, in this bit, its state:
 * set CRUISE (fly to the destination, gun silent), clear ENGAGE.
 */
const AIR_CRUISE = 0x80;
export const AIR_ANCHOR_MASK = 0x7f;

/**
 * A PA aircraft's anchor — the spawner it was built at, which its patrol leash
 * is measured from (the original's `anchor`, the record's own position): the
 * base air console for a base-built one (mode 0), outpost k's spot for one built
 * there (mode 1 + k).
 */
function aircraftAnchorX(state: SimState, id: number): number {
  const m = state.ent.mode[id] & AIR_ANCHOR_MASK;
  const spots = state.map.outpostSpots;
  if (m >= 1 && m - 1 < spots.length) return spots[m - 1].x;
  return state.map.bases[state.ent.team[id]].airConsole.x;
}

function aircraftAnchorY(state: SimState, id: number): number {
  const m = state.ent.mode[id] & AIR_ANCHOR_MASK;
  const spots = state.map.outpostSpots;
  if (m >= 1 && m - 1 < spots.length) return spots[m - 1].y;
  return state.map.bases[state.ent.team[id]].airConsole.y;
}

/** Inside its patrol leash (the original's box test against the anchor)? */
function insideLeash(state: SimState, id: number): boolean {
  const ent = state.ent;
  const fortress = ent.archetype[id] === ARCHETYPE.FORTRESS;
  const lx = fortress ? FORTRESS_LEASH_X : GUARDIAN_LEASH_X;
  const ly = fortress ? FORTRESS_LEASH_Y : GUARDIAN_LEASH_Y;
  const dx = ent.posX[id] - aircraftAnchorX(state, id);
  const dy = ent.posY[id] - aircraftAnchorY(state, id);
  return dx <= lx && dx >= -lx && dy <= ly && dy >= -ly;
}

/**
 * Is this aircraft in ENGAGE? Its shooter fires only then (sim.ts shooterUnit;
 * the original steps an aircraft's weapon in STATE_ENGAGE only, 0x00420c32,
 * after the state switch).
 */
export function aircraftEngaged(state: SimState, id: number): boolean {
  // Not in the climb or the crash: the steering block, which steps the gun, is
  // entered from ENGAGE and CRUISE only (0x00420867).
  return (state.ent.mode[id] & AIR_CRUISE) === 0 && state.air.phase[id] === AIR_FLY;
}

/** The halfword the original keeps a state timer in (`mov word ptr [esi + 0x100]`). */
function toHalfword(v: number): number {
  return ((v + 0x8000) & 0xffff) - 0x8000;
}

/**
 * An ENGAGE / CRUISE dwell reload (0x00420833..0x0042085f): the dwell plus
 * `(rand & 0xff) * dwell >> 10`, kept as a halfword — so a Flying Fortress's
 * long ENGAGE can wrap negative and flip back on the next tick, as it does in
 * the original.
 */
function dwellReload(state: SimState, dwell: number): number {
  return toHalfword(((randInt(state, AIRCRAFT_DWELL_JITTER) * dwell) >> 10) + dwell);
}

/** A new patrol destination inside half the leash (`aircraft_pick_destination`). */
function pickDestination(state: SimState, id: number): void {
  // Nothing in the crash (0x00420680's first refusal).
  const phase = state.air.phase[id];
  if (phase === AIR_CRASH || phase === AIR_LANDED) return;
  const ent = state.ent;
  const fortress = ent.archetype[id] === ARCHETYPE.FORTRESS;
  const lx = (fortress ? FORTRESS_LEASH_X : GUARDIAN_LEASH_X) * 0.5;
  const ly = (fortress ? FORTRESS_LEASH_Y : GUARDIAN_LEASH_Y) * 0.5;
  const extent = worldExtent(state.map);
  const x = aircraftAnchorX(state, id) + (rand01(state) * 2 - 1) * lx;
  const y = aircraftAnchorY(state, id) + (rand01(state) * 2 - 1) * ly;
  ent.timerA[id] = Math.min(Math.max(x, 0), extent);
  ent.timerB[id] = Math.min(Math.max(y, 0), extent);
}

/**
 * The aircraft's target search (`cact_find_target`, every 900 + rand 0..511
 * engine units): the nearest enemy-team actor within the record's detection
 * range — the jet's 28672 raw = 56 m, the Fortress' 32358 = 63.2 m (I2) — with
 * no cone and no line of sight. A cloaked avatar is skipped (P7); projectiles
 * and Metropolis' outpost consoles are not actors of the original.
 */
function aircraftSearch(state: SimState, id: number): number {
  const ent = state.ent;
  const team = ent.team[id];
  const range =
    ent.archetype[id] === ARCHETYPE.FORTRESS ? FORTRESS_DETECT_RANGE : GUARDIAN_DETECT_RANGE;
  let hidden0 = -1;
  let hidden1 = -1;
  if (state.buffInvis.length > 0) {
    if (state.buffInvis[0] > 0) hidden0 = state.avatarId[0];
    if (state.buffInvis[1] > 0) hidden1 = state.avatarId[1];
  }
  let best = -1;
  let bestD2 = range * range;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id || t === hidden0 || t === hidden1) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    const a = ent.archetype[t];
    if (a === ARCHETYPE.PROJECTILE || a === ARCHETYPE.CONSOLE) continue;
    const dx = ent.posX[t] - ent.posX[id];
    const dy = ent.posY[t] - ent.posY[id];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = t;
    }
  }
  return best;
}

/**
 * A PA jet or Flying Fortress, the original's aircraft (`aircraft_step`, retail
 * 0x00420700; RE M3-OR, fcop-re/ai-and-rules.md §4), once a tick of 10 engine
 * units:
 * - every 0x384 + rand 0..0x1ff units (3.0-4.7 s) it searches (aircraftSearch)
 *   and takes what it finds, or nothing; a target that dies is dropped and a
 *   new destination drawn — in every state, the climb and the crash included;
 * - ENGAGE and CRUISE each last their dwell (balance.ts GUARDIAN_/FORTRESS_
 *   DWELL_*: the jet 20 s / 5 s), an ENGAGE that runs out drawing a destination;
 * - in ENGAGE, out of its box — ±20 x ±24 m about its anchor for a jet, ±28 x
 *   ±30 m for a Fortress — it draws a destination and CRUISEs 4.0-10.8 s; in the
 *   box it flies at its target, or with none CRUISEs to its destination for
 *   max(4 s, the cruise dwell); in CRUISE it flies to its destination. Its gun
 *   fires only in ENGAGE;
 * - inside the 1 m standoff (by the octagonal estimate, 0x00458000) it
 *   reverses, and keeps reversing for 0.5-0.9 s;
 * - it flies as the original does (aircraftFly): the heading turned toward the
 *   point, its Y the altitude controller's, the bank's speed penalty;
 * - a launch climb (spawn flag 4) rises straight up into ENGAGE (aircraftClimb);
 *   shot down, 10 in 16 tumble to the ground first (aircraftCrash, sim.ts
 *   systemDamageDeath) and die where they land.
 * Field reuse: timerA/timerB the destination, timerC the state timer (engine
 * units), cooldownB the search timer (engine units), ammoB the target + 1, aimX
 * the reverse timer (engine units), mode the anchor and AIR_CRUISE, velX/velY
 * the horizontal velocity; the heading, steer, tumble and phase are
 * SimState.air's.
 */
function moveAircraft(state: SimState, id: number): void {
  const ent = state.ent;
  const air = state.air;
  const fortress = ent.archetype[id] === ARCHETYPE.FORTRESS;
  const phase = air.phase[id];
  if (phase === AIR_LANDED) return; // down: systemDamageDeath takes it this tick
  // 0x00420752: the search, which replaces the target with what it finds.
  ent.cooldownB[id] -= AIRCRAFT_DELTA_UNITS;
  if (ent.cooldownB[id] < 0) {
    ent.cooldownB[id] = AIRCRAFT_SEARCH_UNITS + randInt(state, AIRCRAFT_SEARCH_JITTER);
    ent.ammoB[id] = aircraftSearch(state, id) + 1;
  }
  // 0x004207c1: a target that is gone is dropped, with a new destination.
  let target = ent.ammoB[id] - 1;
  if (target >= 0) {
    const tt = ent.team[target];
    if (!ent.alive[target] || tt === ent.team[id] || tt === TEAM_NEUTRAL) {
      target = -1;
      ent.ammoB[id] = 0;
      pickDestination(state, id);
    }
  }
  // 0x00420867: the climb and the crash leave the dwell and the steering alone.
  if (phase === AIR_CLIMB) {
    if (aircraftClimb(state, id, airSpeedRaw(state, id), aircraftFlight(state, id))) {
      air.phase[id] = AIR_FLY;
      ent.mode[id] &= AIR_ANCHOR_MASK; // out into ENGAGE
    }
    return;
  }
  if (phase === AIR_CRASH) {
    if (aircraftTumble(state, id)) air.phase[id] = AIR_LANDED;
    return;
  }
  // 0x004207eb: the dwell.
  ent.timerC[id] -= AIRCRAFT_DELTA_UNITS;
  if (ent.timerC[id] < 0) {
    if ((ent.mode[id] & AIR_CRUISE) === 0) {
      pickDestination(state, id);
      ent.mode[id] |= AIR_CRUISE;
      ent.timerC[id] = dwellReload(state, fortress ? FORTRESS_DWELL_CRUISE : GUARDIAN_DWELL_CRUISE);
    } else {
      ent.mode[id] &= AIR_ANCHOR_MASK;
      ent.timerC[id] = dwellReload(state, fortress ? FORTRESS_DWELL_ENGAGE : GUARDIAN_DWELL_ENGAGE);
    }
  }
  // The state switch.
  let tx = ent.timerA[id];
  let ty = ent.timerB[id];
  if ((ent.mode[id] & AIR_CRUISE) === 0) {
    if (!insideLeash(state, id)) {
      pickDestination(state, id);
      tx = ent.timerA[id];
      ty = ent.timerB[id];
      ent.mode[id] |= AIR_CRUISE;
      ent.timerC[id] = AIRCRAFT_CRUISE_DWELL_MIN + randInt(state, AIRCRAFT_CRUISE_JITTER);
    } else if (target >= 0) {
      tx = ent.posX[target];
      ty = ent.posY[target];
    } else {
      const cruise = fortress ? FORTRESS_DWELL_CRUISE : GUARDIAN_DWELL_CRUISE;
      ent.mode[id] |= AIR_CRUISE;
      ent.timerC[id] = cruise > AIRCRAFT_CRUISE_DWELL_MIN ? cruise : AIRCRAFT_CRUISE_DWELL_MIN;
    }
  }
  // 0x004209a2: the standoff reverse and its timer.
  const dx = tx - ent.posX[id];
  const dy = ty - ent.posY[id];
  if (ent.aimX[id] > 0) ent.aimX[id] -= AIRCRAFT_DELTA_UNITS;
  let reverse = false;
  if (octagonal(dx, dy) < AIRCRAFT_STANDOFF || ent.aimX[id] > 0) {
    reverse = true;
    if (ent.aimX[id] <= 0) {
      ent.aimX[id] = AIRCRAFT_REVERSE_UNITS + randInt(state, AIRCRAFT_REVERSE_JITTER);
    }
  }
  aircraftFly(
    state,
    id,
    dx,
    dy,
    reverse,
    AIRCRAFT_TURN_RATE,
    airSpeedRaw(state, id),
    aircraftFlight(state, id),
  );
}

/** The octagonal estimate `vec_distance_xz` (0x00458000) on the ground plane, metres. */
export function octagonal(dx: number, dy: number): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  return ax > ay ? ax + ay / 2 : ay + ax / 2;
}

// --- The flight (`aircraft_fly`, 0x00420977..0x00420c81) --------------------

/** An aircraft's phase (SimState.air.phase): the original's states 4, 3 and 5 beside flight. */
export const AIR_FLY = 0;
export const AIR_CLIMB = 1;
export const AIR_CRASH = 2;
/** The tumble reached the ground this tick: the death is taken (state 5, then op 4). */
export const AIR_LANDED = 3;

/**
 * Every aircraft's flight state, by entity id, in the original's integers: the
 * heading (+0x78/+0x7c/+0x80, 16.16 unit; x and z the sim's posX / posY, y up),
 * the low-passed steering command (+0xe8), the crash velocity (`destination`,
 * which operation 4 reuses), the up row's |Y| the last rotation left (the bank
 * penalty's `m(1,1)`), and the phase. Jets, Fortresses and the Sky Captain.
 * Hashed for every live one (sim.ts hash).
 */
export interface AirState {
  readonly hx: Int32Array;
  readonly hy: Int32Array;
  readonly hz: Int32Array;
  readonly sx: Int32Array;
  readonly sy: Int32Array;
  readonly sz: Int32Array;
  readonly vx: Int32Array;
  readonly vy: Int32Array;
  readonly vz: Int32Array;
  readonly upY: Int32Array;
  /**
   * The model matrix's up row (row 1), 16.16, in the heading's axes: what
   * `math_matrix_from_forward_up` (0x0043fbc0) last built, `forward x
   * normalise(up x forward)`; the tumble's next up reference (0x00420ee3).
   * `upY` is its |y|.
   */
  readonly ux: Int32Array;
  readonly uy: Int32Array;
  readonly uz: Int32Array;
  readonly phase: Uint8Array;
}

export function createAirState(cap: number = MAX_ENTITIES): AirState {
  return {
    hx: new Int32Array(cap),
    hy: new Int32Array(cap),
    hz: new Int32Array(cap),
    sx: new Int32Array(cap),
    sy: new Int32Array(cap),
    sz: new Int32Array(cap),
    vx: new Int32Array(cap),
    vy: new Int32Array(cap),
    vz: new Int32Array(cap),
    upY: new Int32Array(cap),
    ux: new Int32Array(cap),
    uy: new Int32Array(cap).fill(AIRCRAFT_HEADING_ONE),
    uz: new Int32Array(cap),
    phase: new Uint8Array(cap),
  };
}

/** `math_fixed_mul`: the 16.16 product, floored (64-bit in the original, exact here). */
function fixedMul(a: number, b: number): number {
  return Math.floor((a * b) / 0x10000);
}

/** The aircraft's record flight block: its spawner's, or the captain's level's. */
export function aircraftFlight(state: SimState, id: number): AircraftFlight {
  const ent = state.ent;
  const team = ent.team[id];
  const map = state.map;
  if (ent.archetype[id] === ARCHETYPE.WARDEN) {
    return map.skyFlight[wardenLevel(state.wardenDifficulty)];
  }
  const base = map.bases[team === 1 ? 1 : 0];
  if (ent.archetype[id] === ARCHETYPE.FORTRESS) return base.fortressFlight;
  const m = ent.mode[id] & AIR_ANCHOR_MASK;
  if (m >= UNIT_MODE_OUTPOST && m - UNIT_MODE_OUTPOST < map.outposts.length) {
    return map.outposts[m - UNIT_MODE_OUTPOST].jetFlight[team === 1 ? 1 : 0];
  }
  return base.jetFlight;
}

/**
 * The ground under (x, y) in world units as the flight reads it: the coarse
 * maximum-height envelope (`cact_coarse_height_at` 0x00456180, its 0x8000
 * off the field unchecked) where the arena imports it; Metropolis' own maps
 * carry none, and read their heightfield or water, whichever is higher.
 */
function envelopeWu(state: SimState, x: number, y: number): number {
  const map = state.map;
  if (map.coarse) return Math.floor(coarseHeightAt(map.coarse, x, y) * WU_PER_METRE);
  const g = sampleHeight(map, x, y);
  return Math.floor((g < map.waterLevel ? map.waterLevel : g) * WU_PER_METRE);
}

/** The floor the flight is clamped up to: the envelope plus the model's half height (0x00420a31). */
function floorWu(state: SimState, x: number, y: number, f: AircraftFlight): number {
  return envelopeWu(state, x, y) + (f.halfY << 4);
}

/** `math_reciprocal_span` of a band `<< 4` (0x0042060d): `0x80000000 / (band << 4 >> 1)`. */
function gain(band: number): number {
  const half = (band << 4) >> 1;
  return half > 0 ? Math.floor(0x80000000 / half) : 0;
}

/**
 * The vertical command for an altitude `y` over `floor`, wu (0x00420a60..
 * 0x00420af2): ±0x1800 at and beyond the band's edges, between them the error
 * to the cruise altitude times the half band's reciprocal, times 3/32, and 0
 * within the 0x200 deadband.
 */
export function verticalCommand(y: number, floor: number, f: AircraftFlight): number {
  const target = floor + (f.altCruise << 4);
  let cmd: number;
  if (y < target) {
    if (y <= floor + (f.altMin << 4)) cmd = AIRCRAFT_VERT_MAX;
    else cmd = Math.floor((fixedMul(target - y, gain(f.altCruise - f.altMin)) * 3) / 32);
  } else if (y >= floor + (f.altMax << 4)) {
    cmd = -AIRCRAFT_VERT_MAX;
  } else {
    cmd = Math.floor((fixedMul(target - y, gain(f.altMax - f.altCruise)) * 3) / 32);
  }
  return (cmd < 0 ? -cmd : cmd) <= AIRCRAFT_VERT_DEADBAND ? 0 : cmd;
}

/**
 * The heading step's scratch (`flyHeading`), module scope: in, the heading and
 * steer; out, the same updated.
 */
export const flyScratch = { hx: 0, hy: 0, hz: 0, sx: 0, sy: 0, sz: 0 };

/** `vec_rescale_15` (0x00457f60) of the scratch vector: a pure shift to a 15-bit cheap magnitude. */
function rescale15(v: { x: number; y: number; z: number }): void {
  const ax = v.x < 0 ? -v.x : v.x;
  const ay = v.y < 0 ? -v.y : v.y;
  const az = v.z < 0 ? -v.z : v.z;
  // `vec_magnitude` (0x00457b10): the largest plus a quarter of the other two.
  let a = ax;
  let b = ay;
  let c = az;
  if (a < b) {
    const t = a;
    a = b;
    b = t;
  }
  if (a < c) {
    const t = a;
    a = c;
    c = t;
  }
  const bits = topBit(a + ((b + c) >> 2));
  if (bits > AIRCRAFT_STEP_BITS) {
    const s = bits - AIRCRAFT_STEP_BITS;
    v.x >>= s;
    v.y >>= s;
    v.z >>= s;
  } else {
    const s = AIRCRAFT_STEP_BITS - bits;
    v.x <<= s;
    v.y <<= s;
    v.z <<= s;
  }
}

const vecScratch = { x: 0, y: 0, z: 0 };

/**
 * One tick of the original's heading (`aircraft_fly` 0x00420a0f..0x00420b84) on
 * flyScratch: the horizontal vector (dx, dz) to the steer point, wu, rescaled
 * to 15 bits, times `turn * delta >> 3` (16.16, 0x004584a0) is the step, whose Y
 * is the vertical command `vcmd`; the steer low-passes the step (`acc = (3 acc
 * + in) >> 2`, 0x00457fc0) and loses a quarter of its Y; the heading takes the
 * step, loses an eighth of its Y (both rounded toward zero), is rescaled to 15
 * bits, its Y clamped to ±0x8000, and normalised to 16.16 — here by Math.sqrt
 * in place of the original's inverse-square-root table (DAT_004a2b58).
 */
export function flyHeading(dx: number, dz: number, vcmd: number, turn: number): void {
  const s = flyScratch;
  const v = vecScratch;
  v.x = dx;
  v.y = 0;
  v.z = dz;
  rescale15(v);
  const scale = (turn * AIRCRAFT_DELTA_UNITS) >> 3;
  const px = fixedMul(v.x, scale);
  const pz = fixedMul(v.z, scale);
  const py = vcmd;
  s.sx = (3 * s.sx + px) >> 2;
  s.sy = (3 * s.sy + py) >> 2;
  s.sz = (3 * s.sz + pz) >> 2;
  s.sy -= (s.sy + ((s.sy >> 31) & 3)) >> 2;
  let hy = s.hy + py;
  hy -= (hy + ((hy >> 31) & 7)) >> 3;
  v.x = s.hx + px;
  v.y = hy;
  v.z = s.hz + pz;
  rescale15(v);
  if (v.y < -AIRCRAFT_PITCH_LIMIT) v.y = -AIRCRAFT_PITCH_LIMIT;
  else if (v.y > AIRCRAFT_PITCH_LIMIT) v.y = AIRCRAFT_PITCH_LIMIT;
  const l = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (l > 0) {
    s.hx = Math.floor((v.x * AIRCRAFT_HEADING_ONE) / l);
    s.hy = Math.floor((v.y * AIRCRAFT_HEADING_ONE) / l);
    s.hz = Math.floor((v.z * AIRCRAFT_HEADING_ONE) / l);
  }
}

/** Scratch: the up row upRow last built (module scope, no allocation per tick). */
export const upScratch = { x: 0, y: 0, z: 0 };

/**
 * Row 1 of the rotation `math_matrix_from_forward_up` (0x0043fbc0) builds from
 * the heading (hx, hy, hz) and the up reference (ux, uy, uz), 16.16, into
 * upScratch: `forward x normalise(up x forward)`, which for a unit forward is
 * the up reference's part across the heading, normalised -- the bank of a turn
 * and the pitch together. (0, 1.0, 0) for a degenerate up.
 */
export function upRow(
  hx: number,
  hy: number,
  hz: number,
  ux: number,
  uy: number,
  uz: number,
): void {
  const fx = hx / AIRCRAFT_HEADING_ONE;
  const fy = hy / AIRCRAFT_HEADING_ONE;
  const fz = hz / AIRCRAFT_HEADING_ONE;
  const d = ux * fx + uy * fy + uz * fz;
  const px = ux - fx * d;
  const py = uy - fy * d;
  const pz = uz - fz * d;
  const l = Math.sqrt(px * px + py * py + pz * pz);
  if (!(l > 0)) {
    upScratch.x = 0;
    upScratch.y = AIRCRAFT_HEADING_ONE;
    upScratch.z = 0;
    return;
  }
  upScratch.x = Math.floor((px * AIRCRAFT_HEADING_ONE) / l);
  upScratch.y = Math.floor((py * AIRCRAFT_HEADING_ONE) / l);
  upScratch.z = Math.floor((pz * AIRCRAFT_HEADING_ONE) / l);
}

/**
 * The up row's |Y| of the rotation built from the heading and the up vector
 * `steer + (0, 0x2000, 0)` (0x00420c61): upRow's y, made positive. 16.16.
 */
export function upRowY(
  hx: number,
  hy: number,
  hz: number,
  sx: number,
  sy: number,
  sz: number,
): number {
  upRow(hx, hy, hz, sx, sy + AIRCRAFT_UP_BIAS, sz);
  const y = upScratch.y;
  return y < 0 ? -y : y;
}

/** Stores aircraft `id`'s rotation's up row from upScratch, and its |y|. */
function storeUp(air: AirState, id: number): void {
  air.ux[id] = upScratch.x;
  air.uy[id] = upScratch.y;
  air.uz[id] = upScratch.z;
  air.upY[id] = upScratch.y < 0 ? -upScratch.y : upScratch.y;
}

/** A level aircraft's up row (`math_matrix_from_forward`, 0x0043fc60): world up. */
export function levelUp(air: AirState, id: number): void {
  air.ux[id] = 0;
  air.uy[id] = AIRCRAFT_HEADING_ONE;
  air.uz[id] = 0;
  air.upY[id] = AIRCRAFT_HEADING_ONE;
}

/**
 * How far a tick carries an aircraft, wu (0x00420b84): `speed * delta >> 8`
 * scaled by `0x200 - ((0x10000 - |m(1,1)|) * 2 * 15/16 >> 8)` over 0x200 — the
 * bank's (and pitch's) speed penalty, `(0x200 - tilt) >> 9`.
 */
export function travelWu(speedRaw: number, upY: number): number {
  let tilt = (AIRCRAFT_HEADING_ONE - upY) * 2;
  tilt -= (tilt + ((tilt >> 31) & 0xf)) >> 4;
  const factor = 0x200 - (tilt >> 8);
  return (factor * ((speedRaw * AIRCRAFT_DELTA_UNITS) >> 8)) >> 9;
}

/**
 * One tick of `aircraft_fly` for aircraft `id`, toward the point (dx, dy)
 * metres away (reversed inside the standoff): the heading step (flyHeading)
 * with the altitude controller's command (verticalCommand, the coarse floor
 * sampled once, 0x00420a31), the travel with its bank penalty (travelWu) along
 * the 3D heading, the clamp up to the floor (0x00420c25), and the rotation's up
 * row for the next tick's penalty. Positions move in whole world units.
 */
export function aircraftFly(
  state: SimState,
  id: number,
  dx: number,
  dy: number,
  reverse: boolean,
  turn: number,
  speedRaw: number,
  f: AircraftFlight,
): void {
  const ent = state.ent;
  const air = state.air;
  let ix = Math.floor(dx * WU_PER_METRE);
  let iz = Math.floor(dy * WU_PER_METRE);
  if (reverse) {
    ix = -ix;
    iz = -iz;
  }
  const xw = Math.floor(ent.posX[id] * WU_PER_METRE);
  const zw = Math.floor(ent.posY[id] * WU_PER_METRE);
  const yw = Math.floor(ent.height[id] * WU_PER_METRE);
  const floor = floorWu(state, ent.posX[id], ent.posY[id], f);
  const s = flyScratch;
  s.hx = air.hx[id];
  s.hy = air.hy[id];
  s.hz = air.hz[id];
  s.sx = air.sx[id];
  s.sy = air.sy[id];
  s.sz = air.sz[id];
  flyHeading(ix, iz, verticalCommand(yw, floor, f), turn);
  const travel = travelWu(speedRaw, air.upY[id]);
  const mx = fixedMul(travel, s.hx);
  const mz = fixedMul(travel, s.hz);
  let ny = yw + fixedMul(travel, s.hy);
  if (ny < floor) ny = floor;
  const extent = worldExtent(state.map) * WU_PER_METRE;
  let nx = xw + mx;
  let nz = zw + mz;
  nx = nx < 0 ? 0 : nx > extent ? Math.floor(extent) : nx;
  nz = nz < 0 ? 0 : nz > extent ? Math.floor(extent) : nz;
  ent.posX[id] = nx / WU_PER_METRE;
  ent.posY[id] = nz / WU_PER_METRE;
  ent.height[id] = ny / WU_PER_METRE;
  ent.velX[id] = ((nx - xw) * TICK_HZ) / WU_PER_METRE;
  ent.velY[id] = ((nz - zw) * TICK_HZ) / WU_PER_METRE;
  if (s.hx !== 0 || s.hz !== 0) ent.yaw[id] = atan2Poly(s.hz, s.hx);
  ent.animState[id] = ANIM_MOVING;
  air.hx[id] = s.hx;
  air.hy[id] = s.hy;
  air.hz[id] = s.hz;
  air.sx[id] = s.sx;
  air.sy[id] = s.sy;
  air.sz[id] = s.sz;
  // 0x00420c61..0x00420c81: the rotation from the heading and the steer's up.
  upRow(s.hx, s.hy, s.hz, s.sx, s.sy + AIRCRAFT_UP_BIAS, s.sz);
  storeUp(air, id);
}

/**
 * The launch climb (state 4, 0x0042087f): straight up by `speed * delta >> 9`
 * wu a tick, nothing horizontal, world up; true once the clearance over the
 * envelope less the half height passes the cruise altitude (into ENGAGE).
 */
export function aircraftClimb(
  state: SimState,
  id: number,
  speedRaw: number,
  f: AircraftFlight,
): boolean {
  const ent = state.ent;
  const yw = Math.floor(ent.height[id] * WU_PER_METRE) + ((speedRaw * AIRCRAFT_DELTA_UNITS) >> 9);
  ent.height[id] = yw / WU_PER_METRE;
  ent.velX[id] = 0;
  ent.velY[id] = 0;
  // 0x004208b9: the rotation from the heading and world up.
  const air = state.air;
  upRow(air.hx[id], air.hy[id], air.hz[id], 0, AIRCRAFT_HEADING_ONE, 0);
  storeUp(air, id);
  ent.animState[id] = ANIM_MOVING;
  return yw - (f.halfY << 4) - envelopeWu(state, ent.posX[id], ent.posY[id]) > f.altCruise << 4;
}

/**
 * Operation 4's crash (`aircraft_op4` 0x00420296..0x00420345): the heading
 * times the speed frozen as the velocity (`vec3_scale`), three `(rand & 0xfff)
 * - 0x800` as the tumble. The roll that spares 6 in 16 jets is the caller's.
 */
export function aircraftCrash(state: SimState, id: number, speedRaw: number): void {
  const air = state.air;
  air.vx[id] = fixedMul(air.hx[id], speedRaw);
  air.vy[id] = fixedMul(air.hy[id], speedRaw);
  air.vz[id] = fixedMul(air.hz[id], speedRaw);
  air.sx[id] = randInt(state, AIRCRAFT_TUMBLE_SPAN) - (AIRCRAFT_TUMBLE_SPAN >> 1);
  air.sy[id] = randInt(state, AIRCRAFT_TUMBLE_SPAN) - (AIRCRAFT_TUMBLE_SPAN >> 1);
  air.sz[id] = randInt(state, AIRCRAFT_TUMBLE_SPAN) - (AIRCRAFT_TUMBLE_SPAN >> 1);
}

/** `vec_mac` (0x004585b0)'s factored product: `(v >> 2) * (scale >> 2) >> 12`, 32-bit. */
function mac(v: number, scale: number): number {
  return ((v >> 2) * (scale >> 2)) >> 12;
}

/**
 * One tick of the tumble (state 3, 0x00420d5c; 0x00420e83..0x00420f28): while
 * the aircraft is above the surface (`terrain_surface_at`, here the
 * heightfield) by more than half its radius, the tumble loses 1/64 of the
 * velocity, gains `(3 - (rand & 0xf)) << 9` of fall, and both integrate by
 * `delta / 256`; the heading follows the velocity. True when it is down: the
 * tick that finds it so moves nothing.
 */
export function aircraftTumble(state: SimState, id: number): boolean {
  const ent = state.ent;
  const air = state.air;
  const yw = Math.floor(ent.height[id] * WU_PER_METRE);
  const surface = Math.floor(sampleHeight(state.map, ent.posX[id], ent.posY[id]) * WU_PER_METRE);
  const halfR = Math.floor(entityRadius(state, id) * WU_PER_METRE) >> 1;
  if (!(yw > surface + halfR)) {
    ent.velX[id] = 0;
    ent.velY[id] = 0;
    return true;
  }
  air.sx[id] += mac(air.vx[id], -0x400);
  air.sy[id] += mac(air.vy[id], -0x400);
  air.sz[id] += mac(air.vz[id], -0x400);
  air.sy[id] += (3 - randInt(state, 16)) << 9;
  const scale = AIRCRAFT_DELTA_UNITS << 8;
  air.vx[id] += mac(air.sx[id], scale);
  air.vy[id] += mac(air.sy[id], scale);
  air.vz[id] += mac(air.sz[id], scale);
  const xw = Math.floor(ent.posX[id] * WU_PER_METRE);
  const zw = Math.floor(ent.posY[id] * WU_PER_METRE);
  const extent = Math.floor(worldExtent(state.map) * WU_PER_METRE);
  let nx = xw + mac(air.vx[id], scale);
  let nz = zw + mac(air.vz[id], scale);
  nx = nx < 0 ? 0 : nx > extent ? extent : nx;
  nz = nz < 0 ? 0 : nz > extent ? extent : nz;
  ent.posX[id] = nx / WU_PER_METRE;
  ent.posY[id] = nz / WU_PER_METRE;
  ent.height[id] = (yw + mac(air.vy[id], scale)) / WU_PER_METRE;
  ent.velX[id] = ((nx - xw) * TICK_HZ) / WU_PER_METRE;
  ent.velY[id] = ((nz - zw) * TICK_HZ) / WU_PER_METRE;
  // 0x00420ee3: the heading is the velocity's direction.
  const vx = air.vx[id];
  const vy = air.vy[id];
  const vz = air.vz[id];
  const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (l > 0) {
    air.hx[id] = Math.floor((vx * AIRCRAFT_HEADING_ONE) / l);
    air.hy[id] = Math.floor((vy * AIRCRAFT_HEADING_ONE) / l);
    air.hz[id] = Math.floor((vz * AIRCRAFT_HEADING_ONE) / l);
  }
  if (vx !== 0 || vz !== 0) ent.yaw[id] = atan2Poly(vz, vx);
  // 0x00420ee3..0x00420f28: the rotation from the heading and the last up row
  // biased toward world up, so the tumble turns the body on from where it was.
  upRow(air.hx[id], air.hy[id], air.hz[id], air.ux[id], air.uy[id] + AIRCRAFT_UP_BIAS, air.uz[id]);
  storeUp(air, id);
  return false;
}

/**
 * The construct's placement and start (`aircraft_construct` 0x00420380) for a
 * new aircraft at its spawner (x, y already set): `alt_cruise << 4` above the
 * surface, or 0x20000 wu higher with spawn flag 2, or on the surface plus its
 * half height in the launch climb with flag 4; level, a heading drawn from the
 * whole turn (0x004205d1), the steer zeroed. Returns the surface it was placed
 * over, metres.
 */
export function placeAircraft(
  state: SimState,
  id: number,
  f: AircraftFlight,
  ground: number,
): boolean {
  const ent = state.ent;
  const air = state.air;
  const gw = Math.floor(ground * WU_PER_METRE);
  let climb = false;
  let yw = gw + (f.altCruise << 4);
  if ((f.spawn & AIRCRAFT_SPAWN_HIGH) !== 0) yw += AIRCRAFT_SPAWN_HIGH_RISE;
  else if ((f.spawn & AIRCRAFT_SPAWN_CLIMB) !== 0) {
    yw = gw + (f.halfY << 4);
    climb = true;
  }
  ent.height[id] = yw / WU_PER_METRE;
  air.sx[id] = 0;
  air.sy[id] = 0;
  air.sz[id] = 0;
  air.vx[id] = 0;
  air.vy[id] = 0;
  air.vz[id] = 0;
  const yaw = (randInt(state, 4096) / 4096) * TAU;
  air.hx[id] = Math.floor(cosLUT(yaw) * AIRCRAFT_HEADING_ONE);
  air.hy[id] = 0;
  air.hz[id] = Math.floor(sinLUT(yaw) * AIRCRAFT_HEADING_ONE);
  levelUp(air, id);
  air.phase[id] = climb ? AIR_CLIMB : AIR_FLY;
  ent.yaw[id] = yaw;
  ent.velX[id] = 0;
  ent.velY[id] = 0;
  return climb;
}

/**
 * Starts a PA aircraft as the construct does (0x00420380): placed by its
 * record (placeAircraft), in CRUISE (the records' state byte 1) on its cruise
 * dwell — or in the launch climb — to a destination drawn inside its box
 * (0x00420607), searching on its first tick (the timer starts at -1).
 */
export function startAircraft(state: SimState, id: number, ground: number): void {
  const ent = state.ent;
  const fortress = ent.archetype[id] === ARCHETYPE.FORTRESS;
  placeAircraft(state, id, aircraftFlight(state, id), ground);
  ent.mode[id] |= AIR_CRUISE;
  ent.timerC[id] = fortress ? FORTRESS_DWELL_CRUISE : GUARDIAN_DWELL_CRUISE;
  pickDestination(state, id);
  ent.cooldownB[id] = 0;
  ent.ammoB[id] = 0;
  ent.aimX[id] = 0;
}

/**
 * An aircraft's speed word (`+0xf4`): its record's raw `<< 12` over 300 (the
 * construct, 0x004204bc) — the jet's 2048 raw 27962, the Flying Fortress' 2457
 * 33546 — which `aircraft_fly` turns into `speed * delta >> 8` wu a tick: 4.0 and
 * 4.8 m/s level (fcop-re/ai-and-rules.md §4).
 */
export function airSpeedRaw(state: SimState, id: number): number {
  return state.ent.archetype[id] === ARCHETYPE.FORTRESS
    ? FORTRESS_AIRCRAFT_SPEED_RAW
    : GUARDIAN_AIRCRAFT_SPEED_RAW;
}

/** floor(log2(v)) for a positive 32-bit integer, 0 for 0 (`math_top_bit`). */
function topBit(v: number): number {
  return v <= 0 ? 0 : 31 - Math.clz32(v);
}

/**
 * Lane-follower on an arena without the original road graph (district-01, the
 * test maps — Metropolis' own lanes): seek the current waypoint, advance on
 * proximity; past the lane's far end (either direction), beeline the enemy gate.
 * Lanes are authored base 0 → base 1, so team 0 walks indices up and team 1 down.
 * It drives at the original's speed and, like the original's route follower,
 * never stops to fight: its guns fire on the move (SIM_VERSION 52; until then
 * anything hostile in its reach halted it, rules.md §4's Metropolis rule). On an
 * arena with the graph the unit is a route follower instead (route.ts routeTick).
 */
function moveGroundUnit(state: SimState, id: number, speed: number): void {
  const ent = state.ent;
  const map = state.map;

  const team = ent.team[id];
  const x = ent.posX[id];
  const y = ent.posY[id];
  const gate = map.bases[team ^ 1].gate;
  const laneIdx = ent.timerA[id];
  const lane = laneIdx < map.lanes.length ? map.lanes[laneIdx] : undefined;
  const wp = ent.timerB[id];
  const past = lane === undefined || wp < 0 || wp >= lane.length;
  const tx = past || lane === undefined ? gate.x : lane[wp].x;
  const ty = past || lane === undefined ? gate.y : lane[wp].y;

  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  if (!past && d2 <= WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
    ent.timerB[id] += team === 0 ? 1 : -1;
  }
  if (d2 > 0.0001) {
    const inv = 1 / Math.sqrt(d2);
    ent.velX[id] = dx * inv * speed;
    ent.velY[id] = dy * inv * speed;
    ent.yaw[id] = atan2Poly(dy, dx);
  } else {
    ent.velX[id] = 0;
    ent.velY[id] = 0;
  }
  stepAndSnap(state, id, false);
}

/** Integrates velocity, clamps to the map, snaps height (ground or air). */
function stepAndSnap(state: SimState, id: number, air: boolean): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  const moving = ent.velX[id] !== 0 || ent.velY[id] !== 0;
  if (moving) {
    // Axis-separated like the avatar stepper so walls block-and-slide; the y
    // check uses the already-updated x. Flyers ignore walls like terrain.
    // Walls are read on the deck the unit is standing on — entLayer from the
    // previous snap, which is also what pushApart already keys on. On a map
    // without per-deck lattices this is the same lattice either way.
    const layer = ent.entLayer[id];
    const x = ent.posX[id];
    const nx = Math.min(Math.max(x + ent.velX[id] * TICK_DT, 0), extent);
    if (air || !crossesWallX(map, x, nx, ent.posY[id], layer)) ent.posX[id] = nx;
    const y = ent.posY[id];
    const ny = Math.min(Math.max(y + ent.velY[id] * TICK_DT, 0), extent);
    if (air || !crossesWallY(map, ent.posX[id], y, ny, layer)) ent.posY[id] = ny;
    ent.animState[id] = ANIM_MOVING;
  }
  snapUnitHeight(state, id, air);
}

/**
 * Walker/ground layer resolution: among the base surface and every extra deck
 * present at (x, y), pick the HIGHEST whose surface is within STEP_SNAP above
 * the current height h (steppable). Anything higher is an overhang you walk
 * under; if only a far-below surface qualifies you are airborne and fall.
 * On single-story maps this returns { layer: 0, height: sampleHeight } —
 * bit-identical to the old ground path (No-op invariant). Shared by the avatar
 * stepper (sim.ts) and the unit snap below.
 */
export function resolveWalker(
  map: MapData,
  x: number,
  y: number,
  h: number,
): { layer: number; height: number } {
  return surfaceBelow(map, x, y, h + STEP_SNAP);
}

/**
 * The highest surface at (x, y) at or below `top`: the base surface, or the
 * highest extra deck present there whose surface is no higher than `top`. The
 * base surface answers even above `top` (inside terrain there is nothing else
 * to stand on). The walker asks from STEP_SNAP above its feet
 * (`resolveWalker`), the hover from HOVER_PROBE_LIFT above itself (sim.ts
 * `hoverSurface`), as the original's `terrain_surface_at` is asked from a point
 * above the mover.
 */
export function surfaceBelow(
  map: MapData,
  x: number,
  y: number,
  top: number,
): { layer: number; height: number } {
  const baseH = sampleHeight(map, x, y);
  if (map.layerHeights.length === 0) return { layer: 0, height: baseH };
  const s = map.size;
  const inv = 1 / map.cellSize;
  let i = Math.floor(x * inv);
  let j = Math.floor(y * inv);
  if (i < 0) i = 0;
  else if (i > s - 1) i = s - 1;
  if (j < 0) j = 0;
  else if (j > s - 1) j = s - 1;
  let bestLayer = 0;
  let bestH = baseH;
  for (let L = 0; L < map.layerHeights.length; L++) {
    if (map.layerMask[L][j * s + i] === 0) continue;
    const hs = sampleLayerHeight(map, L, x, y);
    if (hs <= top && hs > bestH) {
      bestLayer = L + 1;
      bestH = hs;
    }
  }
  return { layer: bestLayer, height: bestH };
}

/**
 * Worst uphill rise, in metres, among the sub-cell steps of one straight ground
 * segment that a walker could not climb. 0 means the whole segment is walkable.
 *
 * NOT part of the tick — nothing in `step()` calls this. It exists so that map
 * authoring, the stage-2 generator's report and the arena tests all answer "can
 * the player walk this?" with the SAME rule the avatar stepper uses, instead of
 * each carrying its own approximation. There were three different ones before it.
 *
 * It mirrors `sim.ts`'s horizontal gate exactly, and the two details that every
 * earlier copy got wrong are both load-bearing:
 *
 * - **Only uphill counts.** The stepper rejects a step on
 *   `rise > GROUND_EPS && rise > run * maxSlope`. A downhill drop is a fall the
 *   walker survives — gravity is integrated — not a wall. Taking `Math.abs`
 *   counted every descent as impassable, ~40% of the hits on the FCOP arenas.
 * - **Heights come from `resolveWalker`**, the function the stepper calls, with
 *   the resolved height carried forward as the walker's own. On a single-storey
 *   arena that is bit-identical to `sampleHeight`; on a layered one it stops a
 *   deck within STEP_SNAP reading as a cliff.
 *
 * The caller decides what an impassable rise means: a rise the JUMP clears
 * (JUMPABLE_RISE; none since SIM_VERSION 39) is still passable, because the gate is skipped while
 * airborne.
 */
export function worstUphillRise(
  map: MapData,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  // Math.sqrt, not Math.hypot: hypot is engine-dependent and banned in sim source
  // (determinismGuard.test.ts). Nothing in the tick calls this, so a desync was
  // never on the table — but living in packages/sim means living by its rules, and
  // sqrt-of-sum-of-squares is what the sim's own distance code uses.
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(len));
  const run = len / steps;
  let h = sampleHeight(map, ax, ay);
  let worst = 0;
  for (let t = 1; t <= steps; t++) {
    const f = t / steps;
    const next = resolveWalker(map, ax + dx * f, ay + dy * f, h).height;
    const rise = next - h;
    if (rise > 0 && rise / run >= AVATAR_WALKER_MAX_SLOPE && rise > worst) worst = rise;
    h = next;
  }
  return worst;
}

/**
 * Rise a walker clears by jumping where it cannot walk: NONE, on Metropolis'
 * terrain, since SIM_VERSION 39 (fcop-fidelity.md P4). Was 1.4 (an 8 m/s jump
 * against 20 m/s² with full air control). Paired with `worstUphillRise`: a
 * blocking rise above this is impassable for the walker — so now every one is.
 *
 * Why. The jumps are the original's, with no air control. Every terrain step
 * is a one-cell ramp (1 m cells, bilinear — as the original's terrain is), and
 * a step blocks only past the walk's 1.04 gradient (AVATAR_WALKER_MAX_SLOPE),
 * i.e. at 1.04 m and more over its cell. The standing HIGH jump (apex 1.37 m)
 * moves forward only by its 2.11 m/s lunge at 0.24 s, too late to cross a metre
 * of ramp before it comes down, and the lunge is withheld above 1.1 m anyway
 * (WALKER_LUNGE_MAX_RISE); the RUNNING LEAP (apex 0.91 m) clears less than the
 * walk does. avatarMovement.test.ts measures both against a 1.06 m step. The
 * original made its high jump for ledges with vertical faces, which the
 * heightfield has none of.
 */
export const JUMPABLE_RISE = 0;

/**
 * Per-tick travel of the hover, and therefore the resolution its slope gate is
 * evaluated at. `worstHoverRise` samples at this rather than at the metre
 * `worstUphillRise` uses, because the hover's rule reads two DIFFERENT distances:
 * measuring the step over a metre as well would smooth it into the span probe and
 * report a road the sim refuses to drive as clear.
 */
const HOVER_STEP = AVATAR_HOVER_SPEED * TICK_DT;

/**
 * Worst rise, in metres, among the sub-steps of one straight segment that the
 * HOVER could not cross. 0 means the whole segment is drivable in hover. The
 * sibling of `worstUphillRise`, for the other form, with the same contract: not
 * part of the tick, and it exists so that authoring, the stage-2 generator's
 * report and the arena tests all ask "can the player drive this?" with the rule
 * the avatar stepper uses.
 *
 * It mirrors the hover half of `sim.ts`'s `slopeBlocks`, which is two readings,
 * not one (issue #34): a step steeper than `AVATAR_HOVER_MAX_SLOPE` blocks only
 * if the ground `HOVER_CUSHION_SPAN` further on is over the limit too. Heights
 * come from `rideHeight` — the same import the stepper calls — so a dip below
 * the water surface reads as the surface the hover floats on.
 *
 * Both comparisons are STRICT, like the gate's: a rise of exactly `run × limit`
 * is one the sim takes, so reporting it as blocked would be an authoring tool
 * disagreeing with the sim about the boundary. (Its walker sibling above uses
 * `>=`, which over-reports there; that is pre-existing, and its counts are
 * pinned per arena, so it is left to a change that measures the difference.)
 *
 * Unlike the walker's, this measure has no jump to fall back on: a rise it
 * reports is impassable in hover, full stop. Transform or route around.
 */
export function worstHoverRise(
  map: MapData,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return 0;
  const steps = Math.max(1, Math.ceil(len / HOVER_STEP));
  const run = len / steps;
  const ux = dx / len;
  const uy = dy / len;
  const extent = worldExtent(map);
  let h = rideHeight(map, ax, ay, true);
  let worst = 0;
  for (let t = 1; t <= steps; t++) {
    const f = t / steps;
    const next = rideHeight(map, ax + dx * f, ay + dy * f, true);
    const rise = next - h;
    // `rise > run * limit` already implies `rise > 0`, and at this run length it
    // implies the gate's GROUND_EPS too, so this IS the gate's step condition.
    if (rise > run * AVATAR_HOVER_MAX_SLOPE && rise > worst) {
      // Steep in the step; consult the span, from where the step began.
      const g = (t - 1) / steps;
      const px = Math.min(Math.max(ax + dx * g + ux * HOVER_CUSHION_SPAN, 0), extent);
      const py = Math.min(Math.max(ay + dy * g + uy * HOVER_CUSHION_SPAN, 0), extent);
      const span = rideHeight(map, px, py, true) - h;
      if (span > HOVER_CUSHION_SPAN * AVATAR_HOVER_MAX_SLOPE) worst = rise;
    }
    h = next;
  }
  return worst;
}

/** Height rule shared by movement, separation and spawning. */
export function snapUnitHeight(state: SimState, id: number, air: boolean): void {
  const ent = state.ent;
  // An aircraft's height is its flight's (aircraftFly, placeAircraft).
  if (air) return;
  const wr = resolveWalker(state.map, ent.posX[id], ent.posY[id], ent.height[id]);
  ent.entLayer[id] = wr.layer;
  ent.height[id] = wr.height;
}

/**
 * Radial separation between FRIENDLY ground units (architecture.md §2):
 * symmetric pairwise push in dense id order — deterministic on every peer.
 * Enemies are left to fight, flyers stack freely.
 */
export function separateGroundUnits(state: SimState): void {
  const ent = state.ent;
  const extent = worldExtent(state.map);
  for (let i = 0; i < ent.high; i++) {
    if (!ent.alive[i] || !isGroundUnit(ent.archetype[i])) continue;
    for (let j = i + 1; j < ent.high; j++) {
      if (!ent.alive[j] || !isGroundUnit(ent.archetype[j])) continue;
      if (ent.team[j] !== ent.team[i]) continue;
      if (ent.entLayer[j] !== ent.entLayer[i]) continue; // never push across decks
      const dx = ent.posX[j] - ent.posX[i];
      const dy = ent.posY[j] - ent.posY[i];
      const d2 = dx * dx + dy * dy;
      if (d2 >= UNIT_SEPARATION_RADIUS * UNIT_SEPARATION_RADIUS) continue;
      let px: number;
      let py: number;
      if (d2 > 0.000001) {
        const d = Math.sqrt(d2);
        const overlap = (UNIT_SEPARATION_RADIUS - d) * UNIT_SEPARATION_PUSH * 0.5;
        px = (dx / d) * overlap;
        py = (dy / d) * overlap;
      } else {
        // Exactly stacked (same-tick console spam): split along +x by id order.
        px = UNIT_SEPARATION_RADIUS * UNIT_SEPARATION_PUSH * 0.5;
        py = 0;
      }
      // Same axis-separated wall clamp as stepAndSnap — without it the
      // separation push would shove ground units through walls.
      const map = state.map;
      const nix = Math.min(Math.max(ent.posX[i] - px, 0), extent);
      if (!crossesWallX(map, ent.posX[i], nix, ent.posY[i])) ent.posX[i] = nix;
      const niy = Math.min(Math.max(ent.posY[i] - py, 0), extent);
      if (!crossesWallY(map, ent.posX[i], ent.posY[i], niy)) ent.posY[i] = niy;
      const njx = Math.min(Math.max(ent.posX[j] + px, 0), extent);
      if (!crossesWallX(map, ent.posX[j], njx, ent.posY[j])) ent.posX[j] = njx;
      const njy = Math.min(Math.max(ent.posY[j] + py, 0), extent);
      if (!crossesWallY(map, ent.posX[j], ent.posY[j], njy)) ent.posY[j] = njy;
      snapUnitHeight(state, i, false);
      snapUnitHeight(state, j, false);
    }
  }
}

export function isGroundUnit(archetype: number): boolean {
  return archetype === ARCHETYPE.RUNNER || archetype === ARCHETYPE.JUGGERNAUT;
}

export function isAirUnit(archetype: number): boolean {
  return archetype === ARCHETYPE.GUARDIAN || archetype === ARCHETYPE.FORTRESS;
}

export function isUnit(archetype: number): boolean {
  return isGroundUnit(archetype) || isAirUnit(archetype);
}
