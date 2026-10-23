// The models' camera-facing primitives (fcop-fidelity.md G13; RE
// docs/formats/objects.md "Facers"). `cobj_prim_emit` (0x00428690) builds
// four of its arms on the screen every frame instead of reading them as
// faces: a billboard (arm 5) and a rect (arm 6) around a vertex, a line
// (arm 7) between two, and a star (arm 8, `draw_disc_fan` 0x004271c0). The
// RE writes them per frame into the glb's root extras; gen:units moves them
// with the mesh and puts their (u, v) on the model's atlas.
//
// What each one is, in the view (the camera's right / up, `at`'s depth):
//
// - billboard: a square of half-size `half` about `at` in the view plane,
//   corners 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left as the
//   screen shows them (0x004288d7..0x00428900), (u, v) pair k on corner k;
// - rect: the same with [hx, hy] (no shipped primitive is one);
// - line: a ribbon locked to the segment and turned to the camera. n is the
//   unit normal of the segment's on-screen direction turned 90 degrees
//   counter-clockwise (screen y up); corners 0 = from + n h0, 1 = from - n h0,
//   2 = to - n h1, 3 = to + n h1, each end's offset at its own depth
//   (0x00428a2e, 0x00428a4a, 0x00428b44..0x00428b9c);
// - star: a disc in the view plane, a fan of gouraud wedges from the centre
//   colour to the rim colour, each doubled (record op 0x5b, colour mode 0x50,
//   0x00427248), additive (blend byte 2, 0x0042724c), untextured. Its wedges:
//   the on-screen radius in 480-line pixels rounded down to a multiple of
//   four, at least 4, at most the primitive's cap.
//
// A length is the model's own, in metres at its point's depth: an instance
// that scales (a Prop's row bytes) moves the points, never the lengths
// (`<< 12 / z` in every arm). A facer whose point is at or inside the near
// plane (view z <= 0x405, 512 a metre) is dropped, as the arms drop it.
// Textured facers take the face's mode — add (tint x 2 / 255, ONE / ONE),
// half (the bit-15 texels 50/50) or opaque — and the instance's team offset,
// which `cact_model_shade_face` adds to every (u, v) (RE model_shade.c
// 0x00427f0d).
//
// The sort. The original has no depth buffer: every record goes into the
// display list at a sort key and the list is drawn far to near
// (`draw_list_submit` 0x0040ca10). A facer's key is its point's depth (a
// line's, its ends' mean `(z1 + z0) / 2`; RE cobj_prim.c, 0x004288bf for the
// billboard), less the 0x100 the model walker hands every primitive of the
// model, faces as well (`cact_model_draw_prims` 0x004284ea). Here the depth
// buffer stands in for the list, so each facer is laid on its key's plane: a
// billboard, rect and star already are; a line's corners slide along their
// view rays onto the plane at its ends' mean, its screen shape unchanged and
// its texture mapped across the screen as THRASH maps every record (one w for
// every vertex, 0x00456315). The half facers, the one blend whose order shows,
// are written far to near within their batch. The 0x100 is not applied: it is
// the same on the model's faces, which the depth buffer tests at their own
// depth (against the terrain plates, which carry none, `terrain_plate.c`
// 0x004539ea, every model sorts 0x100 nearer in the original).
//
// A star with a 3DAL colour ramp (`colour_anim`, gen:units; the mine's, Mp 50)
// takes its centre colour off the clock every frame, as
// `cobj_tick_color_anims` (RE 0x0041a1a0) rewrites the primitive's bytes 5..7
// before the draw: a triangle wave of `clock * speed`, 4096 clock units a
// period per unit of speed, from one colour to the other and back. The clock is
// the engine's 300 Hz one, on the sim's time (drawFacers' caller).
//
// Renderer rules: one dynamic batch per model and blend (render/fx/ribbons.ts'
// RibbonBuffer: preallocated, rebuilt every frame, nothing allocated once the
// models are in), reading each instance's matrix off the archetype's own
// InstancedMesh — the facers are the original's screen geometry, not an
// instanced mesh of their own (assets.md §4). Matrices are taken as world:
// every InstancedMesh this reads hangs at the identity.

