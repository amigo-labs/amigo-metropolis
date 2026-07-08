// The Warden — the solo opponent (rules.md §7, PLAN Phase 4). A superplane
// avatar that flies over everything, plays by the player's rules and economy,
// and is driven by a decision layer that runs INSIDE the sim: it reads only
// sim state and the sim PRNG, so it is bit-identical on every peer and in
// every replay (architecture.md §5).
//
// Decision layer: a priority state machine over
//   {retreat, defend, buy logic, capture, escort push, harass avatar}
// re-planned every WARDEN_REACTION_TICKS (the difficulty's reaction delay) or
// immediately when the current goal dies under it. Aggression thresholds and
// the income multiplier are the other difficulty knobs (balance.ts).
//
// Entity field reuse on the WARDEN archetype:
//   cooldownA/B — cannon / bomb cooldowns
//   aimX/aimY   — facing (weapons override movement facing)

import { ARCHETYPE } from "./archetypes";
import {
  CAPTURE_RADIUS,
  CONSOLE_RADIUS,
  COST_GUARDIAN,
  COST_JUGGERNAUT,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
  PAD_REPAIR_HP_PER_TICK,
  TICK_DT,
  WARDEN_AGGRESSION_PERCENT,
  WARDEN_ALTITUDE,
  WARDEN_DEFEND_RADIUS,
  WARDEN_ESCORT_DISTANCE,
  WARDEN_GUARDIAN_TARGET,
  WARDEN_HEAVY_COOLDOWN_TICKS,
  WARDEN_HEAVY_RANGE,
  WARDEN_HEAVY_SPEED,
  WARDEN_HEAVY_TTL_TICKS,
  WARDEN_HP,
  WARDEN_JUGGERNAUT_AGGRO,
  WARDEN_PRIMARY_COOLDOWN_TICKS,
  WARDEN_PRIMARY_DAMAGE,
  WARDEN_PRIMARY_RANGE,
  WARDEN_REACTION_TICKS,
  WARDEN_RETREAT_DONE_HP_PERCENT,
  WARDEN_RETREAT_HP_PERCENT,
  WARDEN_SPEED,
  WARDEN_WAVE_SIZE,
} from "./balance";
import { EV_SHOT, pushEvent } from "./events";
import { BUTTON_FIRE2, BUTTON_INTERACT } from "./inputs";
import { sampleHeight, worldExtent } from "./map";
import {
  ANIM_MOVING,
  hitscan,
  PROJ_WARDEN,
  type SimState,
  spawnProjectile,
  systemBuy,
} from "./sim";
import { atan2Poly, rand01 } from "./simMath";
import { isGroundUnit, nearestEnemyInRange } from "./units";

// Goals (SimState.wardenGoal). wardenSlot is the goal's operand.
export const WGOAL_IDLE = 0; //            hold near own core
export const WGOAL_RETREAT = 1; //         repair at own pad
export const WGOAL_DEFEND = 2; //          slot = enemy ground unit entity id
export const WGOAL_HARASS = 3; //          slot = enemy player index
export const WGOAL_CAPTURE = 4; //         slot = neutral turret spot index
export const WGOAL_ESCORT = 5; //          slot = own ground unit entity id
export const WGOAL_BUY_GROUND = 6; //      slot = runners left to buy
export const WGOAL_BUY_JUGGERNAUT = 7; //  slot = 1
export const WGOAL_BUY_AIR = 8; //         slot = guardians left to buy
export const WGOAL_CLAIM = 9; //           slot = outpost spot index

