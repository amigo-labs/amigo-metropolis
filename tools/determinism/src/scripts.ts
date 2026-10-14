// Scripted input generators for authoring golden replays. Scripts avoid
// engine-dependent constructs — simMath LUT trig instead of Math trig, no
// randomness, no wall-clock; IEEE-exact ops like Math.floor are fine — so a
// regenerated replay is byte-identical on any machine. Goldens change only
// when someone deliberately edits a script or the sim itself (which is a
// SIM_VERSION bump).

import {
  ARCHETYPE,
  BTN_ACTION,
  BTN_BACK,
  BTN_CHANGE_TARGET,
  BTN_FORWARD,
  BTN_GUN,
  BTN_HEAVY,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_SPECIAL,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  clearTickInputs,
  crossesWallX,
  crossesWallY,
  type MapData,
  type PlayerInput,
  type SimState,
  sampleHeight,
  segmentBlocked,
  TEAM_NEUTRAL,
  TICK_HZ,
  type TickInputs,
  TRANSFORM_CHORD,
  TRANSFORM_LOCK_TICKS,
  type WardenConfig,
} from "@metropolis/sim";

/**
 * One tick of a golden's inputs. `sim` is the live state at recording time
 * (read it, never write it): a script may steer by it, and the replay keeps only
 * the inputs it chose.
 */
export type InputScript = (tick: number, out: TickInputs, sim: Readonly<SimState>) => void;

/**
 * Golden #1 (Phase 0): 60 s of driving on the original's buttons — a sprint,
 * turning circles both ways, a figure eight, idle stretches, the diagonals with
 * jump chatter, reversing, strafing, and all three weapons. Exercises the button
 * word, the walker's turn at speed and at rest, bound clamping and yaw updates.
 */
export function drive01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 5) {
    p.buttons = BTN_FORWARD; // sprint ahead
  } else if (t < 12) {
    p.buttons = BTN_FORWARD | BTN_TURN_RIGHT; // a circle to the right
  } else if (t < 20) {
    // Turn about on the spot, then straight on, firing.
    p.buttons = t < 13.7 ? BTN_TURN_LEFT : BTN_FORWARD | BTN_GUN;
  } else if (t < 30) {
    // A figure eight: the turn flips every 2.5 s.
    p.buttons = BTN_FORWARD | (Math.floor(t / 2.5) % 2 === 0 ? BTN_TURN_RIGHT : BTN_TURN_LEFT);
  } else if (t < 33) {
    // idle — hash sequence must still advance via the tick counter
  } else if (t < 43) {
    // The diagonal forward-right with jump chatter.
    p.buttons = BTN_FORWARD | BTN_JINK_RIGHT;
    if (Math.floor(t * 2) % 2 === 0) p.buttons |= BTN_JUMP;
  } else if (t < 53) {
    // Reversing in a circle to the left, heavy fire, then Special held.
    p.buttons = BTN_BACK | BTN_TURN_LEFT | (t < 48 ? BTN_HEAVY : BTN_SPECIAL);
  } else {
    // Strafe left, then back-left, into the map edge clamp.
    p.buttons = t < 56 ? BTN_JINK_LEFT : BTN_BACK | BTN_JINK_LEFT;
  }
}

/**
 * Exactly one transform, however the respawn tick lands.
 *
 * The transform is the original's chord, Change Target + Action, read as a
 * level: a chord still held when a change ends starts the next one. Holding it
 * for strictly LESS than one change therefore lands exactly one, at the first
 * tick the avatar is up to take it — every later tick falls inside the change
 * it started. The form at the end of the phase is the script's choice, not
 * arithmetic on the hold and the change's length.
 */
function transformOnce(t: number, from: number): number {
  const dt = t - from;
  if (dt < 0 || dt >= (TRANSFORM_LOCK_TICKS - 1) / TICK_HZ) return 0;
  return TRANSFORM_CHORD;
}

// --- Closed-loop helpers (recording time only) ------------------------------
//
// The goldens below steer by the live state the recorder hands them: drive to a
// point, aim at the nearest target. Plain arithmetic only (Math.sqrt is exact),
// so a re-record is byte-identical on any machine.