import * as THREE from "three";
import type { FaceMode } from "./fcopModel";
import { FX_OUTPUT, FxView } from "./fx/common";
import { RibbonBuffer } from "./fx/ribbons";
import { TEAM_UV_ATTR } from "./teamUv";

export const FACER_BILLBOARD = 0;
export const FACER_RECT = 1;
export const FACER_LINE = 2;
export const FACER_STAR = 3;

/** View depth at or inside which a facer is dropped: 0x405 in the 512-a-metre view. */
export const FACER_NEAR = 0x405 / 512;

/** One facer, frame by frame. */
export interface Facer {
  readonly kind: number;
  readonly mode: FaceMode;
  /** Per frame, xyz: the point (billboard, rect, star) or the line's `from`. */
  readonly a: Float32Array;
  /** Per frame, xyz: the line's `to`. */
  readonly b: Float32Array;
  /** Per frame, two lengths: half twice, [hx, hy], [h0, h1], the radius twice. */
  readonly h: Float32Array;
  /** The atlas (u, v) of corners 0..3; null untextured (a star). */
  readonly uv: Float32Array | null;
  /** What the texel is multiplied by (display values): an add's tint x 2 / 255, else 1; a star's centre. */
  readonly colour: Float32Array;
  /** A star's rim colour, doubled. */
  readonly rim: Float32Array;
  readonly wedgeCap: number;
  /**
   * A star's colour ramp, or null: [speed, from r, g, b, to r, g, b]. Each
   * frame writes its centre into `colour` (rampColour).
   */
  readonly ramp: Int32Array | null;
}

/** A model's facers, as one archetype's instances wear them. */
export interface FacerSet {
  readonly frames: number;
  readonly facers: readonly Facer[];
}

interface RawFacer {
  kind?: string;
  mode?: string;
  rgb?: number[];
  uv?: number[][];
  texture?: number | null;
  at?: number[][];
  from?: number[][];
  to?: number[][];
  half?: (number | number[])[];
  radius?: number[];
  centre_rgb?: number[];
  rim_rgb?: number[];
  wedge_cap?: number;
  colour_anim?: { speed?: number; from?: number[]; to?: number[] };
}

const KINDS: Readonly<Record<string, number>> = {
  billboard: FACER_BILLBOARD,
  rect: FACER_RECT,
  line: FACER_LINE,
  star: FACER_STAR,
};

/**
 * The facers of a glb's root extras (`{facers, frames}`, gen:units), or null.
 * `turn` bakes the quarter turn the unit and weapon buckets give their
 * geometry (`rotateY(PI / 2)`: x' = z, z' = -x). Load time only.
 */
export function parseFacers(extras: unknown, turn = false): FacerSet | null {
  const fcop = (extras as { fcop?: { facers?: RawFacer[]; frames?: number } } | undefined)?.fcop;
  const list = fcop?.facers ?? [];
  if (list.length === 0) return null;
  const frames = Math.max(1, fcop?.frames ?? 1);
  const facers: Facer[] = [];
  for (const f of list) {
    const kind = KINDS[f.kind ?? ""];
    if (kind === undefined) continue;
    const mode: FaceMode = f.mode === "half" ? "half" : f.mode === "opaque" ? "opaque" : "add";
    const a = new Float32Array(frames * 3);
    const b = new Float32Array(frames * 3);
    const h = new Float32Array(frames * 2);
    const first = kind === FACER_LINE ? f.from : f.at;
    for (let k = 0; k < frames; k++) {
      put(a, k, first?.[Math.min(k, (first?.length ?? 1) - 1)], turn);
      if (kind === FACER_LINE) put(b, k, f.to?.[Math.min(k, (f.to?.length ?? 1) - 1)], turn);
      const lengths = kind === FACER_STAR ? f.radius : f.half;
      const v = lengths?.[Math.min(k, (lengths?.length ?? 1) - 1)] ?? 0;
      h[k * 2] = typeof v === "number" ? v : v[0];
      h[k * 2 + 1] = typeof v === "number" ? v : v[1];
    }
    const colour = new Float32Array(3);
    const rim = new Float32Array(3);
    if (kind === FACER_STAR) {
      doubled(f.centre_rgb, colour);
      doubled(f.rim_rgb, rim);
    } else if (mode === "add") {
      doubled(f.rgb, colour);
    } else {
      // The lighting materials are not exported: the texture drawn unlit, as
      // every face is (render/fcopModel.ts).
      colour.fill(1);
    }
    const textured = kind !== FACER_STAR && f.texture !== null && f.texture !== undefined && f.uv;
    const uv = textured ? Float32Array.from((f.uv ?? []).flatMap((c) => [c[0], c[1]])) : null;
    const anim = kind === FACER_STAR ? f.colour_anim : undefined;
    const ramp = anim
      ? Int32Array.from([anim.speed ?? 0, ...(anim.from ?? [0, 0, 0]), ...(anim.to ?? [0, 0, 0])])
      : null;
    facers.push({ kind, mode, a, b, h, uv, colour, rim, wedgeCap: f.wedge_cap ?? 4, ramp });
  }
  return facers.length > 0 ? { frames, facers } : null;
}

