// Keyboard fallback input (player 1). Sampled once per sim tick and quantized
// at the boundary — raw key state never reaches the sim (architecture.md §2).

import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  type PlayerInput,
  quantizeAxis,
} from "@metropolis/sim";

const BUTTON_KEYS: readonly [string, number][] = [
  ["KeyJ", BUTTON_FIRE1],
  ["KeyK", BUTTON_FIRE2],
  ["KeyL", BUTTON_FIRE3],
  ["KeyQ", BUTTON_TRANSFORM],
  ["Space", BUTTON_JUMP],
  ["KeyE", BUTTON_INTERACT],
];

export class KeyboardInput {
  private readonly down = new Set<string>();

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      this.down.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    target.addEventListener("keyup", (e) => {
      this.down.delete(e.code);
    });
    target.addEventListener("blur", () => {
      this.down.clear();
    });
  }

  /** Writes the current key state, quantized, into `out`. Allocation-free. */
  sample(out: PlayerInput): void {
    let x = 0;
    let y = 0;
    if (this.down.has("KeyA") || this.down.has("ArrowLeft")) x -= 1;
    if (this.down.has("KeyD") || this.down.has("ArrowRight")) x += 1;
    if (this.down.has("KeyW") || this.down.has("ArrowUp")) y += 1;
    if (this.down.has("KeyS") || this.down.has("ArrowDown")) y -= 1;
    out.moveX = quantizeAxis(x);
    out.moveY = quantizeAxis(y);
    out.aimX = 0;
    out.aimY = 0;
    let buttons = 0;
    for (let i = 0; i < BUTTON_KEYS.length; i++) {
      if (this.down.has(BUTTON_KEYS[i][0])) buttons |= BUTTON_KEYS[i][1];
    }
    out.buttons = buttons;
  }
}
