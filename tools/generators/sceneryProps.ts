// The type-96 Props and the type-97 DCSQuads as the original builds them, for
// gen:scenery (tools/generators/fcopScenery.ts). Pure functions over the
// records the scenery reader takes out of the mission bytes; the RE's code is
// cited at every step.
//
// - A Prop (`cact_load_type96`, RE snd/emitter.c 0x0042fc80) is a permanent
//   sound emitter with a model: `snd_emit_build` (0x0042f6c0) stands it at its
//   record's position, on the ground of its layer plus its height << 4,
//   oriented by `math_matrix_from_angles(y, x, z)` with a negative angle drawn
//   from `game_rand`, each row scaled by a byte (0x40 unity, a negative one
//   random within its own spread), and `snd_emit_draw_block` (0x0042fe20)
//   steps its frames and turns it every frame it is drawn.
// - A DCSQuad (`cact_load_type97`, RE world/pyro_chain.c 0x004372d0) is one
//   decal quad: `pyro_spawn` (0x00437050) looks its Cdcs rect up by id, stands
//   it at the ground of its layer plus its lift << 4, and `pyro_place`
//   (0x00436e20) turns its four corners by the three angles; the drawer
//   (world/pyro_draw.c 0x004373e0) textures it with the rect and blends it by
//   its flags.

/** The record's +0x1c when the emitter is not put on the ground (0x0042f812). */
export const EMITTER_LAYER_NONE = -99;
/** The DCSQuad's layer byte for "no ground" (0x00437135). */
export const QUAD_LAYER_NONE = -3;
/** 0x40 in a scale byte is unity (0x0042f909). */
export const SCALE_ONE = 0x40;
/** The emitter's period base: a rate becomes 300 / rate (0x0042f76f). */
const PERIOD_BASE = 300;
/** The fixed seed the maths init seeds the generator with (RE math/rsqrt.c). */
export const RETAIL_SEED = 0x457;

/** snd_emit_record's flag bits (RE fcop/snd_emitter.h). */
export const EMIT_FLAG = {
  ANIM_04: 0x04,
  NO_RATE: 0x08,
  ANIM_20: 0x20,
  ATTACH: 0x40,
} as const;

/** The DCSQuad's flag bits the drawer reads (RE fcop/pyro_chain.h). */
export const QUAD_FLAG = {
  TWO_SIDED: 0x01,
  TRANSLUCENT: 0x02,
  BOX: 0x04,
  BLEND_2: 0x10,
  BLEND_3: 0x20,
} as const;

/** A DCSQuad spawns only when one of its spans is at least this (0x00437057). */
const MIN_SPAN = 0x40;

/**
 * The game's simulation generator, `game_rand` (RE math/random.c 0x0043fe30):
 * an additive lagged Fibonacci over a 20-word table filled from a MINSTD seed
 * stream (0x0043feb0, 0x0043ff20). The effects table is filled after it and
 * not drawn from here.
 */
export class GameRand {
  private seedState: number;
  private readonly table = new Uint32Array(20);
  private index = 20;

  constructor(seed: number) {
    this.seedState = seed >>> 0;
    for (let i = 0; i < 20; i++) this.table[i] = this.seedStep();
  }

  /** `state * 16807 mod (2^31 - 1)`, split at 16 bits as retail does it. */
  seedStep(): number {
    const lo = this.seedState & 0xffff;
    const hi = (this.seedState >>> 16) * 16807;
    let value = (lo * 16807 + (hi & 0x7fff) * 0x10000 + Math.floor(hi / 0x8000)) >>> 0;
    if ((value & 0x80000000) !== 0) value = (value - 0x7fffffff) >>> 0;
    this.seedState = value;
    return value;
  }

  /** One draw, as the i32 retail returns. */
  next(): number {
    let at = this.index - 1;
    let ahead = this.index + 2;
    if (at < 0) at = 19;
    else if (ahead > 19) ahead = this.index - 18;
    const value = (this.table[at] + this.table[ahead]) >>> 0;
    this.index = at;
    this.table[at] = value;
    return value | 0;
  }
}

/** An angle field, or a random 12-bit one when it is negative (0x0042f845). */
function angleOr(field: number, rand: GameRand): number {
  return field >= 0 ? field : rand.next() & 0xfff;
}

/** A type-96 record, as the scenery reader takes it (snd_emit_record). */
export interface PropRecord {
  /** The resource's place in the container: the order the mission loads it. */
  readonly seq: number;
  readonly res: string;
  readonly id: number;
  readonly cobjs: readonly number[];
  /** position[0..2], world units. */
  readonly pos: readonly [number, number, number];
  readonly angleY: number;
  readonly angleZ: number;
  readonly angleX: number;
  readonly height: number;
  readonly layer: number;
  readonly flags: number;
  readonly rate: number;
  readonly scale: readonly [number, number, number];
  readonly spin: number;
  readonly heading: number;
  /** terrain_height_at on the remapped layer, world units; null for layer -99. */
  readonly ground: number | null;
}