function put(out: Float32Array, k: number, p: number[] | undefined, turn: boolean): void {
  const x = p?.[0] ?? 0;
  const y = p?.[1] ?? 0;
  const z = p?.[2] ?? 0;
  out[k * 3] = turn ? z : x;
  out[k * 3 + 1] = y;
  out[k * 3 + 2] = turn ? -x : z;
}

/** A colour's bytes doubled, 0x80 unity (colour mode 0x30 / 0x50). */
function doubled(rgb: readonly number[] | undefined, out: Float32Array): void {
  for (let i = 0; i < 3; i++) out[i] = ((rgb?.[i] ?? 0x80) * 2) / 255;
}

/**
 * One byte of a 3DAL ramp at `clock` (RE `cobj_tick_color_anims` 0x0041a1a0):
 * the phase `(clock * speed) & 0xfff` folded at 0x7ff into a triangle wave,
 * then `from + ((to - from + 1) * phase >> 11)`, a negative span biased by
 * 0x7ff before the shift (retail's rounding toward zero), stored as a byte.
 */
export function rampByte(from: number, to: number, speed: number, clock: number): number {
  let phase = Math.imul(clock, speed) & 0xfff;
  if (phase > 0x7ff) phase = 0xfff - phase;
  const span = (to - from + 1) * phase;
  return (((span + ((span >> 31) & 0x7ff)) >> 11) + from) & 0xff;
}

/** A ramped star's centre at `clock` into its `colour`, doubled as the star draws it. */
export function rampColour(f: Facer, clock: number): void {
  const r = f.ramp;
  if (!r) return;
  for (let i = 0; i < 3; i++) f.colour[i] = (rampByte(r[1 + i], r[4 + i], r[0], clock) * 2) / 255;
}

// --- the geometry -------------------------------------------------------------
// Pure functions of the view, for the batches below and the tests.

/** Depth of (x, y, z) along the view axis, metres (no floor). */
export function viewDepth(view: FxView, x: number, y: number, z: number): number {
  return (
    (view.pos.x - x) * view.back.x + (view.pos.y - y) * view.back.y + (view.pos.z - z) * view.back.z
  );
}

/**
 * A billboard's or rect's four corners into `out` (12 floats): about (x, y, z)
 * in the view plane, `hx` along the camera's right, `hy` along its up; 0
 * top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
 */
export function billboardCorners(
  view: FxView,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  out: Float32Array,
): void {
  const r = view.right;
  const u = view.up;
  for (let k = 0; k < 4; k++) {
    const sx = k === 0 || k === 3 ? -hx : hx;
    const sy = k < 2 ? hy : -hy;
    out[k * 3] = x + r.x * sx + u.x * sy;
    out[k * 3 + 1] = y + r.y * sx + u.y * sy;
    out[k * 3 + 2] = z + r.z * sx + u.z * sy;
  }
}

/**
 * A line's four corners into `out` (12 floats): n the unit normal of the
 * segment's on-screen direction turned 90 degrees counter-clockwise, laid in
 * the view plane at each end's own depth; 0 = from + n h0, 1 = from - n h0,
 * 2 = to - n h1, 3 = to + n h1. A segment seen end-on takes the camera's right.
 */
