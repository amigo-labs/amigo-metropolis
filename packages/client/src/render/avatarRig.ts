// The X1-Alpha, drawn as the original animates it (assets.md §4;
// fcop-fidelity.md G11): ONE InstancedMesh whose vertex shader poses every
// vertex by two frame numbers per instance -- the legs' and the cockpit's --
// out of a bone table baked by `bun run gen:x1` (tools/generators/fcopX1.ts).
//
// `avatar-x1.glb` is the five parts in their bind pose, one primitive; each
// vertex's `_X1BONE` names its matrix: a legs joint, a cockpit joint, a gun or
// the beacon. `avatar-x1.anim.bin` holds a 3x4 matrix per slot per frame, the
// legs' 371 frames with the cockpit's mount (3DHS point 0 of the frame) and the
// cockpit's 30 with the guns and the beacon on it. The shader does what
// render/x1Pose.ts does on the CPU: a legs vertex is its joint's matrix of the
// legs frame; a cockpit, gun or beacon vertex is its matrix of the cockpit
// frame, turned by the cockpit's aim and set on the mount. The frames come from
// the original's walker state machine, the sim's (walker.ts), read off the
// avatar snapshot (render/x1Walk.ts); walker, transform and hover are all the
// same mesh at other frames, so nothing swaps.
//
// Renderer rules: one InstancedMesh for the archetype (no exception any more:
// the three-part hip-swing rig this replaced was one), capacity 4,
// `matrixAutoUpdate = false`, no Object3D tree; `place` writes the slot's
// matrix, its four-float pose and its two layer masks and allocates nothing.
//
// The faces keep the original's draw modes (fcop-fidelity.md G13; RE
// x1-alpha.md "Draw modes and layers"): `avatar-x1.glb` has a primitive per
// mode, opaque then half -- the legs are half throughout -- which
// render/fcopModel.ts turns into groups of this one mesh, the half group drawn
// twice (its solid texels with the opaque faces, its bit-15 texels blended
// without a depth write), every material carrying the same pose patch. And
// the layers: each face's `_X1LAYER` (op1 bits 4..6) shows only while its bit
// is in the mask its block is drawn with. The original's partner reads both
// masks off the transform's progress (player_partner.c 299-320): the legs 3 as
// a walker, 7 through the ramp, 5 as a hover; the cockpit 5, 0xf, 0xb; the
// guns and the beacon 1. So the legs' 16 layer-1 faces show as a walker and
// through the ramp, the cockpit's 6 as a hover and through it. The shader
// collapses a hidden face onto the model's origin, where it covers no pixel.
//
// And the lighting (fcop-fidelity.md G13; RE objects.md "Face lighting"): every
// vertex carries its face's `_FCOP_LIGHT` (the legs, the cockpit and the guns
// smooth grey at 0x80, the beacon plain grey), so render/fcopModel.ts draws the
// X1 as it draws every unit, shaded against the original's one light; the
// pose chains its normal onto that shade, turned through the same bone and aim
// as the vertex (x1PoseNormal, render/x1Pose.ts poseX1Normal), as a skeleton
// turns its 4DNL through each bone (`cact_model_project` 0x004281db).
//
// Team colour is the original's texture offset (render/teamUv.ts), kept off the
// beacon by `_TEAMUV`; while the cloak runs, the offset's v is the frame clock
// `>> 2 & 0x3f` instead of the side's (player_partner.c 289-293).

import * as THREE from "three";
import { teamSide, writeX1Uv, x1Uv } from "./arenaUnits";
import { createHitAttribute } from "./damaged";
import { chainPatch, HIT_ATTRIBUTE, materialList } from "./fcopModel";
import type { ShatterSkeleton } from "./fx/skeletonShatter";
import { createTeamUvAttribute, TEAM_UV_ATTR, TEAM_UV_MASK } from "./teamUv";
import { loadUnitAsset } from "./unitMeshes";
import {
  X1_ANIM_HEIGHT,
  X1_ANIM_WIDTH,
  X1_ATTACHED_LAYER_MASK,
  X1_BEAM_POINT,
  X1_COCKPIT_LAYER_MASKS,
  X1_COCKPIT_ROW,
  X1_COCKPIT_SLOT,
  X1_GUN_SLOT,
  X1_LEGS_LAYER_MASKS,
  X1_MOUNT_TEXEL,
  X1_SLOTS,
} from "./x1Rig.generated";

