// Walk animation for the player avatar (assets.md §4: "code-driven animation,
// rigid transforms, no skinning").
//
// The shipped `avatar-walker.glb` is one node, one mesh, one primitive — the
// asset pipeline joins everything and `bakeSkinRestPose` folds the original's
// two skins into the vertices, so there is no skeleton left to drive. What IS
// left is geometry that still falls apart along the original's part seams: weld
// the vertices by position and the mesh splits into nine connected components,
// the largest of which (648 vertices) is exactly the raw legs mesh. That island
// holds both legs plus the hip that joins them, and it separates cleanly by
// triangle-centre x.
//
// So the split is read out of the asset at load time rather than authored: no
// generator change, no new .glb, and `avatarRig.test.ts` pins the numbers so a
// regenerated asset that no longer splits this way fails loudly instead of
// walking wrong.
//
// Renderer rule 1 (zero allocations in the frame loop) holds outright: every
// scratch object is module-scope. Rule 3 (one InstancedMesh per archetype) does
// NOT — the avatar draws as three, one per rigid part. That is a declared
// exception, written down in CLAUDE.md and assets.md §4 rather than assumed: a
// hip that swings needs at least two transforms, and three InstancedMeshes at
// capacity 4 is the cheapest way to get them. No Object3D tree, no per-limb
// matrix update, no traversal.
//
// Knee bend is NOT in here. That needs the generator to emit the parts as
// separate nodes with their joint origins, and `bun run gen:units` is not
// byte-reproducible today, so that refactor has no safety net. Hip swing gets
// the legs moving without touching a single asset byte.

import { ANIM_AIRBORNE, ANIM_MOVING } from "@metropolis/sim";
import * as THREE from "three";
import { tintFor } from "./greybox";
import { loadUnitAsset } from "./unitMeshes";

/**
 * Triangle-centre |x| below this FRACTION of the legs island's own half-width
 * counts as hip rather than leg. At 0.20 the shipped asset splits 94 left /
 * 94 right / 28 hip triangles, i.e. perfectly symmetric — a mech with one leg
 * heavier than the other means the threshold landed inside geometry. Split per
 * TRIANGLE, never per vertex: a vertex-wise split tears triangles that straddle
 * the seam.
 *
 * A FRACTION rather than metres, because the asset's metre size is not a
 * constant of this code. It was 0.15 m against legs then sitting at x ±0.75,
 * and rebuilding the walker at its native FCOP size (2.87x smaller) moved them
 * to ±0.26 — the absolute threshold then cut through the legs and left 41 of
 * each 94 triangles welded to the body, still perfectly symmetric and silently
 * wrong. 0.20 is the same cut the 0.15 m made, expressed so a rescale cannot
 * move it.
 *
 * The gap it lands in is narrower than it looks: measured against this asset,
 * 94/94 holds for 0.192-0.21 and 95/95 for 0.15-0.183, with asymmetric splits
 * in between and below. Retune by measuring, not by nudging.
 */
export const LEG_SPLIT_FRACTION = 0.2;

/** Peak hip swing, radians. The one authored number in the gait. */
export const SWING_RADIANS = 0.44;
/** Both legs tuck to this angle while airborne (a jump reads as legs-together). */
export const AIRBORNE_RADIANS = 0.3;
/** How fast the swing fades in on move / out on stop, per second. */
export const BLEND_RATE = 7;
/** Top fraction of a leg's height that counts as "the hip end" for the pivot. */
const PIVOT_SLICE = 0.1;

const TAU = Math.PI * 2;
/**
 * Instance capacity. Matches greybox.ts's `avatarWalker` bucket rather than
 * MAX_PLAYERS so the two paths drop instances at the same point — the bucket
 * carries headroom for post-v1 2v2.
 */
export const RIG_CAPACITY = 4;
/**
 * Assets are authored +Z forward (assets.md §4); the sim frame is +X forward.
 * The bucket path bakes this into the geometry (unitMeshes.ts); the rig cannot,
 * because baking would rotate the hip hinge axis out of the model's left-right
 * axis. It folds into the per-instance yaw instead, which costs nothing.
 */
const MODEL_YAW = Math.PI / 2;

// --- the split (pure, no Three) ----------------------------------------------

