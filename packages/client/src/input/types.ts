// Local-input abstraction for a human control device. A source is sampled
// ONCE per sim tick into the original's button word — raw device state never
// reaches the sim (architecture.md §2). The frame loop drives one of these per
// local player slot.

import type { PlayerInput } from "@metropolis/sim";

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
  /** Writes this tick's button word into `out`. Allocation-free. */
  sample(out: PlayerInput): void;
}
