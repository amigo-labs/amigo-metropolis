// Type 90: the raiser's model broken into flying faces, or flown whole
// (`effect_type90.c`: the factory 0x004383b0, the handler 0x004384c0, the
// filler 0x004388a0, the whole-object init 0x00438610; `effect_type90_tick.c`:
// the steps 0x00437d00 / 0x00437e30, the reapers 0x00438010 / 0x00437f80; the
// roll 0x00437b20). The rules are tables.json type_rules.90:
//
// - **Faces** (neither 0x08 nor 0x10, or 0x10 on a model that is no skeleton):
//   up to `count` distinct primitives of the model (0 all, outside 0..50
//   fifty), cut to what the 200-record pool has left, each leaving from the
//   model's place at its centre (the four-corner mean, a triangle's corner 0
//   twice) with `magnitude` (drawn in [hi, 2 hi - lo), hi when hi <= lo) along
//   origin -> centre, y made non-negative, plus `drift` (drawn in [lo, hi))
//   along (drift_angle_y, drift_angle_x), y zeroed with 0x04; all x16 world
//   units a SECOND (the step's 218 = 65536 / 300). Each face falls by its own
//   `((rand & 0x1f) * 8 + 0x500) * scale / -100 << 4` world units a second
//   squared (added before the move), turns by two spins drawn in [spin_lo,
//   spin_hi) (`angle += (spin * delta) >> 8`, 4096 a turn), and lives the
//   instance's lifetime + (rand & 0xff) ticks, or without one until the ground:
//   one face in eight a frame asks the terrain. A given-back face starts the
//   reap effect (+0x34) at its point, its corner-0 length the scale, when the
//   pool's count after the release has bit 1 set — about half of them — and
//   the first `peered_faces` faces (0xff all) carry the reference effect
//   (+0x35), riding them.
// - **Whole** (0x08): the model flies as one: the drift (turned by the
//   raiser's frame with header flags 0x104), the fall, two spins, the lifetime
//   or none; when it lands the reap effect starts at the instance's reference
//   (where it was raised). Its reference effect rides it.
//
// - **Skeleton** (0x10, 0x08 clear, on a raiser with a skeleton): the bones
//   fly as pieces (render/fx/skeletonShatter.ts, `shatter.c` 0x004298c0) —
//   the wrecked X1's cockpit. A raiser without one has its faces fly.
//
// Drawn with the dying unit's own mesh and material (main.ts hands the greybox
// bucket's) and its side's texture offset (0x004381e8). Metropolis' meshes are
// triangles, so a quad of the original flies as its two triangles. The killer's
// push (`mission_record_spawn_push` 0x00437aa0) since EV_KILL_PUSH: a death by
// a missile-class round's contact hands its record the round's heading times
// its damage word (RaiseAt.push*, x16 wu/s), added to every face's roll. Not
// drawn: the fragmented arena's halving. The rolls draw from the client's stream, not `game_rand`
// (fcop-fidelity.md E7, A18). One mesh per archetype, preallocated; nothing
// allocates once a match runs.
//
// A face keeps its lighting inputs (`_FCOP_LIGHT`, render/fcopModel.ts), which
// the unit's lit materials shade it by, and its normal turned by the unit's
// yaw at the raise: the shade a face had when it left the model. Not read:
// whether the original turns a flying face's normals by its spins.

import { MAX_ENTITIES } from "@metropolis/sim";
import * as THREE from "three";
import { makeRaiseAt, type RaiseAt } from "../../effects/chain";
import {
  directionOf,
  FXF_IN_FRAME,
  FXF_LOCAL_SPACE,
  FXF_NO_PUSH,
  FXF_PUSH_REVERSED,
  type Fx90,
  SHATTER_FLAT_Y,
  SHATTER_SKELETON,
  SHATTER_WHOLE,
  TURN,
  WORLD_UNITS_PER_METRE,
} from "../../effects/records";
import { LIGHT_ATTRIBUTE } from "../fcopModel";
import { TEAM_UV_ATTR, TEAM_UV_MASK } from "../teamUv";
import { type FxPoses, POSE_STRIDE, prepareMesh } from "./common";
import {
  makeShatterSkeleton,
  type ShatterSkeletonSource,
  SkeletonShatter,
} from "./skeletonShatter";

