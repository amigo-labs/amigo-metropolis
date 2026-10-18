// The arena's lifts (fcop-fidelity.md P12), drawn with the original's own models:
// each lift wears its record's Cobj from the arena's pack
// (public/models/pa-props/<mapId>/, tools/generators/fcopPaProps.ts) and stands
// where the lift snapshot says its top is (writeLiftSnapshot, renderer rule 4),
// interpolated between the last two sim ticks so a rising lift moves smoothly.
//
// A lift's record angle stands its model as every record angle does
// (render/recordYaw.ts): the glb, which the RE exports with the Cobj's x
// negated, turns by pi/2 - yaw about the vertical and is not mirrored — the
// actors frame's swap of the game's x and z and the export's negation cancel.
// It was baked through that swap a second time, a mirror drawn from both sides
// to hide its reversed faces. Placement is per lift and fixed; the per-frame
// work is one matrix write per lift and nothing is allocated.
//
// Same tolerance as the prop loader: a missing .glb costs that model's lifts and
// nothing else.

import { LIFT_SNAP_STRIDE, LIFT_SNAP_TOP, type MapData } from "@metropolis/sim";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { disposeSubtree } from "./meshMap";
import { yawTurn } from "./recordYaw";

const loader = new GLTFLoader();

interface LiftMesh {
  readonly mesh: THREE.InstancedMesh;
  /** Lift index (into map.lifts) of each instance. */
  readonly lifts: Int16Array;
}

/** The loaded meshes of the current arena; replaced wholesale by loadLifts. */
let meshes: LiftMesh[] = [];
/** Per lift: its position on the ground plane, its turn in three and its top above its origin. */
let baseX = new Float32Array(0);
let baseY = new Float32Array(0);
let turn = new Float32Array(0);
let topOffset = new Float32Array(0);

// Frame-loop scratch (renderer rule 1: no allocation per frame).
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3(1, 1, 1);
const matrix = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

function modelUrl(mapId: string, cobj: number): string {
  return `/models/pa-props/${mapId}/obj_${String(cobj).padStart(3, "0")}.glb`;
}

/**
 * Starts the arena's lift model loads; each model's InstancedMesh joins `group`
 * when its .glb arrives. Forgets the previous arena's meshes (their group is
 * disposed by the caller).
 */
export function loadLifts(map: MapData, group: THREE.Object3D, cancelled?: () => boolean): void {
  meshes = [];
  const n = map.lifts.length;
  baseX = new Float32Array(n);
  baseY = new Float32Array(n);
  turn = new Float32Array(n);
  topOffset = new Float32Array(n);
  const byModel = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    const l = map.lifts[k];
    baseX[k] = l.x;
    baseY[k] = l.y;
    turn[k] = yawTurn(l.yaw);
    topOffset[k] = l.top;
    const list = byModel.get(l.model);
    if (list) list.push(k);
    else byModel.set(l.model, [k]);
  }
  for (const [cobj, lifts] of byModel) {
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
          console.warn(`[lifts] empty lift asset at ${url}, skipping`);
          return;
        }
        const geometry = found.geometry.clone();
        geometry.applyMatrix4(found.matrixWorld);
        const material = found.material as THREE.Material;
        const mesh = new THREE.InstancedMesh(geometry, material, lifts.length);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        meshes.push({ mesh, lifts: Int16Array.from(lifts) });
      },
      () => {
        console.warn(`[lifts] no lift asset at ${url}, skipping`);
      },
    );
  }
}

/**
 * Writes every lift instance for this frame: its top interpolated between the
 * previous tick's lift snapshot and this one's by `alpha`.
 */
export function updateLifts(prev: Float32Array, curr: Float32Array, alpha: number): void {
  for (let m = 0; m < meshes.length; m++) {
    const { mesh, lifts } = meshes[m];
    for (let i = 0; i < lifts.length; i++) {
      const k = lifts[i];
      const o = k * LIFT_SNAP_STRIDE + LIFT_SNAP_TOP;
      if (o >= curr.length) continue;
      const top = o < prev.length ? prev[o] + (curr[o] - prev[o]) * alpha : curr[o];
      position.set(baseX[k], top - topOffset[k], baseY[k]);
      quaternion.setFromAxisAngle(UP, turn[k]);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