/** How a Prop steps its model's frames (`snd_emit_draw_block`'s three arms). */
export type PropAnim = "none" | "loop" | "boomerang";

/** One Prop as the build leaves it. */
export interface ResolvedProp {
  readonly record: string;
  readonly cobj: number;
  /** World units, the game's frame. */
  readonly pos: readonly [number, number, number];
  /** The three angles fed to `math_matrix_from_angles`, random ones drawn. */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** The three row scales, 0x40 unity, random ones drawn. */
  readonly scale: readonly [number, number, number];
  /** 12-bit angle per engine tick; 0 holds the built orientation. */
  readonly spin: number;
  /** The swing's amplitude (+0x23 degrees as a 12-bit angle); 0 a plain spin. */
  readonly swing: number;
  /** The swing's centre: the record's +0x14 verbatim (HELD `park`). */
  readonly park: number;
  readonly anim: PropAnim;
  /** Engine ticks a frame (the emitter's `period`). */
  readonly period: number;
  /** The table-A sound the emitter plays (`attached`), 0 none. */
  readonly sound: number;
}

/**
 * Builds every Prop in load order, drawing the random angles and scales from
 * `rand` (shared with the DCSQuads, in the order the mission loads them).
 * `frames(cobj)` is the model's frame count (its 4DGI flags' low half).
 */
export function resolveProp(
  r: PropRecord,
  rand: GameRand,
  frames: (cobj: number) => number,
): ResolvedProp {
  const what = `${r.res} ${r.id}`;
  if (r.cobjs.length === 0) throw new Error(`${what}: a Prop without a Cobj`);
  // 0x0042fcb5: only the first aRSL entry is resolved.
  const cobj = r.cobjs[0];
  // 0x0042f80e..0x0042f842: the ground of the layer plus the height << 4,
  // unless the layer is -99, which keeps the record's own y.
  const y = r.ground === null ? r.pos[1] : r.height * 16 + r.ground;
  // 0x0042f845..0x0042f8a8: read y, x, z; ATTACH takes z's low byte as the
  // sound and the angle as 0.
  const attach = (r.flags & EMIT_FLAG.ATTACH) !== 0;
  const yaw = angleOr(r.angleY, rand);
  const pitch = angleOr(r.angleX, rand);
  const roll = attach ? 0 : angleOr(r.angleZ, rand);
  const sound = attach ? r.angleZ & 0xff : 0;
  // 0x0042f8c9..0x0042f91c: all three at unity skip the loop; a negative byte
  // draws `rand mod 2|s|` and lands in [0x40 - |s|, 0x40 + |s| - 1].
  const scale: [number, number, number] = [r.scale[0], r.scale[1], r.scale[2]];
  if (scale.some((s) => s !== SCALE_ONE)) {
    for (let row = 0; row < 3; row++) {
      const s = scale[row];
      if (s < 0) scale[row] = s + ((rand.next() >>> 0) % (-s * 2)) + 0x40;
    }
  }
  // 0x0042f754..0x0042f776: the period.
  const period = r.rate === 0 ? 0 : r.rate === 1 ? 0xff : Math.floor(PERIOD_BASE / r.rate) & 0xff;
  if ((r.flags & EMIT_FLAG.ANIM_20) !== 0 && (r.flags & EMIT_FLAG.NO_RATE) === 0 && period > 0) {
    // The flicker arm counts down by the clock's low bits and draws from
    // game_rand_fx: no Precinct Assault record takes it.
    throw new Error(`${what}: a flickering Prop (flag 0x20)`);
  }
  const n = frames(cobj);
  let anim: PropAnim = "none";
  if ((r.flags & EMIT_FLAG.NO_RATE) === 0 && period > 0 && n > 1) {
    anim = (r.flags & EMIT_FLAG.ANIM_04) !== 0 ? "boomerang" : "loop";
  }
  return {
    record: what,
    cobj,
    pos: [r.pos[0], y, r.pos[2]],
    yaw,
    pitch,
    roll,
    scale,
    spin: r.spin,
    // 0x0042f7a6..0x0042f7bc: degrees to a 12-bit angle, MSVC's divide by 360.
    swing: Math.trunc((r.heading * 4096) / 360),
    park: r.angleY,
    anim,
    period,
    sound,
  };
}

