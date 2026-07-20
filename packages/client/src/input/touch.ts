// Touch input source (single local player): dual floating virtual sticks plus
// an on-screen button cluster, driving the same LocalInputSource contract as
// keyboard/mouse. Sampled once per sim tick and quantized at the boundary —
// raw pointer state never reaches the sim (architecture.md §2).
//
//   left half   floating move stick (analog, camera-relative like WASD)
//   right half  floating aim stick (snap-to-unit + hold-last facing;
//               primary FIRE1 auto-fires while engaged — twin-stick convention)
//   buttons     TRANSFORM / JUMP / INTERACT(hold) / HEAVY / SPECIAL
//
// Pointer bookkeeping: the first pointer down in a screen half owns that stick
// until its up/cancel (`setPointerCapture` keeps a finger sliding off-screen
// delivering the up); a second pointer in an owned half is ignored. Buttons
// capture their own pointer and stop propagation so they never spawn a stick.
// All numeric mapping lives in touchMapping.ts (pure, unit-tested).

import { MAX_ENTITIES, type PlayerInput, quantizeAxis } from "@metropolis/sim";
import type * as THREE from "three";
import type { TouchControlsHandle } from "../touchControls";
import { ASSIST_CONE_COS, ASSIST_STRENGTH, aimAssist, applyAimAssist } from "./aimAssist";
import type { Vec2 } from "./gamepadMapping";
import { cameraGroundForward, cameraRelativeMove } from "./movement";
import {
  applyStick,
  autoFirePrimary,
  snapAimStick,
  TOUCH_BUTTONS,
  TOUCH_STICK_RADIUS_PX,
} from "./touchMapping";
import type { LocalInputSource, Viewport } from "./types";

/**
 * ?touch=1 forces touch controls on, ?touch=0 forces them off; otherwise
 * auto-detect a coarse-pointer touch device. Read once at boot, like ?aim=.
 */
export function wantsTouch(params: URLSearchParams): boolean {
  const p = params.get("touch");
  if (p !== null) return p !== "0";
  return (
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches &&
    (navigator.maxTouchPoints ?? 0) > 0
  );
}

// Module-scope scratch (sample runs inside the tick loop — no allocations).
const moveScratch: Vec2 = { x: 0, y: 0 };
const aimScratch: Vec2 = { x: 0, y: 0 };

const NO_POINTER = -1;

/**
 * Pointer capture keeps a finger that slides off an element still delivering
 * its up/cancel. Best-effort: synthetic PointerEvents (the e2e harness) have
 * no active pointer to capture, and losing capture only degrades edge cases.
 */
function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // no active pointer with this id (synthetic event) — fine without capture
  }
}

export class TouchInput implements LocalInputSource {
  readonly label = "Touch";
  readonly hint =
    "left stick drive · right stick aim (auto-fire) · MODE transform · JUMP · hold USE to buy/claim · HVY/SPC fire";

  // Stick ownership + state. The aim direction is remembered in the SCREEN
  // frame (x right, y up-screen) and rotated by the camera basis on sample,
  // exactly like the move stick — hold-last defaults to "up-screen".
  private movePointer = NO_POINTER;
  private moveBaseX = 0;
  private moveBaseY = 0;
  private readonly moveVec: Vec2 = { x: 0, y: 0 };
  private aimPointer = NO_POINTER;
  private aimBaseX = 0;
  private aimBaseY = 0;
  private readonly aimUnit: Vec2 = { x: 0, y: 1 };
  private aimEngaged = false;
  private buttonsDown = 0;

  // Camera ground-forward (sim coords) used as the camera-relative basis for
  // BOTH sticks; refreshed each tick in updateAim. Defaults to +x like keyboard.
  private readonly moveBasis: Vec2 = { x: 1, y: 0 };
  // Per-tick aim-assist context, stashed in updateAim (same as PlayerOneInput).
  private selfX = 0;
  private selfY = 0;
  private enemyCount = 0;
  private readonly enemies = new Float32Array(MAX_ENTITIES * 2);
  private readonly assistOut: Vec2 = { x: 0, y: 0 };

