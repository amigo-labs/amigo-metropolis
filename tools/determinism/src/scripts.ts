// Scripted input generators for authoring golden replays. Scripts avoid
// engine-dependent constructs — simMath LUT trig instead of Math trig, no
// randomness, no wall-clock; IEEE-exact ops like Math.floor are fine — so a
// regenerated replay is byte-identical on any machine. Goldens change only
// when someone deliberately edits a script or the sim itself (which is a
// SIM_VERSION bump).

import {
  AVATAR_WALKER_SPEED,
  atan2Poly,
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  clearTickInputs,
  cosLUT,
  quantizeAxis,
  retentionPerTick,
  sinLUT,
  TICK_HZ,
  type TickInputs,
  TRANSFORM_LOCK_TICKS,
  WALKER_DRAG,
  WALKER_STOP_SPEED,
  WALKER_TURN_STEP,
  type WardenConfig,
  X1_STEPS_PER_TICK,
} from "@metropolis/sim";

export type InputScript = (tick: number, out: TickInputs) => void;

/**
 * Golden #1 (Phase 0): 60 s of varied driving — full-stick sprints, circles,
 * a figure eight, idle stretches, diagonals with button chatter. Exercises
 * axis quantization, bound clamping and yaw updates.
 */
export function drive01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 5) {
    p.moveX = 127; // sprint east into the hills
  } else if (t < 12) {
    p.moveX = quantizeAxis(cosLUT(t * 0.9)); // wide circle
    p.moveY = quantizeAxis(sinLUT(t * 0.9));
  } else if (t < 20) {
    p.moveY = -127; // straight south, firing
    p.buttons = BUTTON_FIRE1;
  } else if (t < 30) {
    p.moveX = quantizeAxis(sinLUT(t * 1.3)); // figure eight
    p.moveY = quantizeAxis(sinLUT(t * 0.65));
  } else if (t < 33) {
    // idle — hash sequence must still advance via the tick counter
  } else if (t < 43) {
    p.moveX = 90; // diagonal with jump chatter
    p.moveY = 90;
    if (Math.floor(t * 2) % 2 === 0) p.buttons = BUTTON_JUMP;
  } else if (t < 53) {
    p.moveX = quantizeAxis(cosLUT(-t * 1.1)); // reverse circle, heavy fire
    p.moveY = quantizeAxis(sinLUT(-t * 1.1));
    p.buttons = BUTTON_FIRE2;
  } else {
    p.moveX = -127; // full west push into the map edge clamp
  }
}

/**
 * Exactly one transform, however the respawn tick lands.
 *
 * The mash this replaces pressed for a whole four-second phase, which made the
 * form the avatar ended in a parity accident: a press can only land when the
 * previous lock has expired, so the toggle count was phaseLength/lockLength and
 * TRANSFORM_LOCK_TICKS 15 -> 24 turned five toggles (ending hover) into four
 * (ending walker) without a line of the script changing.
 *
 * Mashing for strictly LESS than one lock fixes that at the root. The rising
 * edges still give a respawn that drifts several chances to catch one, but only
 * the first can ever land — every later edge falls inside the lock it started.
 * The form at the end of the phase is the script's choice again, not arithmetic
 * on two constants that move independently.
 */
function transformOnce(t: number, from: number): number {
  const dt = t - from;
  if (dt < 0 || dt >= (TRANSFORM_LOCK_TICKS - 1) / TICK_HZ) return 0;
  return Math.floor(dt * 10) % 2 === 0 ? BUTTON_TRANSFORM : 0;
}

/**
 * Golden #2 (Phase 1): 90 s movement+combat on district-01. Walks east into the
 * dummies' crossfire and kills the (85,127) dummy with the primary once it is
 * inside the 12 m lock, holds there until killed, respawns, transforms to hover,
 * crosses the north-edge ford lobbing mortar shells, transforms back, then walks
 * with jump chatter and circles. Open-loop script — the golden test asserts the
 * death/respawn/points beats actually happen.
 *
 * Re-timed at SIM_VERSION 41 for the original's weapons and 1250-HP mech
 * (fcop-fidelity.md W1, W2, P1): the Mini-Gun hits only its lock, 12 m out, so the
 * avatar walks up to the dummy instead of shooting from its spawn, and the
 * crossfire needs ~20 s rather than ~5 s to put it down. The explosions are
 * mortar shells now: a Hell Fire 2000 without a lock flies its 16 m and ends.
 */
