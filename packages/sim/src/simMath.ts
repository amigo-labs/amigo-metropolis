// Deterministic math for the simulation. This module (plus sinTable.ts) is the
// ONLY sanctioned source of trigonometry and randomness inside packages/sim.
// Allowed primitives: + - * /, Math.sqrt, Math.floor/ceil/abs/min/max/sign,
// Math.imul and integer bitwise ops — all IEEE-754-exact across JS engines.
// See CLAUDE.md "Hard rules — determinism".

import { SIN_TABLE, SIN_TABLE_MASK, SIN_TABLE_SIZE } from "./sinTable";

// Math.PI is a spec-pinned double constant (not an engine-dependent function);
// scaling by powers of two is exact, so these are bit-identical everywhere.
export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

const ANGLE_TO_INDEX = SIN_TABLE_SIZE / TAU;

/**
 * Table sine, no interpolation: angle is quantized to 1/4096 of a turn
 * (max angle error ~0.0015 rad). Prefer direction vectors + normalize over
 * angles wherever possible; use this only where an angle is unavoidable.
 */
export function sinLUT(angle: number): number {
  return SIN_TABLE[Math.floor(angle * ANGLE_TO_INDEX) & SIN_TABLE_MASK];
}

/** Table cosine: sin shifted by a quarter turn (1024 table entries). */
export function cosLUT(angle: number): number {
  return SIN_TABLE[(Math.floor(angle * ANGLE_TO_INDEX) + (SIN_TABLE_SIZE >> 2)) & SIN_TABLE_MASK];
}

/**
 * Polynomial atan2 (octant reduction + odd minimax polynomial, max error
 * ~1e-5 rad). Returns radians in (-PI, PI]; atan2Poly(0, 0) === 0.
 */
export function atan2Poly(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const z = ax >= ay ? ay / ax : ax / ay;
  const z2 = z * z;
  let t = z * (0.999866 + z2 * (-0.3302995 + z2 * (0.180141 + z2 * (-0.085133 + z2 * 0.0208351))));
  if (ax < ay) t = HALF_PI - t;
  if (x < 0) t = PI - t;
  return y < 0 ? -t : t;
}

/** Squared length of a 2D vector. */
export function len2(x: number, y: number): number {
  return x * x + y * y;
}

/** Length of a 2D vector (Math.sqrt is IEEE-exact and allowed). */
export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** 1/length of a 2D vector, or 0 for the zero vector (multiply to normalize). */
export function invLen(x: number, y: number): number {
  const l = Math.sqrt(x * x + y * y);
  return l > 0 ? 1 / l : 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Any object owning a mulberry32 state word (SimState does). */
export interface PrngState {
  prng: number;
}

/**
 * mulberry32: advances state.prng and returns a float in [0, 1).
 * The ONLY randomness allowed in sim code — the built-in random is banned.
 */
export function rand01(state: PrngState): number {
  state.prng = (state.prng + 0x6d2b79f5) | 0;
  let t = state.prng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** rand01 scaled to an integer in [0, n). */
export function randInt(state: PrngState, n: number): number {
  return Math.floor(rand01(state) * n);
}
