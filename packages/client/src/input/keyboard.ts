// Keyboard + mouse fallback input (player 1). Sampled once per sim tick and
// quantized at the boundary — raw input state never reaches the sim
// (architecture.md §2). Mouse aim: the cursor is projected onto the avatar's
// ground plane each tick; the direction avatar→hit becomes the aim axes.

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
import type * as THREE from "three";
import { Raycaster, Vector2, Vector3 } from "three";

const BUTTON_KEYS: readonly [string, number][] = [
  ["KeyQ", BUTTON_TRANSFORM],
  ["Space", BUTTON_JUMP],
  ["KeyE", BUTTON_INTERACT],
  ["KeyJ", BUTTON_FIRE1],
  ["KeyK", BUTTON_FIRE2],
  ["KeyL", BUTTON_FIRE3],
];

const MOUSE_BUTTON_BITS: readonly number[] = [BUTTON_FIRE1, BUTTON_FIRE3, BUTTON_FIRE2];

// Module-scope scratch (sample runs inside the tick loop — no allocations).
const ndc = new Vector2();
const raycaster = new Raycaster();
const planeNormal = new Vector3(0, 1, 0);
const hit = new Vector3();

export class PlayerOneInput {
  private readonly down = new Set<string>();
  private mouseButtons = 0;
  private mouseX = 0;
  private mouseY = 0;
  private aimX = 0;
  private aimY = 0;

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
      this.mouseButtons = 0;
    });
    target.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    target.addEventListener("mousedown", (e) => {
      this.mouseButtons |= 1 << e.button;
    });
    target.addEventListener("mouseup", (e) => {
      this.mouseButtons &= ~(1 << e.button);
    });
    target.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /**
   * Projects the cursor onto the horizontal plane at the avatar's height and
   * stores the world-space aim direction. Call once per tick before sample().
   * Allocation-free.
   */
  updateAim(camera: THREE.Camera, avatarX: number, avatarY: number, avatarHeight: number): void {
    ndc.set((this.mouseX / innerWidth) * 2 - 1, -(this.mouseY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // Intersect ray with plane y = avatarHeight (sim height axis = three y).
    const dir = raycaster.ray.direction;
    const denom = dir.dot(planeNormal);
    if (Math.abs(denom) < 1e-6) return;
    const t = (avatarHeight - raycaster.ray.origin.y) / dir.y;
    if (t <= 0) return;
    hit.copy(dir).multiplyScalar(t).add(raycaster.ray.origin);
    // three (x, z) → sim (x, y)
    const dx = hit.x - avatarX;
    const dy = hit.z - avatarY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.5) {
      this.aimX = dx / len;
      this.aimY = dy / len;
    }
  }

  /** Writes the current input state, quantized, into `out`. Allocation-free. */
  sample(out: PlayerInput): void {
    let x = 0;
    let y = 0;
    if (this.down.has("KeyA") || this.down.has("ArrowLeft")) x -= 1;
    if (this.down.has("KeyD") || this.down.has("ArrowRight")) x += 1;
    if (this.down.has("KeyW") || this.down.has("ArrowUp")) y += 1;
    if (this.down.has("KeyS") || this.down.has("ArrowDown")) y -= 1;
    out.moveX = quantizeAxis(x);
    out.moveY = quantizeAxis(y);
    out.aimX = quantizeAxis(this.aimX);
    out.aimY = quantizeAxis(this.aimY);
    let buttons = 0;
    for (let i = 0; i < BUTTON_KEYS.length; i++) {
      if (this.down.has(BUTTON_KEYS[i][0])) buttons |= BUTTON_KEYS[i][1];
    }
    for (let i = 0; i < MOUSE_BUTTON_BITS.length; i++) {
      if ((this.mouseButtons & (1 << i)) !== 0) buttons |= MOUSE_BUTTON_BITS[i];
    }
    out.buttons = buttons;
  }
}
