// What every effect class's drawer shares: the frame's camera, the entity
// poses an effect can ride, the placement of an install, and the materials.
// Module-scope scratch only: nothing here allocates once a match runs.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import {
  directionOf,
  FXF_IN_FRAME,
  FXF_LOCAL_SPACE,
  type FxHeader,
  TURN,
  x16ToMetres,
} from "../../effects/records";

/** Floats per entity in the pose table main.ts fills: x, height, z, yaw. */
export const POSE_STRIDE = 4;

/**
 * The rendered pose of every entity this frame (interpolated, as drawn), and
 * whether it was drawn at all. Filled by main.ts's entity pass.
 */
export interface FxPoses {
  readonly table: Float32Array;
  readonly live: Uint8Array;
}

/** The camera of the frame being drawn. */
export class FxView {
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly back = new THREE.Vector3(0, 0, 1);
  /** Pixels of the original's 480-line screen per metre at a depth of 1 m. */
  focal480 = 240 / Math.tan((60 * Math.PI) / 360);
  /** Device pixels per 480-line pixel. */
  pixelScale = 1;
  has = false;

  set(camera: THREE.Camera | undefined, viewportHeight: number): void {
    if (!camera) {
      this.has = false;
      return;
    }
    this.has = true;
    camera.getWorldPosition(this.pos);
    camera.getWorldQuaternion(this.quat);
    this.right.set(1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.back.set(0, 0, 1).applyQuaternion(this.quat);
    const persp = camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) this.focal480 = 240 / Math.tan((persp.fov * Math.PI) / 360);
    this.pixelScale = viewportHeight > 0 ? viewportHeight / 480 : 1;
  }

  /** Distance along the view axis to (x, y, z), floored above zero. */
  depth(x: number, y: number, z: number): number {
    const d =
      (this.pos.x - x) * this.back.x +
      (this.pos.y - y) * this.back.y +
      (this.pos.z - z) * this.back.z;
    return d > 0.05 ? d : 0.05;
  }
}

/**
 * Where an instance stands and what it rides: the placement at install, and,
 * for a record that follows its reference (+0x32 bit 8, `effect_attach_transform`
 * 0x0042c7c0), the offset from the reference's point to re-apply every frame.
 */
export interface Anchors {
  /** The point now: x, y, z per instance. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** The reference: an entity, a pending round token (< -1), or -1. */
  readonly ref: Int32Array;
  /** 1 when the instance is drawn at its reference every frame. */
  readonly follow: Uint8Array;
  /** The raise point in the reference's frame: along its facing, up. */
  readonly refF: Float32Array;
  readonly refU: Float32Array;
  /** The placement's own offset from that point (world). */
  readonly ox: Float32Array;
  readonly oy: Float32Array;
  readonly oz: Float32Array;
  /** The raiser's facing at install (sim yaw), for in-frame directions. */
  readonly yaw: Float32Array;
}

export function makeAnchors(n: number): Anchors {
  return {
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    ref: new Int32Array(n).fill(-1),
    follow: new Uint8Array(n),
    refF: new Float32Array(n),
    refU: new Float32Array(n),
    ox: new Float32Array(n),
    oy: new Float32Array(n),
    oz: new Float32Array(n),
    yaw: new Float32Array(n),
  };
}

const dir = new Float32Array(3);

/**
 * The install's placement (`cact_effect_place` 0x0042c850): the raise point,
 * pushed `offset` (x16) along the record's (angle_y, angle_x) — in the raiser's
 * frame with +0x32 bit 2 — into slot `i`. `follow` overrides bit 8 (a trail's
 * emission point always rides its reference).
 */
