// Type 90's flag 0x10: a skeleton broken up bone by bone (`shatter.c`: the
// creator 0x004298c0, the builder 0x00429a40, the tick 0x00429f40, the landing
// 0x0042a030; the draw `cact_model_submit_pieces` 0x004292c0 through
// `cact_model_piece_place` 0x00429510). In Precinct Assault the one record
// with the flag is 1:8, chained from 1:9 on the wrecked X1's partner — so the
// cockpit's skeleton is what breaks (player_op4 0x00447610).
//
// - **The pieces.** One per `3DHY` record, the bone frozen at the frame the
//   model had (the block's frame is copied once and never stepped). The
//   handler made the actor's 3x3 the identity first (0x004385b3), so the
//   pieces fly in the arena's axes, whatever way the X1 faced. Each piece's
//   direction is its bone's place in the model, through the roll 0x00437b20:
//   the magnitude in [hi, 2 hi - lo) along it, y made non-negative, the drift,
//   y zeroed with 0x04 — all `>> 4` into model units per 256 ticks. Its
//   gravity is the roll's scale `>> 4`, `trunc(fall_scale * raw / -100)`; its
//   two spins are one draw in [spin_lo, spin_hi), `>> 4`, its low byte signed.
// - **The tick.** `vel.y += delta * gravity >> 8`, then `pos += vel * delta >>
//   8` and both angles `+= spin * delta >> 6` (4096 a turn). A piece is caught
//   when its pos.y is below the floor — the frame after the one that took it
//   there — and stops. The floor is `(ground - y) >> 3` at the model's place:
//   eighths of a world unit against a position in sixteenths, so a piece sinks
//   twice the height the model stood above the ground before it is caught.
// - **The draw.** A vertex goes through its bone, then the piece's turn
//   (`Mx(angle_x) My(angle_y)`, about the MODEL's origin, not the bone's), then
//   the piece's offset. Only a face wholly inside its first corner's bone is
//   drawn at all, and when a piece lands every face not wholly inside that
//   piece's bone is dropped: the first piece down is all that is left drawn,
//   the second leaves nothing, and the actor dies with the last.
//
// Not drawn (Metropolis'): the killer's push (as the faces', render/fx/shatter.ts),
// and a quad tested whole — Metropolis' meshes are triangles, so each half is
// tested on its own. The rolls are the client's stream, not `game_rand` (A18).
// Fixed pools; nothing allocates once a match runs.

import * as THREE from "three";
import type { RaiseAt } from "../../effects/chain";
import { type Fx90, SHATTER_FLAT_Y, TURN, WORLD_UNITS_PER_METRE } from "../../effects/records";
import { TEAM_UV_ATTR, TEAM_UV_MASK } from "../teamUv";
import { prepareMesh } from "./common";

/** `CACT_MODEL_PIECES`: the 0xf0-byte array, twelve pieces. */
export const SKELETON_PIECES = 12;
/** Skeletons in flight at once (one per X1 is plenty). */
const SKELETONS = 4;
/** Triangles a skeleton can carry (the X1's cockpit has 126 drawable). */
const SKELETON_TRIS = 256;
/** Vertex units (int16 model coordinates, 1/512 m) per metre: obj_mesh.FIXED_POINT. */
const MODEL_UNITS_PER_METRE = 512;
/** `CACT_SHATTER_FLOOR_SHIFT`: the floor is world units `>> 3`. */
const FLOOR_SHIFT = 8;
const TO_RAD = (2 * Math.PI) / TURN;

/**
 * The skeleton a dying raiser hands the shatter, filled by the caller
 * (main.ts, from render/avatarRig.ts): its bind-pose geometry with a matrix
 * slot per vertex, the bones of the skeleton as matrices at the frame it died
 * in, and where its model's origin stands.
 */
export interface ShatterSkeleton {
  geometry: THREE.BufferGeometry;
  /** The per-vertex slot attribute (render/avatarRig.ts X1_BONE_ATTR). */
  slotAttr: string;
  /** A material that draws the geometry where it is put (no pose of its own). */
  material: THREE.Material;
  /** The side's texture offset, atlas units (render/teamUv.ts). */
  teamU: number;
  teamV: number;
  /** The skeleton's `3DHY` records are slots first .. first + bones - 1, in order. */
  first: number;
  bones: number;
  /**
   * Bone n's 3x4 at the frame, twelve floats, its three rows (x, y, z, w):
   * the glb's frame (x mirrored from the model's), metres.
   */
  readonly matrices: Float32Array;
  /** Where the model's origin stands: three's frame, metres. */
  x: number;
  y: number;
  z: number;
}

