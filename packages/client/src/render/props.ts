// Original arena scenery (#28): draws the DynamicProp placements the map
// carries in `props` — for la-cantina, 36 of them across 8 original Cobj models.
//
// Render-only, and one-way: the sim never reads `props`
// (packages/sim/test/determinismGuard.test.ts enforces that), and nothing here
// feeds anything back. Purely static, so every matrix is written once at init
// and `matrixAutoUpdate` stays off — nothing in this file runs per frame, which
// is what the renderer's zero-allocation rule asks of it.
//
// Same tolerance as the unit and map loaders: an absent or broken .glb costs
// that model's scenery and nothing else. There is no greybox stand-in on
// purpose — the textured terrain already carries the arena's buildings, and
// these are the separate actors on top of it, so their absence reads as a
// plainer arena rather than a broken one.

import { type MapData, type MapProp, sampleHeight } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const loader = new GLTFLoader();

/** Sim yaw is left-handed about +Y relative to three's, as in main.ts. */
const UP = new THREE.Vector3(0, 1, 0);

/** tools/generators/units/manifest.ts PROP_MODELS keys are `prop-<cobj>`. */
function modelKey(cobj: number): string {
  return `prop-${String(cobj).padStart(3, "0")}`;
}

/**
 * Kicks off one async load per distinct prop model. Fire and forget: each
 * model's InstancedMesh joins the arena group when its .glb arrives.
 */
export function loadProps(map: MapData, group: THREE.Object3D): void {
  if (map.props.length === 0) return;
  const byModel = new Map<number, MapProp[]>();
  for (const prop of map.props) {
    const list = byModel.get(prop.model);
    if (list) list.push(prop);
    else byModel.set(prop.model, [prop]);
  }
  for (const [cobj, placements] of byModel) {
    addPropMesh(map, group, cobj, placements);
  }
}

function addPropMesh(
  map: MapData,
  group: THREE.Object3D,
  cobj: number,
  placements: readonly MapProp[],
): void {
  const url = `/models/props/${modelKey(cobj)}.glb`;
  loader.loadAsync(url).then(
    (gltf) => {
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
        console.warn(`[props] empty prop asset at ${url}, skipping`);
        return;
      }
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
      if (!merged) {
        console.warn(`[props] unmergeable prop asset at ${url}, skipping`);
        return;
      }
      // No quarter-turn bake here, unlike unitMeshes.ts: scenery is not
      // authored +Z-forward against the sim's +X-forward convention. These are
      // the original Cobjs in the original's own axes, placed at the original's
      // own coordinates, and the terrain mesh they stand on is loaded in that
      // same frame (mapAlign is a translation only) — so any rotation here
      // would be a rotation away from where the arena was authored.

      // One material per model, never shared: rebuildArena disposes materials
      // and their maps by traversal, so a texture shared between two prop
      // meshes would be disposed twice.
      const material = new THREE.MeshStandardMaterial({
        flatShading: true,
        vertexColors: merged.hasAttribute("color"),
        map: atlas,
      });
      const mesh = new THREE.InstancedMesh(merged, material, placements.length);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      const matrix = new THREE.Matrix4();
      for (let i = 0; i < placements.length; i++) {
        const prop = placements[i];
        // Sim (x, y) is the ground plane and three's Y is up; the model's own
        // origin is already its ground contact, so terrain height carries it.
        position.set(prop.x, sampleHeight(map, prop.x, prop.y) + prop.height, prop.y);
        quaternion.setFromAxisAngle(UP, -prop.yaw);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    },
    () => {
      console.warn(`[props] no prop asset at ${url}, skipping`);
    },
  );
}
