// The Warden — the solo opponent (rules.md §7), the original's Sky Captain
// (fcop-fidelity.md U3; fcop-re/ai-and-rules.md §1, read from dispatch.c and
// aircraft.c in the RE repo). An aircraft with a commander's decision pass on
// top, playing the second side by the human economy's rules: its budget is its
// side's Current Points and it buys the same units at the same prices. It runs
// INSIDE the sim, reads only sim state and the sim PRNG, so it is bit-identical
// on every peer and in every replay (architecture.md §5).
//
// Metropolis' difficulty 1-10 is the captain's level 0-9 (balance.ts
// wardenLevel). Per tick (`sky_tick`, retail 0x004215b0):
//   1. below its retreat threshold it goes home to be restored, or to a health
//      pickup (captainRetreat);
//   2. the rethink countdown runs down; when it goes negative the decision pass
//      runs (`cact_dispatch_types`, 0x00421910; decide): scan, mode machine,
//      aim and move targets, spending;
//   3. its three weapons tick (captainWeapons), then it flies (captainFly).
// Its requests are spawned from queues at the scripts' cadence (captainQueues).
//
// Not modelled: the announcements (state word 56) and its voice lines, the
// crash tumble before a respawn, the turn rate (it turns at once: the original's
// is a vector low-pass, ~40-70°/s by estimate) and its quadrupling on the way
// home, the altitude controller (WARDEN_ALTITUDE).

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
import {
  AVATAR_HP,
  COST_FORTRESS,
  COST_GUARDIAN,
  COST_JUGGERNAUT,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
  FORTRESS_ALIVE_LIMIT,
  JUGGERNAUT_ALIVE_LIMIT,
  PICKUP_HEALTH,
  SHOOTER_FRONT_ARC_COS,
  SHOOTER_RETRY_UNITS,
  SKY_AIM_RANGE,
  SKY_ARC_SIDE_COS,
  SKY_BOMB_REFIRE_UNITS,
  SKY_ESCORT_CAPTURE,
  SKY_FAR_DREAD,
  SKY_FAR_TANK,
  SKY_FORTRESS_BUDGET,
  SKY_GUN_DAMAGE,
  SKY_GUN_REACH,
  SKY_GUN_REFIRE_UNITS,
  SKY_HOME_RADIUS,
  SKY_HURT_PLAYER,
  SKY_JET_QUEUE_TICKS,
  SKY_L9_DREAD,
  SKY_L9_TANK,
  SKY_LEVEL_PENALTY,
  SKY_MISSILE_REFIRE_UNITS,
  SKY_NEAR_DREAD,
  SKY_NEAR_TANK,
  SKY_NEUTRAL_JITTER,
  SKY_OPENING_ORDER,
  SKY_OUTPOST_UNIT_COST,
  SKY_PICKUP_RADIUS,
  SKY_RETHINK_BASE,
  SKY_RETHINK_JITTER,
  SKY_RETHINK_JITTER_DEFEND,
  SKY_RETHINK_PER_LEVEL,
  SKY_RETREAT_JITTER,
  SKY_ROAM_DREAD,
  SKY_ROAM_FORTRESS,
  SKY_ROAM_JET,
  SKY_ROAM_NEUTRAL,
  SKY_ROAM_TAKEN,
  SKY_ROAM_TANK,
  SKY_SCORE_ATTACK,
  SKY_SEARCH_UNITS,
  SKY_SPARE_BUDGET,
  SKY_SPEND_HOME,
  SKY_SPEND_HOME_PER_LEVEL,
  SKY_STANDOFF,
  SKY_TANK_QUEUE_TICKS,
  SKY_TURRET_COUNT,
  SKY_TURRET_PARTS,
  SKY_TURRETS_SAFE,
  SKY_UNIT_CAP,
  skyMaxHp,
  skySpeed,
  TICK_DT,
  WARDEN_ALTITUDE,
  WEAPON_UNITS_PER_TICK,
  wardenLevel,
} from "./balance";
import { segmentBlocked } from "./collision";
import {
  EV_PURCHASE,
  EV_SHOT,
  pushEvent,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  SKY_WEAPON_BOMB,
} from "./events";
import { sampleHeight, worldExtent } from "./map";
import {
  ANIM_MOVING,
  claimOutpostSlot,
  fireWardenMissile,
  hitscan,
  type SimState,
  spawnUnit,
  spawnWardenBomb,
  TURRET_CAPTURABLE,
  TURRET_DEFENSE,
} from "./sim";
import { atan2Poly, cosLUT, rand01, randInt, sinLUT, TAU } from "./simMath";
import { isGroundUnit, nearestEnemyInRange, UNIT_MODE_OUTPOST, UNIT_MODE_PATROL } from "./units";

/** The captain's modes (`ai->mode`, mirrored in state word 39). */
export const SKY_MODE_ROAM = 0; //   the opportunist (mode 0)
export const SKY_MODE_ATTACK = 1; // escort its push (mode 1)
export const SKY_MODE_DEFEND = 2; // defend home, or go after the player (mode 2)

/** Its aircraft states: ENGAGE flies at the move target, CRUISE at the destination. */
export const SKY_ENGAGE = 0;
export const SKY_CRUISE = 1;

/** Request queues: 0 base tanks, 1 base jets, then per outpost k: 2 + 2k tanks, 3 + 2k jets. */
export const SKY_QUEUE_BASE_TANKS = 0;
export const SKY_QUEUE_BASE_JETS = 1;
/** The original's four outposts (state words 40..43, request words 48..55). */
export const SKY_OUTPOSTS = 4;
export const SKY_QUEUES = 2 + 2 * SKY_OUTPOSTS;

/**
 * The captain's state, the original's `sky_ai` block plus the aircraft fields it
 * drives. Hashed when the match has a Warden.
 */