  constructor(private readonly controls: TouchControlsHandle) {
    const root = controls.root;
    root.addEventListener("pointerdown", (e) => this.onDown(e));
    root.addEventListener("pointermove", (e) => this.onMove(e));
    root.addEventListener("pointerup", (e) => this.onUp(e));
    root.addEventListener("pointercancel", (e) => this.onUp(e));

    for (let i = 0; i < controls.buttons.length; i++) {
      const el = controls.buttons[i];
      const bit = TOUCH_BUTTONS[i].bit;
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); // a button press never spawns a stick
        capture(el, e.pointerId);
        this.buttonsDown |= bit;
        controls.setButtonDown(i, true);
      });
      const release = () => {
        this.buttonsDown &= ~bit;
        controls.setButtonDown(i, false);
      };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
    }
  }

  /** The touchscreen never unplugs. */
  isConnected(): boolean {
    return true;
  }

  private onDown(e: PointerEvent): void {
    const half = innerWidth / 2;
    if (e.clientX < half && this.movePointer === NO_POINTER) {
      this.movePointer = e.pointerId;
      this.moveBaseX = e.clientX;
      this.moveBaseY = e.clientY;
      this.moveVec.x = 0;
      this.moveVec.y = 0;
      this.controls.setStick("move", e.clientX, e.clientY, 0, 0);
    } else if (e.clientX >= half && this.aimPointer === NO_POINTER) {
      this.aimPointer = e.pointerId;
      this.aimBaseX = e.clientX;
      this.aimBaseY = e.clientY;
      this.controls.setStick("aim", e.clientX, e.clientY, 0, 0);
    } else {
      return; // that half's stick is already owned — ignore extra pointers
    }
    capture(this.controls.root, e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId === this.movePointer) {
      const dx = e.clientX - this.moveBaseX;
      const dy = e.clientY - this.moveBaseY;
      applyStick(dx, dy, TOUCH_STICK_RADIUS_PX, this.moveVec);
      this.moveKnob("move", this.moveBaseX, this.moveBaseY, dx, dy);
    } else if (e.pointerId === this.aimPointer) {
      const dx = e.clientX - this.aimBaseX;
      const dy = e.clientY - this.aimBaseY;
      this.aimEngaged = snapAimStick(dx, dy, TOUCH_STICK_RADIUS_PX, this.aimUnit);
      this.moveKnob("aim", this.aimBaseX, this.aimBaseY, dx, dy);
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.movePointer) {
      this.movePointer = NO_POINTER;
      this.moveVec.x = 0;
      this.moveVec.y = 0;
      this.controls.hideStick("move");
    } else if (e.pointerId === this.aimPointer) {
      this.aimPointer = NO_POINTER;
      this.aimEngaged = false; // aimUnit keeps the last facing (hold-last)
      this.controls.hideStick("aim");
    }
  }

  /** Knob visual clamped to the stick rim (pure numbers, no allocation). */
  private moveKnob(side: "move" | "aim", baseX: number, baseY: number, dx: number, dy: number) {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > TOUCH_STICK_RADIUS_PX) {
      const s = TOUCH_STICK_RADIUS_PX / len;
      dx *= s;
      dy *= s;
    }
    this.controls.setStick(side, baseX, baseY, dx, dy);
  }

  /**
   * Refreshes the camera-relative basis for both sticks and stashes the
   * aim-assist context (own position + enemy copy). No pointer projection —
   * stick aim is camera-frame, not cursor-based. Allocation-free.
   */
  updateAim(
    camera: THREE.Camera,
    avatarX: number,
    avatarY: number,
    _avatarHeight: number,
    _viewport: Viewport,
    enemies: Float32Array,
    enemyCount: number,
  ): void {
    cameraGroundForward(camera, this.moveBasis);
    this.selfX = avatarX;
    this.selfY = avatarY;
    this.enemyCount = Math.min(enemyCount, MAX_ENTITIES);
    this.enemies.set(enemies.subarray(0, this.enemyCount * 2));
  }

  /** Writes the current input state, quantized, into `out`. Allocation-free. */
  sample(out: PlayerInput): void {
    cameraRelativeMove(
      this.moveVec.x,
      this.moveVec.y,
      this.moveBasis.x,
      this.moveBasis.y,
      moveScratch,
    );
    out.moveX = quantizeAxis(moveScratch.x);
    out.moveY = quantizeAxis(moveScratch.y);
    // Aim: rotate the remembered screen-frame unit direction into sim space
    // (stays unit length, so it always clears the sim facing threshold), then
    // let "assist" magnetism shape it locally, before quantization.
    cameraRelativeMove(
      this.aimUnit.x,
      this.aimUnit.y,
      this.moveBasis.x,
      this.moveBasis.y,
      aimScratch,
    );
    let aimX = aimScratch.x;
    let aimY = aimScratch.y;
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
    out.buttons = this.buttonsDown | autoFirePrimary(this.aimEngaged);
  }
}