/**
 * The model a dying archetype of `team` is drawn with: main.ts hands the
 * greybox bucket's, and the texture offset that team's instances carry (atlas
 * units, render/teamUv.ts), so a face keeps its side's texels.
 */
export type ShatterSource = (
  archetype: number,
  team: number,
) => {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  teamU: number;
  teamV: number;
} | null;

/** Raises an effect for the shatter (the reap and the reference effects): the chain's. */
export type ShatterRaise = (bank: number, id: number, at: Readonly<RaiseAt>) => void;

/** `count` outside 0..50 is fifty (0x004388a0). */
const FACES_MAX = 50;
/** The mission's record pool every type-90 face comes from (`mission_record_pool_create`). */
const RECORD_POOL = 200;
/** Triangles in flight per archetype at once: faces plus whole objects. */
const TRIS_PER_KIND = 512;
const KINDS = 9;
/** A model's triangles the pick can walk (the scratch is preallocated). */
const PICK_MAX = 16384;
/** Whole objects and shatter instances in flight at once. */
const INSTANCES = 64;
/**
 * Pseudo-entity references a face or a whole object carries for the effect it
 * rides, after the sim's ids in the pose table (createFxPoses), handed out in
 * turn so a slot is not reused while anything plausibly still rides it.
 */
export const FACE_REFS = 1024;
/** The first reference slot. */
export const FACE_REF_BASE = MAX_ENTITIES;
/** `peered_faces` 0xff: every face. */
const PEER_ALL = 0xff;
/** Reaped pieces waiting for the end of the update. */
const PENDING_MAX = 64;
/** Metres per x16 unit, and per world unit. */
const X16_M = 16 / WORLD_UNITS_PER_METRE;
const WU_M = 1 / WORLD_UNITS_PER_METRE;
/** 4096 a turn, per 256 engine ticks: radians a second per spin unit. */
const SPIN_RAD_S = ((2 * Math.PI) / TURN) * (300 / 256);
const TO_RAD = (2 * Math.PI) / TURN;
/** The ground test's floor when no terrain sampler is set (tests). */
const NO_GROUND = -100;
/** `_FCOP_LIGHT` for a face that has none: material 0, grey 0x80 (unity). */
const UNLIT: readonly number[] = [0, 0x80, 0x80, 0x80];

interface Kind {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly pos: Float32Array;
  readonly uv: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  /**
   * Per vertex: the face's `_FCOP_LIGHT` (render/fcopModel.ts), which a lit
   * unit material shades by; material 0 at 0x80 (unity) where the model has none.
   */
  readonly light: Float32Array;
  /** Per vertex: the team's texture offset times the model's mask (render/teamUv.ts). */
  readonly teamUv: Float32Array;
  readonly teamMask: Float32Array;
  /** Per triangle: its three corners about its centre, world-aligned at the raise. */
  readonly local: Float32Array;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly cz: Float32Array;
  /** Metres a second. */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** The fall, metres a second squared (negative). */
  readonly fall: Float32Array;
  /** The two angles (radians) and their spins (radians a second). */
  readonly angY: Float32Array;
  readonly angX: Float32Array;
  readonly spinY: Float32Array;
  readonly spinX: Float32Array;
  /** Engine ticks left; +Infinity without a lifetime. */
  readonly timer: Float32Array;
  /** The instance it belongs to (`inst*`), and its reference slot (-1 none). */
  readonly inst: Int16Array;
  readonly ref: Int16Array;
  /** Its corner-0 length, x16: the reap's scale. */
  readonly scale: Float32Array;
  /** 1 for a triangle of a whole object (its group's state), 0 a face of the pool. */
  readonly whole: Uint8Array;
  /** Its place in the ground test's eight-frame round (stable as faces are swapped out). */
  readonly seq: Uint8Array;
  count: number;
}

const rot = new THREE.Matrix3();
const v = new THREE.Vector3();
const dir = new Float32Array(3);
const raiseAt = makeRaiseAt();

/** A uniform draw in [lo, hi), or `hi` when the range is empty (the roll's idiom). */
function draw(lo: number, hi: number): number {
  return hi > lo ? lo + Math.floor(Math.random() * (hi - lo)) : hi;
}

/** The fall a face draws (the roll 0x00437b7b..0x00437bb0), world units a second squared. */
export function shatterFall(scale: number, rand: number): number {
  const raw = (rand & 0x1f) * 8 + 0x500;
  return Math.trunc((scale * raw) / -100) * 16 + 0;
}

