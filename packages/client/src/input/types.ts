// Local-input abstraction shared by every human control device (keyboard/mouse
// and gamepads). A source is sampled ONCE per sim tick and quantized at the
// boundary — raw device state never reaches the sim (architecture.md §2). The
// splitscreen frame loop drives N of these, one per local player slot.

import type { PlayerInput } from "@metropolis/sim";
import type * as THREE from "three";

/** A screen rectangle in CSS pixels, top-left origin (DOM / mouse convention). */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One local human's input device. */
export interface LocalInputSource {
  /** Human-readable device name for the assignment screen. */
  readonly label: string;
  /** One-line control legend for this device (HUD footer). */
  readonly hint: string;
  /** Still usable? A gamepad can vanish mid-match; a keyboard never does. */
  isConnected(): boolean;
  /**
   * Refresh per-tick input context before sample(): the camera-relative move
   * basis, pointer aim (projects the cursor onto the avatar's ground plane
   * within this player's viewport — no-op for stick aim), and the enemy
   * positions used by "assist" aim magnetism. `enemies` is packed
   * `[x0,y0,x1,y1,…]` in sim coords with `enemyCount` pairs (a shared scratch
   * the source must copy, not retain). Call once per tick before sample().
   * Allocation-free.
   */
  updateAim(
    camera: THREE.Camera,
    avatarX: number,
    avatarY: number,
    avatarHeight: number,
    viewport: Viewport,
    enemies: Float32Array,
    enemyCount: number,
  ): void;
  /** Writes the quantized input for this tick into `out`. Allocation-free. */
  sample(out: PlayerInput): void;
  /** Haptic pulse (no-op for keyboard). `strength` 0..1. */
  rumble(strength: number, durationMs: number): void;
}