export function lineCorners(
  view: FxView,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  h0: number,
  h1: number,
  out: Float32Array,
): void {
  const r = view.right;
  const u = view.up;
  const p = view.pos;
  const d0 = viewDepth(view, x0, y0, z0);
  const d1 = viewDepth(view, x1, y1, z1);
  // The projected ends (any focal length: only the direction is kept).
  const sx0 = ((x0 - p.x) * r.x + (y0 - p.y) * r.y + (z0 - p.z) * r.z) / d0;
  const sy0 = ((x0 - p.x) * u.x + (y0 - p.y) * u.y + (z0 - p.z) * u.z) / d0;
  const sx1 = ((x1 - p.x) * r.x + (y1 - p.y) * r.y + (z1 - p.z) * r.z) / d1;
  const sy1 = ((x1 - p.x) * u.x + (y1 - p.y) * u.y + (z1 - p.z) * u.z) / d1;
  const dx = sx1 - sx0;
  const dy = sy1 - sy0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = len > 1e-9 ? -dy / len : 0;
  const ny = len > 1e-9 ? dx / len : 1;
  // n on the screen, in the world: right * nx + up * ny.
  const wx = r.x * nx + u.x * ny;
  const wy = r.y * nx + u.y * ny;
  const wz = r.z * nx + u.z * ny;
  out[0] = x0 + wx * h0;
  out[1] = y0 + wy * h0;
  out[2] = z0 + wz * h0;
  out[3] = x0 - wx * h0;
  out[4] = y0 - wy * h0;
  out[5] = z0 - wz * h0;
  out[6] = x1 - wx * h1;
  out[7] = y1 - wy * h1;
  out[8] = z1 - wz * h1;
  out[9] = x1 + wx * h1;
  out[10] = y1 + wy * h1;
  out[11] = z1 + wz * h1;
}

/**
 * A star's wedges at `depth`: its on-screen radius in 480-line pixels
 * rounded down to a multiple of four, at least 4, at most `cap`.
 */
export function starWedges(view: FxView, radius: number, depth: number, cap: number): number {
  const px = (radius * view.focal480) / depth;
  const w = Math.floor(px) & ~3;
  return Math.min(Math.max(4, cap), Math.max(4, w));
}

// --- the batches --------------------------------------------------------------

const VERTEX = /* glsl */ `
attribute vec3 aColour;
varying vec3 vColour;
varying vec2 vUv;
void main() {
  vColour = aColour;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * The texel in the original's values: the atlases are sRGB textures (the
 * models' own), so the sampler decodes and this encodes back.
 */
const TEXEL = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColour;
varying vec2 vUv;
vec4 facerTexel() {
  vec4 t = texture2D(uMap, vUv);
#ifdef FACER_SRGB
  t = sRGBTransferOETF(t);
#endif
  return t;
}`;

/** add: ONE / ONE, the texture's alpha ignored (the key is black and adds nothing). */
const ADD_FRAGMENT = /* glsl */ `${TEXEL}
void main() {
  gl_FragColor = vec4(facerTexel().rgb * vColour, 1.0);
  ${FX_OUTPUT}
}`;

/** half: the key cut, the bit-15 texels (alpha 128) at their own 50 %, the rest solid. */
const HALF_FRAGMENT = /* glsl */ `${TEXEL}
void main() {
  vec4 t = facerTexel();
  if (t.a < 0.25) discard;
  gl_FragColor = vec4(t.rgb * vColour, t.a);
  ${FX_OUTPUT}
}`;

/** opaque: the key cut, everything else solid. */
const OPAQUE_FRAGMENT = /* glsl */ `${TEXEL}
void main() {
  vec4 t = facerTexel();
  if (t.a < 0.25) discard;
  gl_FragColor = vec4(t.rgb * vColour, 1.0);
  ${FX_OUTPUT}
}`;

