// Unit movement (architecture.md §2 "unit lane-following" slot).
//
// On an arena that carries the original road graph (the imported Precinct
// Assault arenas, rules.md §9) Runners and Juggernauts are the original's route
// followers (fcop-fidelity.md U1/U2; fcop-re/ai-and-rules.md §4): at every node
// the step chooser picks one of up to four links — a Runner seeking the nearest
// enemy within 16 m on 60 % of steps, at random otherwise; a Juggernaut always
// at random — never stepping straight back; they walk the legs at 1.98 m/s, slow
// for traffic in 1 s holds and never stop to fight (their guns fire on the move).
// Elsewhere they follow Metropolis' authored lane polylines toward the enemy
// gate and halt for anything hostile in attack range (rules.md §4). Guardians
// and Fortresses are the original's aircraft on the imported arenas (search,
// leash, standoff; moveAircraft) and fly patrol orbits or assault runs elsewhere.
//
// Per-archetype field reuse on unit entities (see entities.ts):
//   timerA    — ground: lane index, or on the graph the node it walks to (-1 halted)
//               · air: patrol orbit angle (radians)
//   timerB    — ground: current waypoint index (past either end = seek gate), or
//               on the graph the traffic hold in ticks (0 = none)
//   cooldownB — ground on the graph: the node it came from (-1 none)
//   ammoB     — ground on the graph: the node before that, + 1 (0 = none)
//   aimX      — ground on the graph: the commanded speed, m/s
//   mode      — GUARDIAN: UNIT_MODE_PATROL | UNIT_MODE_ASSAULT (spawn-site switch);
//               on a PA arena the aircraft's anchor (0 base, 1 + k outpost k)
//   (a PA aircraft's own reuse is listed at moveAircraft)

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
import {
  AIR_ALTITUDE,
  AIRCRAFT_CRUISE_JITTER,
  AIRCRAFT_CRUISE_TICKS,
  AIRCRAFT_REVERSE_JITTER,
  AIRCRAFT_REVERSE_TICKS,
  AIRCRAFT_SEARCH_JITTER,
  AIRCRAFT_SEARCH_TICKS,
  AIRCRAFT_STANDOFF,
  ARCHETYPE_RADIUS,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_WALKER_MAX_SLOPE,
  FORTRESS_AIRCRAFT_SPEED,
  FORTRESS_DETECT_RANGE,
  FORTRESS_LEASH_X,
  FORTRESS_LEASH_Y,
  GUARDIAN_AIRCRAFT_SPEED,
  GUARDIAN_DETECT_RANGE,
  GUARDIAN_LEASH_X,
  GUARDIAN_LEASH_Y,
  HOVER_CUSHION_SPAN,
  ROUTE_CONE_COS,
  ROUTE_HOLD_TICKS,
  ROUTE_NEAR_BLOCK,
  ROUTE_NEAR_GAP,
  ROUTE_NEAR_MIN_LEN,
  ROUTE_NEAR_RISE,
  ROUTE_NODE_UNITS,
  ROUTE_SCORE_NO_LINK,
  ROUTE_SCORE_PREV,
  ROUTE_SCORE_PREV2,
  ROUTE_SEEK_RANGE,
  ROUTE_TOP_SPEED,
  ROUTE_WANDER,
  TARGET_PRIORITY_AVATAR,
  TARGET_PRIORITY_JUGGERNAUT,
  TARGET_PRIORITY_RUNNER,
  TICK_DT,
  UNIT_SEPARATION_PUSH,
  UNIT_SEPARATION_RADIUS,
  WAYPOINT_RADIUS,
} from "./balance";
import { crossesWallX, crossesWallY, segmentBlocked } from "./collision";
import { type MapData, resolveHeight, sampleHeight, sampleLayerHeight, worldExtent } from "./map";
import { ANIM_MOVING, rideHeight, type SimState, STEP_SNAP } from "./sim";
import { atan2Poly, cosLUT, rand01, randInt, sinLUT } from "./simMath";

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
 * "halts the unit" and "gets shot" agree exactly. Turret callers pass
 * `skipStructures` — turrets only ever fire at mobile targets, never at
 * turrets or consoles — while units DO engage structures in their path.
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
      case ARCHETYPE.JUGGERNAUT:
        if (routes) moveRouteFollower(state, id);
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
  if (!routes) separateGroundUnits(state);
}