export interface CaptainState {
  /** SKY_MODE_*; starts in defend (construct). */
  mode: number;
  /** Rethink countdown in engine units (1/300 s); negative runs a decision pass. */
  think: number;
  /** The shooters' shared target (entity id), -1 = they search by team on their own. */
  aim: number;
  /** What it flies at in ENGAGE (entity id), -1 = its destination. */
  move: number;
  /** SKY_ENGAGE / SKY_CRUISE. */
  fly: number;
  /** Destination (metres): the mode's place, home on a retreat, a pickup. */
  destX: number;
  destY: number;
  /** Retreat threshold: half its max health less rand 0..63 (`ai->word_1e`). */
  threshold: number;
  /** Current speed, m/s (raised on a retreat, reset by a restore or respawn). */
  speed: number;
  /** `byte_1c`: the coin that picks its outpost order and gates two spend blocks. */
  order: number;
  /** The shooters' search countdown, engine units. */
  search: number;
  /** Rate machines of weapons 7, 8, 9: clock (engine units) and phase. */
  readonly gunClock: Float64Array;
  readonly gunPhase: Uint8Array;
  /** Units requested and not yet spawned, and each queue's countdown (ticks). */
  readonly queue: Int32Array;
  readonly queueTimer: Int32Array;
}

export function createCaptainState(): CaptainState {
  return {
    mode: SKY_MODE_DEFEND,
    think: 0,
    aim: -1,
    move: -1,
    fly: SKY_ENGAGE,
    destX: 0,
    destY: 0,
    threshold: 0,
    speed: 0,
    order: 0,
    search: 0,
    gunClock: new Float64Array(3),
    gunPhase: new Uint8Array(3),
    queue: new Int32Array(SKY_QUEUES),
    queueTimer: new Int32Array(SKY_QUEUES),
  };
}

/** The level this match's Warden plays (0..9). */
export function captainLevel(state: SimState): number {
  return wardenLevel(state.wardenDifficulty);
}

/** The Warden's full health at its level (250..1250). */
export function captainMaxHp(state: SimState): number {
  return skyMaxHp(captainLevel(state));
}

/** Its home (`point_0c`): its own spawn, beside its base. */
function homeX(state: SimState): number {
  return state.map.spawns[state.wardenPlayer].x;
}
function homeY(state: SimState): number {
  return state.map.spawns[state.wardenPlayer].y;
}
/** The player's base (`point_00`): where the human's mech was when it was built. */
function pbaseX(state: SimState): number {
  return state.map.spawns[state.wardenPlayer ^ 1].x;
}
function pbaseY(state: SimState): number {
  return state.map.spawns[state.wardenPlayer ^ 1].y;
}

/** The decision pass' distance: the octagonal estimate on the ground plane. */
function oct(dx: number, dy: number): number {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const lo = ay >= ax ? ax : ay;
  return ax + ay - lo / 2;
}

/**
 * Can the captain see player `p`'s mech as a candidate? Not while it is down,
 * cloaked or invulnerable. The original skips the mech while either of two
 * halfwords of its view block is positive (+0x324 / +0x326, could not be
 * established; the HUD blinks on one of them): read here as the cloak and
 * invulnerability timers, as P7 adopted.
 */
function huntable(state: SimState, p: number): boolean {
  if (state.avatarId[p] < 0) return false;
  if (state.buffInvis.length === 0) return true;
  return state.buffInvis[p] === 0 && state.buffInvuln[p] === 0;
}

/** A redraw of the retreat threshold (`sky_redraw_retreat_threshold`). */
function redrawThreshold(state: SimState): void {
  state.captain.threshold = (captainMaxHp(state) >> 1) - randInt(state, SKY_RETREAT_JITTER);
}

/** The mode's place (`sky_refresh_destination`): midpoint, the player's base, home. */
function refreshDestination(state: SimState): void {
  const c = state.captain;
  if (c.mode === SKY_MODE_ROAM) {
    c.destX = homeX(state) + (pbaseX(state) - homeX(state)) / 2;
    c.destY = homeY(state) + (pbaseY(state) - homeY(state)) / 2;
  } else if (c.mode === SKY_MODE_ATTACK) {
    c.destX = pbaseX(state);
    c.destY = pbaseY(state);
  } else {
    c.destX = homeX(state);
    c.destY = homeY(state);
  }
}

/**
 * The construct (`sky_construct`, 0x004211f0), run once by createSim: defend
 * mode, a decision on the first tick, the outpost-order coin, a retreat
 * threshold, a budget of 0 (a one-viewport game starts the captain's Current
 * Points at zero, 0x004214fc) and the free opening order — from level 1, 10 base
 * units, `min(10, rand 0..3 + 9 - L)` tanks and jets for the rest, unpaid
 * (0x00421476).
 */
export function captainConstruct(state: SimState): void {
  const me = state.wardenPlayer;
  if (me < 0) return;
  const c = state.captain;
  const level = captainLevel(state);
  c.mode = SKY_MODE_DEFEND;
  c.think = 0;
  c.aim = -1;
  c.move = -1;
  c.fly = SKY_ENGAGE;
  c.speed = skySpeed(level);
  c.order = randInt(state, 2);
  redrawThreshold(state);
  refreshDestination(state);
  state.points[me] = 0;
  if (level >= 1) {
    let tanks = randInt(state, 4) + 9 - level;
    if (tanks > SKY_OPENING_ORDER) tanks = SKY_OPENING_ORDER;
    c.queue[SKY_QUEUE_BASE_TANKS] += tanks;
    c.queue[SKY_QUEUE_BASE_JETS] += SKY_OPENING_ORDER - tanks;
  }
}

/**
 * The respawn (`sky_respawn`, 0x00422bc0), after systemSpawning put the craft
 * back at its spawn: full health (spawnAvatar), a new threshold, cruise speed,
 * weapons dropped, roam mode with its destination, a decision on the next tick,
 * a random heading.
 */
export function captainRespawn(state: SimState): void {
  const id = state.avatarId[state.wardenPlayer];
  if (id < 0) return;
  const c = state.captain;
  redrawThreshold(state);
  c.speed = skySpeed(captainLevel(state));
  c.think = 0;
  c.aim = -1;
  c.move = -1;
  c.mode = SKY_MODE_ROAM;
  c.fly = SKY_ENGAGE;
  refreshDestination(state);
  const yaw = (randInt(state, 4096) / 4096) * TAU;
  state.ent.yaw[id] = yaw;
  state.ent.aimX[id] = cosLUT(yaw);
  state.ent.aimY[id] = sinLUT(yaw);
}

