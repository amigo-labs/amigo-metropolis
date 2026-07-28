// Unit movement (architecture.md §2 "unit lane-following" slot): Runners and
// Juggernauts follow authored lane polylines toward the enemy gate, Guardians
// and Fortresses fly patrol orbits or assault runs. Units are dumb on purpose
// (rules.md pillar 3): no retreating, no prioritization — an enemy in attack
// range simply halts them (shooting happens in the targeting system).
//
// Per-archetype field reuse on unit entities (see entities.ts):
//   timerA — ground: lane index · air: patrol orbit angle (radians)
//   timerB — ground: current waypoint index (past either end = seek gate)
//   mode   — GUARDIAN: UNIT_MODE_PATROL | UNIT_MODE_ASSAULT (spawn-site switch)

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
import {
  AIR_ALTITUDE,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_WALKER_MAX_SLOPE,
  FORTRESS_PATROL_RADIUS,
  FORTRESS_RANGE,
  FORTRESS_SPEED,
  GRAPH_WAYPOINT_RADIUS,
  GUARDIAN_ASSAULT_STANDOFF,
  GUARDIAN_PATROL_RADIUS,
  GUARDIAN_RANGE,
  GUARDIAN_SPEED,
  HOVER_CUSHION_SPAN,
  JUGGERNAUT_RANGE,
  JUGGERNAUT_SPEED,
  ORBIT_ANGULAR_SPEED,
  RUNNER_RANGE,
  RUNNER_SPEED,
  TICK_DT,
  UNIT_SEPARATION_PUSH,
  UNIT_SEPARATION_RADIUS,
  WAYPOINT_RADIUS,
} from "./balance";
import { crossesWallX, crossesWallY, segmentBlocked } from "./collision";
import { type MapData, sampleHeight, sampleLayerHeight, worldExtent } from "./map";
import { ANIM_MOVING, rideHeight, type SimState, STEP_SNAP } from "./sim";
import { atan2Poly, cosLUT, rand01, sinLUT, TAU } from "./simMath";

export const UNIT_MODE_PATROL = 0;
export const UNIT_MODE_ASSAULT = 1;

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
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  let bestD2 = range * range;
  let bestId = -1;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    if (t === hidden0 || t === hidden1) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    const archetype = ent.archetype[t];
    if (archetype === ARCHETYPE.PROJECTILE) continue;
    if (skipStructures && (archetype === ARCHETYPE.TURRET || archetype === ARCHETYPE.CONSOLE)) {
      continue;
    }
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      if (segmentBlocked(state.map, x, y, ent.posX[t], ent.posY[t])) {
        continue; // wall between us — invisible, so neither halt nor shot
      }
      bestD2 = d2;
      bestId = t;
    }
  }
  return bestId;
}

/** unit lane-following system: moves every unit, then separates ground units. */
export function systemUnitMovement(state: SimState): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    switch (ent.archetype[id]) {
      case ARCHETYPE.RUNNER:
        moveGroundUnit(state, id, RUNNER_SPEED, RUNNER_RANGE);
        break;
      case ARCHETYPE.JUGGERNAUT:
        moveGroundUnit(state, id, JUGGERNAUT_SPEED, JUGGERNAUT_RANGE);
        break;
      case ARCHETYPE.GUARDIAN:
        moveAirUnit(state, id, GUARDIAN_SPEED, GUARDIAN_RANGE, GUARDIAN_PATROL_RADIUS);
        break;
      case ARCHETYPE.FORTRESS:
        moveAirUnit(state, id, FORTRESS_SPEED, FORTRESS_RANGE, FORTRESS_PATROL_RADIUS);
        break;
      default:
        break;
    }
  }
  separateGroundUnits(state);
}

/**
 * Marks a ground unit as traversing the lane GRAPH rather than a polyline
 * (`timerB` sentinel). Field reuse follows the convention at the top of this file.
 */
export const GRAPH_MODE = -2;

