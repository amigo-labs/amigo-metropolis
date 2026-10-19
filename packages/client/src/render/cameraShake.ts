// The chase camera's shake (fcop-fidelity.md V1): the original's second damage
// meter, which is also the shake's amplitude and its own clock.
//
// The meter is the view block's +0xd0 (`meter_2`). Two things fill it, both
// through `player_damage_meter` (RE game/actor/player.c, 0x00446200), which
// stops accepting once the meter is above 0xff and adds a quarter of what it is
// handed, at most 0xff:
//
// - a hit on the X1 (`player_take_amount` 0x00446720): the share is
//   `amount * 5 << 10 / max health`, plus the first meter at +0xa2, which keeps
//   the clamped sum (0..0x1c2) and is zeroed only by `player_reset` (the
//   construct and the respawn); the share passed on is the same sum clamped to
//   0..0x200, halved under mission-state word 23, which Precinct Assault sets;
// - an effect whose record carries +0x32 bit 4 or 13 (`cact_effect_install`
//   0x0042d020, the test at 0x0042d24c): the record's `shake` as the effect
//   export gives it (`screen.shake`: 300, or 1000 with bit 13), to team slot 0
//   and, with two viewports (the network game's), slot 1, each when within
//   its range (0x20000 world units) by `vec_magnitude` (max + (mid + min) / 4).
//
// `view_player_camera_tick` (RE game/frame/view_place.c, 0x00445d10..0x00445dc4)
// spends it: while it is non-zero the eye moves along the camera's up row
// (+0x64) and then its right row (+0x58) by `((rand & (span - 1)) - span / 2)
// << 3` world units each, `span` the top bit of min(meter, 0xff), and then the
// frame's ticks are taken off it, down to 0. The original draws `rand` from
// `game_rand` (0x0043fe30), the simulation's own stream; here it is the
// client's (mulberry32, seeded per view), because a renderer that read the
// lockstep sim's stream would desync the peers (fcop-fidelity.md E19, A18).
//
// Client-local render state, read only from the snapshots and the events;
// nothing allocates per frame (CLAUDE.md renderer rule 1).

import type { FxShake } from "../effects/records";
import { type ChasePose, WU_PER_M } from "./camera";

/** The second meter's gate: above it, nothing more is added. */
export const SHAKE_METER_GATE = 0xff;
/** The first meter's clamp (+0xa2) and the share's (passed on). */
export const DAMAGE_METER_MAX = 0x1c2;
export const DAMAGE_SHARE_MAX = 0x200;
/** The engine clamps a frame to 0x3c ticks (frame.h), and the camera's `dt` with it. */
const MAX_FRAME_TICKS = 0x3c;

export interface CameraShake {
  /** `meter_2` (+0xd0): the amplitude and the clock, engine ticks. */
  meter: number;
  /** The first damage meter (+0xa2), 0..0x1c2. */
  damage: number;
  /** The avatar the meters belong to; a new one is a `player_reset`. */
  avatar: number;
  /** The client stream the jitter draws from (mulberry32). */
  seed: number;
}

export function createCameraShake(seed = 0x5eed): CameraShake {
  return { meter: 0, damage: 0, avatar: -1, seed: seed >>> 0 };
}

/** `player_reset`: both meters zeroed (the construct and every respawn). */
export function resetCameraShake(s: CameraShake, avatar: number): void {
  s.meter = 0;
  s.damage = 0;
  s.avatar = avatar;
}

/** `player_damage_meter` (0x00446200): gated on what is there, a quarter added, capped at 0xff. */
export function shakeAdd(s: CameraShake, share: number): void {
  if (s.meter > SHAKE_METER_GATE) return;
  let quarter = Math.trunc(share / 4);
  if (quarter > SHAKE_METER_GATE) quarter = SHAKE_METER_GATE;
  s.meter += quarter;
}

/**
 * `player_take_amount` (0x00446720), the meters' half of it: a hit of `amount`
 * on an X1 of `maxHp` health. `halve` is mission-state word 23 (the team game's
 * word, set in every Precinct Assault match).
 */
export function shakeDamage(s: CameraShake, amount: number, maxHp: number, halve: boolean): void {
  if (amount <= 0 || maxHp <= 0) return;
  let share = Math.trunc((amount * 5 * 1024) / maxHp) + s.damage;
  s.damage = share < 0 ? 0 : share > DAMAGE_METER_MAX ? DAMAGE_METER_MAX : share;
  share = share < 0 ? 0 : share > DAMAGE_SHARE_MAX ? DAMAGE_SHARE_MAX : share;
  if (halve) share = Math.trunc(share / 2);
  shakeAdd(s, share);
}

/** `vec_magnitude` (0x00457b10) of an offset in metres, in world units: max + (mid + min) / 4. */
export function vecMagnitudeWu(dx: number, dy: number, dz: number): number {
  let a = Math.abs(Math.trunc(dx * WU_PER_M));
  let b = Math.abs(Math.trunc(dy * WU_PER_M));
  let c = Math.abs(Math.trunc(dz * WU_PER_M));
  if (a < b) {
    const t = a;
    a = b;
    b = t;
  }
  if (a < c) {
    const t = a;
    a = c;
    c = t;
  }
  return a + ((b + c) >> 2);
}

/**
 * The install's shake arm: a record's `shake` to an X1 within its range of
 * the effect's point (`cmp edi, 0x20000; jge`, 0x0042d2c6), metres apart.
 */
export function shakeEffect(
  s: CameraShake,
  shake: FxShake | undefined,
  dx: number,
  dy: number,
  dz: number,
): void {
  if (!shake) return;
  if (vecMagnitudeWu(dx, dy, dz) < shake.range) shakeAdd(s, shake.amount);
}

/** The highest power of two not above `m` (1 << math_top_bit(m)), m >= 1. */
export function shakeSpan(m: number): number {
  let span = 1;
  while (span * 2 <= m) span *= 2;
  return span;
}

/** One draw of the client stream, 32 bits (mulberry32). */
function draw(s: CameraShake): number {
  s.seed = (s.seed + 0x6d2b79f5) >>> 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/**
 * The shake's arm of the camera tick for `ticks` engine ticks: the eye of
 * `pose` (three's frame, metres) moved along the camera's up row, then its right
 * row, and the meter spent. Nothing moves while the camera does not tick.
 */
export function applyCameraShake(s: CameraShake, ticks: number, pose: ChasePose): void {
  if (s.meter === 0 || ticks <= 0) return;
  // The camera tick's `dt`, clamped as the frame's is (render/camera.ts).
  const dt = ticks > MAX_FRAME_TICKS ? MAX_FRAME_TICKS : ticks;
  const m = s.meter > SHAKE_METER_GATE ? SHAKE_METER_GATE : s.meter;
  if (m >= 1) {
    const span = shakeSpan(m);
    const mask = span - 1;
    const half = span >> 1;
    const up = (((draw(s) & mask) - half) * 8) / WU_PER_M;
    const right = (((draw(s) & mask) - half) * 8) / WU_PER_M;
    // The camera's rows in three's frame: it looks along (cp cos y, -sp, cp sin y).
    const cy = Math.cos(pose.yaw);
    const sy = Math.sin(pose.yaw);
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    pose.eyeX += sp * cy * up - sy * right;
    pose.eyeY += cp * up;
    pose.eyeZ += sp * sy * up + cy * right;
  }
  if (s.meter > 0) s.meter = s.meter > dt ? s.meter - dt : 0;
}