/** Warden system: decide (rate-limited) → move → shoot → buy. */
export function systemWarden(state: SimState): void {
  const me = state.wardenPlayer;
  if (me < 0) return;
  const id = state.avatarId[me];
  if (id < 0) return; // dead: systemSpawning respawns the superplane
  const ent = state.ent;
  const d = state.wardenDifficulty - 1;

  if (ent.cooldownA[id] > 0) ent.cooldownA[id] -= 1;
  if (ent.cooldownB[id] > 0) ent.cooldownB[id] -= 1;

  // Own pad repairs the superplane exactly like the avatar (rules.md §5).
  const pad = state.map.bases[me].pad;
  const pdx = ent.posX[id] - pad.x;
  const pdy = ent.posY[id] - pad.y;
  if (pdx * pdx + pdy * pdy <= pad.radius * pad.radius && ent.hp[id] < WARDEN_HP) {
    ent.hp[id] += PAD_REPAIR_HP_PER_TICK;
    if (ent.hp[id] > WARDEN_HP) ent.hp[id] = WARDEN_HP;
  }

  // Re-plan on the reaction clock, when the goal's subject vanished, or the
  // moment hp crosses the retreat line (survival outranks the clock).
  const hurt =
    state.wardenGoal !== WGOAL_RETREAT &&
    ent.hp[id] * 100 < WARDEN_RETREAT_HP_PERCENT[d] * WARDEN_HP;
  if (state.wardenThink > 0) state.wardenThink -= 1;
  if (state.wardenThink <= 0 || hurt || !goalValid(state, id)) {
    decide(state, id, d);
    state.wardenThink = WARDEN_REACTION_TICKS[d];
  }

  moveAndAct(state, id, me);
}

/** True while the current goal's subject still exists / is still sensible. */
function goalValid(state: SimState, id: number): boolean {
  const ent = state.ent;
  const me = state.wardenPlayer;
  const slot = state.wardenSlot;
  switch (state.wardenGoal) {
    case WGOAL_RETREAT:
      return ent.hp[id] * 100 < WARDEN_RETREAT_DONE_HP_PERCENT * WARDEN_HP;
    case WGOAL_DEFEND:
      return (
        slot >= 0 &&
        slot < ent.high &&
        ent.alive[slot] === 1 &&
        ent.team[slot] === (me ^ 1) &&
        isGroundUnit(ent.archetype[slot])
      );
    case WGOAL_HARASS:
      return state.avatarId[me ^ 1] >= 0;
    case WGOAL_CAPTURE: {
      if (slot < 0 || slot >= state.neutralTurretEntity.length) return false;
      const tid = state.neutralTurretEntity[slot];
      return tid >= 0 && ent.ownerId[tid] < 0;
    }
    case WGOAL_ESCORT:
      return (
        slot >= 0 &&
        slot < ent.high &&
        ent.alive[slot] === 1 &&
        ent.team[slot] === me &&
        isGroundUnit(ent.archetype[slot])
      );
    case WGOAL_BUY_GROUND:
      return slot > 0 && state.points[me] >= COST_RUNNER;
    case WGOAL_BUY_JUGGERNAUT:
      return (
        state.points[me] >= COST_JUGGERNAUT && countArchetype(state, ARCHETYPE.JUGGERNAUT, me) === 0
      );
    case WGOAL_BUY_AIR:
      return slot > 0 && state.points[me] >= COST_GUARDIAN;
    case WGOAL_CLAIM:
      return (
        slot >= 0 &&
        slot < state.outpostOwner.length &&
        state.outpostOwner[slot] === -1 &&
        state.outpostConsole[slot] >= 0 &&
        state.points[me] >= COST_OUTPOST_CLAIM
      );
    default:
      return true; // IDLE never goes stale; the reaction clock replaces it
  }
}

/**
 * The priority ladder. Highest first: survival, base defense, then spending
 * (Juggernaut savings gate the cheaper buys), then map control (capture),
 * then the push (escort), then optional avatar harassment, else idle.
 */