export interface WalkerSplit {
  /** Connected components found, largest first. A regression pin — expect 9. */
  readonly componentCount: number;
  /** Vertices in the largest component (the legs island). Expect 648. */
  readonly legVertexCount: number;
  /** Triangle indices, three per triangle, into the source position buffer. */
  readonly legL: Uint32Array;
  readonly legR: Uint32Array;
  /** Hip plus every component above it — everything that does not swing. */
  readonly body: Uint32Array;
}

/**
 * Random access to a position attribute.
 *
 * Deliberately NOT a flat `Float32Array`: GLTFLoader hands back an
 * `InterleavedBufferAttribute` whenever the asset packs POSITION, NORMAL and
 * TEXCOORD_0 into one bufferView — which the unit pipeline does — and that
 * attribute's `.array` is the whole interleaved buffer, not the positions. The
 * first version of this read `.array` and found 1675 components with 199
 * "leg" vertices instead of 9 and 648, because it was walking normals and UVs as
 * if they were coordinates. Both `THREE.BufferAttribute` and
 * `THREE.InterleavedBufferAttribute` satisfy this interface; a raw array does not.
 */
export interface PositionReader {
  readonly count: number;
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
}

/**
 * Labels connected components over position-welded vertices, then splits the
 * largest one into left leg / right leg / hip by triangle-centre x.
 *
 * Welding by position is what makes this work at all: the pipeline emits one
 * primitive whose index buffer never shares a vertex between two parts (each
 * part brought its own copies through the join), so the raw index graph has far
 * more islands than there are parts. Welding first collapses the duplicates and
 * leaves exactly the seams the original modelled.
 *
 * With +Y up and +Z forward, +X is the character's own left (right-handed
 * frame), which is where the `legL` / `legR` naming comes from.
 */
export function splitWalkerParts(position: PositionReader, index: ArrayLike<number>): WalkerSplit {
  const vertexCount = position.count;
  // Exact-bit position key: these are baked, not computed, so two vertices of
  // one seam are bit-identical. No epsilon, hence no accidental welds.
  const byPosition = new Map<string, number>();
  const canonical = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const key = `${position.getX(v)},${position.getY(v)},${position.getZ(v)}`;
    const first = byPosition.get(key);
    if (first === undefined) {
      byPosition.set(key, v);
      canonical[v] = v;
    } else {
      canonical[v] = first;
    }
  }

  const parent = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) parent[v] = v;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]]; // path halving
      r = parent[r];
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const triangleCount = Math.floor(index.length / 3);
  for (let t = 0; t < triangleCount; t++) {
    const a = canonical[index[t * 3]];
    const b = canonical[index[t * 3 + 1]];
    const c = canonical[index[t * 3 + 2]];
    union(a, b);
    union(b, c);
  }

  // Component sizes counted over ALL vertices (duplicates included), so
  // legVertexCount is comparable with the raw asset's vertex count.
  const sizes = new Map<number, number>();
  for (let v = 0; v < vertexCount; v++) {
    const root = find(canonical[v]);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  let legRoot = -1;
  let legVertexCount = 0;
  for (const [root, size] of sizes) {
    // Ties broken by lowest root so the choice cannot depend on Map order.
    if (size > legVertexCount || (size === legVertexCount && root < legRoot)) {
      legRoot = root;
      legVertexCount = size;
    }
  }

  // The threshold is a FRACTION of the legs island's own half-width, resolved
  // here, because the asset's metre size is not a constant of this code: the
  // walker is authored at the original's scale and the same split has to hold
  // whatever that turns out to be. As an absolute 0.15 m it silently ate half
  // of each leg the first time the model was rebuilt at its native size —
  // 41 swinging triangles instead of 94, the rest welded to the body.
  let legHalfWidth = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (find(canonical[v]) !== legRoot) continue;
    const ax = position.getX(v) < 0 ? -position.getX(v) : position.getX(v);
    if (ax > legHalfWidth) legHalfWidth = ax;
  }
  const splitX = legHalfWidth * LEG_SPLIT_FRACTION;

  const legL: number[] = [];
  const legR: number[] = [];
  const body: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const i0 = index[t * 3];
    const i1 = index[t * 3 + 1];
    const i2 = index[t * 3 + 2];
    let target = body;
    if (find(canonical[i0]) === legRoot) {
      const centreX = (position.getX(i0) + position.getX(i1) + position.getX(i2)) / 3;
      if (centreX > splitX) target = legL;
      else if (centreX < -splitX) target = legR;
    }
    target.push(i0, i1, i2);
  }
  return {
    componentCount: sizes.size,
    legVertexCount,
    legL: new Uint32Array(legL),
    legR: new Uint32Array(legR),
    body: new Uint32Array(body),
  };
}