export function combat01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 10) {
    p.moveX = 127; // walk east off the plot into the dummies' 28 m
    p.aimX = 127;
    p.buttons = BUTTON_FIRE1; // the (85,127) dummy locks at 12 m and dies
  } else if (t < 30) {
    p.aimX = 127; // hold position in the dummy crossfire: death → respawn
    p.buttons = BUTTON_FIRE1;
  } else if (t < 34) {
    p.buttons = transformOnce(t, 30); // freshly respawned: switch to hover
  } else if (t < 48) {
    // Facing-aligned drive (v19): aim must match throttle or the vehicle stalls.
    p.moveY = -127; // hover north along the west edge — no dummy covers it
    p.aimY = -127;
    p.buttons = BUTTON_FIRE1;
  } else if (t < 66) {
    p.moveX = 127; // east along the north edge: crosses open river water
    p.aimX = 127; // face travel direction; mortar shells land 8 m ahead
    p.buttons = t > 56 ? BUTTON_FIRE3 : BUTTON_FIRE1;
  } else if (t < 70) {
    p.buttons = transformOnce(t, 66); // back to walker on the dry east side
  } else if (t < 72) {
    p.aimY = 127; // special shot (exercises the lob and its blast)
    p.buttons = BUTTON_FIRE3;
  } else if (t < 84) {
    p.moveY = 127; // walk south with jump chatter
    p.aimY = 127;
    p.buttons = BUTTON_FIRE1 | (Math.floor(t * 2) % 2 === 0 ? BUTTON_JUMP : 0);
  } else {
    // Circle: no aim → facing follows move, so throttle stays full.
    p.moveX = quantizeAxis(cosLUT(t));
    p.moveY = quantizeAxis(sinLUT(t));
    if (Math.floor(t * 2) % 2 === 0) p.buttons = BUTTON_JUMP;
  }
}

/**
 * Golden #3 (Phase 2 DoD "mini-match", replayed on the Phase 3 economy): the
 * full toolkit in one script. Player 0's avatar walks the north lane, kills the
 * two dummies that cover it and base East's four ring turrets from inside their
 * reach — earning the enemy-owned turret bounty — puts player 1's avatar down
 * twice, then claims the (176, 88) outpost with it and forward-spawns runners at
 * 2× cost straight through the dead ring before it respawns. Player 1 runs a
 * fixed losing build order: three feeder runners into base West's intact ring,
 * then idles. The replay tail runs PAST the breach, pinning the post-win freeze
 * into the golden.
 *
 * Positions are dead-reckoned from the deterministic avatar walk (verified by the
 * golden03 beats test): the sim is exact, so these constants hold on every
 * engine. Since SIM_VERSION 41 the lock does the aiming: anything within 12 m and
 * 12.5° of the facing is locked, and every weapon fires at the lock.
 */
interface MatchPhase {
  until: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  buttons: number;
}

/**
 * Player 0's choreography as a timeline built from waypoints: walk legs at
 * exact walker speed (durations derived from distances), snipe pauses with
 * aim vectors dead-reckoned from the expected position. The avatar walks
 * the NORTH LANE — carved terrain the district schema test guarantees is
 * walker-traversable — killing the two dummies that cover it from outside
 * their range, then snipes base East's ring from beyond TURRET_RANGE,
 * claims the (176, 88) outpost and forward-buys the winning runners.
 */