/** Off the heading by more than this (sin, about 4°), the hull turns. */
const STEER_TURN = 0.07;
/** Within this of the heading (cos 22.5°), it drives forward as it turns. */
const STEER_DRIVE = 0.9238795325112867;

/**
 * Player `p` steers along (dx, dy) with the turn buttons — Turn Right when the
 * direction lies to the hull's right — and, when `drive` and within 22.5° of it,
 * holds Move Forward. The original has no heading to send, only the buttons.
 */
function head(
  sim: Readonly<SimState>,
  p: number,
  dx: number,
  dy: number,
  out: PlayerInput,
  drive = true,
): void {
  const a = sim.avatarId[p];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (a < 0 || d < 1e-6) return;
  const hx = sim.ent.aimX[a];
  const hy = sim.ent.aimY[a];
  const across = (hx * dy - hy * dx) / d; // + : the direction is to the right
  const along = (hx * dx + hy * dy) / d;
  if (along < 0 || Math.abs(across) > STEER_TURN) {
    out.buttons |= across >= 0 ? BTN_TURN_RIGHT : BTN_TURN_LEFT;
  }
  if (drive && along > STEER_DRIVE) out.buttons |= BTN_FORWARD;
}

/**
 * The steepest climb a route takes, rise per metre, sampled every quarter metre:
 * under the walker's own gate (AVATAR_WALKER_MAX_SLOPE 1.04), which judges the
 * ground's slope, not the difference between two cell centres.
 */
const ROUTE_SLOPE = 0.95;

/** Can the walker climb from (x, y) to (nx, ny)? Any descent is fine. */
function climbable(map: MapData, x: number, y: number, nx: number, ny: number): boolean {
  let h = sampleHeight(map, x, y);
  for (let q = 1; q <= 4; q++) {
    const hq = sampleHeight(map, x + ((nx - x) * q) / 4, y + ((ny - y) * q) / 4);
    if (hq - h > ROUTE_SLOPE * 0.25 * map.cellSize) return false;
    h = hq;
  }
  return true;
}

/**
 * A breadth-first route over the ground layer's cells from (ax, ay) toward the
 * cell of (bx, by): through no wall and up no slope steeper than ROUTE_SLOPE. When
 * that cell cannot be reached, to the reachable cell nearest it. Cell centres
 * as a flat [x0, y0, x1, y1, ...] list.
 */
function groundRoute(map: MapData, ax: number, ay: number, bx: number, by: number): number[] {
  const n = map.size - 1;
  const cs = map.cellSize;
  const cellOf = (v: number): number => Math.min(n - 1, Math.max(0, Math.floor(v / cs)));
  const start = cellOf(ay) * n + cellOf(ax);
  const goal = cellOf(by) * n + cellOf(bx);
  const prev = new Int32Array(n * n).fill(-1);
  prev[start] = start;
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  let best = start;
  let bestD2 = Number.POSITIVE_INFINITY;
  while (head < tail && prev[goal] < 0) {
    const c = queue[head++];
    const i = c % n;
    const j = (c - i) / n;
    const x = (i + 0.5) * cs;
    const y = (j + 0.5) * cs;
    const gd2 = (x - bx) * (x - bx) + (y - by) * (y - by);
    if (gd2 < bestD2) {
      bestD2 = gd2;
      best = c;
    }
    for (let k = 0; k < 4; k++) {
      const ni = i + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const nj = j + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const nc = nj * n + ni;
      if (prev[nc] >= 0) continue;
      const nx = (ni + 0.5) * cs;
      const ny = (nj + 0.5) * cs;
      if (k < 2 ? crossesWallX(map, x, nx, y) : crossesWallY(map, x, y, ny)) continue;
      if (!climbable(map, x, y, nx, ny)) continue;
      prev[nc] = c;
      queue[tail++] = nc;
    }
  }
  const end = prev[goal] >= 0 ? goal : best;
  const cells: number[] = [];
  for (let c = end; c !== start; c = prev[c]) cells.push(c);
  cells.push(start);
  const out: number[] = [];
  for (let k = cells.length - 1; k >= 0; k--) {
    const i = cells[k] % n;
    out.push((i + 0.5) * cs, ((cells[k] - i) / n + 0.5) * cs);
  }
  return out;
}