/** Fills `out` for the raiser `at` names; false when it has no skeleton. */
export type ShatterSkeletonSource = (at: Readonly<RaiseAt>, out: ShatterSkeleton) => boolean;

export function makeShatterSkeleton(): ShatterSkeleton {
  return {
    geometry: new THREE.BufferGeometry(),
    slotAttr: "",
    material: new THREE.MeshBasicMaterial(),
    teamU: 0,
    teamV: 0,
    first: 0,
    bones: 0,
    matrices: new Float32Array(SKELETON_PIECES * 12),
    x: 0,
    y: 0,
    z: 0,
  };
}

/** A uniform draw in [lo, hi), or `hi` when the range is empty (the roll's idiom). */
function draw(lo: number, hi: number): number {
  return hi > lo ? lo + Math.floor(Math.random() * (hi - lo)) : hi;
}

/** The spin byte 0x00429cf8 keeps of a pair draw: `>> 4`, its low byte, signed. */
export function skeletonSpin(pair: number): number {
  return (((pair << 16) >> 20) << 24) >> 24;
}

/** The piece's gravity, the roll's scale `>> 4`: `trunc(fall_scale * raw / -100)`. */
export function skeletonGravity(fallScale: number, rand: number): number {
  return ((fallScale * ((rand & 0x1f) * 8 + 0x500)) / -100) | 0;
}

/** The floor (0x00429e1e): the ground under the model less its height, world units `>> 3`. */
export function skeletonFloor(ground: number, y: number): number {
  return Math.floor(((ground - y) * WORLD_UNITS_PER_METRE) / FLOOR_SHIFT);
}