function decide(state: SimState, id: number, d: number): void {
  const ent = state.ent;
  const me = state.wardenPlayer;
  const enemy = me ^ 1;
  const aggro = WARDEN_AGGRESSION_PERCENT[d];
  const points = state.points[me];

  // 1. Survival: run home and repair.
  if (ent.hp[id] * 100 < WARDEN_RETREAT_HP_PERCENT[d] * WARDEN_HP) {
    setGoal(state, WGOAL_RETREAT, -1);
    return;
  }

  // 2. Defense: an enemy ground unit near our gate is the only real loss
  // condition (rules.md §1) — intercept the one closest to the gate.
  const gate = state.map.bases[me].gate;
  let bestId = -1;
  let bestD2 = WARDEN_DEFEND_RADIUS * WARDEN_DEFEND_RADIUS;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || ent.team[t] !== enemy || !isGroundUnit(ent.archetype[t])) continue;
    const dx = ent.posX[t] - gate.x;
    const dy = ent.posY[t] - gate.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestId = t;
    }
  }
  if (bestId >= 0) {
    setGoal(state, WGOAL_DEFEND, bestId);
    return;
  }

  // 3. Spending. Aggressive difficulties save 50 for the classic Juggernaut
  // push and skip smaller purchases while saving.
  const saving =
    aggro >= WARDEN_JUGGERNAUT_AGGRO && countArchetype(state, ARCHETYPE.JUGGERNAUT, me) === 0;
  if (saving && points >= COST_JUGGERNAUT) {
    setGoal(state, WGOAL_BUY_JUGGERNAUT, 1);
    return;
  }
  if (!saving) {
    // Claim the nearest neutral outpost when flush (forward spawns later).
    if (points >= COST_OUTPOST_CLAIM) {
      const k = nearestNeutralOutpost(state, id);
      if (k >= 0) {
        setGoal(state, WGOAL_CLAIM, k);
        return;
      }
    }
    const wave = WARDEN_WAVE_SIZE[d];
    if (points >= wave * COST_RUNNER && countGroundUnits(state, me) < wave * 2) {
      setGoal(state, WGOAL_BUY_GROUND, wave);
      return;
    }
    const guardTarget = WARDEN_GUARDIAN_TARGET[d];
    const guards = countArchetype(state, ARCHETYPE.GUARDIAN, me);
    if (guards < guardTarget && points >= (guardTarget - guards) * COST_GUARDIAN) {
      setGoal(state, WGOAL_BUY_AIR, guardTarget - guards);
      return;
    }
  }

  // 4. Map control: hover a neutral turret into ownership (presence is
  // currency — the superplane captures like any avatar).
  const spot = nearestNeutralTurretSpot(state, id);
  if (spot >= 0) {
    setGoal(state, WGOAL_CAPTURE, spot);
    return;
  }

  // 5. Escort the push: fly cover for our ground unit closest to their gate.
  const front = foremostGroundUnit(state, me);
  if (front >= 0) {
    setGoal(state, WGOAL_ESCORT, front);
    return;
  }

  // 6. Harass the enemy avatar — an aggression-gated coin flip (sim PRNG).
  if (state.avatarId[enemy] >= 0 && rand01(state) * 100 < aggro) {
    setGoal(state, WGOAL_HARASS, enemy);
    return;
  }
  setGoal(state, WGOAL_IDLE, -1);
}

function setGoal(state: SimState, goal: number, slot: number): void {
  state.wardenGoal = goal;
  state.wardenSlot = slot;
}