/** Each player's route: its goal, the cells, and the cell it is heading for. */
const routes = [
  { gx: Number.NaN, gy: Number.NaN, path: [] as number[], at: -1, age: 0 },
  { gx: Number.NaN, gy: Number.NaN, path: [] as number[], at: -1, age: 0 },
];

/** Forgets both players' routes (a script's first tick). */
function resetRoutes(): void {
  for (const r of routes) {
    r.gx = Number.NaN;
    r.path = [];
    r.at = -1;
  }
}

/**
 * Drives player `p` to (x, y) along a ground route until within `near` metres.
 * It heads for one route cell at a time — the farthest of the next eight it can
 * see in a straight line — and picks the next only on arrival, so the walker's
 * turn is never chasing a target that moves. Returns the distance left, or -1
 * while the player is down.
 */
function driveTo(
  sim: Readonly<SimState>,
  p: number,
  x: number,
  y: number,
  near: number,
  out: PlayerInput,
): number {
  const a = sim.avatarId[p];
  if (a < 0) return -1;
  const ax = sim.ent.posX[a];
  const ay = sim.ent.posY[a];
  const dx = x - ax;
  const dy = y - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= near) return d;
  const r = routes[p];
  r.age += 1;
  if (r.gx !== x || r.gy !== y || r.age > 600 || r.at < 0) {
    r.gx = x;
    r.gy = y;
    r.path = groundRoute(sim.map, ax, ay, x, y);
    r.at = 0;
    r.age = 0;
  }
  const cells = r.path.length / 2;
  if (cells === 0) {
    head(sim, p, dx, dy, out);
    return d;
  }
  if (d < 1.5) {
    head(sim, p, dx, dy, out); // the last stretch: straight at the goal itself
    return d;
  }
  let wx = r.path[r.at * 2] - ax;
  let wy = r.path[r.at * 2 + 1] - ay;
  if (r.at < cells - 1 && wx * wx + wy * wy < 0.6 * 0.6) {
    let k = r.at + 1;
    for (let m = Math.min(cells - 1, r.at + 8); m > r.at + 1; m--) {
      if (!segmentBlocked(sim.map, ax, ay, r.path[m * 2], r.path[m * 2 + 1])) {
        k = m;
        break;
      }
    }
    r.at = k;
    wx = r.path[k * 2] - ax;
    wy = r.path[k * 2 + 1] - ay;
  }
  head(sim, p, wx, wy, out);
  return d;
}

/** The nearest live entity `pick` accepts, from player `p`'s avatar; -1 none. */
function nearestTo(sim: Readonly<SimState>, p: number, pick: (id: number) => boolean): number {
  const a = sim.avatarId[p];
  if (a < 0) return -1;
  const ent = sim.ent;
  let best = -1;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || id === a || !pick(id)) continue;
    const dx = ent.posX[id] - ent.posX[a];
    const dy = ent.posY[id] - ent.posY[a];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = id;
    }
  }
  return best;
}

/**
 * Closes on entity `id` to `range` metres and fires `buttons` at it once in
 * range (the lock does the aiming within 12 m). Returns false when it is gone.
 */
function engage(
  sim: Readonly<SimState>,
  p: number,
  id: number,
  range: number,
  buttons: number,
  out: PlayerInput,
): boolean {
  const a = sim.avatarId[p];
  if (a < 0 || id < 0 || !sim.ent.alive[id]) return false;
  const dx = sim.ent.posX[id] - sim.ent.posX[a];
  const dy = sim.ent.posY[id] - sim.ent.posY[a];
  if (dx * dx + dy * dy > range * range) {
    driveTo(sim, p, sim.ent.posX[id], sim.ent.posY[id], range, out);
  } else {
    head(sim, p, dx, dy, out, false); // face it: the lock takes it within 12.5°
    out.buttons |= buttons;
  }
  return true;
}