interface Skeleton {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly pos: Float32Array;
  readonly uv: Float32Array;
  readonly normal: Float32Array;
  readonly teamUv: Float32Array;
  readonly teamMask: Float32Array;
  /** Per triangle: its corners through their bone, the model's axes (x the model's own), model units. */
  readonly local: Float32Array;
  /** Per triangle: its piece, and whether it is still drawn (the mask). */
  readonly piece: Int8Array;
  readonly drawn: Uint8Array;
  /** Per piece, the 0x14-byte record: model units, per 256 ticks, 4096 a turn. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly angY: Float32Array;
  readonly angX: Float32Array;
  readonly gravity: Float32Array;
  readonly spin: Float32Array;
  live: boolean;
  tris: number;
  pieces: number;
  left: number;
  floor: number;
  ox: number;
  oy: number;
  oz: number;
}

export class SkeletonShatter {
  private readonly skeletons: Skeleton[] = [];

  constructor(scene: THREE.Scene) {
    for (let s = 0; s < SKELETONS; s++) {
      const n = SKELETON_TRIS * 3;
      const geometry = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      const normal = new Float32Array(n * 3);
      const teamUv = new Float32Array(n * 2);
      const teamMask = new Float32Array(n);
      for (const [name, a, size] of [
        ["position", pos, 3],
        ["uv", uv, 2],
        ["normal", normal, 3],
        [TEAM_UV_ATTR, teamUv, 2],
        [TEAM_UV_MASK, teamMask, 1],
      ] as const) {
        const attr = new THREE.BufferAttribute(a, size);
        attr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, attr);
      }
      geometry.setDrawRange(0, 0);
      const mesh = prepareMesh(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()), scene);
      mesh.visible = false;
      const p = SKELETON_PIECES;
      this.skeletons.push({
        mesh,
        geometry,
        pos,
        uv,
        normal,
        teamUv,
        teamMask,
        local: new Float32Array(SKELETON_TRIS * 9),
        piece: new Int8Array(SKELETON_TRIS),
        drawn: new Uint8Array(SKELETON_TRIS),
        px: new Float32Array(p),
        py: new Float32Array(p),
        pz: new Float32Array(p),
        vx: new Float32Array(p),
        vy: new Float32Array(p),
        vz: new Float32Array(p),
        angY: new Float32Array(p),
        angX: new Float32Array(p),
        gravity: new Float32Array(p),
        spin: new Float32Array(p),
        live: false,
        tris: 0,
        pieces: 0,
        left: 0,
        floor: 0,
        ox: 0,
        oy: 0,
        oz: 0,
      });
    }
  }

  /**
   * The builder 0x00429a40 over `sk`, with the record's roll; `ground` is the
   * terrain under the model, metres. False when every skeleton is in flight.
   */
  spawn(rec: Fx90, sk: Readonly<ShatterSkeleton>, ground: number): boolean {
    let s: Skeleton | undefined;
    for (let i = 0; i < SKELETONS; i++) {
      if (!this.skeletons[i].live) {
        s = this.skeletons[i];
        break;
      }
    }
    if (!s) return false;
    const bones = Math.min(sk.bones, SKELETON_PIECES);
    const m = sk.matrices;
    for (let b = 0; b < bones; b++) {
      s.px[b] = 0;
      s.py[b] = 0;
      s.pz[b] = 0;
      s.angY[b] = 0;
      s.angX[b] = 0;
      // The bone's place in the model is the roll's direction, normalised:
      // the glb's x is the model's mirrored.
      const tx = -m[b * 12 + 3];
      const ty = m[b * 12 + 7];
      const tz = m[b * 12 + 11];
      const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
      // [hi, 2 hi - lo), hi for an empty range: the draw adds hi (0x00437bde).
      const lo = rec.magnitudeLo;
      const hi = rec.magnitudeHi;
      const speed = hi > lo ? hi + Math.floor(Math.random() * (hi - lo)) : hi;
      let vx = len > 0 ? (tx / len) * speed : 0;
      let vy = len > 0 ? Math.abs(ty / len) * speed : 0;
      let vz = len > 0 ? (tz / len) * speed : 0;
      // The drift, in the model's axes (x to the side, z forward): the
      // identity the handler gave the actor. A zero scale adds nothing.
      const drift = draw(rec.driftScaleLo, rec.driftScaleHi);
      if (drift !== 0) {
        const cp = Math.cos(rec.driftAngleX * TO_RAD);
        vx += Math.sin(rec.driftAngleY * TO_RAD) * cp * drift;
        vy += Math.sin(rec.driftAngleX * TO_RAD) * drift;
        vz += Math.cos(rec.driftAngleY * TO_RAD) * cp * drift;
      }
      if ((rec.shatterFlags & SHATTER_FLAT_Y) !== 0) vy = 0;
      s.vx[b] = vx;
      s.vy[b] = vy;
      s.vz[b] = vz;
      s.gravity[b] = skeletonGravity(rec.fallScale, Math.floor(Math.random() * 0x20));
      s.spin[b] = skeletonSpin(draw(rec.spinLo, rec.spinHi));
    }

    // The faces: through their bone at the frame, kept when all three corners
    // are the bone's (the mask's rule, per triangle here).
    const g = sk.geometry;
    const position = g.getAttribute("position") as THREE.BufferAttribute | undefined;
    const slot = g.getAttribute(sk.slotAttr) as THREE.BufferAttribute | undefined;
    if (!position || !slot) return false;
    const index = g.getIndex();
    const uv = g.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const normal = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const mask = g.getAttribute(TEAM_UV_MASK) as THREE.BufferAttribute | undefined;
    const tris = Math.floor((index ? index.count : position.count) / 3);
    let f = 0;
    for (let t = 0; t < tris && f < SKELETON_TRIS; t++) {
      const v0 = index ? index.getX(t * 3) : t * 3;
      const b = Math.round(slot.getX(v0)) - sk.first;
      if (b < 0 || b >= bones) continue;
      let whole = true;
      for (let k = 1; k < 3; k++) {
        const vk = index ? index.getX(t * 3 + k) : t * 3 + k;
        if (Math.round(slot.getX(vk)) - sk.first !== b) whole = false;
      }
      if (!whole) continue;
      const o = b * 12;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        const x = position.getX(vi);
        const y = position.getY(vi);
        const z = position.getZ(vi);
        const qx = m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 3];
        const qy = m[o + 4] * x + m[o + 5] * y + m[o + 6] * z + m[o + 7];
        const qz = m[o + 8] * x + m[o + 9] * y + m[o + 10] * z + m[o + 11];
        // The model's own axes (x unmirrored), in model units.
        s.local[f * 9 + k * 3] = -qx * MODEL_UNITS_PER_METRE;
        s.local[f * 9 + k * 3 + 1] = qy * MODEL_UNITS_PER_METRE;
        s.local[f * 9 + k * 3 + 2] = qz * MODEL_UNITS_PER_METRE;
        const c3 = (f * 3 + k) * 3;
        const c2 = (f * 3 + k) * 2;
        s.uv[c2] = uv ? uv.getX(vi) : 0;
        s.uv[c2 + 1] = uv ? uv.getY(vi) : 0;
        // The bind normal in three's frame for the identity: (z, y, -x).
        const nx = normal ? normal.getX(vi) : 0;
        const ny = normal ? normal.getY(vi) : 1;
        const nz = normal ? normal.getZ(vi) : 0;
        s.normal[c3] = nz;
        s.normal[c3 + 1] = ny;
        s.normal[c3 + 2] = -nx;
        s.teamMask[f * 3 + k] = mask ? mask.getX(vi) : 1;
        s.teamUv[c2] = sk.teamU;
        s.teamUv[c2 + 1] = sk.teamV;
      }
      s.piece[f] = b;
      s.drawn[f] = 1;
      f++;
    }
    s.live = true;
    s.tris = f;
    s.pieces = bones;
    s.left = bones;
    s.floor = skeletonFloor(ground, sk.y);
    s.ox = sk.x;
    s.oy = sk.y;
    s.oz = sk.z;
    s.mesh.material = sk.material;
    s.mesh.visible = true;
    s.geometry.setDrawRange(0, f * 3);
    (s.geometry.getAttribute("uv") as THREE.BufferAttribute).needsUpdate = true;
    (s.geometry.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
    (s.geometry.getAttribute(TEAM_UV_ATTR) as THREE.BufferAttribute).needsUpdate = true;
    (s.geometry.getAttribute(TEAM_UV_MASK) as THREE.BufferAttribute).needsUpdate = true;
    this.place(s);
    return true;
  }

  reset(): void {
    for (let i = 0; i < SKELETONS; i++) this.retire(this.skeletons[i]);
  }

  /** Skeletons in flight (tests). */
  live(): number {
    let n = 0;
    for (let i = 0; i < SKELETONS; i++) if (this.skeletons[i].live) n++;
    return n;
  }

  /** Triangles still drawn across every skeleton (tests). */
  drawn(): number {
    let n = 0;
    for (let i = 0; i < SKELETONS; i++) {
      const s = this.skeletons[i];
      if (!s.live) continue;
      for (let f = 0; f < s.tris; f++) n += s.drawn[f];
    }
    return n;
  }

  /** Pieces still flying in skeleton `i` (tests): `pieces_left`. */
  left(i: number): number {
    return this.skeletons[i]?.left ?? 0;
  }

  /** The tick 0x00429f40 for `dtTicks` engine ticks, then the draw. */
  update(dtTicks: number): void {
    for (let i = 0; i < SKELETONS; i++) {
      const s = this.skeletons[i];
      if (!s.live) continue;
      for (let b = 0; b < s.pieces; b++) {
        if (s.gravity[b] === 0) continue;
        if (s.py[b] < s.floor) {
          // 0x00429f7a..0x00429f94: landed, and the mask cut to its bone.
          s.gravity[b] = 0;
          s.left--;
          for (let f = 0; f < s.tris; f++) if (s.piece[f] !== b) s.drawn[f] = 0;
          continue;
        }
        s.vy[b] += (dtTicks * s.gravity[b]) / 256;
        s.px[b] += (s.vx[b] * dtTicks) / 256;
        s.py[b] += (s.vy[b] * dtTicks) / 256;
        s.pz[b] += (s.vz[b] * dtTicks) / 256;
        s.angX[b] += (s.spin[b] * dtTicks) / 64;
        s.angY[b] += (s.spin[b] * dtTicks) / 64;
      }
      if (s.left <= 0) {
        this.retire(s);
        continue;
      }
      this.place(s);
    }
  }

  /** `cact_model_piece_place` per face corner: bone, then the piece's turn and offset. */
  private place(s: Skeleton): void {
    for (let f = 0; f < s.tris; f++) {
      const o = f * 9;
      if (s.drawn[f] === 0) {
        for (let k = 0; k < 9; k++) s.pos[o + k] = 0;
        continue;
      }
      const b = s.piece[f];
      const ax = s.angX[b] * TO_RAD;
      const ay = s.angY[b] * TO_RAD;
      const cx = Math.cos(ax);
      const sx = Math.sin(ax);
      const cy = Math.cos(ay);
      const sy = Math.sin(ay);
      for (let k = 0; k < 3; k++) {
        const lx = s.local[o + k * 3];
        const ly = s.local[o + k * 3 + 1];
        const lz = s.local[o + k * 3 + 2];
        // Row vectors: Mx(angle_x), then My(angle_y) (math_matrix_from_angles_b).
        const y1 = ly * cx - lz * sx;
        const z1 = ly * sx + lz * cx;
        const x2 = lx * cy + z1 * sy;
        const z2 = -lx * sy + z1 * cy;
        const gx = x2 + s.px[b];
        const gy = y1 + s.py[b];
        const gz = z2 + s.pz[b];
        // The model's (x, z) is the sim's (y, x): three's (z, x).
        s.pos[o + k * 3] = s.ox + gz / MODEL_UNITS_PER_METRE;
        s.pos[o + k * 3 + 1] = s.oy + gy / MODEL_UNITS_PER_METRE;
        s.pos[o + k * 3 + 2] = s.oz + gx / MODEL_UNITS_PER_METRE;
      }
    }
    (s.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  private retire(s: Skeleton): void {
    s.live = false;
    s.tris = 0;
    s.geometry.setDrawRange(0, 0);
    s.mesh.visible = false;
  }
}
