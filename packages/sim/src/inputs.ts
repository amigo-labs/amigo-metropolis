// Tick inputs (architecture.md §2): per player, axes quantized to int8.
// Quantization is part of determinism — raw gamepad floats never enter the
// sim. The quantizer lives here so client and tools share one definition.

import { MAX_PLAYERS } from "./balance";

export const BUTTON_FIRE1 = 1 << 0;
export const BUTTON_FIRE2 = 1 << 1;
export const BUTTON_FIRE3 = 1 << 2;
export const BUTTON_TRANSFORM = 1 << 3;
export const BUTTON_JUMP = 1 << 4;
export const BUTTON_INTERACT = 1 << 5;

/** Axes are integers in [-127, 127]; buttons is a u8 bitfield. */
export interface PlayerInput {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  buttons: number;
}

export interface TickInputs {
  /** Always MAX_PLAYERS entries; unused players stay all-zero. */
  readonly players: PlayerInput[];
}

export function createTickInputs(): TickInputs {
  const players: PlayerInput[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    players.push({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 });
  }
  return { players };
}

export function clearTickInputs(t: TickInputs): void {
  for (const p of t.players) {
    p.moveX = 0;
    p.moveY = 0;
    p.aimX = 0;
    p.aimY = 0;
    p.buttons = 0;
  }
}

export function copyTickInputs(dst: TickInputs, src: TickInputs): void {
  for (let i = 0; i < dst.players.length; i++) {
    const d = dst.players[i];
    const s = src.players[i];
    d.moveX = s.moveX;
    d.moveY = s.moveY;
    d.aimX = s.aimX;
    d.aimY = s.aimY;
    d.buttons = s.buttons;
  }
}

/** Clamps to [-1, 1] and quantizes to int8 (round half toward +inf — exact). */
export function quantizeAxis(v: number): number {
  const c = Math.min(Math.max(v, -1), 1);
  return Math.floor(c * 127 + 0.5);
}