/**
 * A PA aircraft's anchor — the spawner it was built at, which its patrol leash
 * is measured from (the original's `anchor`, the record's own position): the
 * base air console for a base-built one (mode 0), outpost k's spot for one built
 * there (mode 1 + k).
 */
function aircraftAnchorX(state: SimState, id: number): number {
  const m = state.ent.mode[id];
  const spots = state.map.outpostSpots;
  if (m >= 1 && m - 1 < spots.length) return spots[m - 1].x;
  return state.map.bases[state.ent.team[id]].airConsole.x;
}

function aircraftAnchorY(state: SimState, id: number): number {
  const m = state.ent.mode[id];
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
 * Is this aircraft engaging — holding a move target, inside its leash and not
 * cruising? Its shooter fires only then (sim.ts shooterUnit; the original steps
 * an aircraft's weapon in STATE_ENGAGE only).
 */
export function aircraftEngaged(state: SimState, id: number): boolean {
  const ent = state.ent;
  return ent.ammoB[id] > 0 && ent.timerC[id] <= 0 && insideLeash(state, id);
}

/** A new patrol destination inside half the leash (`aircraft_pick_destination`). */
function pickDestination(state: SimState, id: number): void {
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
 * 0x00420700; fcop-re/ai-and-rules.md §4, camera-and-movement.md "Aircraft"):
 * - every 900 + rand 0..511 engine units (3.0-4.7 s) it searches for a target
 *   (aircraftSearch) and keeps it until it dies;
 * - engaging (a target, inside its leash) it flies at the target and its gun
 *   fires; outside the leash — ±24 × ±20 m around its anchor for a jet,
 *   ±30 × ±28 m for a Fortress (orbit_area raw / 1024) — it picks a destination
 *   inside half the leash and cruises there for 4.0-10.8 s (0x4b0 + rand 0..0x7ff
 *   units) with its gun silent; with no target it cruises to a destination;
 * - inside the 1 m standoff of whatever it flies at it reverses, and keeps
 *   reversing for 0.5-0.9 s (150 + rand 0..127 units): it circles and jitters
 *   about its target instead of stopping. It never halts.
 * Field reuse: timerA/timerB the destination, timerC the cruise countdown,
 * cooldownB the search countdown (ticks), ammoB the target + 1, aimX the
 * reverse countdown (ticks), mode the anchor (aircraftAnchorX).
 * Not modelled (not in the extracted records): the ENGAGE / CRUISE dwell timers
 * of a target-less patrol (it re-draws its destination on arrival instead), the
 * turn rate (it turns at once) and the altitude controller (AIR_ALTITUDE).
 */
function moveAircraft(state: SimState, id: number): void {
  const ent = state.ent;
  ent.cooldownB[id] -= 1;
  if (ent.cooldownB[id] < 0) {
    ent.cooldownB[id] = AIRCRAFT_SEARCH_TICKS + randInt(state, AIRCRAFT_SEARCH_JITTER);
    const found = aircraftSearch(state, id);
    if (found >= 0) ent.ammoB[id] = found + 1;
  }
  let target = ent.ammoB[id] - 1;
  if (target >= 0) {
    const tt = ent.team[target];
    if (!ent.alive[target] || tt === ent.team[id] || tt === TEAM_NEUTRAL) {
      target = -1;
      ent.ammoB[id] = 0;
      pickDestination(state, id);
    }
  }
  if (ent.timerC[id] > 0) ent.timerC[id] -= 1;
  let tx: number;
  let ty: number;
  if (ent.timerC[id] <= 0 && target >= 0 && !insideLeash(state, id)) {
    // Off the leash: a fresh destination and a long cruise, gun silent.
    pickDestination(state, id);
    ent.timerC[id] = AIRCRAFT_CRUISE_TICKS + randInt(state, AIRCRAFT_CRUISE_JITTER);
  }
  if (ent.timerC[id] <= 0 && target >= 0) {
    tx = ent.posX[target];
    ty = ent.posY[target];
  } else {
    tx = ent.timerA[id];
    ty = ent.timerB[id];
  }
  let dx = tx - ent.posX[id];
  let dy = ty - ent.posY[id];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (target < 0 && d < AIRCRAFT_STANDOFF) {
    pickDestination(state, id); // a target-less patrol moves on
  }
  // The standoff reverse, and its countdown.
  let reverse = false;
  if (d < AIRCRAFT_STANDOFF) {
    reverse = true;
    if (ent.aimX[id] <= 0) {
      ent.aimX[id] = AIRCRAFT_REVERSE_TICKS + randInt(state, AIRCRAFT_REVERSE_JITTER);
    }
  } else if (ent.aimX[id] > 0) {
    reverse = true;
  }
  if (ent.aimX[id] > 0) ent.aimX[id] -= 1;
  if (d > 1e-6) {
    dx /= d;
    dy /= d;
  } else {
    dx = cosLUT(ent.yaw[id]);
    dy = sinLUT(ent.yaw[id]);
  }
  if (reverse) {
    dx = -dx;
    dy = -dy;
  }
  const speed = airSpeed(state, id);
  ent.velX[id] = dx * speed;
  ent.velY[id] = dy * speed;
  ent.yaw[id] = atan2Poly(dy, dx);
  stepAndSnap(state, id, true);
}

/**
 * Starts a PA aircraft: its destination is where it was built and it searches on
 * its first tick.
 */
export function startAircraft(state: SimState, id: number): void {
  const ent = state.ent;
  ent.timerA[id] = ent.posX[id];
  ent.timerB[id] = ent.posY[id];
  ent.timerC[id] = 0;
  ent.cooldownB[id] = 0;
  ent.ammoB[id] = 0;
  ent.aimX[id] = 0;
}

/**
 * An aircraft's level-flight speed: the original's records (jet 2048 raw = 4.0
 * m/s, Flying Fortress 2457 = 4.8 m/s; fcop-re/ai-and-rules.md §4), on every
 * arena since SIM_VERSION 52.
 */
export function airSpeed(state: SimState, id: number): number {
  return state.ent.archetype[id] === ARCHETYPE.FORTRESS
    ? FORTRESS_AIRCRAFT_SPEED
    : GUARDIAN_AIRCRAFT_SPEED;
}

/** True when ground units on this map follow the original's routes (rules.md §9). */
export function followsRoutes(state: SimState): boolean {
  return state.map.laneGraph !== undefined;
}

/** floor(log2(v)) for a positive 32-bit integer, 0 for 0 (`math_top_bit`). */
function topBit(v: number): number {
  return v <= 0 ? 0 : 31 - Math.clz32(v);
}

/**
 * The original's step chooser (`cnet_route_next`, retail 0x00440f70;
 * fcop-re/ai-and-rules.md §4): which neighbour of `from` the follower walks to
 * next. Returns the node, or -1 when every link is refused (the follower halts).
 *
 * - A Runner (the PA tank: SEEK_TEAM, wander 1638/4096, search 16 m) first rolls
 *   the wander: 40 % of steps are random. Otherwise it looks for the nearest
 *   enemy-team actor within ROUTE_SEEK_RANGE; none found makes the step random.
 *   The target is found afresh at every step (retail drops the held one).
 * - A Juggernaut (the Dreadnought: mode 0) always steps at random.
 * - Each of up to four links is scored: no link -4, the node just left -2
 *   (refused), the node before that -1 (the dead-end escape, eligible but below
 *   every real score). Seeking scores the dot product of the step with the
 *   direction to the target, in node units (1/32 m), by octave:
 *   32 + floor(log2 dot) for dot >= 0, 31 - floor(log2 -dot) below. Random
 *   scores a 16-bit draw. Then the occupancy: a positive score is shifted right
 *   once per follower already heading to that node.
 * - The pick walks the links from the fourth to the first, keeping the higher
 *   score; a tie is a coin flip.
 *
 * Every draw is the sim PRNG, in a fixed order, so every peer picks the same.
 * The original's script-closed node bit is not imported (no PA script toggles
 * a node the routes use is not established either), so -3 never occurs.
 */
function chooseNext(state: SimState, id: number, from: number): number {
  const ent = state.ent;
  const g = state.map.laneGraph;
  if (g === undefined || from < 0 || from >= g.nodes.length) return -1;
  const prev = ent.cooldownB[id];
  const prev2 = ent.ammoB[id] - 1;
  const here = g.nodes[from];
  const hx = Math.round(here.x * ROUTE_NODE_UNITS);
  const hy = Math.round(here.y * ROUTE_NODE_UNITS);

  // The roll and the target, before any candidate (retail's order).
  let seek = -1;
  if (ent.archetype[id] === ARCHETYPE.RUNNER) {
    if (randInt(state, 4096) >= ROUTE_WANDER) seek = seekTarget(state, id);
  }
  // Retail's `>> 8` of a world position is a floor in node units.
  const tx = seek >= 0 ? Math.floor(ent.posX[seek] * ROUTE_NODE_UNITS) : 0;
  const ty = seek >= 0 ? Math.floor(ent.posY[seek] * ROUTE_NODE_UNITS) : 0;

  for (let s = 0; s < 4; s++) {
    const link = g.edges[from * 4 + s];
    let score: number;
    if (link < 0) score = ROUTE_SCORE_NO_LINK;
    else if (link === prev) score = ROUTE_SCORE_PREV;
    else if (link === prev2) score = ROUTE_SCORE_PREV2;
    else {
      if (seek >= 0) {
        const c = g.nodes[link];
        const cx = Math.round(c.x * ROUTE_NODE_UNITS);
        const cy = Math.round(c.y * ROUTE_NODE_UNITS);
        const dot = (cx - hx) * (tx - hx) + (cy - hy) * (ty - hy);
        score = dot >= 0 ? topBit(dot) + 0x20 : 0x1f - topBit(-dot);
      } else {
        score = randInt(state, 0x10000);
      }
      const crowd = occupancy(state, id, link);
      if (crowd > 0 && score > 0) score = Math.floor(score / (1 << crowd));
    }
    routeScores[s] = score;
  }
  let best = ROUTE_SCORE_NO_LINK;
  let chosen = -1;
  for (let s = 3; s >= 0; s--) {
    const score = routeScores[s];
    if (score < ROUTE_SCORE_PREV2 || score < best) continue;
    if (score === best && randInt(state, 2) !== 0) continue;
    best = score;
    chosen = s;
  }
  return chosen < 0 ? -1 : g.edges[from * 4 + chosen];
}

/** Per-candidate scores of the step chooser (module scratch, no allocation). */
const routeScores = new Int32Array(4);

/**
 * How many route followers on the same net are already heading to `node` (the
 * original's occupancy nibble, saturating at 15). Each team's units walk their
 * own net, so only the follower's own team counts.
 */
function occupancy(state: SimState, id: number, node: number): number {
  const ent = state.ent;
  const team = ent.team[id];
  let n = 0;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id || ent.team[t] !== team) continue;
    if (!isGroundUnit(ent.archetype[t]) || ent.timerA[t] !== node) continue;
    if (++n === 15) break;
  }
  return n;
}