/**
 * A health restore (`sky_pickup_restore`, 0x00420f60): at home below the
 * threshold, or from a health pickup (the pickup module calls it on the
 * captain, sim.ts systemPickups). Full health, a new threshold, ENGAGE, the mode's
 * destination, a decision next tick, cruise speed again.
 */
export function captainRestore(state: SimState, id: number): void {
  restore(state, id);
}

function restore(state: SimState, id: number): void {
  const c = state.captain;
  state.ent.hp[id] = captainMaxHp(state);
  redrawThreshold(state);
  c.fly = SKY_ENGAGE;
  refreshDestination(state);
  c.think = 0;
  c.speed = skySpeed(captainLevel(state));
}

/**
 * Every credit the engine pays the captain's side (a capture, a captured turret
 * destroyed, the human going down) zeroes its rethink countdown: it decides on
 * the next tick (ai-and-rules.md §1.8).
 */
export function captainCredit(state: SimState, team: number): void {
  if (state.wardenPlayer >= 0 && team === state.wardenPlayer) state.captain.think = 0;
}

/** Warden system: retreat → rethink → weapons → flight; then its queues. */
export function systemWarden(state: SimState): void {
  const me = state.wardenPlayer;
  if (me < 0) return;
  captainQueues(state, me);
  const id = state.avatarId[me];
  if (id < 0) return; // down: systemSpawning brings it back
  // Below zero it is going down this tick (systemDamageDeath): the original's
  // operation 4 starts the crash before the commander ticks again.
  if (state.ent.hp[id] <= 0) return;
  const c = state.captain;
  const level = captainLevel(state);

  if (c.move >= 0 && !moveValid(state, c.move)) c.move = -1;
  if (c.aim >= 0 && !state.ent.alive[c.aim]) c.aim = -1;

  const rethink = captainRetreat(state, id, level);
  if (rethink) {
    c.think -= WEAPON_UNITS_PER_TICK;
    if (c.think < 0) {
      let interval = SKY_RETHINK_BASE - SKY_RETHINK_PER_LEVEL * level;
      if (c.mode === SKY_MODE_DEFEND) interval -= randInt(state, SKY_RETHINK_JITTER_DEFEND);
      else interval += randInt(state, SKY_RETHINK_JITTER);
      c.think = interval;
      decide(state, id, level);
    }
  }
  captainWeapons(state, id, me, level);
  captainFly(state, id);
}

/** The move target is still something to fly at (alive). */
function moveValid(state: SimState, t: number): boolean {
  const ent = state.ent;
  return t < ent.high && ent.alive[t] === 1 && ent.archetype[t] !== ARCHETYPE.PROJECTILE;
}

/**
 * The tick's damaged arms. Returns false when the tick must not rethink.
 */
function captainRetreat(state: SimState, id: number, level: number): boolean {
  const ent = state.ent;
  const c = state.captain;
  let threshold = c.threshold;
  if (c.mode === SKY_MODE_ATTACK || c.mode === SKY_MODE_DEFEND)
    threshold = Math.floor(threshold / 2);
  if (ent.hp[id] >= threshold) return true;
  const hx = homeX(state);
  const hy = homeY(state);
  const homeD = oct(ent.posX[id] - hx, ent.posY[id] - hy);
  if (homeD < SKY_HOME_RADIUS) {
    restore(state, id); // home already: repaired on the spot
    return true;
  }
  if (c.fly === SKY_ENGAGE) {
    // Break off: home, weapons dropped, a faster run the higher the level.
    c.destX = hx;
    c.destY = hy;
    c.fly = SKY_CRUISE;
    c.speed += c.speed / (1 << (4 - (level >> 2)));
    c.aim = -1;
    return false;
  }
  // Cruising home: the nearest health pickup on offer.
  const spots = state.map.pickups;
  let pick = -1;
  let pickD = 0;
  for (let k = 0; k < spots.length; k++) {
    if (spots[k].kind !== PICKUP_HEALTH || state.pickupCooldown[k] > 0) continue;
    const d = oct(ent.posX[id] - spots[k].x, ent.posY[id] - spots[k].y);
    if (pick < 0 || pickD > d) {
      pick = k;
      pickD = d;
    }
  }
  if (pick >= 0) {
    if (pickD < SKY_PICKUP_RADIUS) {
      state.pickupCooldown[pick] = spots[pick].respawnTicks;
      restore(state, id);
      return true;
    }
    if (pickD < homeD) {
      c.destX = spots[pick].x;
      c.destY = spots[pick].y;
      return false;
    }
    return true; // further than home: the rethink runs
  }
  c.destX = hx;
  c.destY = hy;
  return false;
}

// --- The decision pass ------------------------------------------------------

/** The scan's candidate slots (`sky_targets`), reused every pass (no allocation). */
const scan = {
  near28: -1,
  near28D: 0,
  near5: -1,
  near5D: 0,
  near9: -1,
  score: 0,
  far28: -1,
  far28D: 0,
  far5: -1,
  far5D: 0,
  ownTurrets: 0,
  own1: -1,
  own1D: 0,
  own28: -1,
  own28D: 0,
  own5: -1,
  own5D: 0,
  own9hi: -1,
  own9hiD: 0,
  own9lo: -1,
  own9loD: 0,
  own36grp: -1,
  own36grpD: 0,
  own36oth: -1,
  own36othD: 0,
};

/** The original actor type a Metropolis entity stands for in the scan, or 0. */
function scanType(state: SimState, t: number): number {
  const ent = state.ent;
  switch (ent.archetype[t]) {
    case ARCHETYPE.AVATAR:
      return 1;
    case ARCHETYPE.RUNNER:
      return 5;
    case ARCHETYPE.GUARDIAN:
      return 9; // a jet (byte_19 < 10)
    case ARCHETYPE.FORTRESS:
      return 10; // a Flying Fortress (byte_19 >= 10)
    case ARCHETYPE.JUGGERNAUT:
      return 28;
    case ARCHETYPE.TURRET:
      if (ent.mode[t] === TURRET_DEFENSE) return 8;
      if (ent.mode[t] === TURRET_CAPTURABLE) return 36;
      return 0;
    default:
      return 0;
  }
}