/** The magnitude draw (0x00437bde): [hi, 2 hi - lo), hi when hi <= lo. */
export function shatterMagnitude(lo: number, hi: number, fraction: number): number {
  if (hi <= lo) return hi;
  return hi + Math.floor(fraction * (hi - lo));
}

/** How many faces a record breaks a model of `prims` into, with `left` records in the pool. */
export function shatterFaceCount(count: number, prims: number, left: number): number {
  let n = prims;
  const cap = count < 0 || count > FACES_MAX ? FACES_MAX : count;
  if (cap > 0 && cap < n) n = cap;
  return n < left ? n : left;
}

export class Shatter {
  private readonly kinds: Kind[] = [];
  /** Where the dying models come from (main.ts); null draws nothing. */
  source: ShatterSource | null = null;
  /** A dying raiser's skeleton for flag 0x10 (main.ts); null flies faces instead. */
  skeleton: ShatterSkeletonSource | null = null;
  private readonly bones: SkeletonShatter;
  private readonly sk = makeShatterSkeleton();
  /** The chain's raise, for the reap and reference effects; null raises none. */
  raise: ShatterRaise | null = null;
  /** The terrain under (x, z), metres: the faces' ground test. */
  groundAt: ((x: number, z: number) => number) | null = null;
  /** DAT_0050e8d8: the faces out of the record pool. */
  private out = 0;
  private frames = 0;
  private nextRef = 0;
  private seq = 0;
  private readonly pick = new Int32Array(PICK_MAX);
  // --- instances: the reap's bank and id, the reference, whole objects' state ---
  private readonly instLive = new Uint8Array(INSTANCES);
  private readonly instBank = new Uint8Array(INSTANCES);
  private readonly instReap = new Uint16Array(INSTANCES);
  private readonly instX = new Float32Array(INSTANCES);
  private readonly instY = new Float32Array(INSTANCES);
  private readonly instZ = new Float32Array(INSTANCES);
  /** Triangles left per instance. */
  private readonly instTris = new Int32Array(INSTANCES);
  /** A whole object's: landed this frame (1), and its reference slot. */
  private readonly instLanded = new Uint8Array(INSTANCES);
  private readonly instRef = new Int16Array(INSTANCES);
  private readonly instWhole = new Uint8Array(INSTANCES);
  // --- reaps waiting for the end of the update ---
  private pending = 0;
  private readonly pendBank = new Uint8Array(PENDING_MAX);
  private readonly pendId = new Uint16Array(PENDING_MAX);
  private readonly pendX = new Float32Array(PENDING_MAX);
  private readonly pendY = new Float32Array(PENDING_MAX);
  private readonly pendZ = new Float32Array(PENDING_MAX);
  private readonly pendScale = new Float32Array(PENDING_MAX);
  private poses: FxPoses | null = null;