/**
 * The SEEK_TEAM search: the nearest live enemy-team actor within
 * ROUTE_SEEK_RANGE (horizontal), in dense id order (`cact_find_target`, mode
 * NEAREST, no cone, no line of sight). Projectiles and Metropolis' outpost
 * consoles are not actors of the original; a cloaked avatar is skipped as the
 * original's searches skip it (fcop-fidelity.md P7). -1 for none.
 */
function seekTarget(state: SimState, id: number): number {
  const ent = state.ent;
  const team = ent.team[id];
  const x = ent.posX[id];
  const y = ent.posY[id];
  let hidden0 = -1;
  let hidden1 = -1;
  if (state.buffInvis.length > 0) {
    if (state.buffInvis[0] > 0) hidden0 = state.avatarId[0];
    if (state.buffInvis[1] > 0) hidden1 = state.avatarId[1];
  }
  let best = -1;
  let bestD2 = ROUTE_SEEK_RANGE * ROUTE_SEEK_RANGE;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id || t === hidden0 || t === hidden1) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    const a = ent.archetype[t];
    if (a === ARCHETYPE.PROJECTILE || a === ARCHETYPE.CONSOLE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = t;
    }
  }
  return best;
}

/**
 * The original's answer to "something came close" (`cnet_route_near_actor`,
 * retail 0x004248f0; fcop-re/ai-and-rules.md §4): it decides how fast, never
 * where. The follower reacts to its single nearest neighbour (the pair test's)
 * whose gap — centre distance less both radii — is under ROUTE_NEAR_GAP, within
 * ROUTE_NEAR_RISE vertically and inside the ROUTE_CONE_COS cone ahead:
 * - another route follower: on the same net heading for the same node, the one
 *   with more of its leg left yields; for another node, it yields only if the
 *   other comes from where it is going (else its hold is released). Yielding
 *   is half the other's speed, capped at its own top, for ROUTE_HOLD_TICKS, and
 *   releases the other's hold (the deadlock breaker). The other net (the enemy
 *   team's) always yields.
 * - anything else: within ROUTE_NEAR_BLOCK dead ahead it stops; otherwise half
 *   its own speed plus a quarter of the top, for ROUTE_HOLD_TICKS.
 * The Juggernaut (the Dreadnought's route flag 0x8, CNET_ROUTE_NO_TRAFFIC)
 * does not react at all. Aircraft sit far outside the vertical band.
 */
