// Gamepad input (PLAN Phase 5, primary splitscreen device). Reads the W3C
// Standard Gamepad each tick and quantizes at the boundary — analog sticks
// become int8 axes, so raw gamepad floats never enter the sim (architecture.md
// §2). Controls are camera-relative, matching the keyboard/mouse scheme: the
// left stick drives relative to the camera's world-fixed ground-forward
// (camera.spec §5), the right stick aims independently (twin-stick), holding the
// last facing when released. Allocation-free in sample().

import { BUTTON_TARGET_CYCLE, MAX_ENTITIES, type PlayerInput, quantizeAxis } from "@metropolis/sim";
import type * as THREE from "three";
import { ASSIST_CONE_COS, ASSIST_STRENGTH, aimAssist, applyAimAssist } from "./aimAssist";
import { GAMEPAD_BUTTON_MAP, STICK_DEADZONE, stickWithDeadzone, type Vec2 } from "./gamepadMapping";
import { cameraGroundForward, cameraRelativeMove } from "./movement";
import type { LocalInputSource } from "./types";

// Standard-gamepad B button — cycles the soft-lock target in "lock" aim mode.
const GAMEPAD_TARGET_CYCLE_BUTTON = 1;

// Module-scope scratch: sample() runs inside the tick loop for every player in
// turn, so a shared scratch is safe (synchronous, non-reentrant).
const move: Vec2 = { x: 0, y: 0 };
const aim: Vec2 = { x: 0, y: 0 };
const swallow = (): void => {};

export class GamepadInput implements LocalInputSource {
  readonly label: string;
  readonly hint =
    "L-stick drive · R-stick aim · RT/LT/RB fire · Y transform · A jump · hold X to buy/claim/capture";
  private readonly index: number;
  // Last non-neutral aim direction (unit vector). Defaults to +x facing.
  private aimX = 1;
  private aimY = 0;
  // Camera ground-forward (sim coords) used as the camera-relative move basis;
  // refreshed each tick in updateAim. Defaults to +x before the camera is ready.
  private readonly moveBasis: Vec2 = { x: 1, y: 0 };
  // Per-tick aim-assist context stashed in updateAim (own pos + enemy copy).
  private selfX = 0;
  private selfY = 0;
  private enemyCount = 0;
  private readonly enemies = new Float32Array(MAX_ENTITIES * 2);
  private readonly assistOut: Vec2 = { x: 0, y: 0 };

  constructor(index: number) {
    this.index = index;
    this.label = `Gamepad ${index + 1}`;
  }

  private pad(): Gamepad | null {
    // getGamepads snapshots live state; the slot may be null if unplugged. The
    // API itself can be absent/disabled (?. guards that) — treat it as no pad.
    const pads = navigator.getGamepads?.();
    return pads ? (pads[this.index] ?? null) : null;
  }

  isConnected(): boolean {
    return this.pad()?.connected ?? false;
  }

  // Stick aim is world-relative (no camera projection), but movement still needs
  // the camera's ground-forward as its basis (camera.spec §5). Also stashes the
  // aim-assist context (own pos + a copy of the enemy list) for sample().
  updateAim(
    camera: THREE.Camera,
    avatarX: number,
    avatarY: number,
    _avatarHeight: number,
    _viewport: unknown,
    enemies: Float32Array,
    enemyCount: number,
  ): void {
    cameraGroundForward(camera, this.moveBasis);
    this.selfX = avatarX;
    this.selfY = avatarY;
    this.enemyCount = Math.min(enemyCount, MAX_ENTITIES);
    this.enemies.set(enemies.subarray(0, this.enemyCount * 2));
  }

  sample(out: PlayerInput): void {
    const p = this.pad();
    if (p === null) {
      out.moveX = 0;
      out.moveY = 0;
      out.aimX = quantizeAxis(this.aimX);
      out.aimY = quantizeAxis(this.aimY);
      out.buttons = 0;
      return;
    }
    const ax = p.axes;
    // Right stick → aim first, so the move below rotates by this tick's facing.
    // Beyond the deadzone we snap to a unit vector (crisp facing that clears the
    // sim's aim threshold) and remember it; released, the avatar keeps facing
    // where it last aimed (parity with the mouse).
    const mag = stickWithDeadzone(ax[2] ?? 0, ax[3] ?? 0, STICK_DEADZONE, aim);
    if (mag > 0) {
      const inv = 1 / Math.sqrt(aim.x * aim.x + aim.y * aim.y);
      this.aimX = aim.x * inv;
      this.aimY = -aim.y * inv;
    }
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
    // Left stick → analog move, camera-relative (rotated by the camera-forward,
    // NOT the aim). Gamepad Y is +down, sim +y is forward: invert for "forward".
    stickWithDeadzone(ax[0] ?? 0, ax[1] ?? 0, STICK_DEADZONE, move);
    cameraRelativeMove(move.x, -move.y, this.moveBasis.x, this.moveBasis.y, move);
    out.moveX = quantizeAxis(move.x);
    out.moveY = quantizeAxis(move.y);
    const b = p.buttons;
    let buttons = 0;
    for (let i = 0; i < GAMEPAD_BUTTON_MAP.length; i++) {
      if (b[GAMEPAD_BUTTON_MAP[i][0]]?.pressed) buttons |= GAMEPAD_BUTTON_MAP[i][1];
    }
    // Target-cycle (B) only emits in "lock" mode; the sim owns the tracking.
    if (aimAssist.mode === "lock" && b[GAMEPAD_TARGET_CYCLE_BUTTON]?.pressed) {
      buttons |= BUTTON_TARGET_CYCLE;
    }
    out.buttons = buttons;
  }

  rumble(strength: number, durationMs: number): void {
    const act = this.pad()?.vibrationActuator;
    if (!act) return;
    const s = Math.min(Math.max(strength, 0), 1);
    // Not every browser resolves the promise; swallow rejections either way.
    act
      .playEffect("dual-rumble", {
        duration: durationMs,
        strongMagnitude: s,
        weakMagnitude: s * 0.6,
      })
      .then(swallow, swallow);
  }
}
