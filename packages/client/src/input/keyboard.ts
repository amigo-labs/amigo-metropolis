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
  BUTTON_TARGET_CYCLE,
  BUTTON_TRANSFORM,
  MAX_ENTITIES,
  type PlayerInput,
  quantizeAxis,
} from "@metropolis/sim";
import type * as THREE from "three";
import { Raycaster, Vector2, Vector3 } from "three";
import { ASSIST_CONE_COS, ASSIST_STRENGTH, aimAssist, applyAimAssist } from "./aimAssist";
import type { Vec2 } from "./gamepadMapping";
import { cameraGroundForward, cameraRelativeMove } from "./movement";
import type { LocalInputSource, Viewport } from "./types";

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
const moveScratch: Vec2 = { x: 0, y: 0 };

export class PlayerOneInput implements LocalInputSource {
  readonly label = "Keyboard / Mouse";
  readonly hint =
    "WASD drive · mouse aim · LMB/RMB/MMB fire · Q transform · Space jump · hold E to buy/claim/capture";
  private readonly down = new Set<string>();
  private mouseButtons = 0;
  private mouseX = 0;
  private mouseY = 0;
  private aimX = 0;
  private aimY = 0;
  // Camera ground-forward (sim coords) used as the camera-relative move basis;
  // refreshed each tick in updateAim. Defaults to +x before the camera is ready.
  private readonly moveBasis: Vec2 = { x: 1, y: 0 };
  // Per-tick aim-assist context, stashed in updateAim: own position and a copy
  // of the enemy positions (packed x,y) used by "assist" magnetism in sample().
  private selfX = 0;
  private selfY = 0;
  private enemyCount = 0;
  private readonly enemies = new Float32Array(MAX_ENTITIES * 2);
  private readonly assistOut: Vec2 = { x: 0, y: 0 };

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

  /** A keyboard is always present. */
  isConnected(): boolean {
    return true;
  }

  /** Haptics are gamepad-only; the keyboard source ignores rumble. */
  rumble(_strength: number, _durationMs: number): void {}

  /**
   * Projects the cursor onto the horizontal plane at the avatar's height and
   * stores the world-space aim direction. NDC is taken relative to the player's
   * viewport, so mouse aim is correct even in a splitscreen half. Call once per
   * tick before sample(). Allocation-free.
   */
  updateAim(
    camera: THREE.Camera,
    avatarX: number,
    avatarY: number,
    avatarHeight: number,
    viewport: Viewport,
    enemies: Float32Array,
    enemyCount: number,
  ): void {
    // Movement basis = the camera's world-fixed ground-forward (camera.spec §5),
    // independent of where the mouse aims below.
    cameraGroundForward(camera, this.moveBasis);
    // Stash aim-assist context (own position + a copy of the enemy list) for
    // sample(); the caller's `enemies` scratch is reused across views.
    this.selfX = avatarX;
    this.selfY = avatarY;
    this.enemyCount = Math.min(enemyCount, MAX_ENTITIES);
    this.enemies.set(enemies.subarray(0, this.enemyCount * 2));
    const vx = ((this.mouseX - viewport.left) / viewport.width) * 2 - 1;
    const vy = -((this.mouseY - viewport.top) / viewport.height) * 2 + 1;
    ndc.set(vx, vy);
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
    // Camera-relative: rotate the screen-frame WASD axes by the camera's
    // ground-forward so W always drives into the screen — decoupled from aim.
    cameraRelativeMove(x, y, this.moveBasis.x, this.moveBasis.y, moveScratch);
    out.moveX = quantizeAxis(moveScratch.x);
    out.moveY = quantizeAxis(moveScratch.y);
    // "assist" magnetism shapes the free aim locally, before quantization.
    let aimX = this.aimX;
    let aimY = this.aimY;
    if (aimAssist.mode === "assist") {
      applyAimAssist(
        aimX,
        aimY,
        this.selfX,
        this.selfY,
        this.enemies,
        this.enemyCount,
        ASSIST_CONE_COS,
        ASSIST_STRENGTH,
        this.assistOut,
      );
      aimX = this.assistOut.x;
      aimY = this.assistOut.y;
    }
    out.aimX = quantizeAxis(aimX);
    out.aimY = quantizeAxis(aimY);
    let buttons = 0;
    for (let i = 0; i < BUTTON_KEYS.length; i++) {
      if (this.down.has(BUTTON_KEYS[i][0])) buttons |= BUTTON_KEYS[i][1];
    }
    for (let i = 0; i < MOUSE_BUTTON_BITS.length; i++) {
      if ((this.mouseButtons & (1 << i)) !== 0) buttons |= MOUSE_BUTTON_BITS[i];
    }
    // Target-cycle (T) only emits in "lock" mode; the sim owns the tracking.
    if (aimAssist.mode === "lock" && this.down.has("KeyT")) buttons |= BUTTON_TARGET_CYCLE;
    out.buttons = buttons;
  }
}