function routeTraffic(state: SimState, id: number, hx: number, hy: number): void {
  const ent = state.ent;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const h = ent.height[id];
  const r = ARCHETYPE_RADIUS[ent.archetype[id]];
  let near = -1;
  let nearGap = ROUTE_NEAR_GAP;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    const a = ent.archetype[t];
    if (a === ARCHETYPE.PROJECTILE || a === ARCHETYPE.CONSOLE) continue;
    const dz = ent.height[t] - h;
    if (dz > ROUTE_NEAR_RISE || dz < -ROUTE_NEAR_RISE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const gap = Math.sqrt(dx * dx + dy * dy) - r - ARCHETYPE_RADIUS[a];
    if (gap < nearGap) {
      nearGap = gap;
      near = t;
    }
  }
  if (near < 0) return;
  const dx = ent.posX[near] - x;
  const dy = ent.posY[near] - y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len >= ROUTE_NEAR_MIN_LEN && (dx * hx + dy * hy) / len <= ROUTE_CONE_COS) return;

  const top = ROUTE_TOP_SPEED;
  if (isGroundUnit(ent.archetype[near]) && followsRoutes(state)) {
    let yieldNow = true;
    if (ent.team[near] === ent.team[id]) {
      const node = ent.timerA[id];
      if (ent.timerA[near] === node) {
        yieldNow = legLeft(state, near) < legLeft(state, id);
      } else if (ent.cooldownB[near] !== node) {
        ent.timerB[id] = 1; // not in each other's way: release the hold
        return;
      }
    }
    if (!yieldNow) return;
    const other = Math.sqrt(ent.velX[near] * ent.velX[near] + ent.velY[near] * ent.velY[near]);
    ent.aimX[id] = Math.min(other * 0.5, top);
    ent.timerB[id] = ROUTE_HOLD_TICKS;
    if (ent.timerB[near] > 0 && ent.archetype[near] !== ARCHETYPE.JUGGERNAUT) ent.timerB[near] = 1;
    return;
  }
  if (len < ROUTE_NEAR_BLOCK) {
    ent.aimX[id] = 0;
  } else {
    const own = Math.sqrt(ent.velX[id] * ent.velX[id] + ent.velY[id] * ent.velY[id]);
    ent.aimX[id] = own * 0.5 + top * 0.25;
  }
  ent.timerB[id] = ROUTE_HOLD_TICKS;
}