/** A candidate's group byte: its team, a capturable turret's owner (neutral when none). */
function groupOf(state: SimState, t: number): number {
  const ent = state.ent;
  if (ent.archetype[t] === ARCHETYPE.TURRET && ent.mode[t] === TURRET_CAPTURABLE) {
    return ent.ownerId[t] < 0 ? TEAM_NEUTRAL : ent.team[t];
  }
  return ent.team[t];
}

/**
 * The walk (`sky_scan`): every live candidate in dense id order, the nearest of
 * each kind under three measures —
 * - its own units from the player's base: a tank within 52 m (+1 score), its
 *   Dreadnought within 60 m (+10), its Fortress anywhere;
 * - the rest from home: an enemy tank within 64 m, an enemy Dreadnought within
 *   72 m, and a count of its own team turrets within 256 m, two per turret (its
 *   base part is a second type-8 actor);
 * - the same rest from itself, with (9 - L) * 0.5 m added: the player's mech, an
 *   enemy tank, Dreadnought, jet, Fortress, a turret the player captured, and a
 *   neutral turret (this slot drifts by rand 0..0x3fff wu per losing candidate).
 */
function scanAll(state: SimState, id: number, level: number): void {
  const ent = state.ent;
  const me = state.wardenPlayer;
  const enemy = me ^ 1;
  const s = scan;
  s.near28 = -1;
  s.near5 = -1;
  s.near9 = -1;
  s.score = 0;
  s.far28 = -1;
  s.far5 = -1;
  s.ownTurrets = 0;
  s.own1 = -1;
  s.own28 = -1;
  s.own5 = -1;
  s.own9hi = -1;
  s.own9lo = -1;
  s.own36grp = -1;
  s.own36oth = -1;
  s.own36othD = 0;
  const px = pbaseX(state);
  const py = pbaseY(state);
  const hx = homeX(state);
  const hy = homeY(state);
  const sx = ent.posX[id];
  const sy = ent.posY[id];
  const penalty = (9 - level) * SKY_LEVEL_PENALTY;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    const type = scanType(state, t);
    if (type === 0) continue;
    const group = groupOf(state, t);
    let fromPbase = false;
    if (group !== enemy) {
      const toFar = (type === 36 && group !== me) || type === 8;
      if (!toFar) {
        if (group !== me) continue;
        fromPbase = true;
      }
    }
    if (fromPbase) {
      const d = oct(ent.posX[t] - px, ent.posY[t] - py);
      if (type === 5) {
        if (d > SKY_NEAR_TANK) continue;
        if (s.near5 >= 0 && !(s.near5D > d)) continue;
        s.score += 1;
        s.near5 = t;
        s.near5D = d;
      } else if (type === 10) {
        if (s.near9 < 0) s.near9 = t; // its own Fortress, anywhere
      } else if (type === 28) {
        if (d > SKY_NEAR_DREAD) continue;
        if (s.near28 >= 0 && !(s.near28D > d)) continue;
        s.score += 10;
        s.near28 = t;
        s.near28D = d;
      }
      continue;
    }
    if (type === 28 || type === 5 || type === 9 || type === 10 || type === 8) {
      const d = oct(ent.posX[t] - hx, ent.posY[t] - hy);
      if (type === 5) {
        if (d <= SKY_FAR_TANK && (s.far5 < 0 || s.far5D > d)) {
          s.far5 = t;
          s.far5D = d;
        }
      } else if (type === 8) {
        // A team turret and its base part are both type 8: two to the count. A
        // turret captured from neutral is type 36 and never counts.
        if (group === me && d < SKY_TURRET_COUNT) s.ownTurrets += SKY_TURRET_PARTS;
      } else if (type === 28) {
        if (d <= SKY_FAR_DREAD && (s.far28 < 0 || s.far28D > d)) {
          s.far28 = t;
          s.far28D = d;
        }
      }
    }
    const d = oct(ent.posX[t] - sx, ent.posY[t] - sy) + penalty;
    switch (type) {
      case 1:
        if ((s.own1 < 0 || s.own1D > d) && huntable(state, ent.ownerId[t])) {
          s.own1 = t;
          s.own1D = d;
        }
        break;
      case 5:
        if (s.own5 < 0 || s.own5D > d) {
          s.own5 = t;
          s.own5D = d;
        }
        break;
      case 9:
        if (s.own9lo < 0 || s.own9loD > d) {
          s.own9lo = t;
          s.own9loD = d;
        }
        break;
      case 10:
        if (s.own9hi < 0 || s.own9hiD > d) {
          s.own9hi = t;
          s.own9hiD = d;
        }
        break;
      case 28:
        if (s.own28 < 0 || s.own28D > d) {
          s.own28 = t;
          s.own28D = d;
        }
        break;
      case 36:
        if (group === enemy) {
          if (s.own36grp < 0 || s.own36grpD > d) {
            s.own36grp = t;
            s.own36grpD = d;
          }
        } else if (group !== me) {
          s.own36othD += randInt(state, SKY_NEUTRAL_JITTER) / 8192;
          if (s.own36oth >= 0 && s.own36othD <= d) break;
          s.own36oth = t;
          s.own36othD = d;
        }
        break;
      default:
        break;
    }
  }
}

/** Inside its shooters' 12 m engage range, by true distance (`sky_in_weapon_range`)? */
function inWeaponRange(state: SimState, id: number, t: number): boolean {
  const ent = state.ent;
  const dx = ent.posX[t] - ent.posX[id];
  const dy = ent.posY[t] - ent.posY[id];
  return dx * dx + dy * dy < SKY_AIM_RANGE * SKY_AIM_RANGE;
}