// --- the gait (pure, no Three) -----------------------------------------------

/**
 * World units of travel per full two-step cycle, for a leg of length
 * `legLength` swinging by SWING_RADIANS.
 *
 * Derived, not authored, because the two numbers are not independent: pick them
 * separately and the feet skate. At mid-stance the planted foot must move
 * backwards relative to the hull at exactly the hull's own speed, i.e.
 * `d(footZ)/dφ = STRIDE / TAU`. With `footZ = legLength · sin(A · sin φ)` that
 * derivative is `legLength · A` at φ = 0, hence `STRIDE = TAU · legLength · A`.
 *
 * It cannot be exact everywhere — a leg with no knee cannot both stay planted
 * and keep the hip at a constant height, so the feet still slip at the extremes
 * of the swing. Matching mid-stance kills the slide where the eye actually looks.
 */
export function strideForLeg(legLength: number): number {
  return TAU * legLength * SWING_RADIANS;
}

/**
 * Per-slot gait state. Pure render state: the sim never sees a phase, and two
 * peers showing different leg angles is not a desync.
 */
export interface Gait {
  /** Travel per cycle — see strideForLeg. */
  readonly stride: number;
  /** Entity id owning each slot, or -1. A change resets that slot's cycle. */
  readonly owner: Int32Array;
  readonly lastX: Float32Array;
  readonly lastY: Float32Array;
  readonly phase: Float32Array;
  readonly blend: Float32Array;
}

export function createGait(capacity: number, stride: number): Gait {
  return {
    stride,
    owner: new Int32Array(capacity).fill(-1),
    lastX: new Float32Array(capacity),
    lastY: new Float32Array(capacity),
    phase: new Float32Array(capacity),
    blend: new Float32Array(capacity),
  };
}

function approach(value: number, target: number, maxStep: number): number {
  const d = target - value;
  if (d > maxStep) return value + maxStep;
  if (d < -maxStep) return value - maxStep;
  return target;
}

/**
 * Advances one slot's cycle and writes `[leftAngle, rightAngle]` into `out`.
 *
 * The phase is driven by DISTANCE TRAVELLED, not by the clock: a clock-driven
 * cycle slides the feet whenever the avatar's speed changes (climbing a slope,
 * strafing, taking a knock), and foot slide is the thing that makes a rigid
 * walk cycle look broken. Distance-driven, one stride always covers
 * `gait.stride` on the ground whatever the frame rate or the speed.
 *
 * `dtSec` is used only for the fade in/out of the swing amplitude, which has no
 * distance to hang off when the avatar is standing still.
 */
export function advanceGait(
  gait: Gait,
  slot: number,
  id: number,
  x: number,
  y: number,
  animState: number,
  dtSec: number,
  out: Float32Array,
): void {
  if (gait.owner[slot] !== id) {
    // New occupant (respawn, or a different avatar in this slot): start from
    // the neutral pose instead of inheriting the previous one's stride.
    gait.owner[slot] = id;
    gait.lastX[slot] = x;
    gait.lastY[slot] = y;
    gait.phase[slot] = 0;
    gait.blend[slot] = 0;
  }
  const dx = x - gait.lastX[slot];
  const dy = y - gait.lastY[slot];
  gait.lastX[slot] = x;
  gait.lastY[slot] = y;

  if ((animState & ANIM_AIRBORNE) !== 0) {
    // Frozen pose, and the phase is left untouched so landing resumes the
    // stride rather than snapping to wherever a running counter would be.
    out[0] = AIRBORNE_RADIANS;
    out[1] = AIRBORNE_RADIANS;
    return;
  }
  const moving = (animState & ANIM_MOVING) !== 0;
  gait.blend[slot] = approach(gait.blend[slot], moving ? 1 : 0, BLEND_RATE * dtSec);
  if (moving) {
    const step = (Math.sqrt(dx * dx + dy * dy) / gait.stride) * TAU;
    let phase = gait.phase[slot] + step;
    if (phase >= TAU) phase %= TAU; // keep it out of large-float territory
    gait.phase[slot] = phase;
  }
  const angle = SWING_RADIANS * gait.blend[slot] * Math.sin(gait.phase[slot]);
  out[0] = angle;
  out[1] = -angle; // legs in antiphase — the whole point of a walk cycle
}

