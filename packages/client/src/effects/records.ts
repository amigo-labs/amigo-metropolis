// The original's effect records (types 87..94) as the client draws them, and
// the arithmetic every class shares. Pure: no Three, no DOM — the chain
// scheduler, the audio cues and the renderer all read it.
//
// Source: the RE repo's effect export (`extracted/effects/<Map>.json`,
// `tables.json`; docs/formats/effects.md), imported by
// tools/generators/fcopEffects.ts into fcopEffects.generated.ts. The units are
// the export's:
//
//   tick        1/300 s, the engine clock. A Metropolis sim tick is ten.
//   world unit  8192 to a metre (a terrain tile).
//   x16         sixteenths: a field v draws as v << 4 world units = v / 512 m.
//   angle       4096 to a turn; a negative record angle is rolled at random.
//   colour      vertex colour bytes, 0x80 = 1.0: the submitter doubles them
//               and clamps at 0xff.
//   ramp16      raw / 16 ticks (87 stages, 88 fade, 93 colour).
//   ramp300     raw * 300 / 4096 ticks (89 colours, 94 colour, 92 fade).

/** Engine ticks a second (the original's clock). */
export const ENGINE_HZ = 300;
/** Engine ticks per Metropolis sim tick (30 Hz). */
export const ENGINE_TICKS_PER_SIM_TICK = 10;
/** World units a metre. */
export const WORLD_UNITS_PER_METRE = 8192;
/** A turn in the original's angle unit. */
export const TURN = 4096;

/** Header flag bits (+0x32, docs/formats/effects.md "Common header"). */
export const FXF_PLACED = 0x0001;
export const FXF_NO_GROUND_TEST = 0x0002;
/** Offset and velocity in the raiser's frame. */
export const FXF_IN_FRAME = 0x0004;
export const FXF_INHERIT_PLACEMENT = 0x0008;
export const FXF_SHAKE = 0x0010;
export const FXF_SCREEN_FLASH = 0x0020;
export const FXF_UNHOLD = 0x0040;
export const FXF_RANDOM_VERTEX = 0x0080;
/** Compose into the raiser's frame: the effect follows it. */
export const FXF_LOCAL_SPACE = 0x0100;
/** Successor when the repeats run out, not after the spawn delay. */
export const FXF_SUCCESSOR_AT_REPEAT_END = 0x0800;
export const FXF_DIE_WITH_REFERENCE = 0x1000;
export const FXF_HARD_SHAKE = 0x2000;

/** What every record carries, already in engine ticks. */
export interface FxHeader {
  readonly type: number;
  /** +0x15: the id raised next in the same bank, 0 none. */
  readonly next: number;
  /** +0x24 in engine ticks: when the successor is published (0: at once). */
  readonly delay: number;
  /** +0x28 after the registrar's normalisation: -1 none. */
  readonly repeats: number;
  /** +0x2a in engine ticks. */
  readonly period: number;
  /** +0x20 in engine ticks, 0 none. */
  readonly life: number;
  /** +0x32. */
  readonly flags: number;
  /** +0x1c, x16: the placement's distance along (placeY, placeX). */
  readonly offset: number;
  /** +0x18 / +0x1a: the placement direction. */
  readonly placeY: number;
  readonly placeX: number;
  /** +0x1e: the raiser's model point, 255 none. */
  readonly attach: number;
}

/** Type 87: a ribbon through up to 40 nodes. */
export interface Fx87 extends FxHeader {
  readonly type: 87;
  /** The scale field: a new node's half-width, x16. */
  readonly halfWidth: number;
  /** The factory's width rate: `(rate * (delta << 4)) >> 12` a frame. */
  readonly widthRate: number;
  /** Stages 0, 1, 2 as nine bytes; a node ramps 0 -> 1 -> 2 -> black. */
  readonly stageRgb: readonly number[];
  /** Each stage's ramp, ramp16 raw. */
  readonly stageTicks: readonly number[];
  /** One node per this much (x16) travel of the emission point. */
  readonly spacing: number;
  readonly emitAngleY: number;
  readonly emitAngleX: number;
  /** 1/16 world unit a tick. */
  readonly emitSpeed: number;
  readonly velocityJitter: number;
  readonly gravity: number;
  readonly drag: number;
  /** The instance flags (TRAIL_*). */
  readonly trailFlags: number;
  /** The trail rect row (0 for every shipped record), -1 untextured. */
  readonly rect: number;
}