/** Superplane movement toward the goal, weapons free, console interaction. */
function moveAndAct(state: SimState, id: number, me: number): void {
  const ent = state.ent;
  const map = state.map;
  const base = map.bases[me];

  // Goal → target point, arrive radius, console buttons.
  let tx = base.core.x;
  let ty = base.core.y;
  let arrive = 10;
  let buttons = 0;
  switch (state.wardenGoal) {
    case WGOAL_RETREAT:
      tx = base.pad.x;
      ty = base.pad.y;
      arrive = base.pad.radius * 0.5;
      break;
    case WGOAL_DEFEND:
      tx = ent.posX[state.wardenSlot];
      ty = ent.posY[state.wardenSlot];
      arrive = WARDEN_PRIMARY_RANGE * 0.5;
      break;
    case WGOAL_HARASS: {
      const a = state.avatarId[state.wardenSlot];
      if (a >= 0) {
        tx = ent.posX[a];
        ty = ent.posY[a];
      }
      arrive = WARDEN_PRIMARY_RANGE * 0.5;
      break;
    }
    case WGOAL_CAPTURE: {
      const s = map.turretSpots[state.wardenSlot];
      tx = s.x;
      ty = s.y;
      arrive = CAPTURE_RADIUS - 1;
      break;
    }
    case WGOAL_ESCORT:
      tx = ent.posX[state.wardenSlot];
      ty = ent.posY[state.wardenSlot];
      arrive = WARDEN_ESCORT_DISTANCE;
      break;
    case WGOAL_BUY_GROUND:
      tx = base.groundConsole.x;
      ty = base.groundConsole.y;
      arrive = CONSOLE_RADIUS - 1;
      buttons = BUTTON_INTERACT;
      break;
    case WGOAL_BUY_JUGGERNAUT:
      tx = base.groundConsole.x;
      ty = base.groundConsole.y;
      arrive = CONSOLE_RADIUS - 1;
      buttons = BUTTON_INTERACT | BUTTON_FIRE2;
      break;
    case WGOAL_BUY_AIR:
      tx = base.airConsole.x;
      ty = base.airConsole.y;
      arrive = CONSOLE_RADIUS - 1;
      buttons = BUTTON_INTERACT;
      break;
    case WGOAL_CLAIM: {
      const s = map.outpostSpots[state.wardenSlot];
      tx = s.x;
      ty = s.y;
      arrive = CONSOLE_RADIUS - 1;
      buttons = BUTTON_INTERACT;
      break;
    }
    default:
      break; // IDLE: hold near own core
  }

  // Fly straight at the target — terrain is beneath the Warden's concern.
  const extent = worldExtent(map);
  let x = ent.posX[id];
  let y = ent.posY[id];
  const dx = tx - x;
  const dy = ty - y;
  const d2 = dx * dx + dy * dy;
  if (d2 > arrive * arrive) {
    const inv = 1 / Math.sqrt(d2);
    ent.velX[id] = dx * inv * WARDEN_SPEED;
    ent.velY[id] = dy * inv * WARDEN_SPEED;
    x = Math.min(Math.max(x + ent.velX[id] * TICK_DT, 0), extent);
    y = Math.min(Math.max(y + ent.velY[id] * TICK_DT, 0), extent);
    ent.posX[id] = x;
    ent.posY[id] = y;
    ent.yaw[id] = atan2Poly(dy, dx);
    ent.aimX[id] = dx * inv;
    ent.aimY[id] = dy * inv;
    ent.animState[id] = ANIM_MOVING;
  } else {
    ent.velX[id] = 0;
    ent.velY[id] = 0;
    ent.animState[id] = 0;
  }
  const ground = sampleHeight(map, x, y);
  ent.height[id] = Math.max(ground, map.waterLevel) + WARDEN_ALTITUDE;

  // Weapons free: engage the nearest hostile in cannon range regardless of
  // goal (facing snaps to the target — a superplane strafes).
  const target = nearestEnemyInRange(state, id, WARDEN_PRIMARY_RANGE);
  if (target >= 0) {
    const ax = ent.posX[target] - x;
    const ay = ent.posY[target] - y;
    const inv = 1 / Math.sqrt(ax * ax + ay * ay);
    ent.aimX[id] = ax * inv;
    ent.aimY[id] = ay * inv;
    ent.yaw[id] = atan2Poly(ay, ax);
    if (ent.cooldownA[id] <= 0) {
      ent.cooldownA[id] = WARDEN_PRIMARY_COOLDOWN_TICKS;
      pushEvent(state.events, EV_SHOT, id, 0, 0);
      hitscan(
        state,
        id,
        me,
        ent.aimX[id],
        ent.aimY[id],
        WARDEN_PRIMARY_RANGE,
        WARDEN_PRIMARY_DAMAGE,
      );
    }
    if (ent.cooldownB[id] <= 0 && ax * ax + ay * ay <= WARDEN_HEAVY_RANGE * WARDEN_HEAVY_RANGE) {
      ent.cooldownB[id] = WARDEN_HEAVY_COOLDOWN_TICKS;
      pushEvent(state.events, EV_SHOT, id, 1, 0);
      spawnProjectile(
        state,
        id,
        me,
        PROJ_WARDEN,
        ent.aimX[id],
        ent.aimY[id],
        WARDEN_HEAVY_SPEED,
        WARDEN_HEAVY_TTL_TICKS,
      );
    }
  }

  // Console interaction through the player's exact hold-to-buy rules; a
  // completed purchase shows up as a points drop → count the wave down.
  const before = state.points[me];
  systemBuy(state, me, id, buttons);
  if (state.points[me] < before) {
    if (
      (state.wardenGoal === WGOAL_BUY_GROUND || state.wardenGoal === WGOAL_BUY_AIR) &&
      state.wardenSlot > 0
    ) {
      state.wardenSlot -= 1;
    }
    if (state.wardenSlot <= 0 || state.wardenGoal === WGOAL_BUY_JUGGERNAUT) {
      state.wardenThink = 0; // wave done: re-plan next tick
    }
  }
}