// --- the Three side ----------------------------------------------------------

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchBase = new THREE.Matrix4();
const scratchHinge = new THREE.Matrix4();
const scratchOut = new THREE.Matrix4();
const scratchAngles = new Float32Array(2);
const UP = new THREE.Vector3(0, 1, 0);

interface RigPart {
  readonly mesh: THREE.InstancedMesh;
  /** Hip joint in model space; identity when `angle` is -1. */
  readonly pivot: THREE.Vector3;
  /** Lowest vertex of the part — with `pivot.y`, that is the leg's length. */
  readonly lowestY: number;
  /** Index into advanceGait's output, or -1 for a part that does not swing. */
  readonly angle: number;
  readonly tintCache: Int8Array;
}

export interface AvatarRig {
  /** False until the .glb has loaded and split; callers fall back meanwhile. */
  readonly ready: boolean;
  /** Zeroes the per-frame instance counters. Call before the entity sweep. */
  begin(): void;
  /**
   * Poses one walking avatar. Returns false when the rig cannot take it (not
   * loaded yet, or out of capacity) — then the caller must use its bucket.
   */
  place(
    id: number,
    x: number,
    height: number,
    y: number,
    yaw: number,
    animState: number,
    team: number,
    dtSec: number,
  ): boolean;
  /** Publishes counts and matrices. Call after the entity sweep. */
  end(): void;
  /** The split numbers, once loaded — for diagnostics. */
  readonly split: WalkerSplit | null;
  /**
   * Last swing angle written for a slot: `leg` 0 = left, 1 = right.
   *
   * The verification hook (`?debug` → `metropolisRig`). A screenshot cannot tell
   * "the legs swing" from "the legs are drawn", so the harness reads the angles
   * instead. Never called from the frame loop.
   */
  angleAt(slot: number, leg: number): number;
  /** Travel per gait cycle, once measured off the asset. 0 until then. */
  readonly stride: number;
}

/**
 * Builds the rig from `avatar-walker.glb`. Fire and forget, exactly like
 * unitMeshes.ts: `ready` stays false until the asset lands, and a missing or
 * unsplittable asset leaves it false forever so the greybox bucket keeps the
 * avatar on screen.
 */
