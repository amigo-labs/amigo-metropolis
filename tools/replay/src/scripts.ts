// Scripted input generators for authoring golden replays. Scripts avoid
// engine-dependent constructs — simMath LUT trig instead of Math trig, no
// randomness, no wall-clock; IEEE-exact ops like Math.floor are fine — so a
// regenerated replay is byte-identical on any machine. Goldens change only
// when someone deliberately edits a script or the sim itself (which is a
// SIM_VERSION bump).

import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  clearTickInputs,
  cosLUT,
  quantizeAxis,
  sinLUT,
  TICK_HZ,
  type TickInputs,
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

export const SCRIPTS: Record<string, { script: InputScript; ticks: number; mapId?: string }> = {
  "drive-01": { script: drive01, ticks: 60 * TICK_HZ },
  "combat-01": { script: combat01, ticks: 90 * TICK_HZ, mapId: "district-01" },
};