/** Cycles the three fire buttons a second each: Gun, Heavy, Special. */
function allWeapons(tick: number): number {
  const k = Math.floor(tick / TICK_HZ) % 3;
  return k === 0 ? BTN_GUN : k === 1 ? BTN_HEAVY : BTN_SPECIAL;
}

/** A neutral (team-less) turret: the outposts' plate guns before a claim. */
function isNeutralTurret(sim: Readonly<SimState>, id: number): boolean {
  return sim.ent.archetype[id] === ARCHETYPE.TURRET && sim.ent.team[id] === TEAM_NEUTRAL;
}

/**
 * Golden #2 (combat): 120 s on urban-jungle (Conft), player 0 alone. It walks to
 * the nearest outpost's neutral plate guns and fights them with every weapon in
 * turn (the Gun on the lock, Heavy and Special for the blasts) until one dies;
 * then switches to hover, cruises the field firing, jumps and turns back to a
 * walker. Closed loop: it steers by the live state at recording time, so the
 * route survives a moved spawn or facing.
 */
let combatTarget = -1;
let combatPhase = 0;
let combatFrom = 0;
export function combat01(tick: number, out: TickInputs, sim: Readonly<SimState>): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (tick === 0) {
    resetRoutes();
    combatTarget = -1;
    combatPhase = 0;
    combatFrom = 0;
  }
  if (combatPhase === 0) {
    // Fight a plate gun until it dies (or 75 s pass).
    if (combatTarget < 0 || !sim.ent.alive[combatTarget]) {
      if (combatTarget >= 0 || t > 75) {
        combatPhase = 1;
        combatFrom = t;
      } else {
        combatTarget = nearestTo(sim, 0, (id) => isNeutralTurret(sim, id));
      }
    }
    if (combatPhase === 0) engage(sim, 0, combatTarget, 9, allWeapons(tick), p);
    return;
  }
  const dt = t - combatFrom;
  if (dt < 2) {
    p.buttons = transformOnce(t, combatFrom); // to hover
  } else if (dt < 20) {
    // Hover across the field toward the far outposts, firing ahead.
    const cx = sim.map.outpostSpots[2].x;
    const cy = sim.map.outpostSpots[2].y;
    driveTo(sim, 0, cx, cy, 3, p);
    p.buttons |= Math.floor(tick / 15) % 2 === 0 ? BTN_GUN : BTN_SPECIAL;
  } else if (dt < 24) {
    p.buttons = transformOnce(t, combatFrom + 20); // back to walker
  } else if (dt < 36) {
    // Walk back toward the base with jump chatter, Heavy on the way.
    const s = sim.map.spawns[0];
    driveTo(sim, 0, s.x, s.y, 3, p);
    p.buttons |= Math.floor(t * 2) % 2 === 0 ? BTN_JUMP : BTN_HEAVY;
  } else {
    p.buttons = BTN_FORWARD | BTN_TURN_RIGHT; // a circle until the end
  }
}

/**
 * Golden #3 (match): 200 s on la-cantina, two players. Each walks to its own
 * ground console and buys five tanks, one per press; then both walk out to
 * meet and fight each other with every weapon until the recording ends, and
 * whoever goes down walks back out after its respawn. Covers two players'
 * purchases, the units on both sides' roads, avatar fights, downs paid at the
 * respawn, and the rings.
 */
const matchBought = [0, 0];
function matchPlayer(sim: Readonly<SimState>, p: number, tick: number, out: PlayerInput): void {
  const base = sim.map.bases[p];
  const c = base.groundConsole;
  if (matchBought[p] < 5) {
    const d = driveTo(sim, p, c.x, c.y, 1, out);
    if (d >= 0 && d <= 1 && tick % 15 === 0) {
      out.buttons = BTN_ACTION; // a tap: one unit
      matchBought[p] += 1;
    }
    return;
  }
  const foe = sim.avatarId[1 - p];
  if (foe >= 0) {
    engage(sim, p, foe, 9, allWeapons(tick), out);
  } else {
    const g = sim.map.bases[1 - p].gate; // the foe is down: toward its base
    driveTo(sim, p, g.x, g.y, 20, out);
  }
}
export function match01(tick: number, out: TickInputs, sim: Readonly<SimState>): void {
  clearTickInputs(out);
  if (tick === 0) {
    resetRoutes();
    matchBought[0] = 0;
    matchBought[1] = 0;
  }
  matchPlayer(sim, 0, tick, out.players[0]);
  matchPlayer(sim, 1, tick, out.players[1]);
}