/** A star: the gouraud colours alone, added. */
const PLAIN_FRAGMENT = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
  ${FX_OUTPUT}
}`;

/** The batches a model's facers draw in: textured add, half, opaque, and the stars. */
const PASS_ADD = 0;
const PASS_HALF = 1;
const PASS_OPAQUE = 2;
const PASS_STAR = 3;
const PASSES = 4;

function passOf(f: Facer): number {
  if (f.kind === FACER_STAR || !f.uv) return f.kind === FACER_STAR ? PASS_STAR : -1;
  return f.mode === "add" ? PASS_ADD : f.mode === "half" ? PASS_HALF : PASS_OPAQUE;
}

/** The batch material of a pass: ONE / ONE for add and stars, never AdditiveBlending. */
export function facerMaterial(pass: number, map: THREE.Texture | null): THREE.ShaderMaterial {
  const fragment =
    pass === PASS_ADD
      ? ADD_FRAGMENT
      : pass === PASS_HALF
        ? HALF_FRAGMENT
        : pass === PASS_OPAQUE
          ? OPAQUE_FRAGMENT
          : PLAIN_FRAGMENT;
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: fragment,
    uniforms: pass === PASS_STAR ? {} : { uMap: { value: map } },
    side: THREE.DoubleSide,
  });
  if (pass !== PASS_STAR && map?.colorSpace === THREE.SRGBColorSpace) {
    material.defines.FACER_SRGB = "";
  }
  if (pass === PASS_ADD || pass === PASS_STAR) {
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
    material.blendEquationAlpha = THREE.AddEquation;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
  } else if (pass === PASS_HALF) {
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.NormalBlending;
  }
  return material;
}

/** One archetype's facers: its InstancedMesh, what each instance shows, the batches. */
interface Source {
  readonly mesh: THREE.InstancedMesh;
  readonly set: FacerSet;
  /** Per instance, the frame shown; null for frame 0. */
  readonly frames: ArrayLike<number> | null;
  readonly teamUv: boolean;
  readonly batches: (RibbonBuffer | null)[];
  /** Some facer of the set ramps its colour. */
  readonly ramped: boolean;
  /** A frame's half facers, sorted far to near: each one's key, and instance * facers + facer. */
  readonly sortKey: Float32Array;
  readonly sortRef: Int32Array;
}

let sceneRef: THREE.Scene | null = null;
const sources: Source[] = [];
const view = new FxView();
const corners = new Float32Array(12);
/** The transformed point (and a line's other end) of the facer being drawn. */
const ends = new Float32Array(6);

/** The scene the batches join. Once, at boot. */
export function initFacers(scene: THREE.Scene): void {
  sceneRef = scene;
}

/**
 * Draws `set` on every instance of `mesh` from the next frame on, replacing
 * what `mesh` drew before; null takes its facers away. `frames` is each
 * instance's frame (read every frame, so the owner may update it in place);
 * `teamUv` adds the instance's team offset to the (u, v). Load time only.
 */
export function registerFacers(
  mesh: THREE.InstancedMesh,
  set: FacerSet | null,
  map: THREE.Texture | null,
  options: { frames?: ArrayLike<number>; teamUv?: boolean } = {},
): void {
  unregisterFacers(mesh);
  const scene = sceneRef;
  if (!set || !scene) return;
  const capacity = mesh.instanceMatrix.count;
  const verts = new Int32Array(PASSES);
  let halves = 0;
  for (const f of set.facers) {
    const pass = passOf(f);
    if (pass >= 0) verts[pass] += pass === PASS_STAR ? Math.max(4, f.wedgeCap) + 2 : 4;
    if (pass === PASS_HALF) halves++;
  }
  const batches: (RibbonBuffer | null)[] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    batches.push(
      verts[pass] > 0
        ? new RibbonBuffer(scene, verts[pass] * capacity, facerMaterial(pass, map))
        : null,
    );
  }
  sources.push({
    mesh,
    set,
    frames: options.frames ?? null,
    teamUv: options.teamUv === true,
    batches,
    ramped: set.facers.some((f) => f.ramp !== null),
    sortKey: new Float32Array(halves * capacity),
    sortRef: new Int32Array(halves * capacity),
  });
}

/** Takes `mesh`'s facers away. */
export function unregisterFacers(mesh: THREE.InstancedMesh): void {
  for (let i = sources.length - 1; i >= 0; i--) {
    if (sources[i].mesh !== mesh) continue;
    const batches = sources[i].batches;
    for (let p = 0; p < batches.length; p++) batches[p]?.dispose();
    sources[i] = sources[sources.length - 1];
    sources.pop();
  }
}

/** The facers registered (tests, debug). */
export function facerSourceCount(): number {
  return sources.length;
}

/** Whether `obj` still hangs in the scene (an arena swap drops its group). */
function inScene(obj: THREE.Object3D): boolean {
  let o = obj;
  while (o.parent) o = o.parent;
  return o === sceneRef;
}

/**
 * Per frame, after every instance matrix is written and before the draw: each
 * registered model's facers, rebuilt for `camera`, the colour ramps at `clock`
 * (the engine's 300 Hz units on the sim's time). Allocates nothing.
 */
export function drawFacers(camera: THREE.Camera, viewportHeight: number, clock = 0): void {
  view.set(camera, viewportHeight);
  for (let s = sources.length - 1; s >= 0; s--) {
    const src = sources[s];
    if (!inScene(src.mesh)) {
      unregisterFacers(src.mesh);
      continue;
    }
    if (src.ramped) {
      const facers = src.set.facers;
      for (let k = 0; k < facers.length; k++) rampColour(facers[k], clock);
    }
    for (let p = 0; p < PASSES; p++) src.batches[p]?.begin();
    // A mesh of facers alone is hidden (no faces): its matrices still count.
    if (view.has) drawSource(src);
    for (let p = 0; p < PASSES; p++) src.batches[p]?.end();
  }
}

function drawSource(src: Source): void {
  const m = src.mesh.instanceMatrix.array as Float32Array;
  const count = src.mesh.count;
  const facers = src.set.facers;
  let sorted = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 16;
    // A hidden instance stands at a zero scale (or the zero matrix).
    if (m[o] === 0 && m[o + 1] === 0 && m[o + 2] === 0) continue;
    for (let k = 0; k < facers.length; k++) {
      const f = facers[k];
      const pass = passOf(f);
      const buf = pass >= 0 ? src.batches[pass] : null;
      if (!buf) continue;
      if (pass !== PASS_HALF) {
        emitFacer(src, buf, f, i);
        continue;
      }
      // A half facer waits for its batch's order: far to near by its key.
      const key = facerKey(src, f, i);
      if (key <= 0 || sorted >= src.sortKey.length) continue;
      src.sortKey[sorted] = key;
      src.sortRef[sorted] = i * facers.length + k;
      sorted++;
    }
  }
  if (sorted === 0) return;
  sortFarToNear(src.sortKey, src.sortRef, sorted);
  const buf = src.batches[PASS_HALF];
  if (!buf) return;
  for (let n = 0; n < sorted; n++) {
    const ref = src.sortRef[n];
    const i = Math.floor(ref / facers.length);
    emitFacer(src, buf, facers[ref - i * facers.length], i);
  }
}

/** The frame instance `i` of `src` shows. */
function frameOf(src: Source, i: number): number {
  return src.frames ? Math.max(0, Math.min(src.set.frames - 1, src.frames[i] | 0)) : 0;
}

/**
 * Facer `f` of instance `i` through its matrix into `ends` (its point, and a
 * line's other end), and its sort key: the point's view depth, a line's ends'
 * mean. 0 when an end is at or inside the near plane, where the arm drops it.
 */
function facerKey(src: Source, f: Facer, i: number): number {
  const m = src.mesh.instanceMatrix.array as Float32Array;
  const o = i * 16;
  const a = frameOf(src, i) * 3;
  const ax = f.a[a];
  const ay = f.a[a + 1];
  const az = f.a[a + 2];
  // The point through the instance's matrix (column-major).
  ends[0] = m[o] * ax + m[o + 4] * ay + m[o + 8] * az + m[o + 12];
  ends[1] = m[o + 1] * ax + m[o + 5] * ay + m[o + 9] * az + m[o + 13];
  ends[2] = m[o + 2] * ax + m[o + 6] * ay + m[o + 10] * az + m[o + 14];
  const d0 = viewDepth(view, ends[0], ends[1], ends[2]);
  if (d0 <= FACER_NEAR) return 0;
  if (f.kind !== FACER_LINE) return d0;
  const bx = f.b[a];
  const by = f.b[a + 1];
  const bz = f.b[a + 2];
  ends[3] = m[o] * bx + m[o + 4] * by + m[o + 8] * bz + m[o + 12];
  ends[4] = m[o + 1] * bx + m[o + 5] * by + m[o + 9] * bz + m[o + 13];
  ends[5] = m[o + 2] * bx + m[o + 6] * by + m[o + 10] * bz + m[o + 14];
  const d1 = viewDepth(view, ends[3], ends[4], ends[5]);
  if (d1 <= FACER_NEAR) return 0;
  return (d0 + d1) / 2;
}

/** Facer `f` of instance `i` into `buf`, on its key's plane. */
function emitFacer(src: Source, buf: RibbonBuffer, f: Facer, i: number): void {
  const key = facerKey(src, f, i);
  if (key <= 0) return;
  const frame = frameOf(src, i);
  const h0 = f.h[frame * 2];
  const h1 = f.h[frame * 2 + 1];
  if (f.kind === FACER_STAR) {
    star(buf, f, ends[0], ends[1], ends[2], h0, key);
    return;
  }
  if (f.kind === FACER_LINE) {
    lineCorners(view, ends[0], ends[1], ends[2], ends[3], ends[4], ends[5], h0, h1, corners);
    onSortPlane(view, key, corners);
  } else {
    billboardCorners(view, ends[0], ends[1], ends[2], h0, h1, corners);
  }
  let du = 0;
  let dv = 0;
  if (src.teamUv) {
    const team = src.mesh.geometry.getAttribute(TEAM_UV_ATTR) as
      | THREE.InstancedBufferAttribute
      | undefined;
    if (team) {
      const t = team.array as Float32Array;
      du = t[i * 2];
      dv = t[i * 2 + 1];
    }
  }
  quad(buf, f, du, dv);
}

/**
 * Slides four corners (12 floats) along their view rays onto the plane at
 * view depth `depth`: the screen shows them where it did, and the depth buffer
 * meets them at the record's sort key. Each corner must lie in front of the
 * eye.
 */
export function onSortPlane(view: FxView, depth: number, out: Float32Array): void {
  const p = view.pos;
  for (let k = 0; k < 4; k++) {
    const x = out[k * 3];
    const y = out[k * 3 + 1];
    const z = out[k * 3 + 2];
    const s = depth / viewDepth(view, x, y, z);
    out[k * 3] = p.x + (x - p.x) * s;
    out[k * 3 + 1] = p.y + (y - p.y) * s;
    out[k * 3 + 2] = p.z + (z - p.z) * s;
  }
}

/**
 * Sorts the first `n` keys descending, far to near, `refs` along (an insertion
 * sort: a batch's half facers are few). In place.
 */
export function sortFarToNear(keys: Float32Array, refs: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const key = keys[i];
    const ref = refs[i];
    let j = i - 1;
    while (j >= 0 && keys[j] < key) {
      keys[j + 1] = keys[j];
      refs[j + 1] = refs[j];
      j--;
    }
    keys[j + 1] = key;
    refs[j + 1] = ref;
  }
}

function quad(buf: RibbonBuffer, f: Facer, du: number, dv: number): void {
  if (!buf.room(4, 2) || !f.uv) return;
  const c = f.colour;
  const uv = f.uv;
  const base = buf.v;
  for (let k = 0; k < 4; k++) {
    buf.vertex(
      corners[k * 3],
      corners[k * 3 + 1],
      corners[k * 3 + 2],
      c[0],
      c[1],
      c[2],
      uv[k * 2] + du,
      uv[k * 2 + 1] + dv,
    );
  }
  buf.tri(base, base + 1, base + 2);
  buf.tri(base, base + 2, base + 3);
}

function star(
  buf: RibbonBuffer,
  f: Facer,
  x: number,
  y: number,
  z: number,
  radius: number,
  depth: number,
): void {
  const n = starWedges(view, radius, depth, f.wedgeCap);
  if (!buf.room(n + 2, n)) return;
  const c = f.colour;
  const rim = f.rim;
  const r = view.right;
  const u = view.up;
  const centre = buf.vertex(x, y, z, c[0], c[1], c[2], 0, 0);
  for (let k = 0; k <= n; k++) {
    const t = (k * 2 * Math.PI) / n;
    const cx = Math.cos(t) * radius;
    const sy = Math.sin(t) * radius;
    buf.vertex(
      x + r.x * cx + u.x * sy,
      y + r.y * cx + u.y * sy,
      z + r.z * cx + u.z * sy,
      rim[0],
      rim[1],
      rim[2],
      0,
      0,
    );
  }
  for (let k = 0; k < n; k++) buf.tri(centre, centre + 1 + k, centre + 2 + k);
}
