// One scenery model as gen:units writes it (one node, one material, its colour in
// one packed atlas): its geometry and its atlas, for render/props.ts and
// render/emitterProps.ts. Init-time only; the frame loop never calls it.

import type * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** The model's merged geometry and its atlas, or null (with a warning) if it has none. */
export function mergePropAsset(
  gltf: GLTF,
  url: string,
  tag: string,
): { geometry: THREE.BufferGeometry; atlas: THREE.Texture | null } | null {
  // Init-time: allocations here are fine (same call as meshMap.ts's Box3).
  gltf.scene.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  // The pipeline emits ONE material per prop, its colour entirely in a
  // single packed atlas. Keep that texture, drop the loader's material.
  let atlas: THREE.Texture | null = null;
  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    // gen:units writes the one node with the identity matrix, which is
    // what keeps a morph's deltas (applyMatrix4 leaves them alone) right.
    geometry.applyMatrix4(mesh.matrixWorld);
    geometries.push(geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const std = material as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial && std.map && !atlas) atlas = std.map;
      material.dispose(); // material only — the kept map texture survives
    }
  });
  if (geometries.length === 0) {
    console.warn(`[${tag}] empty prop asset at ${url}, skipping`);
    return null;
  }
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
  if (!merged) {
    console.warn(`[${tag}] unmergeable prop asset at ${url}, skipping`);
    return null;
  }
  return { geometry: merged, atlas };
}