/** A type-97 record, as the scenery reader takes it (the PYRO_REC_* fields). */
export interface QuadRecord {
  /** The resource's place in the container: the order the mission loads it. */
  readonly seq: number;
  readonly res: string;
  readonly id: number;
  readonly pos: readonly [number, number, number];
  readonly flags: number;
  readonly kind: number;
  readonly lift: number;
  readonly spanZ: number;
  readonly spanX: number;
  readonly angleY: number;
  readonly angleX: number;
  readonly angleZ: number;
  readonly layer: number;
  readonly colour: readonly [number, number, number];
  /** terrain_height_at on the remapped layer, world units (0 for layer -3). */
  readonly ground: number;
}

/** A Cdcs rect: where on which Cbmp page, and the id a DCSQuad names. */
export interface DecalRect {
  readonly res: number;
  readonly u: number;
  readonly v: number;
  readonly w: number;
  readonly h: number;
  readonly page: number;
  readonly id: number;
}

/** One DCSQuad as the spawn leaves it. */
export interface ResolvedQuad {
  readonly record: string;
  /** The Cdcs rect drawn: its id byte (what the record names). */
  readonly decal: number;
  /** The quad's centre, world units, the game's frame. */
  readonly pos: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** The corners' half extents along the quad's own x and z, world units. */
  readonly halfX: number;
  readonly halfZ: number;
  /** The colour the drawer hands the driver, 0..255 a channel (`colour_of`). */
  readonly tint: readonly [number, number, number];
  /** The driver's blend byte: 1 the default, 2 additive, 3 the third pair. */
  readonly blend: 1 | 2 | 3;
  readonly twoSided: boolean;
}

/** `(v - (v >> 31)) >> 1`: halve toward zero (pyro_chain.c `half`). */
function half(v: number): number {
  return (v - (v >> 31)) >> 1;
}

/** One channel doubled and clamped (draw_submit.c `channel_doubled`). */
function doubled(c: number): number {
  return Math.min(0xff, c * 2);
}

/**
 * Spawns one DCSQuad, or null where retail spawns nothing (both spans under
 * 0x40, or an id no Cdcs rect carries). Draws its random angles from `rand`.
 */
export function resolveQuad(
  r: QuadRecord,
  rand: GameRand,
  rects: readonly DecalRect[],
): ResolvedQuad | null {
  const what = `${r.res} ${r.id}`;
  if (r.spanZ < MIN_SPAN && r.spanX < MIN_SPAN) return null;
  if (r.kind < 0) throw new Error(`${what}: a DCSQuad naming a particle (${r.kind})`);
  const rect = rects.find((q) => q.id === r.kind);
  if (!rect) return null;
  if ((r.flags & QUAD_FLAG.BOX) !== 0) {
    // The sprite arm faces the camera: no Precinct Assault record takes it.
    throw new Error(`${what}: a box (sprite) DCSQuad`);
  }
  const yaw = angleOr(r.angleY, rand);
  const pitch = angleOr(r.angleX, rand);
  const roll = angleOr(r.angleZ, rand);
  // pyro_place 0x00436f96 / 0x00436fb6: the spans << 4, halved toward zero,
  // then >> 4 into the sixteenths the corners are stored in.
  const halfX = (half(r.spanX * 16) >> 4) * 16;
  const halfZ = (half(r.spanZ * 16) >> 4) * 16;
  const f = r.flags;
  // pyro_draw.c instance_texture: blend 2 for bit 0x10, else 3 for 0x20, else 1.
  const blend: 1 | 2 | 3 =
    (f & QUAD_FLAG.BLEND_2) !== 0 ? 2 : (f & QUAD_FLAG.BLEND_3) !== 0 ? 3 : 1;
  const halfAlpha = (f & (QUAD_FLAG.TRANSLUCENT | QUAD_FLAG.BLEND_2 | QUAD_FLAG.BLEND_3)) !== 0;
  if (blend === 3 && halfAlpha) {
    // draw_submit.c's 4x arm (colour mode 0x30, textured, half-alpha, blend 3)
    // with its carrying saturate: no Precinct Assault record takes it.
    throw new Error(`${what}: a blend-3 DCSQuad`);
  }
  // Colour mode 0x30 when bit 0x10 or 0x20 is set, else 0x00: on a textured
  // record both double vertex 0's r, g, b (draw_submit.c colour_of) — but
  // mode 0x00 textured is white (0x80 grey doubled).
  const saturate = (f & (QUAD_FLAG.BLEND_2 | QUAD_FLAG.BLEND_3)) !== 0;
  const tint: [number, number, number] = saturate
    ? [doubled(r.colour[0]), doubled(r.colour[1]), doubled(r.colour[2])]
    : [0xff, 0xff, 0xff];
  return {
    record: what,
    decal: rect.id,
    pos: [r.pos[0], r.lift * 16 + r.ground, r.pos[2]],
    yaw,
    pitch,
    roll,
    halfX,
    halfZ,
    tint,
    blend,
    twoSided: (f & QUAD_FLAG.TWO_SIDED) !== 0,
  };
}
