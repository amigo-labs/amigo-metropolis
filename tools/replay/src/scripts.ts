// Scripted input generators for authoring golden replays. Scripts avoid
// engine-dependent constructs — simMath LUT trig instead of Math trig, no
// randomness, no wall-clock; IEEE-exact ops like Math.floor are fine — so a
// regenerated replay is byte-identical on any machine. Goldens change only
// when someone deliberately edits a script or the sim itself (which is a
// SIM_VERSION bump).

import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_JUMP,
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

export const SCRIPTS: Record<string, { script: InputScript; ticks: number }> = {
  "drive-01": { script: drive01, ticks: 60 * TICK_HZ },
};
