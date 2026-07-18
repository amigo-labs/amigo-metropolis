// Stage B unit models (assets.md §1 Stage B): swaps the real per-archetype
// meshes from /models/units/<key>.glb into the live greybox InstancedMesh
// buckets. Same contract as the map loader (meshMap.ts): init-time async, and
// any archetype whose asset is missing or broken simply keeps its greybox —
// so the rollout can happen model by model and ?render=greybox stays whole.
//
// The swap replaces only geometry + material on each bucket's InstancedMesh;
// instanceMatrix/instanceColor live on the mesh and carry over, so the frame
// loop (main.ts renderEntities), the bucket capacities, and the whole-unit
// instanceColor team tint (greybox.ts tintFor) are untouched — one
// InstancedMesh per archetype, zero frame-loop changes.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Bucket, GreyboxMeshes } from "./greybox";

const loader = new GLTFLoader();

/** Model key under /models/units/ per bucket; projectiles stay procedural. */
const UNIT_MODEL_KEYS = [
  ["avatarWalker", "avatar-walker"],
  ["avatarHover", "avatar-hover"],
  ["runner", "runner"],
  ["guardian", "guardian"],
  ["juggernaut", "juggernaut"],
  ["fortress", "fortress"],
  ["turret", "turret"],
  ["console", "console"],
  ["warden", "warden"],
] as const satisfies readonly (readonly [keyof GreyboxMeshes, string])[];

/**
 * Kicks off the async model load for every model-backed bucket. Fire and
 * forget: buckets upgrade in place as their .glb arrives.
 */
export function loadUnitMeshes(buckets: GreyboxMeshes): void {
  for (const [bucketName, key] of UNIT_MODEL_KEYS) {
    swapBucketMesh(buckets[bucketName], key);
  }
}

function swapBucketMesh(bucket: Bucket, key: string): void {
  const url = `/models/units/${key}.glb`;
  loader.loadAsync(url).then(
    (gltf) => {
      // Init-time, so allocations and Box3-free traversal are fine here.
      gltf.scene.updateMatrixWorld(true);
      const geometries: THREE.BufferGeometry[] = [];
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        geometries.push(geometry);
        // The loader's own materials are never used — the bucket gets one
        // shared vertex-color material below.
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) material.dispose();
      });
      if (geometries.length === 0) {
        console.warn(`[unitMeshes] empty unit asset at ${url}, keeping greybox`);
        return;
      }
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
      if (!merged) {
        console.warn(`[unitMeshes] unmergeable unit asset at ${url}, keeping greybox`);
        return;
      }
      // Models are authored +Z forward (assets.md §4); the sim/greybox frame
      // is +X forward, so bake the quarter turn into the geometry once.
      merged.rotateY(Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({
        flatShading: true,
        vertexColors: merged.hasAttribute("color"),
      });
      bucket.mesh.geometry.dispose();
      bucket.mesh.geometry = merged;
      (bucket.mesh.material as THREE.Material).dispose();
      bucket.mesh.material = material;
      // Belt and braces: re-write every instance tint on the next frame so no
      // slot can carry a stale cache entry across the swap.
      bucket.tintCache.fill(-2);
    },
    () => {
      console.warn(`[unitMeshes] no unit asset at ${url}, keeping greybox`);
    },
  );
}