export function placeAnchor(
  a: Anchors,
  i: number,
  rec: FxHeader,
  at: Readonly<RaiseAt>,
  follow: boolean,
): void {
  let ox = 0;
  let oy = 0;
  let oz = 0;
  if (rec.offset !== 0) {
    const yaw = (rec.flags & FXF_IN_FRAME) !== 0 ? at.yaw : 0;
    directionOf(roll(rec.placeY), roll(rec.placeX), yaw, dir);
    const d = x16ToMetres(rec.offset);
    ox = dir[0] * d;
    oy = dir[1] * d;
    oz = dir[2] * d;
  }
  a.ox[i] = ox;
  a.oy[i] = oy;
  a.oz[i] = oz;
  a.x[i] = at.x + ox;
  a.y[i] = at.y + oy;
  a.z[i] = at.z + oz;
  a.ref[i] = at.attach;
  a.follow[i] = follow || (rec.flags & FXF_LOCAL_SPACE) !== 0 ? 1 : 0;
  a.refF[i] = at.attachForward;
  a.refU[i] = at.attachUp;
  a.yaw[i] = at.yaw;
}

export function copyAnchor(a: Anchors, from: number, to: number): void {
  a.x[to] = a.x[from];
  a.y[to] = a.y[from];
  a.z[to] = a.z[from];
  a.ref[to] = a.ref[from];
  a.follow[to] = a.follow[from];
  a.refF[to] = a.refF[from];
  a.refU[to] = a.refU[from];
  a.ox[to] = a.ox[from];
  a.oy[to] = a.oy[from];
  a.oz[to] = a.oz[from];
  a.yaw[to] = a.yaw[from];
}

/**
 * Moves a following instance to its reference's pose this frame. Returns false
 * when the reference is gone (it was not drawn): the instance detaches where
 * it last was.
 */
export function followAnchor(a: Anchors, i: number, poses: FxPoses | null): boolean {
  const ref = a.ref[i];
  if (ref < 0 || !poses) return true;
  if (poses.live[ref] === 0) {
    a.ref[i] = -1;
    return false;
  }
  if (a.follow[i] === 0) return true;
  const o = ref * POSE_STRIDE;
  const yaw = poses.table[o + 3];
  const f = a.refF[i];
  a.x[i] = poses.table[o] + Math.cos(yaw) * f + a.ox[i];
  a.y[i] = poses.table[o + 1] + a.refU[i] + a.oy[i];
  a.z[i] = poses.table[o + 2] + Math.sin(yaw) * f + a.oz[i];
  a.yaw[i] = yaw;
  return true;
}

/** A pending round token's answer, for every instance riding it. */
export function rebindAnchors(a: Anchors, n: number, token: number, entity: number): void {
  for (let i = 0; i < n; i++) {
    if (a.ref[i] !== token) continue;
    a.ref[i] = entity;
    // A launch effect rides the round itself, not its shooter's muzzle.
    a.refF[i] = 0;
    a.refU[i] = 0;
  }
}

/** An original angle, rolled at random when negative (`cact_effect_range_roll`). */
export function roll(v: number): number {
  const a = v < 0 ? Math.floor(Math.random() * -v) : v;
  return (a * 2 * Math.PI) / TURN;
}

/** A roll over [lo, hi), the way the 94 emitter rolls its ranges. */
export function rollRange(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

/** The original's blends, as the hardware path reads blend byte 2 and 3. */
export function additive(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  return material;
}

/** dst - src, floored at 0 (blend byte 3, software mode 7). */
export function subtractive(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.ReverseSubtractEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  return material;
}

/** 50/50 with the frame buffer (the half-alpha op bit with blend byte 1). */
export function halfAlpha(material: THREE.ShaderMaterial): THREE.ShaderMaterial {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.NormalBlending;
  return material;
}

/**
 * The last line of every effect fragment shader. The drawers compute in the
 * original's own colour values (texels and record bytes as the hardware took
 * them, on an sRGB screen); this hands three linear light, so a frame drawn
 * straight to the canvas shows those values unchanged, and one drawn through
 * the bloom composer (render/post.ts) gets them back from its output pass, as
 * every sRGB texture of the arena does. The atlases are loaded raw
 * (NoColorSpace) for the same reason.
 */
export const FX_OUTPUT = "gl_FragColor = linearToOutputTexel(sRGBTransferEOTF(gl_FragColor));";

/** Common InstancedMesh setup: no culling, no auto matrices, drawn after units. */
export function prepareMesh<T extends THREE.Object3D>(mesh: T, scene: THREE.Scene): T {
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 10;
  mesh.updateMatrix();
  scene.add(mesh);
  return mesh;
}