export function createAvatarRig(scene: THREE.Scene): AvatarRig {
  let parts: RigPart[] | null = null;
  let split: WalkerSplit | null = null;
  // Built together with the parts: the stride comes off the measured leg length,
  // so there is nothing sensible to create before the asset lands.
  let gait: Gait | null = null;
  let count = 0;
  let overflowed = false;
  /** Per-slot [left, right], kept only so `angleAt` can report it. */
  const written = new Float32Array(RIG_CAPACITY * 2);

  loadUnitAsset("avatar-walker").then(
    ({ geometry, material }) => {
      const position = geometry.getAttribute("position");
      const index = geometry.getIndex();
      if (!position || !index) {
        console.warn("[avatarRig] avatar-walker has no indexed positions, keeping greybox");
        return;
      }
      // `index` is always a plain BufferAttribute (glTF forbids interleaved
      // indices), so its `.array` really is the index buffer. `position` is not
      // — see PositionReader.
      const s = splitWalkerParts(position, index.array as ArrayLike<number>);
      if (s.legL.length === 0 || s.legR.length === 0) {
        console.warn(
          `[avatarRig] avatar-walker did not split into two legs (${s.componentCount} components, ` +
            `${s.legVertexCount} leg vertices) — keeping greybox`,
        );
        return;
      }
      split = s;
      // Attributes are SHARED between the three geometries — same GPU buffer,
      // three index buffers. Only the indices differ, so the split costs a few
      // kilobytes of indices and no vertex data at all.
      const built = [
        buildPart(scene, geometry, material, s.body, -1),
        buildPart(scene, geometry, material, s.legL, 0),
        buildPart(scene, geometry, material, s.legR, 1),
      ];
      // Leg length = hip joint height above the sole. Both legs measure the same
      // to within a millimetre; take the left one and be done.
      gait = createGait(RIG_CAPACITY, strideForLeg(built[1].pivot.y - built[1].lowestY));
      parts = built;
    },
    (err) => {
      console.warn(`[avatarRig] no usable avatar-walker asset, keeping greybox: ${err}`);
    },
  );

  return {
    get ready() {
      return parts !== null;
    },
    get split() {
      return split;
    },
    get stride() {
      return gait ? gait.stride : 0;
    },
    angleAt(slot, leg) {
      return written[slot * 2 + leg];
    },
    begin() {
      count = 0;
    },
    place(id, x, height, y, yaw, animState, team, dtSec) {
      const p = parts;
      const g = gait;
      if (!p || !g) return false;
      if (count >= RIG_CAPACITY) {
        // Same contract as renderEntities' bucket overflow: shout once, because
        // verify:arenas fails the run on any console error.
        if (!overflowed) {
          overflowed = true;
          console.error(
            `[avatarRig] rig full at ${RIG_CAPACITY} avatars — raise RIG_CAPACITY in render/avatarRig.ts`,
          );
        }
        return false;
      }
      const slot = count;
      count = slot + 1;
      advanceGait(g, slot, id, x, y, animState, dtSec, scratchAngles);
      written[slot * 2] = scratchAngles[0];
      written[slot * 2 + 1] = scratchAngles[1];

      // sim (x, y, height, yaw) → three (x, height, z), model +Z forward folded
      // into the yaw so the hip hinge stays on the model's left-right axis.
      scratchPos.set(x, height, y);
      scratchQuat.setFromAxisAngle(UP, MODEL_YAW - yaw);
      scratchBase.compose(scratchPos, scratchQuat, scratchScale);
      for (let i = 0; i < p.length; i++) {
        const part = p[i];
        if (part.angle >= 0) {
          hingeMatrix(part.pivot, scratchAngles[part.angle], scratchHinge);
          scratchOut.multiplyMatrices(scratchBase, scratchHinge);
          part.mesh.setMatrixAt(slot, scratchOut);
        } else {
          part.mesh.setMatrixAt(slot, scratchBase);
        }
        if (part.tintCache[slot] !== team) {
          part.tintCache[slot] = team;
          part.mesh.setColorAt(slot, tintFor(team));
          if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
        }
      }
      return true;
    },
    end() {
      const p = parts;
      if (!p) return;
      for (let i = 0; i < p.length; i++) {
        p[i].mesh.count = count;
        p[i].mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

/** `T(pivot) · Rx(angle) · T(-pivot)` — a hinge about the model's left-right axis. */
function hingeMatrix(pivot: THREE.Vector3, angle: number, out: THREE.Matrix4): void {
  out.makeRotationX(angle);
  // Rotation about X leaves x alone, so only y and z of the pivot matter.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out.setPosition(0, pivot.y - (c * pivot.y - s * pivot.z), pivot.z - (s * pivot.y + c * pivot.z));
}

function buildPart(
  scene: THREE.Scene,
  source: THREE.BufferGeometry,
  material: THREE.Material,
  triangles: Uint32Array,
  angle: number,
): RigPart {
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"]) {
    const attr = source.getAttribute(name);
    if (attr) geometry.setAttribute(name, attr);
  }
  geometry.setIndex(new THREE.BufferAttribute(triangles, 1));
  const mesh = new THREE.InstancedMesh(geometry, material, RIG_CAPACITY);
  mesh.count = 0;
  mesh.frustumCulled = false; // shared attributes make the bounding sphere lie
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  // Hip joint: the top of the part's own bounding box, at the fore-aft centre of
  // the vertices up there. The legs hang down from that point, so it is the
  // joint — and reading it off the geometry needs none of the skeleton data the
  // asset has thrown away.
  //
  // The fore-aft centre is taken from the TOP SLICE, not the whole bounding box:
  // the leg's box runs z −1.15…0.69 because the foot sticks out backwards, and
  // hinging about the box centre would swing the thigh through the hull.
  const pivot = new THREE.Vector3();
  let lowestY = 0;
  if (angle >= 0) {
    const position = source.getAttribute("position");
    let maxY = -Infinity;
    let minY = Infinity;
    for (let t = 0; t < triangles.length; t++) {
      const py = position.getY(triangles[t]);
      if (py > maxY) maxY = py;
      if (py < minY) minY = py;
    }
    const slice = maxY - (maxY - minY) * PIVOT_SLICE;
    let sumZ = 0;
    let n = 0;
    for (let t = 0; t < triangles.length; t++) {
      const v = triangles[t];
      if (position.getY(v) < slice) continue;
      sumZ += position.getZ(v);
      n++;
    }
    pivot.set(0, maxY, n > 0 ? sumZ / n : 0);
    lowestY = minY;
  }
  return { mesh, pivot, lowestY, angle, tintCache: new Int8Array(RIG_CAPACITY).fill(-2) };
}