export const TRAIL_RETIRE_EMPTY = 0x0001;
export const TRAIL_PARTICLE = 0x0002;
export const TRAIL_UNTEXTURED = 0x0004;
export const TRAIL_GROUND = 0x0008;
export const TRAIL_HEAD_WORLD = 0x0010;
export const TRAIL_NO_HEAD = 0x2000;
export const TRAIL_STOP_AT_ONCE = 0x4000;
export const TRAIL_VELOCITY = 0x8000;
/** Nodes in one trail (`nodes_max`). */
export const TRAIL_NODES_MAX = 40;
/** The Cpyr particle a trail node spawns (index 7, id 10). */
export const TRAIL_NODE_PARTICLE_INDEX = 7;

/** Type 88: jagged strands between two ends. */
export interface Fx88 extends FxHeader {
  readonly type: 88;
  /** The scale field: end 1's scatter, x16. */
  readonly scatter: number;
  readonly segments: number;
  readonly strands: number;
  readonly rgb: readonly number[];
  /** ramp16 raw. */
  readonly fadeTicks: number;
  readonly amplitude: number;
  /** Both ends' half-width, x16; the far end's is 0 with LINK_FAR_NO_WIDTH. */
  readonly endHalfWidth: number;
  readonly linkFlags: number;
}

export const LINK_FAR_NO_WIDTH = 0x08;

/** Type 89: a screen-facing disc or star. */
export interface Fx89 extends FxHeader {
  readonly type: 89;
  /** The scale field: radius, x16. */
  readonly radius: number;
  readonly wedgeCap: number;
  readonly radiusGrowth: number;
  /** ramp300 raw. */
  readonly centreTicks: number;
  readonly rimTicks: number;
  readonly centreFrom: readonly number[];
  readonly centreTo: readonly number[];
  readonly rimFrom: readonly number[];
  readonly rimTo: readonly number[];
  readonly emitAngleY: number;
  readonly emitAngleX: number;
  /** 1/16 world unit a tick. */
  readonly speed: number;
  readonly gravityY: number;
  readonly phaseLow: number;
  readonly startAngle: number;
  readonly flashFlags: number;
}

export const FLASH_BOUNCE = 0x1;
export const FLASH_PHASED = 0x2;
export const FLASH_STAR = 0x4;

/** Type 90: the raiser's model broken into flying faces. */
export interface Fx90 extends FxHeader {
  readonly type: 90;
  readonly magnitudeLo: number;
  readonly magnitudeHi: number;
  readonly driftScaleLo: number;
  readonly driftScaleHi: number;
  readonly driftAngleY: number;
  readonly driftAngleX: number;
  readonly count: number;
  readonly shatterFlags: number;
}

/** Type 92: an expanding ring or sphere. */
export interface Fx92 extends FxHeader {
  readonly type: 92;
  /** radius += (delta * v) >> 8 a frame, x16. */
  readonly growth: number;
  readonly decay: number;
  readonly maxRadius: number;
  readonly thickness: number;
  readonly angleY: number;
  readonly angleX: number;
  readonly segments: number;
  readonly inner: readonly number[];
  readonly outer: readonly number[];
  /** The fade's parameter: ramp300 raw, under 16 none. */
  readonly fade: number;
  /** The scale field: the start radius, x16. */
  readonly startRadius: number;
  readonly spinY: number;
  readonly spinX: number;
  readonly shellFlags: number;
}

export const SHELL_SWAP = 0x0001;
export const SHELL_ADDITIVE = 0x0004;
export const SHELL_HALF_ALPHA = 0x0008;
export const SHELL_DOUBLE = 0x0010;
export const SHELL_SPHERE = 0x0040;
export const SHELL_NARROW = 0x0200;
export const SHELL_CONE = 0x0400;

/** Type 93: one Cpyr particle node. */
export interface Fx93 extends FxHeader {
  readonly type: 93;
  /** Index into FX_PARTICLES, -1 when no particle carries the id. */
  readonly particle: number;
  /** The scale field: span max(v << 5, 0x500) world units. */
  readonly size: number;
  readonly emitAngleY: number;
  readonly emitAngleX: number;
  /** 1/16 world unit a tick. */
  readonly speed: number;
  readonly fall: number;
  readonly colourFrom: readonly number[];
  readonly colourTo: readonly number[];
  /** ramp16 raw. */
  readonly rampTicks: number;
  readonly grow: number;
  readonly angleY: number;
  readonly angleX: number;
  readonly spinY: number;
  readonly spinX: number;
  /** +0x56: the low byte | 0x40 is the pyro flags; 0x100 drains to black. */
  readonly emitterFlags: number;
}

/** The pyro flags (fcop/pyro_chain.h; particles.json draw.modes). */
export const PYRO_TWO_SIDED = 0x01;
export const PYRO_TRANSLUCENT = 0x02;
export const PYRO_SPRITE = 0x04;
export const PYRO_HEADING = 0x08;
export const PYRO_ADDITIVE = 0x10;
export const PYRO_SUBTRACTIVE = 0x20;
export const EMITTER_DRAIN = 0x100;