/**
 * Instance capacity. Matches greybox.ts's `avatarWalker` bucket rather than
 * MAX_PLAYERS so the two paths drop instances at the same point — the bucket
 * carries headroom for post-v1 2v2.
 */
export const RIG_CAPACITY = 4;
/** Per-instance pose: legs frame, cockpit frame, the cockpit's aim yaw and pitch (radians, model space). */
export const X1_POSE_ATTR = "instanceX1";
/** Per-vertex matrix slot (`_X1BONE`, which GLTFLoader lowercases). */
export const X1_BONE_ATTR = "x1Bone";
const GLTF_BONE = "_x1bone";
/**
 * Per-vertex face (`_X1FACE`, gen:x1): the primitive its triangle came from
 * (the part's place in the mesh x 1024 plus its 3DQL index), so a quad's two
 * triangles share one. The skeleton shatter tests a quad whole by it.
 */
export const X1_FACE_ATTR = "x1Face";
const GLTF_FACE = "_x1face";
/** Per-vertex layer of the vertex's face (`_X1LAYER`). */
export const X1_LAYER_ATTR = "x1Layer";
const GLTF_LAYER = "_x1layer";
/** Per-instance layer masks: the legs' block's, the cockpit's. */
export const X1_LAYERS_ATTR = "instanceX1Layers";
/** The bone table's sampler uniform. */
const X1_ANIM_UNIFORM = "x1Anim";
/**
 * The cockpit skeleton's `3DHY` records, slots X1_COCKPIT_SLOT on in record
 * order: the slots after them are the two guns and the beacon (gen:x1).
 */
export const X1_COCKPIT_BONES = X1_SLOTS - X1_COCKPIT_SLOT - 3;
/**
 * Assets are authored +Z forward (assets.md §4); the sim frame is +X forward.
 * The rig folds the quarter turn into the per-instance yaw, so the cockpit's
 * aim stays a turn about the model's own up axis.
 */
const MODEL_YAW = Math.PI / 2;

const VERTEX_DECL = `#include <common>
attribute float ${X1_BONE_ATTR};
attribute float ${X1_LAYER_ATTR};
attribute vec4 ${X1_POSE_ATTR};
attribute vec2 ${X1_LAYERS_ATTR};
uniform highp sampler2D ${X1_ANIM_UNIFORM};
// render/x1Pose.ts poseX1Normal: the slot's 3x3 of the frame and, riding the
// cockpit, the aim's pitch then yaw; no translation, not renormalised.
vec3 x1PoseNormal( vec3 n ) {
	int x1Slot = int(${X1_BONE_ATTR} + 0.5);
	bool x1Rides = x1Slot >= ${X1_COCKPIT_SLOT};
	int x1Row = x1Rides ? ${X1_COCKPIT_ROW} + int(${X1_POSE_ATTR}.y + 0.5) : int(${X1_POSE_ATTR}.x + 0.5);
	int x1Texel = (x1Rides ? x1Slot - ${X1_COCKPIT_SLOT} : x1Slot) * 3;
	vec3 q = vec3(
		dot(texelFetch(${X1_ANIM_UNIFORM}, ivec2(x1Texel, x1Row), 0).xyz, n),
		dot(texelFetch(${X1_ANIM_UNIFORM}, ivec2(x1Texel + 1, x1Row), 0).xyz, n),
		dot(texelFetch(${X1_ANIM_UNIFORM}, ivec2(x1Texel + 2, x1Row), 0).xyz, n));
	if (x1Rides) {
		float cp = cos(${X1_POSE_ATTR}.w);
		float sp = sin(${X1_POSE_ATTR}.w);
		q = vec3(q.x, cp * q.y - sp * q.z, sp * q.y + cp * q.z);
		float cy = cos(${X1_POSE_ATTR}.z);
		float sy = sin(${X1_POSE_ATTR}.z);
		q = vec3(cy * q.x + sy * q.z, q.y, -sy * q.x + cy * q.z);
	}
	return q;
}`;

