// The arena's pickups, drawn with the original's own models (fcop-fidelity.md
// P9; owner's call 2026-10-14 to show them): ammunition, power-up, health and
// cloak pickups each wear their Cobj, from the arena's own pack
// (public/models/pa-props/<mapId>/, tools/generators/fcopPaProps.ts).
//
// One InstancedMesh per model, one instance per pickup that wears it. Each
// frame a pickup is drawn where the match snapshot says it stands
// (MATCH_PICKUPS, renderer rule 4) and hidden (scale 0) while it waits to
// re-arm; it turns at its record's spin rate, 4096ths of a turn per 300 Hz
// engine tick (`pickup.c` 0x0041e532), on the sim's clock, the angle standing
// the model as every record angle does (render/recordYaw.ts). Placement is static,
// so the per-frame work is a matrix write per instance and nothing is allocated.
//
// Same tolerance as the prop loader: a missing .glb costs that model's
// pickups and nothing else.

import {
  MATCH_PICKUPS,
  MATCH_TICK,
  type MapData,
  resolveHeight,
  rideHeight,
} from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposeSubtree } from "./meshMap";
import { RECORD_TURN, recordTurn } from "./recordYaw";

const loader = new GLTFLoader();

/** Engine ticks (300 Hz) per sim tick (30 Hz): the spin's clock. */
const ENGINE_TICKS_PER_SIM_TICK = 10;

interface PickupMesh {
  readonly mesh: THREE.InstancedMesh;
  /** Pickup index (into map.pickups) of each instance. */
  readonly spots: Int16Array;
}

/** The loaded meshes of the current arena; replaced wholesale by loadPickups. */
let meshes: PickupMesh[] = [];
/** Per pickup: its world position (x, height, y) and spin rate, fixed at load. */
let baseX = new Float32Array(0);
let baseY = new Float32Array(0);
let baseZ = new Float32Array(0);
let spinRate = new Float32Array(0);

// Frame-loop scratch (renderer rule 1: no allocation per frame).
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const matrix = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

function modelUrl(mapId: string, cobj: number): string {
  return `/models/pa-props/${mapId}/obj_${String(cobj).padStart(3, "0")}.glb`;
}

/**
 * Starts the arena's pickup model loads; each model's InstancedMesh joins
 * `group` when its .glb arrives. Forgets the previous arena's meshes (their
 * group is disposed by the caller).
 */
export function loadPickups(map: MapData, group: THREE.Object3D, cancelled?: () => boolean): void {
  meshes = [];
  const n = map.pickups.length;
  baseX = new Float32Array(n);
  baseY = new Float32Array(n);
  baseZ = new Float32Array(n);
  spinRate = new Float32Array(n);
  const byModel = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    const p = map.pickups[k];
    baseX[k] = p.x;
    baseY[k] = p.y;
    // As the sim stands it: `lift` above the ground under it, water included.
    const ground =
      p.layer === 0 ? rideHeight(map, p.x, p.y, true) : resolveHeight(map, p.x, p.y, p.layer);
    baseZ[k] = ground + p.lift;
    spinRate[k] = p.spin;
    if (p.model < 0) continue;
    const list = byModel.get(p.model);
    if (list) list.push(k);
    else byModel.set(p.model, [k]);
  }
  for (const [cobj, spots] of byModel) {
    const url = modelUrl(map.id, cobj);
    loader.loadAsync(url).then(
      (gltf) => {
        if (cancelled?.()) {
          disposeSubtree(gltf.scene);
          return;
        }
        gltf.scene.updateMatrixWorld(true);
        let source: THREE.Mesh | null = null;
        gltf.scene.traverse((obj) => {
          const m = obj as THREE.Mesh;
          if (m.isMesh && !source) source = m;
        });
        const found = source as THREE.Mesh | null;
        if (!found) {
          console.warn(`[pickups] empty pickup asset at ${url}, skipping`);
          return;
        }
        // The pack's model is one mesh with one textured material (pa_props
        // manifest); its node transform is baked in, the material kept.
        const geometry = found.geometry.clone();
        geometry.applyMatrix4(found.matrixWorld);
        const material = found.material as THREE.Material;
        const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        // Hidden until the first update says the pickup stands.
        scale.set(0, 0, 0);
        for (let i = 0; i < spots.length; i++) {
          matrix.compose(
            position.set(baseX[spots[i]], baseZ[spots[i]], baseY[spots[i]]),
            quaternion.identity(),
            scale,
          );
          mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
        meshes.push({ mesh, spots: Int16Array.from(spots) });
      },
      () => {
        console.warn(`[pickups] no pickup asset at ${url}, skipping`);
      },
    );
  }
}

/**
 * Writes every pickup instance for this frame: shown and turned where the
 * match snapshot says it stands, collapsed while it re-arms. `alpha` is the
 * interpolation fraction into the next sim tick, for a smooth spin.
 */
export function updatePickups(matchSnap: Float32Array, alpha: number): void {
  if (meshes.length === 0) return;
  const up = matchSnap[MATCH_PICKUPS] | 0;
  const engineTicks = (matchSnap[MATCH_TICK] + alpha) * ENGINE_TICKS_PER_SIM_TICK;
  for (let m = 0; m < meshes.length; m++) {
    const { mesh, spots } = meshes[m];
    for (let i = 0; i < spots.length; i++) {
      const k = spots[i];
      const shown = k < 24 && (up & (1 << k)) !== 0;
      const s = shown ? 1 : 0;
      scale.set(s, s, s);
      quaternion.setFromAxisAngle(UP, recordTurn((engineTicks * spinRate[k]) % RECORD_TURN));
      position.set(baseX[k], baseZ[k], baseY[k]);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
