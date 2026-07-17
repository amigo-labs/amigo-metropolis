// Stage 4: textured map render path. Loads the .glb built from the FCOP Til data
// (private RE pipeline) and adds it to the arena group. Init-time only; GLTFLoader
// is async, so the .then() fills the (initially empty) group once loaded.
import { type MapData, worldExtent } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

/**
 * Loads the textured map mesh for `map.id` into `group`. When no asset exists
 * for the map (assets live outside this repo), warns and calls `onMissing` so
 * the caller can build the greybox terrain instead of leaving the world empty.
 * The .glb is authored origin-centered; this loader re-centres it into the sim's
 * [0, extent] frame (see below) so it lines up with the greybox/collision.
 *
 * `onMaterials` (optional) receives every MeshStandardMaterial of the loaded
 * mesh once — the debug texture-variant switcher (render/texVariants.ts) uses
 * it to swap material.map at runtime. Purely additive; existing callers are
 * unaffected.
 */
export function loadMapMesh(
  map: MapData,
  group: THREE.Group,
  onMissing?: () => void,
  onMaterials?: (materials: THREE.MeshStandardMaterial[]) => void,
): void {
  const url = `/models/${map.id}/${map.id}.glb`;
  loader.loadAsync(url).then(
    (gltf) => {
      const materials: THREE.MeshStandardMaterial[] = [];
      gltf.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        // mesh.material may be an array, and materials other than
        // MeshStandardMaterial have no .map — handle both so the sampler tweak
        // and the onMaterials contract stay sound for any asset.
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of list) {
          const mat = m as THREE.MeshStandardMaterial;
          if (!mat.isMeshStandardMaterial) continue;
          materials.push(mat);
          const tex = mat.map;
          if (tex) {
            // Modern look (assets.md §3 deliberately relaxed): anisotropy on top of
            // the glTF's linear/mipmap sampler. Filters already come from the sampler.
            tex.anisotropy = 8;
            tex.needsUpdate = true;
          }
        }
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
      });
      // Alignment: the .glb is authored in the extractor's origin-centered
      // frame (bbox straddles 0), while the sim/greybox/markers live in
      // [0, extent]. Translate the mesh so its footprint centre sits at the
      // arena centre (XZ) and its lowest point rests at y=0, matching the
      // greybox terrain. Init-time, so the Box3 allocation is fine.
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const centre = box.getCenter(new THREE.Vector3());
      const half = worldExtent(map) / 2;
      gltf.scene.position.set(half - centre.x, -box.min.y, half - centre.z);
      gltf.scene.matrixAutoUpdate = false;
      gltf.scene.updateMatrix();
      group.add(gltf.scene);
      if (materials.length > 0) onMaterials?.(materials);
    },
    () => {
      console.warn(`[meshMap] no mesh asset at ${url}, falling back to greybox terrain`);
      onMissing?.();
    },
  );
}