/** `sky_set_move_target`: fly at it, and engage. */
function setMove(state: SimState, t: number): void {
  state.captain.move = t;
  state.captain.fly = SKY_ENGAGE;
}

/** `sky_engage`: aim at it if within 12 m, and fly at it. */
function engage(state: SimState, id: number, t: number): void {
  const c = state.captain;
  if (c.move === t && c.aim === t) return;
  if (c.aim !== t && inWeaponRange(state, id, t)) c.aim = t;
  if (c.move === t) return;
  setMove(state, t);
}

/** The decision pass (`cact_dispatch_types`, 0x00421910). */
function decide(state: SimState, id: number, level: number): void {
  const c = state.captain;
  const ent = state.ent;
  const me = state.wardenPlayer;
  const enemy = me ^ 1;
  scanAll(state, id, level);
  const s = scan;
  const entryMode = c.mode;

  // Promote to defend: an enemy Dreadnought or tank near home, or too few own
  // turrets and not attacking.
  if (c.mode !== SKY_MODE_DEFEND) {
    if (
      s.far28 >= 0 ||
      s.far5 >= 0 ||
      (s.ownTurrets < SKY_TURRETS_SAFE && c.mode !== SKY_MODE_ATTACK)
    ) {
      c.mode = SKY_MODE_DEFEND;
    }
  }
  if (c.mode === SKY_MODE_DEFEND) {
    if (s.far28 >= 0 && !(s.far5 >= 0 && s.far5D < s.far28D)) {
      engage(state, id, s.far28);
    } else if (s.far5 >= 0) {
      engage(state, id, s.far5);
    } else if (s.ownTurrets < SKY_TURRETS_SAFE) {
      // Go after the player itself: the move target only.
      const player = state.avatarId[enemy];
      if (player >= 0 && c.move !== player) setMove(state, player);
    } else {
      c.mode = SKY_MODE_ROAM;
    }
  }
  if (c.mode !== SKY_MODE_DEFEND) {
    if (c.mode !== SKY_MODE_ATTACK && s.score >= SKY_SCORE_ATTACK) c.mode = SKY_MODE_ATTACK;
    if (c.mode === SKY_MODE_ATTACK) {
      if (s.near28 >= 0 && s.near28D < SKY_NEAR_DREAD) {
        if (c.move !== s.near28) {
          if (c.aim < 0 && s.own36oth >= 0 && s.own36othD < SKY_ESCORT_CAPTURE) {
            if (c.move !== s.own36oth) setMove(state, s.own36oth);
          } else {
            setMove(state, s.near28);
          }
        }
      } else if (s.near5 >= 0 && s.near5D < SKY_NEAR_TANK) {
        if (c.move !== s.near5) {
          c.aim = -1;
          setMove(state, s.near5);
        }
      } else {
        c.mode = SKY_MODE_ROAM;
      }
    }
  }
  if (c.mode === SKY_MODE_ROAM) {
    const hurt =
      s.own1 >= 0 && s.own1D < SKY_HURT_PLAYER && ent.hp[s.own1] < Math.floor(AVATAR_HP / 4);
    if (hurt) {
      if (!(c.move === s.own1 && c.aim === s.own1)) {
        if (c.aim !== s.own1 && inWeaponRange(state, id, s.own1)) c.aim = s.own1;
        if (c.move !== s.own1) setMove(state, s.own1);
      }
    } else if (s.own28 >= 0 && s.own28D < SKY_ROAM_DREAD) {
      engage(state, id, s.own28);
    } else if (s.own5 >= 0 && s.own5D < SKY_ROAM_TANK) {
      engage(state, id, s.own5);
    } else if (s.own36oth >= 0 && s.own36othD < SKY_ROAM_NEUTRAL) {
      if (c.move !== s.own36oth) setMove(state, s.own36oth);
    } else if (s.own9lo >= 0 && s.own9loD < SKY_ROAM_JET) {
      engage(state, id, s.own9lo);
    } else if (s.own36grp >= 0 && s.own36grpD < SKY_ROAM_TAKEN) {
      if (c.move !== s.own36grp) setMove(state, s.own36grp);
    } else if (s.own9hi >= 0 && s.own9hiD < SKY_ROAM_FORTRESS) {
      // Retail's quirk: this arm aims on the stored flat distance, not the
      // hypotenuse.
      if (!(c.move === s.own9hi && c.aim === s.own9hi)) {
        if (c.aim !== s.own9hi && s.own9hiD < SKY_AIM_RANGE) c.aim = s.own9hi;
        if (c.move !== s.own9hi) setMove(state, s.own9hi);
      }
    } else if (s.own36oth >= 0) {
      if (c.move !== s.own36oth) setMove(state, s.own36oth);
    } else if (s.own36grp >= 0) {
      if (c.move !== s.own36grp) setMove(state, s.own36grp);
    } else if (c.fly !== SKY_CRUISE) {
      c.fly = SKY_CRUISE;
      refreshDestination(state);
    }
  }
  // Whatever the mode: the player's mech gets one more chance to be the target.
  if (s.own1 >= 0 && c.aim !== s.own1) {
    const held = c.aim;
    if (held < 0 || (held !== s.own28 && held !== s.own5)) {
      if (inWeaponRange(state, id, s.own1)) c.aim = s.own1;
    }
  }
  if (entryMode !== c.mode) refreshDestination(state);
  spend(state, id, level);
}

// --- Spending ----------------------------------------------------------------

function countTeam(state: SimState, archetype: number, team: number): number {
  const ent = state.ent;
  let n = 0;
  for (let t = 0; t < ent.high; t++) {
    if (ent.alive[t] && ent.archetype[t] === archetype && ent.team[t] === team) n += 1;
  }
  return n;
}

/** Word 29: its tanks, alive or requested. */
function tankCount(state: SimState, me: number): number {
  const q = state.captain.queue;
  let n = countTeam(state, ARCHETYPE.RUNNER, me) + q[SKY_QUEUE_BASE_TANKS];
  for (let k = 0; k < SKY_OUTPOSTS; k++) n += q[2 + 2 * k];
  return n;
}