/** Metres left of a follower's current leg (to its target node). */
function legLeft(state: SimState, id: number): number {
  const g = state.map.laneGraph;
  const node = state.ent.timerA[id];
  if (g === undefined || node < 0) return 0;
  const dx = g.nodes[node].x - state.ent.posX[id];
  const dy = g.nodes[node].y - state.ent.posY[id];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * A route follower's tick (`cnet_route_tick`, retail 0x004402a0): the hold
 * clock, the traffic reaction, then the walk. The walk is along the leg itself —
 * a leg is complete when the distance travelled reaches it, with no arrival
 * radius, and an overshoot carries into the next leg — so a follower is on the
 * original's road at every tick and neither walls nor a separation push move
 * it (the original's route followers collide with neither; the arena pipeline
 * opened every road's wall bits). Acceleration is the original's full speed in
 * one engine tick, so the commanded speed is the speed.
 *
 * Not modelled: the corner window's heading blend and inward cut (position on
 * the straight leg, heading snapped at the node), and the look-ahead (the
 * original chooses the next node when a leg starts; this chooses on arrival).
 */
function moveRouteFollower(state: SimState, id: number): void {
  const ent = state.ent;
  const g = state.map.laneGraph;
  if (g === undefined) return;

  // The hold clock: when it runs out the commanded speed is the top again.
  if (ent.timerB[id] > 0) {
    ent.timerB[id] -= 1;
    if (ent.timerB[id] <= 0) {
      ent.timerB[id] = 0;
      ent.aimX[id] = ROUTE_TOP_SPEED;
    }
  }

  let node = ent.timerA[id];
  if (node < 0) {
    halt(ent, id);
    snapUnitHeight(state, id, false);
    return;
  }
  let nd = g.nodes[node];
  let dx = nd.x - ent.posX[id];
  let dy = nd.y - ent.posY[id];
  let d = Math.sqrt(dx * dx + dy * dy);
  let hx = d > 1e-6 ? dx / d : cosLUT(ent.yaw[id]);
  let hy = d > 1e-6 ? dy / d : sinLUT(ent.yaw[id]);
  if (ent.archetype[id] !== ARCHETYPE.JUGGERNAUT) routeTraffic(state, id, hx, hy);

  const speed = ent.aimX[id];
  let travel = speed * TICK_DT;
  // Arrival is a loop: an overshoot walks on into the next leg.
  for (let guard = 0; guard < 8 && travel >= d; guard++) {
    travel -= d;
    ent.posX[id] = nd.x;
    ent.posY[id] = nd.y;
    if (nd.layer !== ent.entLayer[id]) {
      // Deck roads (issue #33): the node is on the surface the road is on.
      ent.height[id] = resolveHeight(state.map, nd.x, nd.y, nd.layer);
      ent.entLayer[id] = nd.layer;
    }
    const next = chooseNext(state, id, node);
    ent.ammoB[id] = ent.cooldownB[id] + 1;
    ent.cooldownB[id] = node;
    ent.timerA[id] = next;
    if (next < 0) {
      halt(ent, id);
      snapUnitHeight(state, id, false);
      return;
    }
    node = next;
    nd = g.nodes[node];
    dx = nd.x - ent.posX[id];
    dy = nd.y - ent.posY[id];
    d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-6) {
      hx = dx / d;
      hy = dy / d;
    }
  }
  if (travel > 0 && d > 1e-6) {
    ent.posX[id] += hx * travel;
    ent.posY[id] += hy * travel;
  }
  ent.velX[id] = hx * speed;
  ent.velY[id] = hy * speed;
  ent.yaw[id] = atan2Poly(hy, hx);
  ent.animState[id] = speed > 0 ? ANIM_MOVING : 0;
  snapUnitHeight(state, id, false);
}