/**
 * The lighting's normal (render/fcopModel.ts fcopLightPatch) posed as the
 * vertex is: a skeleton turns its normals through each bone and lights them
 * against the light in the same space (`cact_model_project`
 * 0x004281db..0x00428206), so the shade is the posed normal's.
 */
const LIGHT_NORMAL = "vec3 fcopNormal = vec3( normal );";
const LIGHT_NORMAL_POSED = "vec3 fcopNormal = x1PoseNormal( normal );";

// render/x1Pose.ts in GLSL: the slot's 3x4 matrix is three texels of its row.
const VERTEX_POSE = `#include <begin_vertex>
{
	int x1Slot = int(${X1_BONE_ATTR} + 0.5);
	int x1Legs = int(${X1_POSE_ATTR}.x + 0.5);
	bool x1Rides = x1Slot >= ${X1_COCKPIT_SLOT};
	int x1Row = x1Rides ? ${X1_COCKPIT_ROW} + int(${X1_POSE_ATTR}.y + 0.5) : x1Legs;
	int x1Texel = (x1Rides ? x1Slot - ${X1_COCKPIT_SLOT} : x1Slot) * 3;
	vec4 x1P = vec4(position, 1.0);
	vec3 x1Q = vec3(
		dot(texelFetch(${X1_ANIM_UNIFORM}, ivec2(x1Texel, x1Row), 0), x1P),
		dot(texelFetch(${X1_ANIM_UNIFORM}, ivec2(x1Texel + 1, x1Row), 0), x1P),
		dot(texelFetch(${X1_ANIM_UNIFORM}, ivec2(x1Texel + 2, x1Row), 0), x1P));
	if (x1Rides) {
		float x1Cp = cos(${X1_POSE_ATTR}.w);
		float x1Sp = sin(${X1_POSE_ATTR}.w);
		x1Q = vec3(x1Q.x, x1Cp * x1Q.y - x1Sp * x1Q.z, x1Sp * x1Q.y + x1Cp * x1Q.z);
		float x1Cy = cos(${X1_POSE_ATTR}.z);
		float x1Sy = sin(${X1_POSE_ATTR}.z);
		x1Q = vec3(x1Cy * x1Q.x + x1Sy * x1Q.z, x1Q.y, -x1Sy * x1Q.x + x1Cy * x1Q.z);
		x1Q += texelFetch(${X1_ANIM_UNIFORM}, ivec2(${X1_MOUNT_TEXEL}, x1Legs), 0).xyz;
	}
	// The layer gate (cact_model_draw_prims): the face shows while its layer's
	// bit is in its block's mask, else it collapses to a point and draws nothing.
	int x1Mask = x1Slot >= ${X1_GUN_SLOT} ? ${X1_ATTACHED_LAYER_MASK}
		: int((x1Rides ? ${X1_LAYERS_ATTR}.y : ${X1_LAYERS_ATTR}.x) + 0.5);
	if (((x1Mask >> int(${X1_LAYER_ATTR} + 0.5)) & 1) == 0) x1Q = vec3(0.0);
	transformed = x1Q;
}`;

/** Chains the pose onto each material's own patches (the team offset, the half pass). */
function patchX1(material: THREE.Material, table: THREE.DataTexture): void {
  chainPatch(material, "x1", (shader) => {
    shader.uniforms[X1_ANIM_UNIFORM] = { value: table };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", VERTEX_DECL)
      .replace(LIGHT_NORMAL, LIGHT_NORMAL_POSED)
      .replace("#include <begin_vertex>", VERTEX_POSE);
  });
}