function buildMatch01Timeline(): MatchPhase[] {
  const phases: MatchPhase[] = [];
  let t = 100;
  let px = 30;
  let py = 127; // player 0 spawn
  let facing = 0; // its spawn yaw
  const push = (
    ticks: number,
    p: Partial<Pick<MatchPhase, "moveX" | "moveY" | "aimX" | "aimY" | "buttons">>,
  ) => {
    t += ticks;
    phases.push({ until: t, moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0, ...p });
  };
  // The hull TURNS toward the aim at the original walker's rate (SIM_VERSION
  // 39, fcop-fidelity.md P4: 0x20 engine angle units a step at rest), so every
  // new heading gets a stationary turn first — driving or shooting before the
  // turn ends would strafe or shoot wide. The facing is tracked here to size it.
  const TURN_PER_TICK = WALKER_TURN_STEP * X1_STEPS_PER_TICK * ((2 * Math.PI) / 4096);
  const face = (ax: number, ay: number) => {
    const want = atan2Poly(ay, ax);
    let d = want - facing;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const ticks = Math.ceil(Math.abs(d) / TURN_PER_TICK) + 1;
    push(ticks, { aimX: ax, aimY: ay });
    facing = want;
  };
  // The original walker's run on flat ground (balance.ts "X1-Alpha movement"):
  // 1.25 steps a tick of v += P - 0.375 v toward 4.69 m/s, then a coast that
  // stops dead under 0.586 m/s. Distance covered by `n` driven ticks and the
  // coast after them, in the sim's own integration order.
  const walkDistance = (n: number): number => {
    const r = retentionPerTick(WALKER_DRAG);
    let v = 0;
    let x = 0;
    for (let i = 0; i < n; i++) {
      v = AVATAR_WALKER_SPEED * (1 - r) + v * r;
      x += v / TICK_HZ;
    }
    while (v > 0) {
      v = Math.abs(v * (1 - WALKER_DRAG)) < WALKER_STOP_SPEED ? 0 : v * r;
      x += v / TICK_HZ;
    }
    return x;
  };
  // Dead-reckons with the QUANTISED direction, which is the one the sim will
  // actually drive: the move intent goes out as int8, so `quantizeAxis` rounds
  // the heading off by up to a fifth of a degree, and over a 40 m leg that put
  // the avatar 2.9 m from where this function thought it stood. The snipes below
  // aim from `px, py`, so that error lands as aim error — invisible while a
  // turret was a 1.5 m disc, fatal once the hitboxes came down to the size of
  // the models (balance.ts ARCHETYPE_RADIUS). Reckoning along the rounded
  // heading closes it, and keeps these scripts robust against the next change to
  // either number.
  const walkTo = (x: number, y: number, settle = 6) => {
    const dx = x - px;
    const dy = y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    const qx = quantizeAxis(dx / d);
    const qy = quantizeAxis(dy / d);
    const qlen = Math.sqrt(qx * qx + qy * qy);
    const ux = qx / qlen;
    const uy = qy / qlen;
    face(qx, qy);
    let ticks = 1;
    while (walkDistance(ticks + 1) <= d) ticks++;
    push(ticks, { moveX: qx, moveY: qy, aimX: qx, aimY: qy });
    push(settle, { aimX: qx, aimY: qy }); // the coast, and a full stop between legs
    const travelled = walkDistance(ticks);
    px += ux * travelled;
    py += uy * travelled;
  };
  // SIM_VERSION 41: the original's weapons (fcop-fidelity.md W1, W2). The
  // Mini-Gun hits only its lock, 12 m out, so nothing is sniped from outside a
  // turret's 28 m any more: the avatar walks up to `stand` m of each target,
  // where the lock takes it, and fires all three — the Mini-Gun on the lock, the
  // Hell Fire homing on it, the Mortar landing on it up to its 9.7 m reach —
  // soaking the return fire on the original's 1250 HP.
  const engage = (x: number, y: number, stand: number, ticks: number) => {
    const dx = x - px;
    const dy = y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > stand + 0.5) walkTo(px + (dx * (d - stand)) / d, py + (dy * (d - stand)) / d);
    const ex = x - px;
    const ey = y - py;
    const inv = 1 / Math.sqrt(ex * ex + ey * ey);
    const ax = quantizeAxis(ex * inv);
    const ay = quantizeAxis(ey * inv);
    face(ax, ay);
    push(ticks, { aimX: ax, aimY: ay, buttons: BUTTON_FIRE1 | BUTTON_FIRE2 | BUTTON_FIRE3 });
  };

  engage(60, 110, 8, 60); // dummy (60,110) covers the lane entry
  walkTo(40, 116); // join the north lane
  walkTo(62, 84);
  walkTo(92, 62);
  engage(127, 60, 8, 60); // dummy (127,60) sits on the mid-lane ford
  walkTo(127, 54);
  walkTo(162, 62);
  walkTo(192, 84); // lane end short of base East
  // The ring from the north, nearest pair first, so at most two of the four
  // reach the avatar at a time.
  walkTo(210, 102);
  engage(219, 112, 8.5, 60); // ring north-outer
  engage(213, 118, 8.5, 60); // ring north-inner
  engage(213, 136, 8.5, 60); // ring south-inner
  engage(219, 142, 8.5, 60); // ring south-outer
  // The original's economy (SIM_VERSION 33) has no trickle and pays a ring
  // turret 1, so the ring bounty and player 1's dead feeders come to ~17 points,
  // short of the 30-point claim. What pays is putting the enemy avatar down: +10
  // to us when it respawns (fcop-fidelity.md R4). Player 1 idles at its ground
  // console, then at its spawn on its own pad.
  engage(227.342, 137.474, 7, 300); // player 1 at its console
  engage(224, 127, 7, 420); // its spawn: keep firing through the respawn, drop it again
  walkTo(176, 88); // outpost console: claim once the second respawn has paid
  return phases;
}