function countArchetype(state: SimState, archetype: number, team: number): number {
  const ent = state.ent;
  let n = 0;
  for (let t = 0; t < ent.high; t++) {
    if (ent.alive[t] && ent.archetype[t] === archetype && ent.team[t] === team) n += 1;
  }
  return n;
}

function countGroundUnits(state: SimState, team: number): number {
  const ent = state.ent;
  let n = 0;
  for (let t = 0; t < ent.high; t++) {
    if (ent.alive[t] && ent.team[t] === team && isGroundUnit(ent.archetype[t])) n += 1;
  }
  return n;
}

/** Nearest map turret spot whose capturable turret is alive and unowned. */
function nearestNeutralTurretSpot(state: SimState, id: number): number {
  const ent = state.ent;
  const spots = state.map.turretSpots;
  let best = -1;
  let bestD2 = Infinity;
  for (let k = 0; k < spots.length; k++) {
    const tid = state.neutralTurretEntity[k];
    if (tid < 0 || ent.ownerId[tid] >= 0) continue;
    const dx = spots[k].x - ent.posX[id];
    const dy = spots[k].y - ent.posY[id];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = k;
    }
  }
  return best;
}

/** Nearest outpost spot that is unowned with a live (claimable) console. */
function nearestNeutralOutpost(state: SimState, id: number): number {
  const ent = state.ent;
  const spots = state.map.outpostSpots;
  let best = -1;
  let bestD2 = Infinity;
  for (let k = 0; k < spots.length; k++) {
    if (state.outpostOwner[k] !== -1 || state.outpostConsole[k] < 0) continue;
    const dx = spots[k].x - ent.posX[id];
    const dy = spots[k].y - ent.posY[id];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = k;
    }
  }
  return best;
}

/** Own ground unit closest to the enemy gate — the tip of the push. */
function foremostGroundUnit(state: SimState, team: number): number {
  const ent = state.ent;
  const gate = state.map.bases[team ^ 1].gate;
  let best = -1;
  let bestD2 = Infinity;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || ent.team[t] !== team || !isGroundUnit(ent.archetype[t])) continue;
    const dx = ent.posX[t] - gate.x;
    const dy = ent.posY[t] - gate.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = t;
    }
  }
  return best;
}