/** The bone table as the shader samples it: RGBA float texels, never filtered. */
export function createX1AnimTexture(table: Float32Array): THREE.DataTexture {
  if (table.length !== X1_ANIM_WIDTH * X1_ANIM_HEIGHT * 4) {
    throw new Error(`avatar-x1.anim.bin holds ${table.length} floats, not the layout's`);
  }
  const texture = new THREE.DataTexture(
    table,
    X1_ANIM_WIDTH,
    X1_ANIM_HEIGHT,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchMatrix = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** The rig once its asset has landed: one mesh and its bookkeeping. */
export interface X1RigCore {
  readonly mesh: THREE.InstancedMesh;
  readonly table: Float32Array;
  /**
   * The unit's materials without the pose, one per geometry group as the
   * mesh's (its draw-mode passes), for the skeleton shatter's pieces.
   */
  readonly plain: THREE.Material | THREE.Material[];
  /** Per slot: the side last written (-2 none), and the cloak's v (-1 none). */
  readonly sideCache: Int8Array;
  readonly cloakCache: Int16Array;
  /** The per-instance damaged flag (render/damaged.ts), HIT_ATTRIBUTE. */
  readonly hit: THREE.InstancedBufferAttribute;
  readonly hitCache: Uint8Array;
}

/** A generator attribute under its shader name (GLTFLoader lowercases `_X1…`). */
function renameAttribute(geometry: THREE.BufferGeometry, gltf: string, name: string): void {
  const attr = geometry.getAttribute(gltf) ?? geometry.getAttribute(name);
  if (!attr) throw new Error(`avatar-x1.glb has no ${gltf.toUpperCase()} attribute`);
  geometry.setAttribute(name, attr);
  if (geometry.getAttribute(gltf)) geometry.deleteAttribute(gltf);
}

/**
 * Copies of the asset's materials with the patches they have so far (the team
 * offset, a half face's bit-15 pass) and not the pose chained on after: a clone
 * keeps no onBeforeCompile, so the copy takes the original's patch function,
 * which none of the patches binds to its material. Load time only.
 */
function plainMaterials(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  const copy = (m: THREE.Material): THREE.Material => {
    const c = m.clone();
    c.onBeforeCompile = m.onBeforeCompile;
    c.customProgramCacheKey = m.customProgramCacheKey;
    return c;
  };
  return Array.isArray(material) ? material.map(copy) : copy(material);
}

/**
 * Builds the mesh from a loaded asset and its bone table. Load time only.
 * `material` is the asset's: one, or one per geometry group (its draw modes,
 * render/fcopModel.ts faceMaterials), each given the pose.
 */
export function buildX1Rig(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  table: Float32Array,
): X1RigCore {
  renameAttribute(geometry, GLTF_BONE, X1_BONE_ATTR);
  renameAttribute(geometry, GLTF_LAYER, X1_LAYER_ATTR);
  renameAttribute(geometry, GLTF_FACE, X1_FACE_ATTR);
  if (!geometry.getAttribute(TEAM_UV_MASK)) throw new Error("avatar-x1.glb has no _TEAMUV");
  geometry.setAttribute(TEAM_UV_ATTR, createTeamUvAttribute(RIG_CAPACITY));
  const pose = new THREE.InstancedBufferAttribute(new Float32Array(RIG_CAPACITY * 4), 4);
  pose.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(X1_POSE_ATTR, pose);
  const layers = new THREE.InstancedBufferAttribute(new Float32Array(RIG_CAPACITY * 2), 2);
  layers.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(X1_LAYERS_ATTR, layers);
  // The mech's and its partner's CACT_FLAG_DAMAGED, set together by
  // `player_credit_amount` (render/damaged.ts).
  const hit = createHitAttribute(RIG_CAPACITY);
  geometry.setAttribute(HIT_ATTRIBUTE, hit);
  // Taken before the pose is chained on: the shatter's pieces keep the passes.
  const plain = plainMaterials(material);
  const anim = createX1AnimTexture(table);
  for (const m of materialList(material)) patchX1(m, anim);
  const mesh = new THREE.InstancedMesh(geometry, material, RIG_CAPACITY);
  mesh.count = 0;
  // The shader moves every vertex; the bind pose's bounds say nothing.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);
  return {
    mesh,
    table,
    plain,
    sideCache: new Int8Array(RIG_CAPACITY).fill(-2),
    cloakCache: new Int16Array(RIG_CAPACITY).fill(-1),
    hit,
    hitCache: new Uint8Array(RIG_CAPACITY),
  };
}

/**
 * Writes slot `slot` of the rig: its matrix, its pose, the layer masks of its
 * draw form (X1_FORM_*, render/x1Walk.ts x1DrawForm) and, when the side or the
 * cloak's v changed, its texture offset.
 */
export function placeX1(
  core: X1RigCore,
  slot: number,
  x: number,
  height: number,
  y: number,
  yaw: number,
  side: number,
  legsFrame: number,
  cockpitFrame: number,
  aimYaw: number,
  aimPitch: number,
  cloakV: number,
  form: number,
): void {
  // sim (x, y, height, yaw) -> three (x, height, z), model +Z forward folded in.
  scratchPos.set(x, height, y);
  scratchQuat.setFromAxisAngle(UP, MODEL_YAW - yaw);
  scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
  core.mesh.setMatrixAt(slot, scratchMatrix);
  const pose = core.mesh.geometry.getAttribute(X1_POSE_ATTR) as THREE.InstancedBufferAttribute;
  const a = pose.array as Float32Array;
  const o = slot * 4;
  if (
    a[o] !== legsFrame ||
    a[o + 1] !== cockpitFrame ||
    a[o + 2] !== aimYaw ||
    a[o + 3] !== aimPitch
  ) {
    a[o] = legsFrame;
    a[o + 1] = cockpitFrame;
    a[o + 2] = aimYaw;
    a[o + 3] = aimPitch;
    pose.needsUpdate = true;
  }
  // The masks change only at a transform, so nothing here may wait behind an
  // `if` for one: an operation the walker never reaches has no type feedback,
  // and the frame loop, optimised before the first transform, deopts there and
  // comes back allocating (x1Alloc.test.ts). Written every call, uploaded only
  // on a change (`needsUpdate = false` bumps no version).
  const layers = core.mesh.geometry.getAttribute(X1_LAYERS_ATTR) as THREE.InstancedBufferAttribute;
  const l = layers.array as Float32Array;
  const i = slot * 2;
  const legsMask = X1_LEGS_LAYER_MASKS[form];
  const cockpitMask = X1_COCKPIT_LAYER_MASKS[form];
  const changed = l[i] !== legsMask || l[i + 1] !== cockpitMask;
  l[i] = legsMask;
  l[i + 1] = cockpitMask;
  layers.needsUpdate = changed;
  if (core.sideCache[slot] !== side || core.cloakCache[slot] !== cloakV) {
    core.sideCache[slot] = side;
    core.cloakCache[slot] = cloakV;
    writeX1Uv(core.mesh, slot, side, cloakV);
  }
}

/**
 * Slot `slot`'s damaged flag (render/damaged.ts), written every call and
 * uploaded on a change, as the masks are. Its own function: placeX1 grown
 * past V8's inlining budget takes its doubles boxed (x1Alloc.test.ts).
 */
export function markX1Hit(core: X1RigCore, slot: number, hit: boolean): void {
  const hv = hit ? 1 : 0;
  const changed = core.hitCache[slot] !== hv;
  core.hitCache[slot] = hv;
  (core.hit.array as Float32Array)[slot] = hv;
  core.hit.needsUpdate = changed;
}

const scratchUv = new Float32Array(2);

/**
 * The wrecked X1's cockpit as the skeleton shatter takes it
 * (render/fx/skeletonShatter.ts): its bones at `cockpitFrame`, its origin on
 * the legs' mount at `legsFrame` for an X1 at sim (x, y, height) facing `yaw`,
 * and `side`'s texels. The partner's own 3x3 is made the identity
 * (0x004385b3), so neither the aim nor the hull's yaw turns the bones.
 */
export function x1CockpitSkeleton(
  core: X1RigCore,
  x: number,
  height: number,
  y: number,
  yaw: number,
  side: number,
  legsFrame: number,
  cockpitFrame: number,
  out: ShatterSkeleton,
): void {
  out.geometry = core.mesh.geometry;
  out.slotAttr = X1_BONE_ATTR;
  out.faceAttr = X1_FACE_ATTR;
  out.material = core.plain;
  x1Uv(core.plain, side, -1, scratchUv);
  out.teamU = scratchUv[0];
  out.teamV = scratchUv[1];
  out.first = X1_COCKPIT_SLOT;
  out.bones = X1_COCKPIT_BONES;
  const t = core.table;
  const row = (X1_COCKPIT_ROW + cockpitFrame) * X1_ANIM_WIDTH;
  for (let n = 0; n < X1_COCKPIT_BONES; n++) {
    for (let k = 0; k < 12; k++) out.matrices[n * 12 + k] = t[(row + n * 3) * 4 + k];
  }
  // The mount, turned with the hull as the rig turns it (placeX1).
  const m = (legsFrame * X1_ANIM_WIDTH + X1_MOUNT_TEXEL) * 4;
  const turn = MODEL_YAW - yaw;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  out.x = x + t[m] * c + t[m + 2] * s;
  out.y = height + t[m + 1];
  out.z = y - t[m] * s + t[m + 2] * c;
}

/**
 * Where the lock beam leaves an X1 (`hud_draw_lock_beam` 0x00435382): the
 * partner's model point 0 -- the cockpit's, X1_BEAM_POINT at `cockpitFrame` --
 * turned by the cockpit's aim (`aimYaw` / `aimPitch`, model space, as
 * render/x1Pose.ts turns a cockpit vertex), set on the mount of `legsFrame`, and
 * placed as placeX1 places the X1 at sim (x, y, height) facing `yaw`. Writes the
 * three-frame point (x, height, sim y) into `out`. Allocates nothing.
 */
export function x1BeamPoint(
  table: Float32Array,
  x: number,
  height: number,
  y: number,
  yaw: number,
  legsFrame: number,
  cockpitFrame: number,
  aimYaw: number,
  aimPitch: number,
  out: Float32Array,
): void {
  const b = cockpitFrame * 3;
  const px = X1_BEAM_POINT[b];
  const py = X1_BEAM_POINT[b + 1];
  const pz = X1_BEAM_POINT[b + 2];
  // Pitch about +x, then yaw about +y (column vectors: Ry * Rx * p).
  const cp = Math.cos(aimPitch);
  const sp = Math.sin(aimPitch);
  const y1 = cp * py - sp * pz;
  const z1 = sp * py + cp * pz;
  const cy = Math.cos(aimYaw);
  const sy = Math.sin(aimYaw);
  const m = (legsFrame * X1_ANIM_WIDTH + X1_MOUNT_TEXEL) * 4;
  const mx = cy * px + sy * z1 + table[m];
  const my = y1 + table[m + 1];
  const mz = -sy * px + cy * z1 + table[m + 2];
  // The hull's turn about +y, as placeX1's quaternion.
  const turn = MODEL_YAW - yaw;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  out[0] = x + mx * c + mz * s;
  out[1] = height + my;
  out[2] = y - mx * s + mz * c;
}

export interface AvatarRig {
  /** False until the asset and its table have loaded; callers fall back meanwhile. */
  readonly ready: boolean;
  /** Zeroes the per-frame instance count. Call before the entity sweep. */
  begin(): void;
  /**
   * Poses one X1 -- walker, transforming or hover alike -- by its frames
   * (render/x1Walk.ts) and the cockpit's aim, its faces gated by the layer
   * masks of its draw form (X1_FORM_*). `cloakV` is the cloak's v offset in
   * texels, or -1; `hit` draws it in the damaged arms (render/damaged.ts).
   * Returns false when the rig cannot take it (not loaded yet, or out of
   * capacity): then the caller uses its bucket.
   */
  place(
    x: number,
    height: number,
    y: number,
    yaw: number,
    team: number,
    legsFrame: number,
    cockpitFrame: number,
    aimYaw: number,
    aimPitch: number,
    cloakV: number,
    form: number,
    hit?: boolean,
  ): boolean;
  /** Publishes the count and the matrices. Call after the entity sweep. */
  end(): void;
  /** The cockpit's mount height above the X1's origin at a legs frame, m (0 until loaded). */
  mountHeight(legsFrame: number): number;
  /** x1BeamPoint on the loaded table; false (and `out` untouched) until loaded. */
  beamPoint(
    x: number,
    height: number,
    y: number,
    yaw: number,
    legsFrame: number,
    cockpitFrame: number,
    aimYaw: number,
    aimPitch: number,
    out: Float32Array,
  ): boolean;
  /** x1CockpitSkeleton for a team's X1; false until loaded. */
  cockpitSkeleton(
    x: number,
    height: number,
    y: number,
    yaw: number,
    team: number,
    legsFrame: number,
    cockpitFrame: number,
    out: ShatterSkeleton,
  ): boolean;
  /** Debug readout (`?debug` -> metropolisRig): the frames last written to a slot. */
  legsAt(slot: number): number;
  cockpitAt(slot: number): number;
}

/**
 * Builds the rig from `avatar-x1.glb` and `avatar-x1.anim.bin`. Fire and
 * forget, like unitMeshes.ts: `ready` stays false until both land, and a
 * missing or broken asset leaves it false so the greybox buckets keep the
 * avatar on screen.
 */
export function createAvatarRig(scene: THREE.Scene): AvatarRig {
  let core: X1RigCore | null = null;
  let count = 0;
  let overflowed = false;

  Promise.all([
    loadUnitAsset("avatar-x1"),
    fetch("/models/units/avatar-x1.anim.bin").then((r) => {
      if (!r.ok) throw new Error(`avatar-x1.anim.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]).then(
    ([{ geometry, material }, bin]) => {
      try {
        core = buildX1Rig(scene, geometry, material, new Float32Array(bin));
      } catch (err) {
        console.warn(`[avatarRig] unusable avatar-x1 asset, keeping greybox: ${err}`);
      }
    },
    (err) => {
      console.warn(`[avatarRig] no avatar-x1 asset, keeping greybox: ${err}`);
    },
  );

  return {
    get ready() {
      return core !== null;
    },
    begin() {
      count = 0;
    },
    place(x, height, y, yaw, team, legsFrame, cockpitFrame, aimYaw, aimPitch, cloakV, form, hit) {
      const c = core;
      if (!c) return false;
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
      placeX1(
        c,
        slot,
        x,
        height,
        y,
        yaw,
        teamSide(team),
        legsFrame,
        cockpitFrame,
        aimYaw,
        aimPitch,
        cloakV,
        form,
      );
      markX1Hit(c, slot, hit === true);
      return true;
    },
    end() {
      const c = core;
      if (!c) return;
      c.mesh.count = count;
      c.mesh.instanceMatrix.needsUpdate = true;
    },
    mountHeight(legsFrame) {
      const c = core;
      if (!c) return 0;
      return c.table[(legsFrame * X1_ANIM_WIDTH + X1_MOUNT_TEXEL) * 4 + 1];
    },
    beamPoint(x, height, y, yaw, legsFrame, cockpitFrame, aimYaw, aimPitch, out) {
      const c = core;
      if (!c) return false;
      x1BeamPoint(c.table, x, height, y, yaw, legsFrame, cockpitFrame, aimYaw, aimPitch, out);
      return true;
    },
    cockpitSkeleton(x, height, y, yaw, team, legsFrame, cockpitFrame, out) {
      const c = core;
      if (!c) return false;
      x1CockpitSkeleton(c, x, height, y, yaw, teamSide(team), legsFrame, cockpitFrame, out);
      return true;
    },
    legsAt(slot) {
      const c = core;
      if (!c) return -1;
      return (c.mesh.geometry.getAttribute(X1_POSE_ATTR).array as Float32Array)[slot * 4];
    },
    cockpitAt(slot) {
      const c = core;
      if (!c) return -1;
      return (c.mesh.geometry.getAttribute(X1_POSE_ATTR).array as Float32Array)[slot * 4 + 1];
    },
  };
}
