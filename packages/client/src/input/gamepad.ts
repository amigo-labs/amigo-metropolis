// The joystick, read as the original reads its DirectInput device (RE
// sample.c `input_joystick_configure`, camera-and-movement.md "Reading the
// devices"): the first stick's X and Y only, each with a dead zone of a quarter
// of its travel set on that axis alone, read for its sign — four digital
// directions, Left (x < 0), Right (x > 0), Up (y < 0), Down (y > 0) — and
// buttons 0..16. No second stick, no hat, nothing analogue reaches the game.
//
// A browser pad reports its d-pad as buttons 12-15 under the "standard"
// mapping. The original's gamepads (the Sidewinder, the Gravis) reported their
// pad AS the X and Y axes, which is why their presets bind the directions to
// them; so the standard d-pad is read as those same four directions.
//
// Player 1 reads the first connected pad, as the original's first player reads
// joystick 0.

import { JOY_BUTTON_MAX, JOY_DOWN, JOY_LEFT, JOY_RIGHT, JOY_UP } from "./bindings";

/** DIPROP_DEADZONE 2500 of DirectInput's 10000: a quarter of each axis's travel. */
export const JOY_DEAD_ZONE = 0.25;

/** The standard mapping's d-pad buttons: up, down, left, right. */
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

/** What of a pad is read (the Gamepad API's shape, so tests can fake one). */
export interface PadState {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly mapping?: string;
}

function button(pad: PadState, b: number): boolean {
  return b < pad.buttons.length && pad.buttons[b].pressed;
}

/** Is joystick control `code` (a button 0..16 or one of the four directions) down? */
export function joyControlDown(pad: PadState, code: number): boolean {
  const x = pad.axes.length > 0 ? pad.axes[0] : 0;
  const y = pad.axes.length > 1 ? pad.axes[1] : 0;
  const dpad = pad.mapping === "standard";
  switch (code) {
    case JOY_LEFT:
      return x < -JOY_DEAD_ZONE || (dpad && button(pad, DPAD_LEFT));
    case JOY_RIGHT:
      return x > JOY_DEAD_ZONE || (dpad && button(pad, DPAD_RIGHT));
    case JOY_UP:
      return y < -JOY_DEAD_ZONE || (dpad && button(pad, DPAD_UP));
    case JOY_DOWN:
      return y > JOY_DEAD_ZONE || (dpad && button(pad, DPAD_DOWN));
    default:
      return code >= 0 && code <= JOY_BUTTON_MAX && button(pad, code);
  }
}

/** The joystick control that is down on `pad`, for capturing a binding; -1 none. */
export function firstJoyControl(pad: PadState): number {
  for (const code of [JOY_UP, JOY_DOWN, JOY_LEFT, JOY_RIGHT]) {
    if (joyControlDown(pad, code)) return code;
  }
  for (let b = 0; b <= JOY_BUTTON_MAX; b++) {
    // The d-pad's buttons are the directions above, not buttons of their own.
    if (pad.mapping === "standard" && b >= DPAD_UP && b <= DPAD_RIGHT) continue;
    if (button(pad, b)) return b;
  }
  return -1;
}

/**
 * The first connected pad, or null. The Gamepad API hands back a fresh array
 * on every call, so callers poll it only when a binding needs a pad.
 */
export function firstPad(): PadState | null {
  const nav = globalThis.navigator as Navigator | undefined;
  if (!nav?.getGamepads) return null;
  const pads = nav.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p?.connected) return p;
  }
  return null;
}