/**
 * Advances a unit along the committed lane graph and returns its current target
 * node, or -1 once it has arrived (caller then beelines the gate).
 *
 * There is no search here. `nextHopA`/`nextHopB` were computed at authoring time
 * and validated at load (every signpost points along a real edge, and following
 * the primary chain terminates), so this reads one array entry and, only where
 * the original road forks, spends one draw of the seeded PRNG. That is what keeps
 * rules.md §6 true — see its §9 amendment.
 */
function advanceOnGraph(state: SimState, id: number, team: number): number {
  const ent = state.ent;
  const g = state.map.laneGraph;
  if (g === undefined) return -1;
  const n = g.nodes.length;
  const node = ent.timerA[id];
  if (node < 0 || node >= n) return -1;

  const target = g.nodes[node];
  const dx = target.x - ent.posX[id];
  const dy = target.y - ent.posY[id];
  if (dx * dx + dy * dy > GRAPH_WAYPOINT_RADIUS * GRAPH_WAYPOINT_RADIUS) return node;

  // Arrived at this node: read the signpost.
  const a = g.nextHopA[team * n + node];
  if (a < 0) {
    ent.timerA[id] = -1; // arrived at the enemy base end of the road
    return -1;
  }
  const b = g.nextHopB[team * n + node];
  let next = a;
  if (b >= 0) {
    // A genuine fork in the original road: pick with the sim PRNG, never
    // Math.random (CLAUDE.md rule 3).
    next = rand01(state) < 0.5 ? a : b;
    // Prefer not to double back the way we came, but never refuse to move: a
    // dead end has to stay escapable.
    if (next === ent.cooldownB[id]) next = next === a ? b : a;
  }
  ent.cooldownB[id] = node;
  ent.timerA[id] = next;
  return next;
}

/**
 * Lane-follower: seek the current waypoint, advance on proximity; past the
 * lane's far end (either direction), beeline the enemy gate. Lanes are
 * authored base 0 → base 1, so team 0 walks indices up and team 1 down.
 *
 * On an arena that carries the original waypoint graph (rules.md §9) the unit
 * follows that instead; the polyline path below is untouched and still runs
 * verbatim everywhere else.
 */