/** Word 30: its jets, alive or requested. */
function jetCount(state: SimState, me: number): number {
  const q = state.captain.queue;
  let n = countTeam(state, ARCHETYPE.GUARDIAN, me) + q[SKY_QUEUE_BASE_JETS];
  for (let k = 0; k < SKY_OUTPOSTS; k++) n += q[3 + 2 * k];
  return n;
}

/**
 * State words 40..43: does `team` own outpost k? The imported arenas carry the
 * original's four, in owner-word order; Metropolis' own arenas have fewer.
 */
function owns(state: SimState, k: number, team: number): boolean {
  return k < state.outpostOwner.length && state.outpostOwner[k] === team;
}

/** Pay `cost` and queue `n` units on queue `q`. */
function request(state: SimState, me: number, q: number, n: number, cost: number): void {
  state.captain.queue[q] += n;
  const left = state.points[me] - cost;
  state.points[me] = left > 0 ? left : 0;
}

/**
 * The spend blocks (0x00422405..0x004229ac). Every request pays at once from its
 * side's Current Points and is queued for the scripts to spawn (captainQueues).
 * Counts are the units alive plus those requested (words 29/30), capped at 20.
 */
function spend(state: SimState, id: number, level: number): void {
  const c = state.captain;
  const ent = state.ent;
  const me = state.wardenPlayer;
  const enemy = me ^ 1;
  const s = scan;
  const l4 = level >> 2;
  let refused = 0;
  if (c.mode === SKY_MODE_DEFEND) {
    if (level >= 9) {
      const worth =
        (s.far28 >= 0 && s.far28D < SKY_L9_DREAD) || (s.far5 >= 0 && s.far5D < SKY_L9_TANK);
      if (worth && tankCount(state, me) < SKY_UNIT_CAP && state.points[me] > 0) {
        request(state, me, SKY_QUEUE_BASE_TANKS, 1, COST_RUNNER);
      }
    }
    const hd =
      oct(ent.posX[id] - homeX(state), ent.posY[id] - homeY(state)) -
      level * SKY_SPEND_HOME_PER_LEVEL;
    if (jetCount(state, me) < l4 + 4) {
      if (hd < SKY_SPEND_HOME) {
        let want = randInt(state, 4) + l4 + 4;
        const room = SKY_UNIT_CAP - jetCount(state, me);
        if (want > room) want = room;
        if (want > state.points[me]) want = state.points[me];
        const n = want + l4 * 2 - 4;
        if (n > 0) request(state, me, SKY_QUEUE_BASE_JETS, n, n * COST_GUARDIAN);
      }
      if (hd < SKY_SPEND_HOME || jetCount(state, me) < 10) {
        for (let k = 2; k < SKY_OUTPOSTS; k++) {
          if (!owns(state, k, me)) continue;
          let want = randInt(state, 4);
          const room = SKY_UNIT_CAP - jetCount(state, me);
          if (want > room) want = room;
          const spare = state.points[me] - SKY_SPARE_BUDGET;
          if (want * 2 > spare) want = Math.trunc(spare / 2);
          if (want <= 0) continue;
          request(state, me, 3 + 2 * k, want, want * COST_GUARDIAN * SKY_OUTPOST_UNIT_COST);
        }
      }
    }
    if (hd < SKY_SPEND_HOME && s.near9 < 0) {
      const threshold = randInt(state, 8) + SKY_FORTRESS_BUDGET;
      if (state.points[me] > threshold) {
        state.points[me] -= COST_FORTRESS;
        heavyNow(state, me, ARCHETYPE.FORTRESS);
      }
    }
  } else {
    // Claim every unclaimed outpost while it has 30, in its construct's order.
    const order = c.order === 1 ? ORDER_1 : ORDER_0;
    for (let i = 0; i < SKY_OUTPOSTS; i++) {
      const k = order[i];
      if (k >= state.outpostOwner.length) continue; // district-01 has two outposts
      if (state.outpostOwner[k] !== -1 || state.outpostConsole[k] < 0) continue;
      if (state.points[me] < COST_OUTPOST_CLAIM) {
        refused += 1;
        continue;
      }
      claimOutpostSlot(state, me, k);
      if (state.points[me] < COST_OUTPOST_CLAIM) break;
    }
  }
  if (c.mode === SKY_MODE_ATTACK) {
    for (let k = 0; k < 2; k++) {
      if (!owns(state, k, me)) continue;
      let want = randInt(state, 8) + 7 + l4 - 2;
      const room = SKY_UNIT_CAP - tankCount(state, me);
      if (want > room) want = room;
      if (want < 7 || want * 2 > state.points[me]) continue;
      request(state, me, 2 + 2 * k, want, want * COST_RUNNER * SKY_OUTPOST_UNIT_COST);
    }
    if (tankCount(state, me) > 11) {
      for (let k = 0; k < 2; k++) {
        if (!owns(state, k, me)) continue;
        let want = randInt(state, 4) + 4 + l4 - 2;
        const room = SKY_UNIT_CAP - jetCount(state, me);
        if (want > room) want = room;
        if (want < 4 || want * 2 > state.points[me]) continue;
        request(state, me, 3 + 2 * k, want, want * COST_GUARDIAN * SKY_OUTPOST_UNIT_COST);
      }
    }
  }
  if (c.mode !== SKY_MODE_ROAM) return;
  // A Dreadnought when none of its own is near the player's base. The spawner's
  // limit of one silently refuses a second while the 50 is spent: the retail
  // quirk, kept.
  if (s.near28 < 0 && state.points[me] >= COST_JUGGERNAUT) {
    state.points[me] -= COST_JUGGERNAUT;
    heavyNow(state, me, ARCHETYPE.JUGGERNAUT);
  }
  // The two words this gate compares (`word_32 > word_30`) have no writer that
  // was decompiled; both start at zero, so only the level clause opens it.
  let stock = (c.order === 1 && level < 8) || (c.order === 0 && level < 6);
  if (stock && level + 6 > SKY_UNIT_CAP - tankCount(state, me)) stock = false;
  if (stock) {
    for (let k = 0; k < 2; k++) {
      if (!owns(state, k, me)) continue;
      let want = randInt(state, 8) + level + 6 + l4 - 2;
      const room = SKY_UNIT_CAP - tankCount(state, me);
      if (want > room) want = room;
      if (want < level + 6 || want * 2 > state.points[me]) continue;
      request(state, me, 2 + 2 * k, want, want * COST_RUNNER * SKY_OUTPOST_UNIT_COST);
    }
    let allowed = true;
    if (ownedCount(state, me) !== 0 || level >= 5) {
      if (!owns(state, 0, enemy) || !owns(state, 1, enemy)) allowed = false;
    }
    if (allowed && tankCount(state, me) < 2) {
      let want = randInt(state, 4) + level + 6;
      // "+6 if the player owns all four outposts" (all of district-01's two).
      const all =
        state.outpostOwner.length > 0 && ownedCount(state, enemy) === state.outpostOwner.length;
      if (all) want += 6;
      const room = SKY_UNIT_CAP - tankCount(state, me);
      if (want > room) want = room;
      if (want >= level + 6 && want <= state.points[me]) {
        request(state, me, SKY_QUEUE_BASE_TANKS, want, want * COST_RUNNER);
      }
    }
  }
  void refused; // the gate's `slots_refused > 0` clause sits behind the dead words above
  if (c.order === 0 && jetCount(state, me) < 1) {
    let want = randInt(state, 2) + 1;
    const room = SKY_UNIT_CAP - jetCount(state, me);
    if (want > room) want = room;
    if (want > state.points[me]) want = state.points[me];
    if (want > 0) request(state, me, SKY_QUEUE_BASE_JETS, want, want * COST_GUARDIAN);
  }
}