const MATCH01_TIMELINE = buildMatch01Timeline();
const MATCH01_HOLD_FROM = MATCH01_TIMELINE[MATCH01_TIMELINE.length - 1].until;

export function match01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p0 = out.players[0];
  const p1 = out.players[1];

  // --- Player 0: lane walk, dummy + ring snipes, outpost claim, forward wave.
  if (tick >= 100 && tick < MATCH01_HOLD_FROM) {
    for (let i = 0; i < MATCH01_TIMELINE.length; i++) {
      const phase = MATCH01_TIMELINE[i];
      if (tick < phase.until) {
        p0.moveX = phase.moveX;
        p0.moveY = phase.moveY;
        p0.aimX = phase.aimX;
        p0.aimY = phase.aimY;
        p0.buttons = phase.buttons;
        break;
      }
    }
  } else if (tick >= MATCH01_HOLD_FROM) {
    // The outpost is claimed on arrival in its zone (30 pts: start, ring
    // bounty, feeders, two downs of the enemy avatar); holding interact there
    // then buys forward runners at 2×, which walk through the dead ring's window.
    p0.buttons = BUTTON_INTERACT;
  }

  // --- Player 1: fixed (losing) build order — three feeders, then idle rich.
  if (tick < 76) {
    p1.moveX = 40;
    p1.moveY = 120; // walk spawn → own ground console
  }
  if (tick >= 1000 && tick < 1046) p1.buttons = BUTTON_INTERACT;
}

/**
 * Golden #4 (Phase 4 DoD "AI match"): the Warden (difficulty 8) as player 1
 * against a scripted player 0 running an open-loop patrol-and-shoot defense
 * near its own base — enough resistance to exercise the Warden's retreat,
 * respawn and defend paths. Since SIM_VERSION 46 the Warden is the Sky Captain:
 * it defends, captures what it flies over and fields its opening order, which
 * dies on district-01's lanes; the golden04 beats test pins the outcome.
 * Player 1's input channel stays all-zero: the AI ignores TickInputs.
 */
export function warden01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  const phase = t % 40; // repeating 40 s patrol loop, survives respawns
  if (phase < 8) {
    p.moveX = 100; // push out east toward mid
    p.moveY = -60;
  } else if (phase < 12) {
    p.aimX = 127; // stand and burst east
    p.buttons = BUTTON_FIRE1;
  } else if (phase < 20) {
    p.moveX = -80; // fall back northwest
    p.moveY = -80;
  } else if (phase < 24) {
    p.aimX = 90; // burst southeast (covers the lane approach)
    p.aimY = 90;
    p.buttons = BUTTON_FIRE1;
  } else if (phase < 32) {
    p.moveX = -40; // drift back south toward the base
    p.moveY = 120;
  } else {
    p.aimX = 90; // burst northeast until the loop restarts
    p.aimY = -90;
    p.buttons = BUTTON_FIRE1;
  }
}

/**
 * Golden #5 (FCOP stage 2): 90 s on urban-jungle, the first arena with wall
 * data. Buys runners at the ground console (units follow lanes, exercising
 * the walled unit stepper + separation), then drives ENE into the vertical
 * wall band on grid line x=81 (rows ~100-102), pins against it, slides north
 * along it, and roams back — the golden's hash sequence covers wall-blocked
 * avatar movement on both axes. Probe-verified: the avatar clamps at x≈80.9.
 */
