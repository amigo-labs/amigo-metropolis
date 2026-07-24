// Stage 4: textured map render path. Loads the .glb built from the FCOP Til data
// (private RE pipeline) and adds it to the arena group. Init-time only; GLTFLoader
// is async, so the .then() fills the (initially empty) group once loaded.
import type { MapData } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

/**
 * Gameplay/logic content centre in sim XZ (same 0-based grid as FCOP actors /
 * Cnet and docs/renders/fcop-viz). Matches prep_viz logic-bbox centre so the
 * textured mesh lines up with spawns/lanes/turrets like la-cantina-top.png.
 */
function logicCentre(map: MapData): { x: number; z: number } {
  const xs: number[] = [];
  const zs: number[] = [];
  const add = (x: number, z: number) => {
    xs.push(x);
    zs.push(z);
  };
  for (const s of map.spawns) add(s.x, s.y);
  for (const b of map.bases) {
    add(b.core.x, b.core.y);
    for (const t of b.turrets) add(t.x, t.y);
  }
  for (const t of map.turretSpots) add(t.x, t.y);
  for (const t of map.dummySpots) add(t.x, t.y);
  for (const o of map.outpostSpots) add(o.x, o.y);
  for (const lane of map.lanes) {
    for (const p of lane) add(p.x, p.y);
  }
  if (xs.length === 0) {
    // Fallback: half extent (only empty/synthetic maps).
    const half = ((map.size - 1) * map.cellSize) / 2;
    return { x: half, z: half };
  }
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };
}

/**
 * Loads the textured map mesh for `map.id` into `group`. When no asset exists
 * for the map (assets live outside this repo), warns and calls `onMissing` so
 * the caller can build the greybox terrain instead of leaving the world empty.
 *
 * Alignment (docs/renders/fcop-viz/README.md — same as Blender overlays):
 *   position.xz = logicCentre − glbBBoxCentre
 * Do NOT centre on worldExtent/2 (grid centre); the apron is asymmetric and
 * that shifts the mesh ~16 cells off the FCOP logic frame. Y is left authored
 * (matches the heightfield, incl. negative riverbeds).
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
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const glbCentre = box.getCenter(new THREE.Vector3());
      const logic = logicCentre(map);
      // Same transform as fcop-viz build_map.py (three.js Z = sim y, no Blender flip).
      gltf.scene.position.set(logic.x - glbCentre.x, 0, logic.z - glbCentre.z);
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