function halt(ent: SimState["ent"], id: number): void {
  ent.velX[id] = 0;
  ent.velY[id] = 0;
  ent.animState[id] = 0;
}

/**
 * Starts a ground unit on its team's road: `start` is the node it walks to
 * first (the entry node, or for an outpost spawn the nearest node of its own
 * net). From the production console that first leg is a straight walk to the
 * node, as before.
 */
export function startRoute(state: SimState, id: number, start: number): void {
  const ent = state.ent;
  ent.timerA[id] = start;
  ent.cooldownB[id] = -1;
  ent.ammoB[id] = 0;
  ent.timerB[id] = 0;
  ent.aimX[id] = ROUTE_TOP_SPEED;
}

/**
 * Lane-follower on an arena without the original road graph (district-01, the
 * test maps — Metropolis' own lanes): seek the current waypoint, advance on
 * proximity; past the lane's far end (either direction), beeline the enemy gate.
 * Lanes are authored base 0 → base 1, so team 0 walks indices up and team 1 down.
 * It drives at the original's speed and, like the original's route follower,
 * never stops to fight: its guns fire on the move (SIM_VERSION 52; until then
 * anything hostile in its reach halted it, rules.md §4's Metropolis rule). On an
 * arena with the graph the unit is a route follower instead (moveRouteFollower).
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
  if (air) {
    const g = sampleHeight(state.map, ent.posX[id], ent.posY[id]);
    const floor = g < state.map.waterLevel ? state.map.waterLevel : g;
    ent.height[id] = floor + AIR_ALTITUDE;
    return;
  }
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