export function fcop01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 4) {
    // The script is unchanged across the issue-#30 rebuild on purpose, so the
    // re-record is purely the map moving. Its bearings are no longer literal:
    // urban-jungle's spawn 0 is at (106.2, 71) since the arena was rebuilt from
    // the original Conft logic, not the (38,128) this comment was written for.
    p.moveY = -127; // north, off the base platform toward the consoles
  } else if (t < 20) {
    p.buttons = BUTTON_INTERACT; // hold-to-buy runner waves onto the lanes
  } else if (t < 40) {
    p.moveX = 127; // ENE toward the wall band — pins on line x=81 around y≈115
    p.moveY = -35;
  } else if (t < 52) {
    p.moveY = -127; // slide north along the wall, still pinned
  } else if (t < 64) {
    p.moveX = 127; // due-east push against the band again, firing
    p.buttons = BUTTON_FIRE1;
  } else if (t < 78) {
    p.moveX = -90; // swing back southwest across open ground
    p.moveY = 110;
  } else {
    p.moveX = 60; // drift southeast until the recording ends
    p.moveY = 127;
  }
}

/**
 * Golden #6 (Layered v2): the avatar on layered-test walks EAST up the layer-1
 * ramp (cols 2..5 rising 0→3 m) onto the mid deck, crosses it north, then walks
 * back west and descends to the base layer. Pins the multi-deck movement +
 * transition + gravity path (the only golden whose hash covers entLayer).
 */
export function layered01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 6) {
    p.moveX = 127; // spawn (2,2) → east, up the ramp onto the 3 m deck
  } else if (t < 12) {
    p.moveY = 127; // cross the deck northward
  } else if (t < 18) {
    p.moveX = -127; // back west, descending the ramp to the base layer
  } else {
    p.moveY = -60; // drift south on the ground until the recording ends
  }
}

/**
 * Golden #7 (Precinct Assault): 120 s on la-cantina, the arena rebuilt from the
 * original Mp logic (rules.md §9). Covers what no other golden touches — bought
 * units on the original Cnet graph, per-turret weapon profiles with gun slew,
 * capture on an authentic pad, a power-up pickup, a base-intrusion alarm and the
 * original's gate-box win with its outro.
 *
 * Played against the Warden, because that is what a solo match on this arena
 * actually is: nothing is produced for free (SIM_VERSION 32), so an unattended
 * recording would exercise nothing at all.
 *
 * Route: spawn (112.1, 69.1) on the north base platform, hold INTERACT at the
 * console for a bought wave, then drive south-west to the pad at (94.8, 91.7) and
 * tap the action key there: the original captures on a press, instantly
 * (SIM_VERSION 34). The route used to run east along row 69 to the pad at
 * (137.6, 68.6) and stand there for a 3 s capture, but a wall on x = 115 has
 * stopped the avatar at (115.0, 73.0) since the arena's walls were rebuilt, so
 * every capture in this golden was the Warden's. Then push south down the
 * central spine, firing, as far as the enemy line allows.
 */
export function pa01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  if (t < 3) {
    p.moveX = 90; // spawn -> ground console at (114.1, 74.6)
    p.moveY = 110;
  } else if (t < 12) {
    p.buttons = BUTTON_INTERACT; // hold-to-buy runners onto the graph
  } else if (t < 18.5) {
    p.moveX = -100; // south-west to the pad at (94.8, 91.7)
    p.moveY = 78;
  } else if (t < 46) {
    // By the pad: tap the action key (a press captures; holding does not). The
    // first press lands on the tick it arrives (555): the Sky Captain chases the
    // player and flies over this pad two ticks later (SIM_VERSION 46).
    p.buttons = Math.floor(tick / 15) % 2 === 1 ? BUTTON_INTERACT : 0;
  } else if (t < 62) {
    p.moveX = -127; // back west across the base platform
    p.moveY = 30;
  } else if (t < 84) {
    p.moveY = 127; // push south down the spine, firing into the enemy line
    p.buttons = BUTTON_FIRE1;
    p.aimY = 110;
  } else if (t < 100) {
    p.moveX = -60;
    p.moveY = 100;
    p.buttons = BUTTON_FIRE1;
    p.aimX = -50;
    p.aimY = 100;
  } else {
    p.moveY = -110; // withdraw north up the spine until the recording ends
  }
}

export const SCRIPTS: Record<
  string,
  { script: InputScript; ticks: number; mapId?: string; warden?: WardenConfig }
> = {
  "drive-01": { script: drive01, ticks: 60 * TICK_HZ },
  "combat-01": { script: combat01, ticks: 90 * TICK_HZ, mapId: "district-01" },
  "match-01": { script: match01, ticks: 160 * TICK_HZ, mapId: "district-01" },
  "warden-01": {
    script: warden01,
    ticks: 300 * TICK_HZ,
    mapId: "district-01",
    warden: { player: 1, difficulty: 8 },
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