/** The two outpost orders (`0x0048b7a0` / `0x0048b7a4`). */
const ORDER_0: readonly number[] = [3, 2, 1, 0];
const ORDER_1: readonly number[] = [1, 0, 3, 2];

function ownedCount(state: SimState, team: number): number {
  let n = 0;
  for (let k = 0; k < state.outpostOwner.length; k++) if (state.outpostOwner[k] === team) n += 1;
  return n;
}

/** A Dreadnought or Fortress request: the script spawns it at once if its limit allows. */
function heavyNow(state: SimState, me: number, archetype: number): void {
  const limit = archetype === ARCHETYPE.JUGGERNAUT ? JUGGERNAUT_ALIVE_LIMIT : FORTRESS_ALIVE_LIMIT;
  if (countTeam(state, archetype, me) >= limit) return; // spent, refused: the quirk
  const base = state.map.bases[me];
  let x = base.airConsole.x;
  let y = base.airConsole.y;
  let layer = base.airConsole.layer;
  if (archetype === ARCHETYPE.JUGGERNAUT) {
    const dread = base.juggernaut;
    x = dread !== undefined ? dread.x : base.groundConsole.x;
    y = dread !== undefined ? dread.y : base.groundConsole.y;
    layer = dread !== undefined ? dread.layer : base.groundConsole.layer;
  }
  const uid = spawnUnit(state, archetype, me, x, y, UNIT_MODE_PATROL, false, layer);
  if (uid >= 0) pushEvent(state.events, EV_PURCHASE, uid, me, archetype);
}

/**
 * The scripts that turn its requests into units (fn17/fn19 and the outpost
 * queues): one unit per queue per period, tanks every 3.4 s, jets every 0.97 s,
 * at the base consoles or the outpost (a forward spawn), while the side is
 * under its cap of 20 alive.
 */
function captainQueues(state: SimState, me: number): void {
  const c = state.captain;
  const map = state.map;
  for (let q = 0; q < SKY_QUEUES; q++) {
    if (c.queue[q] <= 0) {
      c.queueTimer[q] = 0;
      continue;
    }
    if (c.queueTimer[q] > 0) {
      c.queueTimer[q] -= 1;
      continue;
    }
    const jet = (q & 1) === 1;
    const archetype = jet ? ARCHETYPE.GUARDIAN : ARCHETYPE.RUNNER;
    if (countTeam(state, archetype, me) >= SKY_UNIT_CAP) continue;
    let x: number;
    let y: number;
    let layer: number;
    let forward = false;
    let mode = UNIT_MODE_PATROL;
    if (q < 2) {
      const at = jet ? map.bases[me].airConsole : map.bases[me].groundConsole;
      x = at.x;
      y = at.y;
      layer = at.layer;
    } else {
      const k = (q - 2) >> 1;
      if (k >= map.outpostSpots.length) {
        c.queue[q] = 0;
        continue;
      }
      // The original's outposts have a tank pad and a jet pad; Metropolis' own
      // sell both at the console.
      const o = map.outposts.length > 0 ? map.outposts[k] : undefined;
      const at = o === undefined ? map.outpostSpots[k] : jet ? o.jetPad : o.tankPad;
      x = at.x;
      y = at.y;
      layer = at.layer;
      forward = true;
      if (jet) mode = UNIT_MODE_OUTPOST + k;
    }
    const uid = spawnUnit(state, archetype, me, x, y, mode, forward, layer);
    if (uid < 0) continue; // the entity store is full: try again next tick
    c.queue[q] -= 1;
    // The next one SKY_*_QUEUE_TICKS later (the countdown runs out the tick before).
    c.queueTimer[q] = (jet ? SKY_JET_QUEUE_TICKS : SKY_TANK_QUEUE_TICKS) - 1;
    pushEvent(state.events, EV_PURCHASE, uid, me, archetype);
  }
}

// --- Weapons -----------------------------------------------------------------

const PHASE_INSIDE = 0;
const PHASE_DUE = 1;
const PHASE_BETWEEN = 2;
const REFIRE: readonly number[] = [
  SKY_GUN_REFIRE_UNITS,
  SKY_MISSILE_REFIRE_UNITS,
  SKY_BOMB_REFIRE_UNITS,
];