  constructor(scene: THREE.Scene) {
    this.bones = new SkeletonShatter(scene);
    for (let k = 0; k < KINDS; k++) {
      const n = TRIS_PER_KIND * 3;
      const geometry = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      const normal = new Float32Array(n * 3);
      const colour = new Float32Array(n * 3).fill(1);
      const light = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) light.set(UNLIT, i * 4);
      const teamUv = new Float32Array(n * 2);
      const teamMask = new Float32Array(n);
      for (const [name, a, size] of [
        ["position", pos, 3],
        ["uv", uv, 2],
        ["normal", normal, 3],
        ["color", colour, 3],
        [LIGHT_ATTRIBUTE, light, 4],
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
      const f = TRIS_PER_KIND;
      this.kinds.push({
        mesh,
        geometry,
        pos,
        uv,
        normal,
        colour,
        light,
        teamUv,
        teamMask,
        local: new Float32Array(f * 9),
        cx: new Float32Array(f),
        cy: new Float32Array(f),
        cz: new Float32Array(f),
        vx: new Float32Array(f),
        vy: new Float32Array(f),
        vz: new Float32Array(f),
        fall: new Float32Array(f),
        angY: new Float32Array(f),
        angX: new Float32Array(f),
        spinY: new Float32Array(f),
        spinX: new Float32Array(f),
        timer: new Float32Array(f),
        inst: new Int16Array(f),
        ref: new Int16Array(f),
        scale: new Float32Array(f),
        whole: new Uint8Array(f),
        seq: new Uint8Array(f),
        count: 0,
      });
    }
  }

  /** The pose table the reference slots are published in (fx.ts's). */
  setPoses(poses: FxPoses | null): void {
    this.poses = poses;
  }

  /**
   * The filler 0x004388a0, the whole-object init 0x00438610, or the skeleton
   * shatter 0x004298c0 (bit 3 is tested first, 0x004384c0). False with no model.
   */
  spawn(rec: Fx90, at: Readonly<RaiseAt>, bank: number): boolean {
    if (
      (rec.shatterFlags & (SHATTER_WHOLE | SHATTER_SKELETON)) === SHATTER_SKELETON &&
      this.skeleton?.(at, this.sk)
    ) {
      const sk = this.sk;
      return this.bones.spawn(rec, sk, this.groundAt ? this.groundAt(sk.x, sk.z) : NO_GROUND);
    }
    const kind = at.archetype >= 0 ? this.kinds[at.archetype] : undefined;
    const src = kind && this.source ? this.source(at.archetype, at.team) : null;
    if (!kind || !src) return false;
    const g = src.geometry;
    const position = g.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position) return false;
    const index = g.getIndex();
    const tris = Math.floor((index ? index.count : position.count) / 3);
    if (tris === 0) return false;
    const whole = (rec.shatterFlags & SHATTER_WHOLE) !== 0;
    const n = whole
      ? Math.min(tris, TRIS_PER_KIND - kind.count)
      : shatterFaceCount(rec.count, tris, RECORD_POOL - this.out);
    if (n <= 0) return false;
    const inst = this.freeInstance();
    if (inst < 0) return false;
    kind.mesh.material = src.material;
    kind.mesh.visible = true;
    const originY = Number.isFinite(at.modelY) ? at.modelY : at.y;
    this.instLive[inst] = 1;
    this.instBank[inst] = bank;
    this.instReap[inst] = rec.reapEffect;
    this.instX[inst] = at.x;
    this.instY[inst] = at.y;
    this.instZ[inst] = at.z;
    this.instTris[inst] = 0;
    this.instLanded[inst] = 0;
    this.instWhole[inst] = whole ? 1 : 0;
    this.instRef[inst] = -1;
    const life = rec.life > 0 ? rec.life : Number.POSITIVE_INFINITY;

    // The whole object's one state: the drift (the raiser's frame with 0x104),
    // the fall, the spins, the timer.
    let wvx = 0;
    let wvy = 0;
    let wvz = 0;
    if (whole) {
      const inFrame = (rec.flags & (FXF_IN_FRAME | FXF_LOCAL_SPACE)) !== 0;
      directionOf(rec.driftAngleY * TO_RAD, rec.driftAngleX * TO_RAD, inFrame ? at.yaw : 0, dir);
      const drift = draw(rec.driftScaleLo, rec.driftScaleHi) * X16_M;
      wvx = dir[0] * drift;
      wvy = dir[1] * drift;
      wvz = dir[2] * drift;
      if ((rec.shatterFlags & SHATTER_FLAT_Y) !== 0) wvy = 0;
      this.instRef[inst] = this.takeRef(at.x, originY, at.z);
    }
    // The killer's push (0x00437aa0): header bit 9 refuses it, bit 10 reverses
    // it (0x00437ab9, 0x00437ac2). The whole object's init takes none.
    const pushSign =
      (rec.flags & FXF_NO_PUSH) !== 0 ? 0 : (rec.flags & FXF_PUSH_REVERSED) !== 0 ? -X16_M : X16_M;
    const pushX = at.pushX * pushSign;
    const pushY = at.pushY * pushSign;
    const pushZ = at.pushZ * pushSign;
    const wFall = shatterFall(rec.fallScale, Math.floor(Math.random() * 0x20)) * WU_M;
    const wSpinY = draw(rec.spinLo, rec.spinHi) * SPIN_RAD_S;
    const wSpinX = draw(rec.spinLo, rec.spinHi) * SPIN_RAD_S;

    // n distinct triangles (a partial shuffle), or every one for a whole object.
    const pickable = tris < PICK_MAX ? tris : PICK_MAX;
    for (let t = 0; t < pickable; t++) this.pick[t] = t;
    const c = Math.cos(-at.yaw);
    const s = Math.sin(-at.yaw);
    const uv = g.getAttribute("uv") as THREE.BufferAttribute | undefined;
    const normal = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const colour = g.getAttribute("color") as THREE.BufferAttribute | undefined;
    const light = g.getAttribute(LIGHT_ATTRIBUTE) as THREE.BufferAttribute | undefined;
    const mask = g.getAttribute(TEAM_UV_MASK) as THREE.BufferAttribute | undefined;
    const peers = rec.peeredFaces === PEER_ALL ? n : rec.peeredFaces;
    for (let m = 0; m < n; m++) {
      const f = kind.count;
      if (f >= TRIS_PER_KIND) break;
      let t = m;
      if (!whole) {
        const r = m + Math.floor(Math.random() * (pickable - m));
        t = this.pick[r];
        this.pick[r] = this.pick[m];
        this.pick[m] = t;
      }
      kind.count++;
      this.instTris[inst]++;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
        // The model's frame (+X forward) turned by the raiser's yaw, as the
        // instance matrix main.ts writes turns it.
        const lx = position.getX(vi);
        const ly = position.getY(vi);
        const lz = position.getZ(vi);
        const wx = lx * c + lz * s;
        const wz = -lx * s + lz * c;
        kind.local[f * 9 + k * 3] = wx;
        kind.local[f * 9 + k * 3 + 1] = ly;
        kind.local[f * 9 + k * 3 + 2] = wz;
        // The four-corner mean: a triangle weighs corner 0 twice.
        const w = k === 0 ? 0.5 : 0.25;
        mx += wx * w;
        my += ly * w;
        mz += wz * w;
        const o = (f * 3 + k) * 3;
        const o2 = (f * 3 + k) * 2;
        kind.uv[o2] = uv ? uv.getX(vi) : 0;
        kind.uv[o2 + 1] = uv ? uv.getY(vi) : 0;
        // The normal turned with the face (the lit materials shade by it).
        const nx = normal ? normal.getX(vi) : 0;
        const nz = normal ? normal.getZ(vi) : 0;
        kind.normal[o] = nx * c + nz * s;
        kind.normal[o + 1] = normal ? normal.getY(vi) : 1;
        kind.normal[o + 2] = -nx * s + nz * c;
        const l4 = (f * 3 + k) * 4;
        if (light) {
          kind.light[l4] = light.getX(vi);
          kind.light[l4 + 1] = light.getY(vi);
          kind.light[l4 + 2] = light.getZ(vi);
          kind.light[l4 + 3] = light.getW(vi);
        } else kind.light.set(UNLIT, l4);
        kind.colour[o] = colour ? colour.getX(vi) : 1;
        kind.colour[o + 1] = colour ? colour.getY(vi) : 1;
        kind.colour[o + 2] = colour ? colour.getZ(vi) : 1;
        kind.teamMask[f * 3 + k] = mask ? mask.getX(vi) : 1;
        kind.teamUv[o2] = src.teamU;
        kind.teamUv[o2 + 1] = src.teamV;
      }
      kind.inst[f] = inst;
      kind.whole[f] = whole ? 1 : 0;
      kind.seq[f] = this.seq++ & 7;
      if (whole) {
        // One rigid body about the model's origin: every triangle the same state.
        kind.cx[f] = at.x;
        kind.cy[f] = originY;
        kind.cz[f] = at.z;
        kind.vx[f] = wvx;
        kind.vy[f] = wvy;
        kind.vz[f] = wvz;
        kind.fall[f] = wFall;
        kind.spinY[f] = wSpinY;
        kind.spinX[f] = wSpinX;
        kind.ref[f] = -1;
        kind.scale[f] = 0;
      } else {
        for (let k = 0; k < 3; k++) {
          kind.local[f * 9 + k * 3] -= mx;
          kind.local[f * 9 + k * 3 + 1] -= my;
          kind.local[f * 9 + k * 3 + 2] -= mz;
        }
        kind.cx[f] = at.x + mx;
        kind.cy[f] = originY + my;
        kind.cz[f] = at.z + mz;
        // The roll: the magnitude along origin -> centre, y made non-negative,
        // then the drift, then y zeroed with flag 0x04.
        const len = Math.sqrt(mx * mx + my * my + mz * mz);
        const speed = shatterMagnitude(rec.magnitudeLo, rec.magnitudeHi, Math.random()) * X16_M;
        let vx = len > 0 ? (mx / len) * speed : 0;
        let vy = len > 0 ? Math.abs(my / len) * speed : 0;
        let vz = len > 0 ? (mz / len) * speed : 0;
        directionOf(rec.driftAngleY * TO_RAD, rec.driftAngleX * TO_RAD, 0, dir);
        const drift = draw(rec.driftScaleLo, rec.driftScaleHi) * X16_M;
        vx += dir[0] * drift;
        vy += dir[1] * drift;
        vz += dir[2] * drift;
        // The killer's push, after the drift and before y is zeroed (the roll's
        // `add_offset`, 0x00437c8d..0x00437c9f).
        vx += pushX;
        vy += pushY;
        vz += pushZ;
        if ((rec.shatterFlags & SHATTER_FLAT_Y) !== 0) vy = 0;
        kind.vx[f] = vx;
        kind.vy[f] = vy;
        kind.vz[f] = vz;
        kind.fall[f] = shatterFall(rec.fallScale, Math.floor(Math.random() * 0x20)) * WU_M;
        kind.spinY[f] = draw(rec.spinLo, rec.spinHi) * SPIN_RAD_S;
        kind.spinX[f] = draw(rec.spinLo, rec.spinHi) * SPIN_RAD_S;
        const l0x = kind.local[f * 9];
        const l0y = kind.local[f * 9 + 1];
        const l0z = kind.local[f * 9 + 2];
        kind.scale[f] = Math.sqrt(l0x * l0x + l0y * l0y + l0z * l0z) / X16_M;
        kind.ref[f] = m < peers ? this.takeRef(kind.cx[f], kind.cy[f], kind.cz[f]) : -1;
        this.out++;
      }
      kind.angY[f] = 0;
      kind.angX[f] = 0;
      kind.timer[f] =
        Number.isFinite(life) && !whole ? life + Math.floor(Math.random() * 256) : life;
      if (kind.ref[f] >= 0) this.raiseOn(bank, rec.effectOnReference, kind.ref[f], f, kind);
    }
    if (whole && this.instRef[inst] >= 0) {
      this.raiseOnPoint(bank, rec.effectOnReference, this.instRef[inst], at.x, originY, at.z);
    }
    if (this.instTris[inst] === 0) this.instLive[inst] = 0;
    return true;
  }

  reset(): void {
    this.bones.reset();
    for (let k = 0; k < this.kinds.length; k++) {
      const kind = this.kinds[k];
      for (let f = 0; f < kind.count; f++) this.dropRef(kind.ref[f]);
      kind.count = 0;
      kind.geometry.setDrawRange(0, 0);
      kind.mesh.visible = false;
    }
    for (let i = 0; i < INSTANCES; i++) {
      if (this.instLive[i] !== 0) this.dropRef(this.instRef[i]);
      this.instLive[i] = 0;
    }
    this.out = 0;
    this.pending = 0;
  }

  /** Triangles in flight (tests). */
  faces(): number {
    let n = 0;
    for (let k = 0; k < this.kinds.length; k++) n += this.kinds[k].count;
    return n;
  }

  /** Faces out of the record pool (tests). */
  poolOut(): number {
    return this.out;
  }

  /** The skeleton shatter's pieces (tests). */
  get skeletons(): SkeletonShatter {
    return this.bones;
  }

  /** The steps 0x00437e30 / 0x00437d00 for `dtTicks` engine ticks, the reapers, the draw. */
  update(dtTicks: number): void {
    const dt = dtTicks / 300;
    this.frames++;
    this.bones.update(dtTicks);
    for (let k = 0; k < this.kinds.length; k++) {
      const kind = this.kinds[k];
      if (kind.count === 0) continue;
      let f = 0;
      while (f < kind.count) {
        // The fall into the velocity, then the move, then the spins.
        kind.vy[f] += kind.fall[f] * dt;
        kind.cx[f] += kind.vx[f] * dt;
        kind.cy[f] += kind.vy[f] * dt;
        kind.cz[f] += kind.vz[f] * dt;
        kind.angY[f] += kind.spinY[f] * dt;
        kind.angX[f] += kind.spinX[f] * dt;
        if (kind.timer[f] > 0) {
          kind.timer[f] -= dtTicks;
          if (kind.timer[f] <= 0) kind.timer[f] = -1;
        }
        // The ground: a whole object every frame, a face one frame in eight.
        if (
          kind.timer[f] >= 0 &&
          (kind.whole[f] !== 0 || ((this.frames ^ kind.seq[f]) & 7) === 0) &&
          kind.cy[f] <= (this.groundAt ? this.groundAt(kind.cx[f], kind.cz[f]) : NO_GROUND)
        ) {
          kind.timer[f] = -1;
        }
        const inst = kind.inst[f];
        if (kind.whole[f] !== 0 && kind.timer[f] < 0) this.instLanded[inst] = 1;
        if (kind.whole[f] !== 0 ? this.instLanded[inst] !== 0 : kind.timer[f] < 0) {
          this.giveBack(kind, f);
          continue;
        }
        if (kind.ref[f] >= 0) this.publish(kind.ref[f], kind.cx[f], kind.cy[f], kind.cz[f]);
        else if (kind.whole[f] !== 0 && this.instRef[inst] >= 0) {
          this.publish(this.instRef[inst], kind.cx[f], kind.cy[f], kind.cz[f]);
        }
        f++;
      }
      for (let i = 0; i < kind.count; i++) {
        // The face's matrix: its x angle, then its y angle (math/matrix.c from_angles).
        const ay = kind.angY[i];
        const ax = kind.angX[i];
        const cy = Math.cos(ay);
        const sy = Math.sin(ay);
        const cx = Math.cos(ax);
        const sx = Math.sin(ax);
        rot.set(cy, sy * sx, sy * cx, 0, cx, -sx, -sy, cy * sx, cy * cx);
        for (let c = 0; c < 3; c++) {
          v.set(
            kind.local[i * 9 + c * 3],
            kind.local[i * 9 + c * 3 + 1],
            kind.local[i * 9 + c * 3 + 2],
          );
          v.applyMatrix3(rot);
          const o = (i * 3 + c) * 3;
          kind.pos[o] = kind.cx[i] + v.x;
          kind.pos[o + 1] = kind.cy[i] + v.y;
          kind.pos[o + 2] = kind.cz[i] + v.z;
        }
      }
      kind.geometry.setDrawRange(0, kind.count * 3);
      (kind.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute("uv") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute(LIGHT_ATTRIBUTE) as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute(TEAM_UV_ATTR) as THREE.BufferAttribute).needsUpdate = true;
      (kind.geometry.getAttribute(TEAM_UV_MASK) as THREE.BufferAttribute).needsUpdate = true;
      if (kind.count === 0) kind.mesh.visible = false;
    }
    this.flushReaps();
  }

  /** The reapers: a face back to the pool (and maybe its reap), a whole object's landing. */
  private giveBack(kind: Kind, f: number): void {
    const inst = kind.inst[f];
    this.dropRef(kind.ref[f]);
    if (kind.whole[f] === 0) {
      // 0x00438010: the count goes down first; bits 2 or 3 of what is left raise.
      this.out--;
      if ((this.out & 3) > 1 && this.instReap[inst] !== 0) {
        this.queueReap(inst, kind.cx[f], kind.cy[f], kind.cz[f], kind.scale[f]);
      }
    }
    this.instTris[inst]--;
    if (this.instTris[inst] <= 0) {
      if (this.instWhole[inst] !== 0) {
        // 0x00437f80: one reap, at the instance's own reference.
        if (this.instReap[inst] !== 0) {
          this.queueReap(inst, this.instX[inst], this.instY[inst], this.instZ[inst], 0);
        }
        this.dropRef(this.instRef[inst]);
      }
      this.instLive[inst] = 0;
    }
    this.kill(kind, f);
  }

  private queueReap(inst: number, x: number, y: number, z: number, scale: number): void {
    const p = this.pending;
    if (p >= PENDING_MAX) return;
    this.pending++;
    this.pendBank[p] = this.instBank[inst];
    this.pendId[p] = this.instReap[inst];
    this.pendX[p] = x;
    this.pendY[p] = y;
    this.pendZ[p] = z;
    this.pendScale[p] = scale;
  }

  /** The reaps of this update, raised once every face has moved (a reap may shatter again). */
  private flushReaps(): void {
    const n = this.pending;
    this.pending = 0;
    if (!this.raise) return;
    for (let p = 0; p < n; p++) {
      const at = this.pointAt(this.pendX[p], this.pendY[p], this.pendZ[p]);
      // Kind 5: the point and the scale; a whole object's reap takes its record's.
      at.scale = this.pendScale[p];
      this.raise(this.pendBank[p], this.pendId[p], at);
    }
  }

  /** The reference effect (+0x35) on a face's own reference, riding it. */
  private raiseOn(bank: number, id: number, ref: number, f: number, kind: Kind): void {
    this.raiseOnPoint(bank, id, ref, kind.cx[f], kind.cy[f], kind.cz[f]);
  }

  private raiseOnPoint(
    bank: number,
    id: number,
    ref: number,
    x: number,
    y: number,
    z: number,
  ): void {
    if (id === 0 || !this.raise) return;
    const at = this.pointAt(x, y, z);
    at.attach = FACE_REF_BASE + ref;
    this.raise(bank, id, at);
  }

  private pointAt(x: number, y: number, z: number): RaiseAt {
    const at = raiseAt;
    at.x = x;
    at.y = y;
    at.z = z;
    at.yaw = 0;
    at.attach = -1;
    at.attachForward = 0;
    at.attachUp = 0;
    at.scale = 0;
    at.raiserScale = 0x100;
    at.endX = Number.NaN;
    at.endY = Number.NaN;
    at.endZ = Number.NaN;
    at.archetype = -1;
    at.modelY = Number.NaN;
    at.team = -1;
    at.repeat = false;
    at.hold = 0;
    return at;
  }

  /** A reference slot, published at (x, y, z); -1 without a pose table. */
  private takeRef(x: number, y: number, z: number): number {
    if (!this.poses) return -1;
    const r = this.nextRef;
    this.nextRef = (r + 1) % FACE_REFS;
    this.publish(r, x, y, z);
    return r;
  }

  private publish(ref: number, x: number, y: number, z: number): void {
    const poses = this.poses;
    if (!poses) return;
    const e = FACE_REF_BASE + ref;
    const o = e * POSE_STRIDE;
    poses.table[o] = x;
    poses.table[o + 1] = y;
    poses.table[o + 2] = z;
    poses.table[o + 3] = 0;
    poses.live[e] = 1;
  }

  private dropRef(ref: number): void {
    if (ref < 0 || !this.poses) return;
    this.poses.live[FACE_REF_BASE + ref] = 0;
  }

  private freeInstance(): number {
    for (let i = 0; i < INSTANCES; i++) if (this.instLive[i] === 0) return i;
    return -1;
  }

  private kill(kind: Kind, f: number): void {
    const last = kind.count - 1;
    if (f !== last) {
      for (let k = 0; k < 9; k++) {
        kind.local[f * 9 + k] = kind.local[last * 9 + k];
        kind.normal[f * 9 + k] = kind.normal[last * 9 + k];
        kind.colour[f * 9 + k] = kind.colour[last * 9 + k];
      }
      for (let k = 0; k < 12; k++) kind.light[f * 12 + k] = kind.light[last * 12 + k];
      for (let k = 0; k < 6; k++) {
        kind.uv[f * 6 + k] = kind.uv[last * 6 + k];
        kind.teamUv[f * 6 + k] = kind.teamUv[last * 6 + k];
      }
      for (let k = 0; k < 3; k++) kind.teamMask[f * 3 + k] = kind.teamMask[last * 3 + k];
      kind.cx[f] = kind.cx[last];
      kind.cy[f] = kind.cy[last];
      kind.cz[f] = kind.cz[last];
      kind.vx[f] = kind.vx[last];
      kind.vy[f] = kind.vy[last];
      kind.vz[f] = kind.vz[last];
      kind.fall[f] = kind.fall[last];
      kind.angY[f] = kind.angY[last];
      kind.angX[f] = kind.angX[last];
      kind.spinY[f] = kind.spinY[last];
      kind.spinX[f] = kind.spinX[last];
      kind.timer[f] = kind.timer[last];
      kind.inst[f] = kind.inst[last];
      kind.ref[f] = kind.ref[last];
      kind.scale[f] = kind.scale[last];
      kind.whole[f] = kind.whole[last];
      kind.seq[f] = kind.seq[last];
    }
    kind.count = last;
  }
}