/** Type 94: bursts of nodes drawn as flat screen rectangles. */
export interface Fx94 extends FxHeader {
  readonly type: 94;
  readonly nodeCount: number;
  readonly nodeCap: number;
  readonly speedLo: number;
  readonly speedHi: number;
  readonly gravity: number;
  readonly windAngleY: number;
  readonly windAngleX: number;
  readonly windSpeed: number;
  readonly drag: number;
  readonly dragDivisor: number;
  readonly orientYaw: number;
  readonly orientPitch: number;
  readonly pitchLo: number;
  readonly pitchHi: number;
  /** 1..7 screen units at 640x480; negative rolls 1..|v|. */
  readonly rectSize: number;
  readonly colourA: readonly number[];
  readonly colourB: readonly number[];
  /** ramp300 raw (absolute). */
  readonly rampTicks: number;
  readonly rampFlags: number;
  readonly walkFlags: number;
  readonly spawnRadius: number;
  readonly velocityJitter: number;
  readonly positionJitter: number;
}

export const WALK_HALF_ALPHA = 0x08;
export const WALK_ADDITIVE = 0x10;
export const WALK_SUBTRACTIVE = 0x20;
/** The original's node budget, shared by every type-94 instance. */
export const NODES_MAX = 700;

export type FxRecord = Fx87 | Fx88 | Fx89 | Fx90 | Fx92 | Fx93 | Fx94;