/** One weapon's rate machine, the shooters' (`cact_shooter_step`): true when due. */
function gunDue(state: SimState, k: number): boolean {
  const c = state.captain;
  let phase = c.gunPhase[k];
  let clock = c.gunClock[k];
  if (phase === PHASE_INSIDE) {
    clock += WEAPON_UNITS_PER_TICK;
    if (clock >= 0) phase = PHASE_DUE;
  } else if (phase === PHASE_BETWEEN) {
    clock += WEAPON_UNITS_PER_TICK;
    if (clock >= REFIRE[k]) {
      clock -= REFIRE[k];
      if (clock > 0) clock = 0;
      phase = PHASE_INSIDE;
    }
  }
  c.gunPhase[k] = phase;
  c.gunClock[k] = clock;
  return phase === PHASE_DUE;
}

/** cos of the arc a weapon fires in at this level (-2 = all round). */
function arcCos(k: number, level: number): number {
  if (k === 0) return level < 1 ? SHOOTER_FRONT_ARC_COS : SKY_ARC_SIDE_COS;
  if (k === 1) return level < 3 ? SHOOTER_FRONT_ARC_COS : level < 7 ? SKY_ARC_SIDE_COS : -2;
  return -2;
}

/** Its target stays one: alive, an enemy, inside its 12 m engage range. */
function aimValid(state: SimState, id: number, t: number): boolean {
  const ent = state.ent;
  if (!ent.alive[t] || ent.hp[t] <= 0 || ent.archetype[t] === ARCHETYPE.PROJECTILE) return false;
  const team = ent.team[t];
  if (team === ent.team[id] || team === TEAM_NEUTRAL) return false;
  return inWeaponRange(state, id, t);
}

/** A line the captain can shoot along: walls stop it, except at ground units it flies over. */
function clearLine(state: SimState, id: number, t: number): boolean {
  const ent = state.ent;
  if (isGroundUnit(ent.archetype[t])) return true;
  return !segmentBlocked(state.map, ent.posX[id], ent.posY[id], ent.posX[t], ent.posY[t]);
}

/**
 * Its three weapons share one target (`sky_aim`). A due round drops a target
 * that died, stopped being an enemy or left the 12 m engage range; with no
 * target the shooters search by team every 1.0 s for the nearest enemy in reach
 * with a line of sight. A round goes out only inside the weapon's arc about its
 * heading — and the missile only with a line of sight — else it is put back and
 * tried 0-0.85 s later.
 */
function captainWeapons(state: SimState, id: number, me: number, level: number): void {
  const ent = state.ent;
  const c = state.captain;
  let anyDue = false;
  const due0 = gunDue(state, 0);
  const due1 = gunDue(state, 1);
  const due2 = gunDue(state, 2);
  anyDue = due0 || due1 || due2;
  if (!anyDue) return;
  if (c.aim >= 0 && !aimValid(state, id, c.aim)) c.aim = -1;
  if (c.aim < 0) {
    c.search -= WEAPON_UNITS_PER_TICK;
    if (c.search < 0) {
      c.search = SKY_SEARCH_UNITS;
      c.aim = nearestEnemyInRange(state, id, SKY_AIM_RANGE);
    }
  }
  const t = c.aim;
  if (t < 0) return; // the rounds wait for a target, their clocks stopped
  const dx = ent.posX[t] - ent.posX[id];
  const dy = ent.posY[t] - ent.posY[id];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const fx = cosLUT(ent.yaw[id]);
  const fy = sinLUT(ent.yaw[id]);
  const facing = ux * fx + uy * fy;
  for (let k = 0; k < 3; k++) {
    if (!(k === 0 ? due0 : k === 1 ? due1 : due2)) continue;
    const blocked = facing < arcCos(k, level) || (k === 1 && !clearLine(state, id, t));
    if (blocked) {
      c.gunPhase[k] = PHASE_INSIDE;
      c.gunClock[k] -= Math.floor(rand01(state) * SHOOTER_RETRY_UNITS);
      continue;
    }
    if (k === 0) {
      hitscan(state, id, me, ux, uy, SKY_GUN_REACH, SKY_GUN_DAMAGE, SHOT_SLOT_HITSCAN);
    } else if (k === 1) {
      fireWardenMissile(state, id, t, ux, uy);
    } else {
      pushEvent(state.events, EV_SHOT, id, SHOT_SLOT_LAUNCH, SKY_WEAPON_BOMB);
      spawnWardenBomb(state, id, me, ux, uy);
    }
    c.gunPhase[k] = PHASE_BETWEEN;
  }
}

// --- Flight ------------------------------------------------------------------

/**
 * The commander's flight (`aircraft_fly`): in ENGAGE with a move target it flies
 * at the target, otherwise at its destination; inside the 1 m standoff it
 * reverses, which is what makes it circle and jitter on a target. It never
 * patrols. Level flight at its level's speed; terrain and walls are beneath it.
 */
function captainFly(state: SimState, id: number): void {
  const ent = state.ent;
  const c = state.captain;
  let tx = c.destX;
  let ty = c.destY;
  if (c.fly === SKY_ENGAGE && c.move >= 0) {
    tx = ent.posX[c.move];
    ty = ent.posY[c.move];
  }
  let dx = tx - ent.posX[id];
  let dy = ty - ent.posY[id];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1e-6) {
    dx /= d;
    dy /= d;
  } else {
    dx = cosLUT(ent.yaw[id]);
    dy = sinLUT(ent.yaw[id]);
  }
  if (d < SKY_STANDOFF) {
    dx = -dx;
    dy = -dy;
  }
  const extent = worldExtent(state.map);
  ent.velX[id] = dx * c.speed;
  ent.velY[id] = dy * c.speed;
  const x = Math.min(Math.max(ent.posX[id] + ent.velX[id] * TICK_DT, 0), extent);
  const y = Math.min(Math.max(ent.posY[id] + ent.velY[id] * TICK_DT, 0), extent);
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.yaw[id] = atan2Poly(dy, dx);
  ent.aimX[id] = dx;
  ent.aimY[id] = dy;
  ent.animState[id] = ANIM_MOVING;
  const ground = sampleHeight(state.map, x, y);
  ent.height[id] = Math.max(ground, state.map.waterLevel) + WARDEN_ALTITUDE;
}
