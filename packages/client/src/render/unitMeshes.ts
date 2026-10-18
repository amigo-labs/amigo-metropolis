// Stage B unit models (assets.md §1 Stage B): swaps the real per-archetype
// meshes from /models/units/<key>.glb into the live greybox InstancedMesh
// buckets. Same contract as the map loader (meshMap.ts): init-time async, and
// any archetype whose asset is missing or broken simply keeps its greybox —
// so the rollout can happen model by model and ?render=greybox stays whole.
//
// Boot-time only, and only the projectiles. The units — the X1-Alpha's two
// forms and the arena's own tank, jet, Fortress, Dreadnought, turrets, console
// and Sky Captain — load with the arena (render/arenaUnits.ts), through
// loadUnitAsset below, which gives every unit material the original's team
// colour: a per-instance texture offset (render/teamUv.ts), not a tint.
//
// The swap replaces only geometry + material on each bucket's InstancedMesh;
// instanceMatrix lives on the mesh and carries over, so the bucket capacities
// are untouched — one InstancedMesh per archetype.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Bucket, GreyboxMeshes } from "./greybox";
import { patchTeamUv, prepareTeamUvMask } from "./teamUv";

const loader = new GLTFLoader();

/**
 * Model key under /models/fx/ per projectile bucket — the mesh the original
 * fires for that kind, per the type-99 weapon table (docs/specs/fcop-fx.md §3).
 *
 * The player's four come straight off the player table. The world rounds come
 * off the type-98 rows the RE's effect export names (`projectile_cobj`): the
 * Sky Captain's bomb is row 9's Cobj 49, the rounds of the other rows are by
 * row (effects/rounds.ts matches each round to its launch). The shockwave has
 * no entry because the original has none either — its row is one of the seven
 * empty ones.
 */
const FX_MODEL_KEYS = [
  ["projHeavy", "rocket-helfire"],
  ["projHyper", "rocket-hyper"],
  ["projMortar", "shell-mortar"],
  ["projMine", "mine"],
  // The Sky Captain's bomb is world row 9: Cobj 49 (the mortar shell's payload).
  ["projWarden", "round-row9"],
  // The world rows' rounds, in the original's own colours (effects/rounds.ts).
  ["roundRow1", "round-row1"],
  ["roundRow3", "round-row3"],
  ["roundRow4", "round-row4"],
  ["roundRow6", "round-row6"],
  ["roundRow8", "round-row8"],
] as const satisfies readonly (readonly [keyof GreyboxMeshes, string])[];

/**
 * Kicks off the async model load for every model-backed bucket. Fire and
 * forget: buckets upgrade in place as their .glb arrives.
 */
export function loadUnitMeshes(buckets: GreyboxMeshes): void {
  // Projectiles keep the unlit material their bucket was built with: a bolt or
  // a shell reads as a light source, not as a lit surface, which is also why
  // the original drew their glows as emissive facer geometry.
  for (const [bucketName, key] of FX_MODEL_KEYS) {
    swapBucketMesh(buckets[bucketName], key, "fx", true);
  }
}

/** One merged geometry plus the single material every unit asset carries. */
export interface UnitAsset {
  /** Model space, i.e. still +Z forward — the caller decides on the bake. */
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
}

/**
 * Loads `/models/units/<key>.glb` and flattens it to one geometry + material.
 * `key` may name a subfolder (`la-cantina/obj_030`, render/arenaUnits.ts).
 *
 * Model space, deliberately: `avatarRig.ts` splits the geometry into limbs and
 * hinges them, which is a rotation about the model's own left-right axis. Baking
 * the +Z→+X quarter turn in here would move that axis, so the turn stays with
 * each caller — the bucket path bakes it into the geometry, the rig folds it
 * into the per-instance yaw.
 *
 * Rejects with the loader's error when the asset is missing or unmergeable, so
 * every caller can fall back to its greybox.
 */
export async function loadUnitAsset(
  key: string,
  dir: "units" | "fx" = "units",
  unlit = false,
): Promise<UnitAsset> {
  const url = `/models/${dir}/${key}.glb`;
  const gltf = await loader.loadAsync(url);
  // Init-time, so allocations and Box3-free traversal are fine here.
  gltf.scene.updateMatrixWorld(true);
  const geometries: THREE.BufferGeometry[] = [];
  // The pipeline emits ONE material per unit: either a single packed
  // atlas texture (FCOP originals) or vertex colors (untextured packs).
  // Keep the atlas, dispose the loader's material shells.
  // Boxed rather than a plain `let`: the assignment happens inside the
  // traverse callback, which control-flow analysis does not follow, so a
  // `let` reads as still-null afterwards and narrows to `never` inside
  // `if (map)`. The box has nothing to narrow.
  const atlas: { texture: THREE.Texture | null } = { texture: null };
  gltf.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometries.push(geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const std = material as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial && std.map && !atlas.texture) atlas.texture = std.map;
      material.dispose(); // material only — the kept map texture survives
    }
  });
  if (geometries.length === 0) throw new Error(`empty unit asset at ${url}`);
  const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
  if (!merged) throw new Error(`unmergeable unit asset at ${url}`);
  // PS1-era atlas sampling (assets.md §3): hard pixels, no mips.
  const map = atlas.texture;
  if (map) {
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;
  }
  const vertexColors = merged.hasAttribute("color");
  const material = unlit
    ? new THREE.MeshBasicMaterial({ vertexColors, map, toneMapped: false })
    : new THREE.MeshStandardMaterial({ flatShading: true, vertexColors, map });
  // A unit's team is a texture offset per instance (render/teamUv.ts); the
  // projectiles keep their tint (render/fx.ts, docs/specs/fcop-fx.md).
  if (dir === "units") {
    patchTeamUv(material);
    prepareTeamUvMask(merged);
  }
  return { geometry: merged, material };
}

function swapBucketMesh(bucket: Bucket, key: string, dir: "fx", unlit: boolean): void {
  loadUnitAsset(key, dir, unlit).then(
    ({ geometry, material }) => {
      // Models are authored +Z forward (assets.md §4); the sim/greybox frame
      // is +X forward, so bake the quarter turn into the geometry once.
      geometry.rotateY(Math.PI / 2);
      bucket.mesh.geometry.dispose();
      bucket.mesh.geometry = geometry;
      (bucket.mesh.material as THREE.Material).dispose();
      bucket.mesh.material = material;
      // Belt and braces: re-write every instance tint on the next frame so no
      // slot can carry a stale cache entry across the swap.
      bucket.tintCache.fill(-2);
    },
    (err) => {
      console.warn(`[unitMeshes] no usable unit asset for ${key}, keeping greybox: ${err}`);
    },
  );
}
