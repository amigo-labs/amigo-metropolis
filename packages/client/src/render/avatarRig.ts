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
// the original's walker state machine (render/x1Walk.ts); walker, transform and
// hover are all the same mesh at other frames, so nothing swaps.
//
// Renderer rules: one InstancedMesh for the archetype (no exception any more:
// the three-part hip-swing rig this replaced was one), capacity 4,
// `matrixAutoUpdate = false`, no Object3D tree; `place` writes the slot's
// matrix and its four-float pose and allocates nothing.
//
// Team colour is the original's texture offset (render/teamUv.ts), kept off the
// beacon by `_TEAMUV`; while the cloak runs, the offset's v is the frame clock
// `>> 2 & 0x3f` instead of the side's (player_partner.c 289-293).

import * as THREE from "three";
import { teamSide, writeX1Uv } from "./arenaUnits";
import { createTeamUvAttribute, TEAM_UV_ATTR, TEAM_UV_MASK } from "./teamUv";
import { loadUnitAsset } from "./unitMeshes";
import {
  X1_ANIM_HEIGHT,
  X1_ANIM_WIDTH,
  X1_COCKPIT_ROW,
  X1_COCKPIT_SLOT,
  X1_MOUNT_TEXEL,
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
/** The bone table's sampler uniform. */
const X1_ANIM_UNIFORM = "x1Anim";
/**
 * Assets are authored +Z forward (assets.md §4); the sim frame is +X forward.
 * The rig folds the quarter turn into the per-instance yaw, so the cockpit's
 * aim stays a turn about the model's own up axis.
 */
const MODEL_YAW = Math.PI / 2;

const VERTEX_DECL = `#include <common>
attribute float ${X1_BONE_ATTR};
attribute vec4 ${X1_POSE_ATTR};
uniform highp sampler2D ${X1_ANIM_UNIFORM};`;

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
	transformed = x1Q;
}`;

/** Chains the pose onto the unit material's own patch (the team offset). */
function patchX1(material: THREE.Material, table: THREE.DataTexture): void {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms[X1_ANIM_UNIFORM] = { value: table };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", VERTEX_DECL)
      .replace("#include <begin_vertex>", VERTEX_POSE);
  };
  material.customProgramCacheKey = () => "teamUv+x1";
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
  /** Per slot: the side last written (-2 none), and the cloak's v (-1 none). */
  readonly sideCache: Int8Array;
  readonly cloakCache: Int16Array;
}

/** Builds the mesh from a loaded asset and its bone table. Load time only. */
export function buildX1Rig(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  table: Float32Array,
): X1RigCore {
  const bone = geometry.getAttribute(GLTF_BONE) ?? geometry.getAttribute(X1_BONE_ATTR);
  if (!bone) throw new Error("avatar-x1.glb has no _X1BONE attribute");
  geometry.setAttribute(X1_BONE_ATTR, bone);
  if (geometry.getAttribute(GLTF_BONE)) geometry.deleteAttribute(GLTF_BONE);
  if (!geometry.getAttribute(TEAM_UV_MASK)) throw new Error("avatar-x1.glb has no _TEAMUV");
  geometry.setAttribute(TEAM_UV_ATTR, createTeamUvAttribute(RIG_CAPACITY));
  const pose = new THREE.InstancedBufferAttribute(new Float32Array(RIG_CAPACITY * 4), 4);
  pose.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute(X1_POSE_ATTR, pose);
  patchX1(material, createX1AnimTexture(table));
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
    sideCache: new Int8Array(RIG_CAPACITY).fill(-2),
    cloakCache: new Int16Array(RIG_CAPACITY).fill(-1),
  };
}

/**
 * Writes slot `slot` of the rig: its matrix, its pose and, when the side or the
 * cloak's v changed, its texture offset. Returns false past capacity.
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
  if (core.sideCache[slot] !== side || core.cloakCache[slot] !== cloakV) {
    core.sideCache[slot] = side;
    core.cloakCache[slot] = cloakV;
    writeX1Uv(core.mesh, slot, side, cloakV);
  }
}

export interface AvatarRig {
  /** False until the asset and its table have loaded; callers fall back meanwhile. */
  readonly ready: boolean;
  /** Zeroes the per-frame instance count. Call before the entity sweep. */
  begin(): void;
  /**
   * Poses one X1 -- walker, transforming or hover alike -- by its frames
   * (render/x1Walk.ts) and the cockpit's aim. `cloakV` is the cloak's v
   * offset in texels, or -1. Returns false when the rig cannot take it (not
   * loaded yet, or out of capacity): then the caller uses its bucket.
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
  ): boolean;
  /** Publishes the count and the matrices. Call after the entity sweep. */
  end(): void;
  /** The cockpit's mount height above the X1's origin at a legs frame, m (0 until loaded). */
  mountHeight(legsFrame: number): number;
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
    place(x, height, y, yaw, team, legsFrame, cockpitFrame, aimYaw, aimPitch, cloakV) {
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
      );
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