function moveGroundUnit(state: SimState, id: number, speed: number, range: number): void {
  const ent = state.ent;
  const map = state.map;

  // Engage-in-path: anything hostile in attack range halts the unit.
  if (nearestEnemyInRange(state, id, range) >= 0) {
    ent.velX[id] = 0;
    ent.velY[id] = 0;
    ent.animState[id] = 0;
    return;
  }

  const team = ent.team[id];
  const x = ent.posX[id];
  const y = ent.posY[id];
  const gate = map.bases[team ^ 1].gate;
  let tx: number;
  let ty: number;
  let past: boolean;
  if (map.laneGraph !== undefined && ent.timerB[id] === GRAPH_MODE) {
    const node = advanceOnGraph(state, id, team);
    past = node < 0;
    tx = past ? gate.x : map.laneGraph.nodes[node].x;
    ty = past ? gate.y : map.laneGraph.nodes[node].y;
  } else {
    const laneIdx = ent.timerA[id];
    const lane = laneIdx < map.lanes.length ? map.lanes[laneIdx] : undefined;
    const wp = ent.timerB[id];
    past = lane === undefined || wp < 0 || wp >= lane.length;
    tx = past || lane === undefined ? gate.x : lane[wp].x;
    ty = past || lane === undefined ? gate.y : lane[wp].y;
  }

  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  // Polyline advance only: graph units advance inside advanceOnGraph above.
  if (!past && ent.timerB[id] !== GRAPH_MODE && d2 <= WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
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

/**
 * Flyer: patrol orbits the own base core and chases anything hostile that
 * enters the patrol radius; assault (mode 1, spawn-site switch) presses
 * toward the enemy core and holds a standoff. Flyers ignore terrain.
 */
function moveAirUnit(
  state: SimState,
  id: number,
  speed: number,
  range: number,
  patrolRadius: number,
): void {
  const ent = state.ent;
  const map = state.map;
  const assault = ent.mode[id] === UNIT_MODE_ASSAULT;
  const team = ent.team[id];
  const anchor = assault ? map.bases[team ^ 1].core : map.bases[team].core;

  // Shooting range halts movement, exactly like ground units.
  if (nearestEnemyInRange(state, id, range) >= 0) {
    ent.velX[id] = 0;
    ent.velY[id] = 0;
    ent.animState[id] = 0;
    stepAndSnap(state, id, true);
    return;
  }

  const x = ent.posX[id];
  const y = ent.posY[id];
  let tx: number;
  let ty: number;
  if (assault) {
    // Press toward the enemy core, hold a standoff once there.
    const ddx = anchor.x - x;
    const ddy = anchor.y - y;
    if (ddx * ddx + ddy * ddy <= GUARDIAN_ASSAULT_STANDOFF * GUARDIAN_ASSAULT_STANDOFF) {
      ent.velX[id] = 0;
      ent.velY[id] = 0;
      ent.animState[id] = 0;
      stepAndSnap(state, id, true);
      return;
    }
    tx = anchor.x;
    ty = anchor.y;
  } else {
    const intruder = nearestEnemyNear(state, id, anchor.x, anchor.y, patrolRadius);
    if (intruder >= 0) {
      tx = ent.posX[intruder];
      ty = ent.posY[intruder];
    } else {
      // Orbit the anchor; the angle advances every tick and wraps.
      let angle = ent.timerA[id] + ORBIT_ANGULAR_SPEED * TICK_DT;
      if (angle > TAU) angle -= TAU;
      ent.timerA[id] = angle;
      const orbitR = patrolRadius * 0.5;
      tx = anchor.x + cosLUT(angle) * orbitR;
      ty = anchor.y + sinLUT(angle) * orbitR;
    }
  }

  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  if (d2 > 0.0001) {
    const inv = 1 / Math.sqrt(d2);
    ent.velX[id] = dx * inv * speed;
    ent.velY[id] = dy * inv * speed;
    ent.yaw[id] = atan2Poly(dy, dx);
  } else {
    ent.velX[id] = 0;
    ent.velY[id] = 0;
  }
  stepAndSnap(state, id, true);
}

/** Nearest live enemy to `id` among enemies within `radius` of an anchor. */
function nearestEnemyNear(
  state: SimState,
  id: number,
  ax: number,
  ay: number,
  radius: number,
): number {
  const ent = state.ent;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  const r2 = radius * radius;
  let bestD2 = Infinity;
  let bestId = -1;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
    const adx = ent.posX[t] - ax;
    const ady = ent.posY[t] - ay;
    if (adx * adx + ady * ady > r2) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestId = t;
    }
  }
  return bestId;
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
    const x = ent.posX[id];
    const nx = Math.min(Math.max(x + ent.velX[id] * TICK_DT, 0), extent);
    if (air || !crossesWallX(map, x, nx, ent.posY[id])) ent.posX[id] = nx;
    const y = ent.posY[id];
    const ny = Math.min(Math.max(y + ent.velY[id] * TICK_DT, 0), extent);
    if (air || !crossesWallY(map, ent.posX[id], y, ny)) ent.posY[id] = ny;
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
    if (hs <= h + STEP_SNAP && hs > bestH) {
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
 * (`AVATAR_JUMP_SPEED`/`GRAVITY`, ~1.4 m) is still passable, because the gate is
 * skipped while airborne.
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
 * Rise a walker clears by jumping: an 8 m/s launch against 20 m/s² gravity is a
 * 1.6 m apex, and balance.ts pins the usable clearance at 1.4 m. Paired with
 * `worstUphillRise` — a blocking rise above this is genuinely impassable, one
 * below it is a jump.
 */
export const JUMPABLE_RISE = 1.4;

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
