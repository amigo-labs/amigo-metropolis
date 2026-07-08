// Scripted input generators for authoring golden replays. Scripts avoid
// engine-dependent constructs — simMath LUT trig instead of Math trig, no
// randomness, no wall-clock; IEEE-exact ops like Math.floor are fine — so a
// regenerated replay is byte-identical on any machine. Goldens change only
// when someone deliberately edits a script or the sim itself (which is a
// SIM_VERSION bump).

import {
  AVATAR_WALKER_SPEED,
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  clearTickInputs,
  cosLUT,
  quantizeAxis,
  sinLUT,
  TICK_HZ,
  type TickInputs,
  type WardenConfig,
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
 * Golden #2 (Phase 1): 70 s movement+combat on district-01. Kills the dummy
 * turret east of base 0 with the primary, transforms to hover, crosses the
 * central ford, trades heavy/special fire at the mid dummy, then loiters in
 * turret range until killed, respawns, and drives again. Open-loop script —
 * the golden test asserts the death/respawn/points beats actually happen.
 */
export function combat01(tick: number, out: TickInputs): void {
  clearTickInputs(out);
  const p = out.players[0];
  const t = tick / TICK_HZ;
  // Transform "mash": edge-triggered presses every few ticks, robust against
  // the exact respawn tick shifting when balance numbers are retuned.
  const mash = Math.floor(t * 5) % 2 === 0 ? BUTTON_TRANSFORM : 0;
  if (t < 4.5) {
    p.moveX = 127; // walk east off the plot, shooting the (85,127) dummy
    p.aimX = 127;
    p.buttons = BUTTON_FIRE1;
  } else if (t < 20) {
    p.aimX = 127; // hold position in the dummy crossfire: death → respawn
    p.buttons = BUTTON_FIRE1;
  } else if (t < 24) {
    p.buttons = mash; // freshly respawned: switch to hover
  } else if (t < 38) {
    p.moveY = -127; // hover north along the west edge — no dummy covers it
    p.aimX = 127;
    p.buttons = BUTTON_FIRE1;
  } else if (t < 56) {
    p.moveX = 127; // east along the north edge: crosses open river water
    p.aimX = 127; //  (away from any ford), heavies detonating on terrain
    p.buttons = t > 46 ? BUTTON_FIRE2 : BUTTON_FIRE1;
  } else if (t < 60) {
    p.buttons = mash; // back to walker on the dry east side
  } else if (t < 62) {
    p.aimY = 127; // special shot (exercises TTL/terrain detonation)
    p.buttons = BUTTON_FIRE3;
  } else if (t < 76) {
    p.moveY = 127; // walk south with jump chatter
    p.aimX = -127;
    p.buttons = BUTTON_FIRE1 | (Math.floor(t * 2) % 2 === 0 ? BUTTON_JUMP : 0);
  } else {
    p.moveX = quantizeAxis(cosLUT(t)); // circle + hop until the replay ends
    p.moveY = quantizeAxis(sinLUT(t));
    if (Math.floor(t * 2) % 2 === 0) p.buttons = BUTTON_JUMP;
  }
}

/**
 * Golden #3 (Phase 2 DoD "mini-match", replayed on the Phase 3 economy): the
 * full toolkit in one script. Player 0's avatar hovers the dummy-free
 * north-edge corridor (the golden-02 route), walks down behind base East and
 * snipes all four ring turrets from outside their range — earning the
 * enemy-owned turret bounty — then claims the (176, 88) outpost with it and
 * forward-spawns runners at 2× cost straight through the dead ring before
 * its 60 s respawns land. Player 1 runs a fixed losing build order: three
 * feeder runners into base West's intact ring, then idles. The replay tail
 * runs PAST the breach, pinning the post-win freeze into the golden.
 *
 * Aim vectors are dead-reckoned from the deterministic avatar positions at
 * the snipe ticks (verified by the golden03 beats test): the sim is exact,
 * so these constants hold on every engine.
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
  const push = (
    ticks: number,
    p: Partial<Pick<MatchPhase, "moveX" | "moveY" | "aimX" | "aimY" | "buttons">>,
  ) => {
    t += ticks;
    phases.push({ until: t, moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0, ...p });
  };
  const walkTo = (x: number, y: number, settle = 6) => {
    const dx = x - px;
    const dy = y - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    push(Math.round((d / AVATAR_WALKER_SPEED) * TICK_HZ), {
      moveX: quantizeAxis(dx / d),
      moveY: quantizeAxis(dy / d),
    });
    push(settle, {}); // full stop between legs
    px = x;
    py = y;
  };
  const snipe = (x: number, y: number, ticks: number) => {
    const dx = x - px;
    const dy = y - py;
    const inv = 1 / Math.sqrt(dx * dx + dy * dy);
    push(ticks, {
      aimX: quantizeAxis(dx * inv),
      aimY: quantizeAxis(dy * inv),
      buttons: BUTTON_FIRE1,
    });
  };

  snipe(60, 110, 110); // dummy (60,110) covers the lane entry — kill from spawn
  walkTo(40, 116); // join the north lane
  walkTo(62, 84);
  walkTo(92, 62);
  snipe(127, 60, 110); // dummy (127,60) sits on the mid-lane ford
  walkTo(127, 54);
  walkTo(162, 62);
  walkTo(192, 84); // lane end short of base East
  walkTo(196, 90); // snipe spot: outside all four ring turrets' range
  snipe(213, 118, 130); // ring north-inner
  snipe(219, 112, 130); // ring north-outer
  walkTo(206, 110); // advance: south-inner shoots back for ~2 s here
  snipe(213, 136, 130); // ring south-inner
  snipe(219, 142, 130); // ring south-outer
  walkTo(176, 88); // outpost console
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
    // Claim the outpost (30 pts: start + trickle + ring bounty), then keep
    // holding — forward runners at 2× walk through the dead ring's window.
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
 * near its own base — enough resistance to exercise the Warden's harass /
 * retreat / defend paths, but a losing game plan. The Warden must capture,
 * build and breach through it; the golden04 beats test pins the outcome.
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

export const SCRIPTS: Record<
  string,
  { script: InputScript; ticks: number; mapId?: string; warden?: WardenConfig }
> = {
  "drive-01": { script: drive01, ticks: 60 * TICK_HZ },
  "combat-01": { script: combat01, ticks: 90 * TICK_HZ, mapId: "district-01" },
  "match-01": { script: match01, ticks: 150 * TICK_HZ, mapId: "district-01" },
  "warden-01": {
    script: warden01,
    ticks: 300 * TICK_HZ,
    mapId: "district-01",
    warden: { player: 1, difficulty: 8 },
  },
};
