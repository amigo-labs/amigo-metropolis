// Stage 4: textured map render path. Loads the .glb built from the FCOP Til data
// (private RE pipeline) and adds it to the arena group. Init-time only; GLTFLoader
// is async, so the .then() fills the (initially empty) group once loaded.
import type { MapData } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MAP_ALIGN } from "./mapAlign.generated";

const loader = new GLTFLoader();

/**
 * Loads the textured map mesh for `map.id` into `group`. When no asset exists
 * for the map (assets live outside this repo), warns and calls `onMissing` so
 * the caller can build the greybox terrain instead of leaving the world empty.
 * The .glb is authored origin-centered; this loader translates it by the
 * committed per-map offset (render/mapAlign.generated.ts) so it lines up with
 * the greybox/collision frame.
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
  cancelled?: () => boolean,
): void {
  const url = `/models/${map.id}/${map.id}.glb`;
  loader.loadAsync(url).then(
    (gltf) => {
      // A preview swap can outrun this load: the group is already out of the
      // scene and disposed, so attaching (or arming onMaterials for the wrong
      // map) would leak GPU memory into a dead tree. Dispose what was parsed.
      if (cancelled?.()) {
        disposeSubtree(gltf.scene);
        return;
      }
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
      // [0, extent]. The offset is NOT derivable from the bounds at runtime:
      // the FCOP grid is padded on its short axis, so the apron is asymmetric
      // (bbox-centering lands ~8 cells off), and the mesh covers only the real
      // region, so its min corner is one Til east of grid cell 0. glb Y is
      // already in the sim's height frame, so Y must stay untranslated — the
      // old `-box.min.y` floated the art metres above the collision surface.
      // tools/generators/genMapAlign.ts measures the truth per map by
      // correlating mesh vertices against MapData.heights; we just apply it.
      gltf.scene.updateMatrixWorld(true);
      const align = MAP_ALIGN[map.id];
      // Init-time, so the Box3 allocation is fine. It is the drift guard: a
      // regenerated .glb with different bounds must never be placed silently.
      const box = new THREE.Box3().setFromObject(gltf.scene);
      if (align === undefined) {
        console.warn(
          `[meshMap] no alignment record for "${map.id}" — falling back to the ` +
            "min-corner + one-Til rule; run `bun run gen:mapalign` to measure it",
        );
        gltf.scene.position.set(-box.min.x + 16 * map.cellSize, 0, -box.min.z);
      } else {
        const drift = Math.max(
          Math.abs(box.min.x - align.minX),
          Math.abs(box.min.y - align.minY),
          Math.abs(box.min.z - align.minZ),
          Math.abs(box.max.x - align.maxX),
          Math.abs(box.max.y - align.maxY),
          Math.abs(box.max.z - align.maxZ),
        );
        if (drift > 1e-3) {
          console.error(
            `[meshMap] ${map.id}.glb bounds drifted ${drift.toFixed(3)} from the ` +
              "measured alignment — re-run `bun run gen:mapalign`",
          );
        }
        gltf.scene.position.set(align.x, align.y, align.z);
      }
      gltf.scene.matrixAutoUpdate = false;
      gltf.scene.updateMatrix();
      group.add(gltf.scene);
      if (materials.length > 0) onMaterials?.(materials);
    },
    () => {
      if (cancelled?.()) return;
      console.warn(`[meshMap] no mesh asset at ${url}, falling back to greybox terrain`);
      onMissing?.();
    },
  );
}

/** Frees every geometry, material and texture under `root` (stale loads). */
function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) {
      const mat = m as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  });
}