/**
 * Golden #4 (Warden): 150 s on urban-jungle against the Sky Captain at difficulty 3
 * (level 2, so it fields its free opening order). Player 0 holds its own base:
 * it stands by its gate and fights whatever enemy comes within 20 m, the
 * captain included, every weapon in turn, and walks back to the gate between
 * fights. Player 1's input channel stays all-zero: the AI ignores TickInputs.
 */
export function warden01(tick: number, out: TickInputs, sim: Readonly<SimState>): void {
  clearTickInputs(out);
  if (tick === 0) resetRoutes();
  const p = out.players[0];
  const a = sim.avatarId[0];
  if (a < 0) return;
  const ent = sim.ent;
  const foe = nearestTo(sim, 0, (id) => {
    const arch = ent.archetype[id];
    const unit =
      arch === ARCHETYPE.WARDEN ||
      arch === ARCHETYPE.RUNNER ||
      arch === ARCHETYPE.GUARDIAN ||
      arch === ARCHETYPE.JUGGERNAUT ||
      arch === ARCHETYPE.FORTRESS;
    if (!unit || ent.team[id] === ent.team[a]) return false;
    const dx = ent.posX[id] - ent.posX[a];
    const dy = ent.posY[id] - ent.posY[a];
    return dx * dx + dy * dy < 20 * 20;
  });
  if (foe >= 0) {
    engage(sim, 0, foe, 10, allWeapons(tick), p);
    return;
  }
  const g = sim.map.bases[0].gate;
  driveTo(sim, 0, g.x, g.y, 4, p);
}

/**
 * Golden #5 (FCOP stage 2): 90 s on urban-jungle, the first arena with wall
 * data. Buys runners at the ground console (units follow lanes, exercising
 * the walled unit stepper + separation), then drives ENE into the vertical
 * wall band on grid line x=81 (rows ~100-102), pins against it, slides north
 * along it, and roams back — the golden's hash sequence covers wall-blocked
 * avatar movement on both axes.
 */
export function fcop01(tick: number, out: TickInputs, sim: Readonly<SimState>): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  // Each leg steers along a world bearing with the turn buttons (`head`), so
  // the walls are met as they were when this golden pushed a stick that way.
  // urban-jungle's spawn 0 is at (106.2, 71) since the arena was rebuilt from
  // the original Conft logic, not the (38,128) the bearings were written for.
  if (t < 4) {
    head(sim, 0, 0, -1, p); // north, off the base platform toward the consoles
  } else if (t < 20) {
    // Runner waves onto the lanes: one per press of the Action Key, a press
    // every 0.5 s.
    p.buttons = tick % 15 === 0 ? BTN_ACTION : 0;
  } else if (t < 40) {
    head(sim, 0, 127, -35, p); // ENE toward the wall band on line x=81
  } else if (t < 52) {
    head(sim, 0, 0, -1, p); // slide north along the wall
  } else if (t < 64) {
    head(sim, 0, 1, 0, p); // due-east push against the band again, firing
    p.buttons |= BTN_GUN;
  } else if (t < 78) {
    head(sim, 0, -90, 110, p); // swing back southwest across open ground
  } else {
    p.buttons = BTN_JINK_RIGHT | BTN_BACK; // back off on a diagonal until the end
  }
}

/**
 * Golden #6 (Layered v2): the avatar on layered-test walks EAST up the layer-1
 * ramp (cols 2..5 rising 0→3 m) onto the mid deck, crosses it north, then walks
 * back west and descends to the base layer. Pins the multi-deck movement +
 * transition + gravity path (the only golden whose hash covers entLayer).
 */
