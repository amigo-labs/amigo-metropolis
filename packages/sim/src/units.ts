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
  FORTRESS_PATROL_RADIUS,
  FORTRESS_RANGE,
  FORTRESS_SPEED,
  GUARDIAN_ASSAULT_STANDOFF,
  GUARDIAN_PATROL_RADIUS,
  GUARDIAN_RANGE,
  GUARDIAN_SPEED,
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
import { sampleHeight, worldExtent } from "./map";
import { ANIM_MOVING, type SimState } from "./sim";
import { atan2Poly, cosLUT, sinLUT, TAU } from "./simMath";

export const UNIT_MODE_PATROL = 0;
export const UNIT_MODE_ASSAULT = 1;

/**
 * Nearest live enemy of `id` within `range` (dense id order; ties keep the
 * lowest id). Neutral entities are never engaged by units, and projectiles
 * are never targets. Shared by unit movement AND the targeting system so
 * "halts the unit" and "gets shot" agree exactly.
 */
export function nearestEnemyInRange(state: SimState, id: number, range: number): number {
  const ent = state.ent;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  let bestD2 = range * range;
  let bestId = -1;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
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
 * Lane-follower: seek the current waypoint, advance on proximity; past the
 * lane's far end (either direction), beeline the enemy gate. Lanes are
 * authored base 0 → base 1, so team 0 walks indices up and team 1 down.
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
  const laneIdx = ent.timerA[id];
  const lane = laneIdx < map.lanes.length ? map.lanes[laneIdx] : undefined;
  const wp = ent.timerB[id];
  const past = lane === undefined || wp < 0 || wp >= lane.length;
  const gate = map.bases[team ^ 1].gate;
  const tx = past || lane === undefined ? gate.x : lane[wp].x;
  const ty = past || lane === undefined ? gate.y : lane[wp].y;

  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  if (!past && d2 <= WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
    ent.timerB[id] = wp + (team === 0 ? 1 : -1);
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
    ent.posX[id] = Math.min(Math.max(ent.posX[id] + ent.velX[id] * TICK_DT, 0), extent);
    ent.posY[id] = Math.min(Math.max(ent.posY[id] + ent.velY[id] * TICK_DT, 0), extent);
    ent.animState[id] = ANIM_MOVING;
  }
  snapUnitHeight(state, id, air);
}

/** Height rule shared by movement, separation and spawning. */
export function snapUnitHeight(state: SimState, id: number, air: boolean): void {
  const ent = state.ent;
  const g = sampleHeight(state.map, ent.posX[id], ent.posY[id]);
  if (air) {
    const floor = g < state.map.waterLevel ? state.map.waterLevel : g;
    ent.height[id] = floor + AIR_ALTITUDE;
  } else {
    ent.height[id] = g;
  }
}

/**
 * Radial separation between FRIENDLY ground units (architecture.md §2):
 * symmetric pairwise push in dense id order — deterministic on every peer.
 * Enemies are left to fight, flyers stack freely.
 */
function separateGroundUnits(state: SimState): void {
  const ent = state.ent;
  const extent = worldExtent(state.map);
  for (let i = 0; i < ent.high; i++) {
    if (!ent.alive[i] || !isGroundUnit(ent.archetype[i])) continue;
    for (let j = i + 1; j < ent.high; j++) {
      if (!ent.alive[j] || !isGroundUnit(ent.archetype[j])) continue;
      if (ent.team[j] !== ent.team[i]) continue;
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
      ent.posX[i] = Math.min(Math.max(ent.posX[i] - px, 0), extent);
      ent.posY[i] = Math.min(Math.max(ent.posY[i] - py, 0), extent);
      ent.posX[j] = Math.min(Math.max(ent.posX[j] + px, 0), extent);
      ent.posY[j] = Math.min(Math.max(ent.posY[j] + py, 0), extent);
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
