// Stage 4: textured map render path. Loads the .glb built from the FCOP Til data
// (private RE pipeline) and adds it to the arena group. Init-time only; GLTFLoader
// is async, so the .then() fills the (initially empty) group once loaded.
import type { MapData } from "@metropolis/sim";
import type * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

/**
 * Loads the textured map mesh for `map.id` into `group`. When no asset exists
 * for the map (assets live outside this repo), warns and calls `onMissing` so
 * the caller can build the greybox terrain instead of leaving the world empty.
 * Alignment: the .glb is authored in the extractor's origin-centered frame; the
 * caller positions `group` so the mesh lines up with the greybox/collision.
 */
export function loadMapMesh(map: MapData, group: THREE.Group, onMissing?: () => void): void {
  const url = `/models/${map.id}/${map.id}.glb`;
  loader.loadAsync(url).then(
    (gltf) => {
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const tex = mat.map;
        if (tex) {
          // Modern look (assets.md §3 deliberately relaxed): anisotropy on top of
          // the glTF's linear/mipmap sampler. Filters already come from the sampler.
          tex.anisotropy = 8;
          tex.needsUpdate = true;
        }
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
      });
      gltf.scene.matrixAutoUpdate = false;
      gltf.scene.updateMatrix();
      group.add(gltf.scene);
    },
    () => {
      console.warn(`[meshMap] no mesh asset at ${url}, falling back to greybox terrain`);
      onMissing?.();
    },
  );
}