export function layered01(tick: number, out: TickInputs, sim: Readonly<SimState>): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 6) {
    head(sim, 0, 1, 0, p); // spawn (2,2) → east, up the ramp onto the 3 m deck
  } else if (t < 12) {
    head(sim, 0, 0, 1, p); // cross the deck northward
  } else if (t < 18) {
    head(sim, 0, -1, 0, p); // back west, descending the ramp to the base layer
  } else {
    p.buttons = BTN_TURN_LEFT | BTN_CHANGE_TARGET; // turn on the spot, cycling the lock
  }
}

/**
 * Golden #7 (Precinct Assault): 120 s on la-cantina, the arena rebuilt from the
 * original Mp logic (rules.md §9), against the Sky Captain (difficulty 8).
 * Covers what no other golden touches — bought units on the original Cnet graph,
 * per-turret weapon profiles with gun slew, capture on an authentic pad, a
 * base-intrusion alarm and the original's gate-box win with its outro.
 *
 * Player 0 walks to its ground console and buys five tanks, one per press; then
 * to the nearest neutral pad and captures it on a press (the original captures
 * on a press, instantly); then pushes south down the central spine, firing, as
 * far as the enemy line allows. Closed loop since SIM_VERSION 56: it steers by
 * the live state at recording time, so it finds the console's trigger box (Mp:
 * 1.2 x 1.2 m) wherever the walk ends.
 */
let paBought = 0;
let paPad = -1;
let paPhase = 0;
let paFrom = 0;
export function pa01(tick: number, out: TickInputs, sim: Readonly<SimState>): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (tick === 0) {
    resetRoutes();
    paBought = 0;
    paPad = -1;
    paPhase = 0;
  }
  if (paPhase === 0) {
    // Tanks onto the graph: one per press at the ground console.
    const c = sim.map.bases[0].groundConsole;
    const d = driveTo(sim, 0, c.x, c.y, 0.4, p);
    if (d >= 0 && d <= 0.4 && tick % 15 === 0) {
      p.buttons = BTN_ACTION;
      paBought += 1;
      if (paBought === 5) paPhase = 1;
    }
    return;
  }
  if (paPhase === 1) {
    // The nearest pad still neutral: walk up and tap the action key by it.
    if (paPad < 0 || !sim.ent.alive[paPad] || sim.ent.team[paPad] !== TEAM_NEUTRAL) {
      paPad = nearestTo(sim, 0, (id) => isNeutralTurret(sim, id));
    }
    if (paPad < 0 || t > 50) {
      paPhase = 2;
      paFrom = t;
      return;
    }
    const d = driveTo(sim, 0, sim.ent.posX[paPad], sim.ent.posY[paPad], 2.5, p);
    if (d >= 0 && d <= 2.5) {
      p.buttons = Math.floor(tick / 15) % 2 === 1 ? BTN_ACTION : 0;
      if (sim.ent.team[paPad] === 0) {
        paPhase = 2;
        paFrom = t;
      }
    }
    return;
  }
  // Push south toward the enemy gate, firing into the line.
  const g = sim.map.bases[1].gate;
  driveTo(sim, 0, g.x, g.y, 6, p);
  if (t - paFrom > 2) p.buttons |= allWeapons(tick);
}

export const SCRIPTS: Record<
  string,
  { script: InputScript; ticks: number; mapId?: string; warden?: WardenConfig }
> = {
  "drive-01": { script: drive01, ticks: 60 * TICK_HZ },
  "combat-01": { script: combat01, ticks: 120 * TICK_HZ, mapId: "urban-jungle" },
  "match-01": { script: match01, ticks: 200 * TICK_HZ, mapId: "la-cantina" },
  "warden-01": {
    script: warden01,
    ticks: 150 * TICK_HZ,
    mapId: "urban-jungle",
    warden: { player: 1, difficulty: 3 },
  },
  "fcop-01": { script: fcop01, ticks: 90 * TICK_HZ, mapId: "urban-jungle" },
  "layered-01": { script: layered01, ticks: 20 * TICK_HZ, mapId: "layered-test" },
  "pa-01": {
    script: pa01,
    ticks: 120 * TICK_HZ,
    mapId: "la-cantina",
    warden: { player: 1, difficulty: 8 },
  },
};