/** One Cpyr particle as the drawer reads it (extracted/particles/particles.json). */
export interface FxParticle {
  readonly id: number;
  /** The cell the sprite sits in: a span s draws the cell s wide. */
  readonly sizePow2: number;
  /** The sprite's rect in particles.png and its offset inside the cell. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly offX: number;
  readonly offY: number;
}

/** One arena's two banks: id -> index into FX_RECORDS. */
export interface FxArena {
  readonly mission: string;
  readonly banks: readonly [Readonly<Record<number, number>>, Readonly<Record<number, number>>];
  /** The arena's row in trails.png (its own tex10's trail rect). */
  readonly trailRow: number;
}

/**
 * One line facer of a bolt Cobj (3DQL type 7, `cobj_prim_emit` 0x004289cc): a
 * camera-facing quad from z0 to z1 along the round's heading, `half0` and
 * `half1` wide at its ends, textured from tex10 (trails.png), coloured by its
 * face (doubled), drawn additive (material 6: blend 2).
 */
export interface FxBoltLine {
  /** The ends along the model's +z (forward), metres. */
  readonly z0: number;
  readonly z1: number;
  /** The half-widths at each end (3DRL), metres. */
  readonly half0: number;
  readonly half1: number;
  /** The face's colour bytes. */
  readonly rgb: readonly number[];
  /**
   * The four corners' (u, v), texels of the arena's trails.png row, in the
   * line arm's order: out and in at end 0, in and out at end 1.
   */
  readonly uv: readonly number[];
}

// --- arithmetic ---------------------------------------------------------------

/** x16 field -> metres. */
export function x16ToMetres(v: number): number {
  return (v * 16) / WORLD_UNITS_PER_METRE;
}

/** ramp16: the ramp's length in engine ticks; 0 when under the class minimum. */
export function ramp16Ticks(raw: number): number {
  return raw < 16 ? 0 : raw / 16;
}

/** ramp300: the ramp's length in engine ticks; 0 when under 16. */
export function ramp300Ticks(raw: number): number {
  return raw < 16 ? 0 : (raw * ENGINE_HZ) / 4096;
}

/**
 * A colour byte as the hardware draws it: 0x80 is 1.0, the submitter doubles
 * and clamps at 0xff. Returned as 0..1.
 */
export function vertexColour(byte: number): number {
  const v = byte * 2;
  return (v > 255 ? 255 : v < 0 ? 0 : v) / 255;
}

/**
 * Where a channel ramping from `from` to `to` over `ticks` stands after `t`
 * ticks: linear, clamped at `to` (the classes' ramp step stops at its bound).
 */
export function rampChannel(from: number, to: number, ticks: number, t: number): number {
  if (ticks <= 0) return from;
  if (t >= ticks) return to;
  return from + ((to - from) * t) / ticks;
}

/**
 * Type 89's ramp with the bounce flag: the step turns round at each bound, so
 * the channel ping-pongs between `from` and `to`.
 */
export function bounceChannel(from: number, to: number, ticks: number, t: number): number {
  if (ticks <= 0) return from;
  const cycle = t / ticks;
  const n = Math.floor(cycle);
  const f = cycle - n;
  return (n & 1) === 0 ? from + (to - from) * f : to + (from - to) * f;
}

/**
 * A trail node's colour after `t` ticks: stage 0 ramps to stage 1, 1 to 2, 2
 * to black, each over its own ramp16 length (a stage under the minimum ends at
 * once). Writes three bytes into `out` and returns the stage it is in (3 done).
 */
export function trailColour(
  stageRgb: readonly number[],
  stageTicks: readonly number[],
  t: number,
  out: Float32Array,
): number {
  let left = t;
  for (let s = 0; s < 3; s++) {
    const len = ramp16Ticks(stageTicks[s]);
    const f = len <= 0 ? 1 : left >= len ? 1 : left / len;
    if (f < 1) {
      for (let c = 0; c < 3; c++) {
        const a = stageRgb[s * 3 + c];
        const b = s < 2 ? stageRgb[(s + 1) * 3 + c] : 0;
        out[c] = a + (b - a) * f;
      }
      return s;
    }
    left -= len;
  }
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  return 3;
}

/** A trail's whole life in engine ticks: the three stages end to end. */
export function trailNodeLife(stageTicks: readonly number[]): number {
  return ramp16Ticks(stageTicks[0]) + ramp16Ticks(stageTicks[1]) + ramp16Ticks(stageTicks[2]);
}

/**
 * The placement's scale (instance +0x12, `0x0042c850`): a context with a scale
 * gives it outright (the impact's 0x80); otherwise the record's field, where 0
 * means the raiser's scale and a negative v `(-raiser * v) >> 12`.
 */
export function placementScale(field: number, raiserScale: number, contextScale: number): number {
  if (contextScale > 0) return contextScale;
  if (field > 0) return field;
  if (field === 0) return raiserScale;
  return Math.floor((-raiserScale * field) / 4096);
}

/** The impact raise's scale: context word 0x800 >> 4 (whatever the record says). */
export const IMPACT_SCALE = 0x80;
/** No raiser, or the player's attach block (OPEN in the RE; the rebuild's 0x100). */
export const DEFAULT_SCALE = 0x100;

/** A type-93 node's span in metres: max(scale << 5, 0x500) world units. */
export function particleSpan(scale: number): number {
  const wu = scale < 0x28 ? 0x500 : scale * 32;
  return wu / WORLD_UNITS_PER_METRE;
}

/**
 * The palette level rule (`palette_shade`, particles.json palette_levels): each
 * 5-bit channel c of an A1R5G5B5 word becomes min(31, (c * L + 16) >> 5), bit
 * 15 kept. Level 0x20 is the word itself, and it is the level the drawer binds.
 */
export function paletteLevel(word: number, level: number): number {
  const shade = (c: number) => Math.min(31, (c * level + 16) >> 5);
  const r = shade((word >> 10) & 31);
  const g = shade((word >> 5) & 31);
  const b = shade(word & 31);
  return (word & 0x8000) | (r << 10) | (g << 5) | b;
}

/** A1R5G5B5 -> 8-bit channels, widened `(c << 3) | (c >> 2)`. */
export function widenWord(word: number): [number, number, number] {
  const w = (c: number) => (c << 3) | (c >> 2);
  return [w((word >> 10) & 31), w((word >> 5) & 31), w(word & 31)];
}

/**
 * An original angle -> radians, rolling a negative one at random over
 * [0, |v|) as `cact_effect_range_roll` does.
 */
export function angleRad(v: number, random: () => number): number {
  const a = v < 0 ? Math.floor(random() * -v) : v;
  return (a * 2 * Math.PI) / TURN;
}

/**
 * A direction given as the original's (yaw, pitch) pair — yaw from +z toward
 * +x, pitch up — in Metropolis' three frame, turned by the raiser's yaw (the
 * sim's, radians: 0 is +x). The original's (x, y, z) is three's (z, y, x).
 */
export function directionOf(
  yaw: number,
  pitch: number,
  raiserYaw: number,
  out: Float32Array,
): void {
  const cp = Math.cos(pitch);
  // FCOP local: (sin yaw * cos pitch, sin pitch, cos yaw * cos pitch).
  const lx = Math.sin(yaw) * cp;
  const ly = Math.sin(pitch);
  const lz = Math.cos(yaw) * cp;
  localToThree(lx, ly, lz, raiserYaw, out);
}

/**
 * The original's local (x, y, z) — z forward, x to the side, y up — in three's
 * frame for a raiser facing sim yaw `yaw`.
 */
export function localToThree(
  lx: number,
  ly: number,
  lz: number,
  yaw: number,
  out: Float32Array,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[0] = lz * c - lx * s;
  out[1] = ly;
  out[2] = lz * s + lx * c;
}
